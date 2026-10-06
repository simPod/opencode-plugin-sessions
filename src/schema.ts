import type { SessionTransferData } from '@opencode/client';
import { SessionTransfer } from '@opencode/schema/session-transfer';
import { Schema } from 'effect';
import { z } from 'zod';

export const SessionID = z.string().regex(/^ses_[a-zA-Z0-9]+$/);
export const ArchiveID = z.uuid();
const isTransfer = Schema.is(Schema.toEncoded(SessionTransfer.Data));

// Validate the complete native transfer contract, not a partial transcript shape.
export const Transfer = z.custom<SessionTransferData>(
  isTransfer,
  'Invalid V2 session transfer',
);
export const Bundle = z
  .strictObject({
    format: z.literal('opencode-session-archive'),
    version: z.literal(1),
    id: ArchiveID,
    createdAt: z.number().int().positive(),
    projectID: z.string().min(1),
    rootSessionID: SessionID,
    sessions: z.array(Transfer).min(1),
  })
  .superRefine((bundle, context) => {
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
      if (session.info.location.workspaceID !== undefined)
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

export interface ArchiveStorage {
  save(bundle: ArchiveBundle): Promise<{ id: string; path: string }>;
  read(id: string): Promise<ArchiveBundle>;
  list(): Promise<ArchiveSummary[]>;
}
