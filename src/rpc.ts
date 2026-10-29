import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import {
  ArchiveID,
  Bundle,
  RestoreLocation,
  RestoreMappings,
  SessionID,
  Summary,
  WorktreePlan,
  WorktreeRequest,
  WorktreeSnapshot,
} from './schema.ts';

const ArchiveReference = z.strictObject({
  id: ArchiveID,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ArchiveResult = z.strictObject({
  operationID: z.uuid(),
  sessionID: SessionID,
  variant: z.enum(['started', 'success', 'error']),
  message: z.string(),
});
export type ArchiveResult = z.infer<typeof ArchiveResult>;

export const Archives = Rpc.define({
  id: 'simpod-session-archive',
  events: { archiveResult: { schema: ArchiveResult } },
  methods: {
    worktreeCapture: {
      input: z.strictObject({ locations: z.array(RestoreLocation) }),
      output: z.array(WorktreeSnapshot),
    },
    worktreeMissing: {
      input: z.strictObject({ locations: z.array(RestoreLocation) }),
      output: z.array(RestoreLocation),
    },
    worktreePrepare: {
      input: z.strictObject({
        archive: ArchiveReference,
        request: WorktreeRequest,
      }),
      output: WorktreePlan,
    },
    worktreeRecreate: {
      input: z.strictObject({ archive: ArchiveReference, plan: WorktreePlan }),
      output: z.null(),
    },
    restoreMappings: { input: z.strictObject({}), output: RestoreMappings },
    instance: {
      input: z.strictObject({}),
      output: z.strictObject({ id: z.uuid() }),
    },
    list: {
      input: z.strictObject({ sessionID: SessionID.optional() }),
      output: z.array(Summary),
    },
    read: { input: z.strictObject({ id: ArchiveID }), output: Bundle },
    save: {
      input: z.strictObject({ bundle: Bundle }),
      output: z.strictObject({ id: ArchiveID, path: z.string() }),
    },
  },
});
