import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { Plugin } from '@opencode/plugin';
import { z } from 'zod';
import { desktopClient } from './desktop-client.ts';
import { desktopCommands } from './desktop.ts';
import { Archives } from './rpc.ts';
import { restoreStorage } from './restore-storage.ts';
import { RestoreMappings } from './schema.ts';
import { FileArchiveStorage } from './storage.ts';

const Options = z.strictObject({
  storageDirectory: z.string().min(1).optional(),
  restoreMappings: RestoreMappings.default([]),
});

export default Plugin.define({
  id: 'simpod-sessions',
  async setup(context) {
    const options = Options.parse(context.options);
    const configured = options.storageDirectory;
    const directory =
      configured === undefined
        ? join(homedir(), '.opencode-session-archives')
        : configured === '~'
          ? homedir()
          : configured.startsWith('~/')
            ? join(homedir(), configured.slice(2))
            : configured;
    if (!isAbsolute(directory))
      throw new Error(
        'storageDirectory must be an absolute path or start with ~/',
      );

    const primary = new FileArchiveStorage({
      storageDirectory: directory,
      projectID: context.location.project.id,
      projectName: basename(
        context.location.project.id === 'global'
          ? context.location.directory
          : context.location.project.canonical,
      ),
      projectDirectory: context.location.directory,
    });
    const storage = restoreStorage(primary, {
      storageDirectory: directory,
      projectID: context.location.project.id,
      directory: context.location.directory,
      restoreMappings: options.restoreMappings,
    });
    const instanceID = randomUUID();
    const lifetime = new AbortController();
    const registration = await context.rpc.register(Archives, {
      restoreMappings: async () => options.restoreMappings,
      instance: async () => ({ id: instanceID }),
      list: ({ sessionID }) => storage.list(sessionID),
      read: ({ id }) => storage.read(id),
      save: ({ bundle }) => storage.save(bundle),
    });
    let commands;
    try {
      const definitions = desktopCommands(
        () =>
          desktopClient(
            {
              directory: context.location.directory,
              ...(context.location.workspaceID === undefined
                ? {}
                : { workspaceID: context.location.workspaceID }),
            },
            instanceID,
            lifetime.signal,
          ),
        storage,
        {
          projectID: context.location.project.id,
          directory: context.location.directory,
        },
        lifetime.signal,
        options.restoreMappings,
      );
      commands = await context.command.transform((editor) => {
        for (const command of definitions) editor.add(command);
      });
    } catch (error) {
      lifetime.abort();
      await registration.dispose();
      throw error;
    }
    return async () => {
      lifetime.abort();
      await commands.dispose();
      await registration.dispose();
    };
  },
});
