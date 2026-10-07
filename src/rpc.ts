import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import {
  ArchiveID,
  Bundle,
  RestoreMappings,
  SessionID,
  Summary,
} from './schema.ts';

export const Archives = Rpc.define({
  id: 'simpod-session-archive',
  events: {},
  methods: {
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
