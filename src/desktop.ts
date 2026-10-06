import type { CommandDefinition } from '@opencode/plugin/promise/command';
import type { DesktopHost } from './desktop-client.ts';
import { fingerprint } from './fingerprint.ts';
import { canRestore } from './restore-storage.ts';
import {
  ArchiveID,
  SessionID,
  type ArchiveStorage,
  type RestoreMapping,
} from './schema.ts';
import { SessionArchive } from './service.ts';

export function desktopCommands(
  connect: () => Promise<DesktopHost>,
  storage: ArchiveStorage,
  scope: { projectID: string; directory: string },
  signal: AbortSignal,
  restoreMappings: RestoreMapping[] = [],
): CommandDefinition[] {
  const projectID = scope.projectID;
  let running = false;

  function command(
    name: string,
    description: string,
    run: (
      host: DesktopHost,
      sessionID: string,
      argument: string,
    ) => Promise<void>,
  ): CommandDefinition {
    return {
      name,
      description,
      async execute({ sessionID, prompt, delivery }) {
        if (running)
          throw new Error(
            'Another archive or restore operation is in progress.',
          );
        running = true;
        try {
          signal.throwIfAborted();
          if (delivery === 'queue')
            throw new Error(
              'Session archive commands run immediately and cannot be queued.',
            );
          if (
            prompt.files?.length ||
            prompt.agents?.length ||
            prompt.skills?.length
          )
            throw new Error(
              'Session archive commands do not accept attachments or mentions.',
            );
          const host = await connect();
          const session = await host.sessions.get(sessionID);
          if (session.projectID !== projectID)
            throw new Error(
              'The command belongs to another project. Nothing was changed.',
            );
          await run(host, sessionID, prompt.text.trim());
        } finally {
          running = false;
        }
      },
    };
  }

  async function restore(
    host: DesktopHost,
    sessionID: string,
    argument: string,
  ): Promise<void> {
    let id = argument;
    if (id && !ArchiveID.safeParse(id).success)
      throw new Error('Use /session-restore [archiveUUID].');
    if (!id) {
      const archives = await storage.list();
      if (!archives.length) {
        await host.report(
          sessionID,
          'Session archives',
          'No session archives in this project.',
        );
        return;
      }
      const answer = await host.ask(
        sessionID,
        'Session archives — select to restore',
        [
          {
            key: 'archive',
            type: 'string',
            title: 'Archive',
            required: true,
            custom: true,
            options: archives.map((archive) => ({
              value: archive.id,
              label: archive.title,
              description: `${archive.sessionCount} session(s) · ${new Date(archive.createdAt).toLocaleString()} · ${archive.id}`,
            })),
          },
        ],
      );
      if (!answer) return;
      if (
        typeof answer.archive !== 'string' ||
        !archives.some((archive) => archive.id === answer.archive)
      )
        throw new Error(
          'Select an archive from this project. Nothing was restored.',
        );
      id = answer.archive;
    }
    const bundle = await storage.read(id);
    if (!canRestore(bundle, scope, restoreMappings))
      throw new Error(
        'The archive belongs to another project. Nothing was restored.',
      );
    signal.throwIfAborted();
    const result = await new SessionArchive(host.sessions, storage).restore(
      id,
      fingerprint(bundle),
      restoreMappings,
    );
    try {
      await host.report(
        sessionID,
        'Session tree restored',
        `${result.sessionIDs.length} session(s). Open ${result.rootSessionID} in the session list. Archive retained: ${id}`,
      );
    } catch {
      throw new Error(
        `The tree was restored, but the desktop result could not be shown. Open ${result.rootSessionID}; do not restore it again. Archive retained: ${id}`,
      );
    }
  }

  return [
    command(
      'session-archive',
      'Save and verify a session tree, then remove it from OpenCode',
      async (host, sessionID, argument) => {
        const target = argument || sessionID;
        if (!SessionID.safeParse(target).success)
          throw new Error('Use /session-archive [sessionID].');
        const service = new SessionArchive(host.sessions, storage);
        const preview = await service.preview(target);
        if (preview.projectID !== projectID)
          throw new Error(
            'The session belongs to another project. Nothing was deleted.',
          );
        signal.throwIfAborted();
        const saved = await service.archive(preview);
        // Native deletion removes cached data, but cannot navigate the desktop.
        // Never attach a result to a deleted session.
        if (!preview.sessionIDs.includes(sessionID)) {
          try {
            await host.report(
              sessionID,
              'Session tree archived',
              `${preview.sessionIDs.length} session(s). Archive: ${saved.id}\nServer file: ${saved.path}`,
            );
          } catch {
            throw new Error(
              `The tree was archived, but the desktop result could not be shown. Archive retained: ${saved.id}\nServer file: ${saved.path}`,
            );
          }
        }
      },
    ),
    command(
      'session-restore',
      'Restore an archive ID, or select an archive from this project',
      restore,
    ),
  ];
}
