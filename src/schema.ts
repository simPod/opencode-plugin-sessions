import type { SessionTransferData } from '@opencode/client';
import { isAbsolute } from 'node:path';
import { SessionTransfer } from '@opencode/schema/session-transfer';
import { Schema } from 'effect';
import { z } from 'zod';

export const SessionID = z.string().regex(/^ses_[a-zA-Z0-9]+$/);
export const ArchiveID = z.uuid();
export const RestoreLocation = z.strictObject({
  projectID: z.string().min(1),
  directory: z
    .string()
    .refine(isAbsolute, 'Restore directories must be absolute server paths'),
});
export type RestoreLocation = z.infer<typeof RestoreLocation>;
const AbsoluteDirectory = RestoreLocation.shape.directory;
const Commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const WorktreePlan = RestoreLocation.extend({
  commit: Commit,
  repository: AbsoluteDirectory,
  worktree: AbsoluteDirectory,
});
export type WorktreePlan = z.infer<typeof WorktreePlan>;
export const WorktreeSnapshot = WorktreePlan.extend({
  dirty: z.boolean(),
  branch: z.string().min(1).optional(),
});
export type WorktreeSnapshot = z.infer<typeof WorktreeSnapshot>;
export const WorktreeRequest = RestoreLocation.extend({
  ref: z.string().min(1),
  repository: AbsoluteDirectory,
  worktree: AbsoluteDirectory,
});
export type WorktreeRequest = z.infer<typeof WorktreeRequest>;
export const RestoreMappings = z
  .array(
    z.strictObject({
      from: RestoreLocation,
      to: RestoreLocation,
    }),
  )
  .superRefine((mappings, context) => {
    const seen = new Set<string>();
    for (const [index, mapping] of mappings.entries()) {
      const key = JSON.stringify([
        mapping.from.projectID,
        mapping.from.directory,
      ]);
      if (seen.has(key))
        context.addIssue({
          code: 'custom',
          path: [index, 'from'],
          message: 'Duplicate restore mapping source',
        });
      seen.add(key);
    }
  });
export type RestoreMapping = z.infer<typeof RestoreMappings>[number];
const isTransfer = Schema.is(Schema.toEncoded(SessionTransfer.Data));

// Validate the complete native transfer contract, not a partial transcript shape.
export const Transfer = z.custom<SessionTransferData>(
  isTransfer,
  'Invalid V2 session transfer',
);
const BundleFields = {
  format: z.literal('opencode-session-archive'),
  id: ArchiveID,
  createdAt: z.number().int().positive(),
  projectID: z.string().min(1),
  rootSessionID: SessionID,
  sessions: z.array(Transfer).min(1),
};
export const Bundle = z
  .discriminatedUnion('version', [
    z.strictObject({ ...BundleFields, version: z.literal(1) }),
    z.strictObject({
      ...BundleFields,
      version: z.literal(2),
      worktrees: z.array(WorktreeSnapshot),
    }),
  ])
  .superRefine((bundle, context) => {
    if (bundle.version === 2) {
      const locations = new Set<string>();
      for (const snapshot of bundle.worktrees) {
        const key = JSON.stringify([snapshot.projectID, snapshot.directory]);
        if (
          locations.has(key) ||
          !bundle.sessions.some(
            ({ info }) =>
              info.projectID === snapshot.projectID &&
              info.location.directory === snapshot.directory,
          )
        )
          context.addIssue({
            code: 'custom',
            message: 'Invalid worktree location',
          });
        locations.add(key);
      }
    }
    const seen = new Set<string>();
    const messageIDs = new Set<string>();
    const all = new Set(bundle.sessions.map((session) => session.info.id));
    if (bundle.sessions[0]?.info.id !== bundle.rootSessionID) {
      context.addIssue({
        code: 'custom',
        message: 'The root session must be first',
      });
    }
    if (bundle.sessions[0]?.info.projectID !== bundle.projectID) {
      context.addIssue({
        code: 'custom',
        message: 'The root session must match the archive project',
      });
    }
    for (const session of bundle.sessions) {
      const { id, parentID, projectID } = session.info;
      if (!SessionID.safeParse(id).success || seen.has(id) || !projectID) {
        context.addIssue({
          code: 'custom',
          message: 'Invalid or duplicate session',
        });
      }
      if (id !== bundle.rootSessionID && (!parentID || !seen.has(parentID))) {
        context.addIssue({
          code: 'custom',
          message: 'Descendants must follow their parent',
        });
      }
      if (id === bundle.rootSessionID && parentID && all.has(parentID)) {
        context.addIssue({
          code: 'custom',
          message: 'The session hierarchy contains a cycle',
        });
      }
      if (session.info.fork || session.info.revert) {
        context.addIssue({
          code: 'custom',
          message: 'V2 import cannot restore fork or revert state',
        });
      }
      if (
        'workspaceID' in session.info.location &&
        session.info.location.workspaceID !== undefined
      )
        context.addIssue({
          code: 'custom',
          message: 'V2 HTTP import cannot restore workspace identity',
        });
      for (const message of session.messages) {
        if (messageIDs.has(message.id))
          context.addIssue({
            code: 'custom',
            message: 'Duplicate message IDs',
          });
        messageIDs.add(message.id);
      }
      seen.add(id);
    }
  });

export type ArchiveBundle = z.infer<typeof Bundle>;
export const Summary = z.strictObject({
  id: ArchiveID,
  rootSessionID: SessionID,
  title: z.string(),
  createdAt: z.number(),
  sessionCount: z.number().int().positive(),
});
export type ArchiveSummary = z.infer<typeof Summary>;
export const RestoreSummary = Summary.extend({
  id: z.union([ArchiveID, SessionID]),
});
export type RestoreSummary = z.infer<typeof RestoreSummary>;

export interface ArchiveStorage {
  save(bundle: ArchiveBundle): Promise<{ id: string; path: string }>;
  read(id: string): Promise<ArchiveBundle>;
  list(sessionID?: string): Promise<ArchiveSummary[]>;
}
