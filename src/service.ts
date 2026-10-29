import type {
  SessionInfo,
  SessionMessageInfo,
  SessionTransferData,
} from '@opencode/client';
import { fingerprint } from './fingerprint.ts';
import type { SessionGateway } from './gateway.ts';
import {
  Bundle,
  RestoreMappings,
  type ArchiveBundle,
  type ArchiveStorage,
  type RestoreMapping,
  type RestoreLocation,
  type WorktreePlan,
} from './schema.ts';
import type { WorktreeGateway } from './worktrees.ts';

function locationsFor(transfers: SessionTransferData[]): RestoreLocation[] {
  return Array.from(
    new Map(
      transfers.map(({ info }) => {
        const location = {
          projectID: info.projectID,
          directory: info.location.directory,
        };
        return [JSON.stringify(location), location] as const;
      }),
    ).values(),
  );
}

function assertSettled(messages: SessionMessageInfo[]): void {
  for (const message of messages) {
    if (
      (message.type === 'assistant' &&
        (message.time.completed === undefined ||
          message.content.some(
            (part) =>
              part.type === 'tool' &&
              (part.state.status === 'running' ||
                part.state.status === 'streaming'),
          ))) ||
      (message.type === 'shell' && message.status === 'running') ||
      (message.type === 'compaction' && message.status === 'running')
    )
      throw new Error(
        'A session contains unfinished work. Wait for it to settle first.',
      );
  }
}

// Native transfer does not restore these fields. Do not silently discard them.
function assertRestorable(info: SessionInfo): void {
  if ('workspaceID' in info.location && info.location.workspaceID !== undefined)
    throw new Error('V2 HTTP import cannot restore workspace identity.');
  if (info.fork || info.revert) {
    throw new Error(
      'V2 import cannot restore fork or revert state. This session cannot be restored.',
    );
  }
}

export class SessionArchive {
  #working = false;
  readonly #sessions: SessionGateway;
  readonly #storage: ArchiveStorage;
  readonly #worktrees: WorktreeGateway | undefined;

