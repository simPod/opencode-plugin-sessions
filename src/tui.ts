import type { LocationRef } from '@opencode/client';
import { Plugin } from '@opencode/plugin/tui';
import { SessionDelete } from './delete.ts';
import { fingerprint } from './fingerprint.ts';
import { gateway } from './gateway.ts';
import { NativeSessionArchive, restoreArchives } from './native-archive.ts';
import { Archives } from './rpc.ts';
import { canRestore } from './restore-storage.ts';
import {
  RestorePickerArchives,
  RestorePickerResult,
  restorePickerMetadataKey,
  restorePickerOptions,
  restoreResultMetadataKey,
} from './restore-picker.ts';
import { ArchiveID, SessionID, type ArchiveStorage } from './schema.ts';
import { SessionArchive } from './service.ts';
import { restoreRecoveryMessage } from './worktree-recovery.ts';
import type { WorktreeGateway } from './worktrees.ts';

export default Plugin.define({
  id: 'simpod-sessions-tui',
  setup(context) {
    const rpc = context.client.rpc(Archives);
    const lifetime = new AbortController();
    // Include archive selection in the guard. Never queue destructive UI actions.
    let running = false;

    async function operate(run: () => Promise<void>): Promise<void> {
      if (running) {
        context.ui.toast.show({
          message: 'Another session operation is in progress.',
          variant: 'warning',
        });
        return;
      }
      running = true;
      try {
        await run();
      } catch (error) {
        context.ui.toast.show({
          title: 'Session operation',
          message:
            error instanceof Error
              ? error.message
              : 'The session operation failed.',
          variant: 'error',
        });
      } finally {
        running = false;
      }
    }

    async function scoped(
      location: LocationRef,
      archive?: { id: string; fingerprint: string },
    ) {
      const scope = await context.client.location.get({ location });
      const restoreMappings = await rpc.restoreMappings({}, { location });
      const storage: ArchiveStorage = {
        list: (sessionID) => rpc.list(sessionID ? { sessionID } : {}, { location }),
        read: async (id) => {
          const bundle = await rpc.read({ id }, { location });
          if (
            !canRestore(
              bundle,
              { projectID: scope.project.id, directory: location.directory },
              restoreMappings,
            )
          ) {
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
      const worktrees: WorktreeGateway = {
        capture: (locations) =>
          rpc.worktreeCapture({ locations }, { location }),
        missing: (locations) =>
          rpc.worktreeMissing({ locations }, { location }),
        prepare: (request) => {
          if (!archive)
            throw new Error('Select an archive before recreating worktrees.');
          return rpc.worktreePrepare({ archive, request }, { location });
        },
        async recreate(plan) {
          if (!archive)
            throw new Error('Select an archive before recreating worktrees.');
          await rpc.worktreeRecreate({ archive, plan }, { location });
        },
      };
      return {
        storage,
        projectID: scope.project.id,
        service: new SessionArchive(
          gateway(context.client),
          storage,
          worktrees,
        ),
        restoreMappings,
      };
    }

    async function archive(input?: string): Promise<void> {
      const argument = input?.trim();
      const route = context.ui.router.current();
      const sessionID =
        argument || (route.type === 'session' ? route.sessionID : undefined);
      if (!sessionID || !SessionID.safeParse(sessionID).success) {
        throw new Error(
          'Open a session or provide a valid session ID to archive.',
        );
      }
      // Do not use the TUI's default project or its possibly stale session cache here.
      const session = await context.client.session.get({ sessionID });
      const projectID = (
        await context.client.location.get({ location: session.location })
      ).project.id;
      const service = new NativeSessionArchive(
        gateway(context.client, lifetime.signal),
      );
      const preview = await service.preview(sessionID);
      if (preview.projectID !== projectID) {
        throw new Error(
          'The session location does not match its project. Nothing was changed.',
        );
      }
      const before = context.ui.router.current();
      const viewingTree =
        before.type === 'session' &&
        preview.sessionIDs.includes(before.sessionID);
      lifetime.signal.throwIfAborted();
      await service.archive(preview);
      leaveTree(preview.sessionIDs, viewingTree);
      context.ui.toast.show({
        title: 'Session tree archived',
        message: `${preview.sessionIDs.length} session(s) archived natively. Restore with /session-restore ${sessionID}.`,
        variant: 'success',
      });
    }

    function leaveTree(sessionIDs: string[], viewingTree: boolean): void {
      // Navigate before tab cleanup so it cannot focus another removed tree member.
      const current = context.ui.router.current();
      if (
        viewingTree ||
        (current.type === 'session' && sessionIDs.includes(current.sessionID))
      ) {
        context.ui.router.navigate({ type: 'home' });
      }
      if (context.ui.tabs.enabled()) {
        const removed = new Set(sessionIDs);
        for (const tab of context.ui.tabs.list()) {
          if (removed.has(tab.sessionID)) context.ui.tabs.close(tab.sessionID);
        }
      }
    }

    async function remove(input?: string): Promise<void> {
      const route = context.ui.router.current();
      const sessionID =
        input?.trim() || (route.type === 'session' ? route.sessionID : undefined);
      if (!sessionID || !SessionID.safeParse(sessionID).success)
        throw new Error(
          'Use /session-delete [sessionID], or open a session first.',
        );
      const service = new SessionDelete(gateway(context.client, lifetime.signal));
      const preview = await service.preview(sessionID);
      lifetime.signal.throwIfAborted();
      const before = context.ui.router.current();
      const viewingTree =
        before.type === 'session' && preview.sessionIDs.includes(before.sessionID);
      await service.remove(preview);
      leaveTree(preview.sessionIDs, viewingTree);
      context.ui.toast.show({
        title: 'Session tree deleted',
        message: `${preview.sessionIDs.length} session(s) permanently deleted. No archive was saved.`,
        variant: 'success',
      });
    }

    async function restore(input?: string): Promise<void> {
      const route = context.ui.router.current();
      const location =
        route.type === 'session'
          ? (await context.client.session.get({ sessionID: route.sessionID }))
              .location
          : (context.location ?? context.data.location.default());
      const argument = input?.trim();
      const targetSessionID = SessionID.safeParse(argument).success
        ? argument
        : undefined;
      if (
        argument &&
        !targetSessionID &&
        !ArchiveID.safeParse(argument).success
      ) {
        throw new Error('Provide a session ID or archive UUID to restore.');
      }
      const { storage, restoreMappings, projectID } = await scoped(location);
      const native = new NativeSessionArchive(
        gateway(context.client, lifetime.signal),
      );
      const scope = { projectID, directory: location.directory };
      let id = targetSessionID ? undefined : argument;
      if (!id) {
        const archives = await restoreArchives(
          native,
          storage,
          scope,
          targetSessionID,
        );
        if (archives.length === 0) {
          context.ui.toast.show({
            message: targetSessionID
              ? `No session archives for ${targetSessionID} in this project.`
              : 'No session archives in this project.',
            variant: 'info',
          });
          return;
        }
        const single = archives.length === 1 ? archives[0] : undefined;
        if (targetSessionID && single) {
          id = single.id;
        } else {
          id = await context.ui.dialog.select(restorePickerOptions(archives));
          if (!id) return;
          if (!archives.some((archive) => archive.id === id))
            throw new Error(
              'Select an archive from this project. Nothing was restored.',
            );
        }
      }

      let restored: {
        rootSessionID: string;
        sessionIDs: string[];
        recovery?: { worktreeCount: number; dirty: boolean };
      };
      const isNative = SessionID.safeParse(id).success;
      lifetime.signal.throwIfAborted();
      if (isNative) {
        restored = await native.restore(id, scope, targetSessionID);
      } else {
        const bundle = await storage.read(id);
        if (
          targetSessionID &&
          !bundle.sessions.some((session) => session.info.id === targetSessionID)
        )
          throw new Error(
            `The archive does not contain ${targetSessionID}. Nothing was restored.`,
          );
        const { service } = await scoped(location, {
          id,
          fingerprint: fingerprint(bundle),
        });
        restored = await service.restore(
          id,
          fingerprint(bundle),
          restoreMappings,
        );
      }
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
        message: `${restored.sessionIDs.length} session(s). ${isNative ? 'Restored from the native archive.' : 'The archive file is retained.'}${restoreRecoveryMessage(restored.recovery)}`,
        variant: 'success',
      });
    }

    // Slash commands remain server-owned. Marked selection and result forms
    // get terminal presentation without running restoration a second time.
    const stopRestorePicker = context.data.on('form.created', (event) => {
      const form = event.data.form;
      const route = context.ui.router.current();
      if (route.type !== 'session' || route.sessionID !== form.sessionID)
        return;
      const location = event.location;
      const result = RestorePickerResult.safeParse(
        form.metadata?.[restoreResultMetadataKey],
      );
      if (result.success) {
        void (async () => {
          try {
            await context.data.session.form.reply(
              {
                sessionID: form.sessionID,
                formID: form.id,
                answer: { acknowledged: 'done' },
              },
              location,
            );
            for (const sessionID of result.data.sessionIDs)
              context.data.session.invalidate(sessionID);
            await Promise.all(
              result.data.sessionIDs.map((sessionID) =>
                context.data.session.sync(sessionID),
              ),
            );
            lifetime.signal.throwIfAborted();
            const current = context.ui.router.current();
            if (
              current.type === 'session' &&
              current.sessionID === form.sessionID
            ) {
              context.ui.tabs.open(result.data.rootSessionID);
              context.ui.router.navigate({
                type: 'session',
                sessionID: result.data.rootSessionID,
              });
            }
            context.ui.toast.show({
              title: 'Session tree restored',
              message: result.data.message,
              variant: 'success',
            });
          } catch {
            context.ui.toast.show({
              title: 'Session tree restored',
              message: `The tree was restored, but the TUI could not refresh it. Reopen ${result.data.rootSessionID}; do not restore it again.`,
              variant: 'warning',
            });
          }
        })();
        return;
      }
      const archives = RestorePickerArchives.safeParse(
        form.metadata?.[restorePickerMetadataKey],
      );
      if (!archives.success) return;
      void operate(async () => {
        const id = await context.ui.dialog.select(
          restorePickerOptions(archives.data),
        );
        lifetime.signal.throwIfAborted();
        const input = { sessionID: form.sessionID, formID: form.id };
        if (id === undefined) {
          await context.data.session.form.cancel(input, location);
        } else {
          await context.data.session.form.reply(
            { ...input, answer: { archive: id } },
            location,
          );
        }
      });
    });

    // The server owns slash entries in both clients. TUI entries are palette-only
    // because OpenCode combines both slash lists without deduplicating names.
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'simpod.session-archive.archive',
          title: 'Archive session tree',
          description:
            'Archive the current session or a session ID natively, including descendants',
          group: 'Session archives',
          palette: true,
          run: (input) => operate(() => archive(input)),
        },
        {
          id: 'simpod.session-archive.restore',
          title: 'Restore session archive',
          description:
            'Restore a native session archive or legacy file archive in the current project',
          group: 'Session archives',
          palette: true,
          run: (input) => operate(() => restore(input)),
        },
        {
          id: 'simpod.session-archive.delete',
          title: 'Delete session tree permanently',
          description:
            'Delete the current session or a session ID and its descendants without an archive',
          group: 'Session archives',
          palette: true,
          run: (input) => operate(() => remove(input)),
        },
      ],
    }));
    return () => {
      stopRestorePicker();
      lifetime.abort();
    };
  },
});
