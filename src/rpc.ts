import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import { ArchiveID, Bundle, Summary } from './schema.ts';

export const Archives = Rpc.define({
  id: 'simpod-session-archive',
  events: {},
  methods: {
    list: { input: z.strictObject({}), output: z.array(Summary) },
    read: { input: z.strictObject({ id: ArchiveID }), output: Bundle },
    save: {
      input: z.strictObject({ bundle: Bundle }),
      output: z.strictObject({ id: ArchiveID, path: z.string() }),
    },
  },
});