  constructor(
    sessions: SessionGateway,
    storage: ArchiveStorage,
    worktrees?: WorktreeGateway,
  ) {
    this.#sessions = sessions;
    this.#storage = storage;
    this.#worktrees = worktrees;
  }

  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.#working)
      throw new Error('Another restore operation is in progress.');
    this.#working = true;
    try {
      return await run();
    } finally {
      this.#working = false;
    }
  }

  async #validateLocations(locations: RestoreLocation[]): Promise<void> {
    for (const location of locations) {
      const projectID = await this.#sessions
        .resolveProject(location.directory)
        .catch(() => {
          throw new Error(
            `The restore location ${location.directory} is unavailable. Nothing was imported; the archive is retained. Restore the directory or configure an explicit restore mapping before retrying.`,
          );
        });
      if (projectID !== location.projectID)
        throw new Error(
          `The restore location ${location.directory} belongs to another project. Nothing was imported; the archive is retained. Restore the project identity or configure an explicit restore mapping before retrying.`,
        );
    }
  }

  restore(
    id: string,
    expectedFingerprint?: string,
    restoreMappings: RestoreMapping[] = [],
  ): Promise<{
    rootSessionID: string;
    sessionIDs: string[];
    recovery?: { worktreeCount: number; dirty: boolean };
  }> {
    return this.#exclusive(async () => {
      const bundle: ArchiveBundle = Bundle.parse(await this.#storage.read(id));
      if (
        expectedFingerprint !== undefined &&
        fingerprint(bundle) !== expectedFingerprint
      ) {
        throw new Error(
          'The archive changed after inspection. Nothing was imported.',
        );
      }
      for (const transfer of bundle.sessions) {
        assertSettled(transfer.messages);
        assertRestorable(transfer.info);
      }
      const mappings = RestoreMappings.parse(restoreMappings);
      const transfers = bundle.sessions.map((transfer) => {
        const mapping = mappings.find(
          ({ from }) =>
            from.projectID === transfer.info.projectID &&
            from.directory === transfer.info.location.directory,
        );
        return mapping
          ? {
              ...transfer,
              info: {
                ...transfer.info,
                projectID: mapping.to.projectID,
                location: {
                  ...transfer.info.location,
                  directory: mapping.to.directory,
                },
              },
            }
          : transfer;
      });
      const existing = await this.#sessions.existing();
      if (bundle.sessions.some((session) => existing.has(session.info.id))) {
        throw new Error(
          'A session ID already exists. Nothing was imported; the archive is retained.',
        );
      }
      const parentID = bundle.sessions[0]?.info.parentID;
      if (parentID && !existing.has(parentID))
        throw new Error('Restore the archived session’s parent first.');
      const locations = locationsFor(transfers);
      let recovery: { worktreeCount: number; dirty: boolean } | undefined;
      if (this.#worktrees) {
        const missing = await this.#worktrees.missing(locations);
        await this.#validateLocations(
          locations.filter(
            (location) =>
              !missing.some(
                (target) =>
                  target.directory === location.directory &&
                  target.projectID === location.projectID,
              ),
          ),
        );
        const plans = new Map<string, WorktreePlan>();
        let dirty = false;
        for (const location of missing) {
          const saved =
            bundle.version === 2
              ? bundle.worktrees.find(
                  (snapshot) =>
                    snapshot.projectID === location.projectID &&
                    snapshot.directory === location.directory,
                )
              : undefined;
          if (!saved)
            throw new Error(
              `The archive lacks a recorded repository and commit for ${location.directory}. Nothing was imported; the archive is retained. Recreate the exact original directory or configure an explicit restore mapping before retrying.`,
            );
          dirty ||= saved.dirty;
          const plan = await this.#worktrees.prepare({
            ...location,
            repository: saved.repository,
            worktree: saved.worktree,
            ref: saved.commit,
          });
          const previous = plans.get(plan.worktree);
          if (
            previous &&
            (previous.commit !== plan.commit ||
              previous.repository !== plan.repository ||
              previous.projectID !== plan.projectID)
          )
            throw new Error(
              'Conflicting recorded recovery metadata for the same worktree. Nothing was imported; the archive is retained.',
            );
          plans.set(plan.worktree, plan);
        }
        if (plans.size) {
          const selected = Array.from(plans.values());
          // Check the archive again after preflight, before creating directories.
          if (fingerprint(await this.#storage.read(id)) !== fingerprint(bundle))
            throw new Error(
              'The archive changed after inspection. Nothing was imported.',
            );
          for (const plan of selected) await this.#worktrees.recreate(plan);
          recovery = { worktreeCount: selected.length, dirty };
        }
      }
      // Native import derives project identity from the location, not info.projectID.
      // Check the entire family before importing its root, including foreign projects.
      await this.#validateLocations(locations);
      let imported = 0;
      try {
        for (const transfer of transfers) {
          const { archived: _archived, ...time } = transfer.info.time;
          const restored = await this.#sessions.import({
            ...transfer,
            info: { ...transfer.info, time },
          });
          if (
            restored.id !== transfer.info.id ||
            restored.parentID !== transfer.info.parentID ||
            restored.projectID !== transfer.info.projectID ||
            fingerprint(restored.location) !==
              fingerprint(transfer.info.location)
          ) {
            throw new Error('The server restored a different session identity');
          }
          const messages = await this.#sessions.messages(restored.id);
          if (fingerprint(messages) !== fingerprint(transfer.messages))
            throw new Error('The restored transcript differs');
          imported++;
        }
      } catch {
        throw new Error(
          `Restore did not complete; ${imported} session(s) were verified. The archive is retained. Inspect existing IDs; do not delete them automatically.`,
        );
      }
      return {
        rootSessionID: bundle.rootSessionID,
        sessionIDs: bundle.sessions.map((session) => session.info.id),
        ...(recovery ? { recovery } : {}),
      };
    });
  }
}
