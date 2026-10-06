import type { CommandDefinition } from '@opencode/plugin/promise/command';
import type { DesktopHost } from './desktop-client.ts';
import { fingerprint } from './fingerprint.ts';
import { ArchiveID, SessionID, type ArchiveStorage } from './schema.ts';
import { SessionArchive } from './service.ts';

const exclusiveUse =
  'Other clients and automations must not write to this session tree during this operation. The APIs provide no lock; a concurrent write can be lost.';

export function desktopCommands(
  connect: () => Promise<DesktopHost>,
  storage: ArchiveStorage,
  projectID: string,
  signal: AbortSignal,
): CommandDefinition[] {
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
      throw new Error('Use /session-unarchive [archiveUUID].');
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
    if (bundle.projectID !== projectID)
      throw new Error(
        'The archive belongs to another project. Nothing was restored.',
      );
    const root = bundle.sessions[0];
    if (!root)
      throw new Error(
        'The archive contains no root session. Nothing was restored.',
      );
    const answer = await host.ask(sessionID, 'Restore session tree?', [
      {
        key: 'exclusive',
        type: 'string',
        title: 'Restore session tree?',
        custom: true,
        required: true,
        options: [
          { value: 'restore', label: 'I have exclusive use; restore' },
          { value: 'cancel', label: 'Cancel' },
        ],
        description: [
          `Title: ${root.info.title ?? bundle.rootSessionID}`,
          `Root: ${bundle.rootSessionID}`,
          `Sessions: ${bundle.sessions.length}`,
          `Archive: ${bundle.id}`,
          `Original working directory: ${root.info.location.directory}`,
          'Restore original IDs and transcripts. Existing IDs are not overwritten. The archive is retained. Original working directories must remain available.',
          exclusiveUse,
        ].join('\n'),
      },
    ]);
    if (answer?.exclusive !== 'restore') return;
    signal.throwIfAborted();
    const result = await new SessionArchive(host.sessions, storage).restore(
      id,
      fingerprint(bundle),
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
      'Archive a session tree after preview and confirmation',
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
        const session = await host.sessions.get(target);
        const answer = await host.ask(sessionID, 'Archive session tree?', [
          {
            key: 'exclusive',
            type: 'string',
            title: 'Archive session tree?',
            custom: true,
            required: true,
            options: [
              { value: 'archive', label: 'I have exclusive use; archive' },
              { value: 'cancel', label: 'Cancel' },
            ],
            description: [
              `Title: ${preview.title}`,
              `Root: ${target}`,
              `Sessions: ${preview.sessionIDs.length} (selected session and all descendants)`,
              `Working directory: ${session.location.directory}`,
              'Save and verify a private archive, then recursively remove this session tree from OpenCode.',
              exclusiveUse,
              ...(preview.sessionIDs.includes(sessionID)
                ? [
                    'This also removes the open session. Afterward, open another session from the sidebar.',
                  ]
                : []),
            ].join('\n'),
          },
        ]);
        if (answer?.exclusive !== 'archive') return;
        signal.throwIfAborted();
        const saved = await service.archive(preview, true);
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
      'session-unarchive',
      'Restore a session archive after confirmation',
      restore,
    ),
    command(
      'session-archives',
      'Browse this project’s archives and select one to restore',
      async (host, sessionID, argument) => {
        if (argument)
          throw new Error('Use /session-archives without arguments.');
        await restore(host, sessionID, '');
      },
    ),
  ];
}
