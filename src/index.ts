import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { Plugin } from '@opencode/plugin';
import { z } from 'zod';
import { Archives } from './rpc.ts';
import { FileArchiveStorage } from './storage.ts';

const Options = z.strictObject({
  storageDirectory: z.string().min(1).optional(),
});

export default Plugin.define({
  id: 'simpod-session-archive',
  async setup(context) {
    const options = Options.parse(context.options);
    const configured = options.storageDirectory;
    const directory =
      configured === undefined
        ? join(
            process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
            'opencode-session-archive',
          )
        : configured === '~'
          ? homedir()
          : configured.startsWith('~/')
            ? join(homedir(), configured.slice(2))
            : configured;
    if (!isAbsolute(directory))
      throw new Error(
        'storageDirectory must be an absolute path or start with ~/',
      );

    const storage = new FileArchiveStorage({
      storageDirectory: directory,
      projectID: context.location.project.id,
      projectName: basename(
        context.location.project.id === 'global'
          ? context.location.directory
          : context.location.project.canonical,
      ),
      projectDirectory: context.location.directory,
    });
    const registration = await context.rpc.register(Archives, {
      list: () => storage.list(),
      read: ({ id }) => storage.read(id),
      save: ({ bundle }) => storage.save(bundle),
    });
    return () => registration.dispose();
  },
});
