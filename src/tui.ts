import type { LocationRef } from '@opencode/client';
import { Plugin } from '@opencode/plugin/tui';
import { fingerprint } from './fingerprint.ts';
import { gateway } from './gateway.ts';
import { Archives } from './rpc.ts';
import { ArchiveID, SessionID, type ArchiveStorage } from './schema.ts';
import { SessionArchive } from './service.ts';

export default Plugin.define({
  id: 'simpod-session-archive-tui',
  setup(context) {
    const rpc = context.client.rpc(Archives);
    // Include preview and confirmation in the guard. Never queue destructive UI actions.
    let running = false;

    async function operate(run: () => Promise<void>): Promise<void> {
      if (running) {
        context.ui.toast.show({
          message: 'Another archive or restore operation is in progress.',
          variant: 'warning',
        });
        return;
      }
      running = true;
      try {
        await run();
      } catch (error) {
        context.ui.toast.show({
          title: 'Session archive',
          message:
            error instanceof Error
              ? error.message
              : 'The archive operation failed.',
          variant: 'error',
        });
      } finally {
        running = false;
      }
    }

    async function scoped(location: LocationRef) {
      const scope = await context.client.location.get({ location });
      const storage: ArchiveStorage = {
        list: () => rpc.list({}, { location }),
        read: async (id) => {
          const bundle = await rpc.read({ id }, { location });
          if (bundle.projectID !== scope.project.id) {
            throw new Error(
              'The archive belongs to another project. Nothing was changed.',
            );
          }
          return bundle;
        },
        save: (bundle) => {
          if (bundle.projectID !== scope.project.id) {
            throw new Error(
              'The session belongs to another project. Nothing was deleted.',
            );
          }
          return rpc.save({ bundle }, { location });
        },
      };
      return {
        storage,
        projectID: scope.project.id,
        service: new SessionArchive(gateway(context.client), storage),
      };
    }

    async function archive(input?: string): Promise<void> {
      // V2 slash arguments contain the raw remainder, not the command name.
      const argument = input?.trim();
      const route = context.ui.router.current();
      const sessionID =
        argument || (route.type === 'session' ? route.sessionID : undefined);
      if (!sessionID || !SessionID.safeParse(sessionID).success) {
        throw new Error(
          'Use /session-archive [sessionID], or open a session first.',
        );
      }
      // Do not use the TUI's default project or its possibly stale session cache here.
      const session = await context.client.session.get({ sessionID });
      const { service, projectID } = await scoped(session.location);
      const preview = await service.preview(sessionID);
      if (preview.projectID !== projectID) {
        throw new Error(
          'The session location does not match its project. Nothing was deleted.',
        );
      }
      const confirmed = await context.ui.dialog.confirm({
        title: 'Archive session tree?',
        message: [
          `Title: ${preview.title}`,
          `Root: ${preview.rootSessionID}`,
          `Sessions: ${preview.sessionIDs.length} (selected session and all descendants)`,
          `Working directory: ${context.ui.format.path(session.location.directory)}`,
          '',
          'Save and verify a private archive, then recursively remove this session tree from OpenCode.',
          'The APIs provide no lock. Other clients and automations must not write to this tree during the operation.',
          'Continue only if you have exclusive use of the entire session tree.',
        ].join('\n'),
        label: { confirm: 'I have exclusive use; archive', cancel: 'Cancel' },
      });
      if (confirmed !== true) return;

      const before = context.ui.router.current();
      const viewingTree =
        before.type === 'session' &&
        preview.sessionIDs.includes(before.sessionID);
      const saved = await service.archive(preview, true);
      // Native session.deleted events remove cached sessions and may already close tabs.
      // Navigate before our tab cleanup so it cannot focus another deleted tree member.
      const current = context.ui.router.current();
      if (
        viewingTree ||
        (current.type === 'session' &&
          preview.sessionIDs.includes(current.sessionID))
      ) {
        context.ui.router.navigate({ type: 'home' });
      }
      if (context.ui.tabs.enabled()) {
        const deleted = new Set(preview.sessionIDs);
        for (const tab of context.ui.tabs.list()) {
          if (deleted.has(tab.sessionID)) context.ui.tabs.close(tab.sessionID);
        }
      }
      context.ui.toast.show({
        title: 'Session tree archived',
        message: `${preview.sessionIDs.length} session(s). Archive: ${saved.id}\nServer file: ${saved.path}`,
        variant: 'success',
      });
    }

    async function unarchive(input?: string): Promise<void> {
      const route = context.ui.router.current();
      const location =
        route.type === 'session'
          ? (await context.client.session.get({ sessionID: route.sessionID }))
              .location
          : (context.location ?? context.data.location.default());
      const argument = input?.trim();
      if (argument && !ArchiveID.safeParse(argument).success) {
        throw new Error('Use /session-unarchive [archiveUUID].');
      }
      const { storage, service } = await scoped(location);
      let id = argument;
      if (!id) {
        const archives = await storage.list();
        if (archives.length === 0) {
          context.ui.toast.show({
            message: 'No session archives in this project.',
            variant: 'info',
          });
          return;
        }
        id = await context.ui.dialog.select({
          title: 'Session archives — select to restore',
          placeholder: 'Search archived session titles',
          options: archives.map((archive) => ({
            title: archive.title,
            value: archive.id,
            description: `${archive.sessionCount} session(s) · ${new Date(archive.createdAt).toLocaleString()}`,
            footer: `Archive: ${archive.id} · Root: ${archive.rootSessionID}`,
          })),
        });
        if (!id) return;
      }

      const bundle = await storage.read(id);
      const root = bundle.sessions[0];
      if (!root)
        throw new Error(
          'The archive contains no root session. Nothing was restored.',
        );
      const confirmed = await context.ui.dialog.confirm({
        title: 'Restore session tree?',
        message: [
          `Title: ${root.info.title ?? bundle.rootSessionID}`,
          `Root: ${bundle.rootSessionID}`,
          `Sessions: ${bundle.sessions.length}`,
          `Archived: ${new Date(bundle.createdAt).toLocaleString()}`,
          `Archive: ${bundle.id}`,
          `Original working directory: ${context.ui.format.path(root.info.location.directory)}`,
          '',
          'Restore the original session IDs and transcripts. The archive file will be retained.',
          'Existing session IDs are not overwritten. The original working directories must remain available on the connected server.',
          'The APIs provide no lock. Other clients and automations must not write to this tree during the operation.',
          'Continue only if you have exclusive use of the entire session tree.',
        ].join('\n'),
        label: { confirm: 'I have exclusive use; restore', cancel: 'Cancel' },
      });
      if (confirmed !== true) return;

      const restored = await service.restore(id, fingerprint(bundle));
      for (const sessionID of restored.sessionIDs)
        context.data.session.invalidate(sessionID);
      try {
        await Promise.all(
          restored.sessionIDs.map((sessionID) =>
            context.data.session.sync(sessionID),
          ),
        );
      } catch {
        throw new Error(
          `The tree was restored, but the TUI could not refresh it. Reopen ${restored.rootSessionID}; do not restore it again.`,
        );
      }
      context.ui.tabs.open(restored.rootSessionID);
      context.ui.router.navigate({
        type: 'session',
        sessionID: restored.rootSessionID,
      });
      context.ui.toast.show({
        title: 'Session tree restored',
        message: `${restored.sessionIDs.length} session(s). The archive file is retained.`,
        variant: 'success',
      });
    }

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'simpod.session-archive.archive',
          title: 'Archive session tree',
          description:
            'Archive the current session or a session ID, including descendants',
          group: 'Session archives',
          palette: true,
          slash: { name: 'session-archive', arguments: true },
          run: (input) => operate(() => archive(input)),
        },
        {
          id: 'simpod.session-archive.unarchive',
          title: 'Restore session archive',
          description:
            'Restore an archive UUID, or select an archive in the current project',
          group: 'Session archives',
          palette: true,
          slash: { name: 'session-unarchive', arguments: true },
          run: (input) => operate(() => unarchive(input)),
        },
        {
          id: 'simpod.session-archive.list',
          title: 'List session archives',
          description:
            'List project archives and select one to confirm restoration',
          group: 'Session archives',
          palette: true,
          slash: { name: 'session-archives', arguments: true },
          run: (input) =>
            operate(async () => {
              if (input?.trim())
                throw new Error('Use /session-archives without arguments.');
              await unarchive();
            }),
        },
      ],
    }));
  },
});
