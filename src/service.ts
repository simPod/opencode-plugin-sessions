import { randomUUID } from 'node:crypto';
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
  SessionID,
  type ArchiveBundle,
  type ArchiveStorage,
  type RestoreMapping,
} from './schema.ts';

export interface ArchivePreview {
  rootSessionID: string;
  title: string;
  sessionIDs: string[];
  projectID: string;
  fingerprint: string;
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
      'V2 import cannot restore fork or revert state. This session cannot be archived.',
    );
  }
}

export class SessionArchive {
  #working = false;
  readonly #sessions: SessionGateway;
  readonly #storage: ArchiveStorage;

  constructor(sessions: SessionGateway, storage: ArchiveStorage) {
    this.#sessions = sessions;
    this.#storage = storage;
  }

  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.#working)
      throw new Error('Another archive or restore operation is in progress.');
    this.#working = true;
    try {
      return await run();
    } finally {
      this.#working = false;
    }
  }

  async #capture(rootID: string): Promise<SessionTransferData[]> {
    SessionID.parse(rootID);
    const root = await this.#sessions.get(rootID);
    const family: SessionInfo[] = [root];
    const seen = new Set([rootID]);
    for (let index = 0; index < family.length; index++) {
      const parent = family[index];
      if (!parent) throw new Error('Invalid session hierarchy');
      const children = await this.#sessions.children(parent.id);
      children.sort((left, right) => left.id.localeCompare(right.id));
      for (const child of children) {
        if (seen.has(child.id) || child.parentID !== parent.id) {
          throw new Error(
            'The session hierarchy changed or contains duplicate descendants.',
          );
        }
        seen.add(child.id);
        family.push(child);
      }
    }
    const transfers: SessionTransferData[] = [];
    for (const session of family) {
      assertRestorable(session);
      if (await this.#sessions.busy(session.id))
        throw new Error('A session is running or has queued work.');
      const messages = await this.#sessions.messages(session.id);
      assertSettled(messages);
      const transfer = await this.#sessions.export(session.id);
      if (
        transfer.info.id !== session.id ||
        transfer.info.parentID !== session.parentID ||
        transfer.info.projectID !== session.projectID ||
        fingerprint(transfer.info.location) !== fingerprint(session.location) ||
        fingerprint(messages) !== fingerprint(transfer.messages)
      ) {
        throw new Error(
          'The transcript changed or export omitted messages. Nothing was deleted.',
        );
      }
      assertRestorable(transfer.info);
      if (await this.#sessions.busy(session.id))
        throw new Error('A session started work during export.');
      transfers.push(transfer);
    }
    return transfers;
  }

  async preview(rootID: string): Promise<ArchivePreview> {
    const transfers = await this.#capture(rootID);
    const root = transfers[0];
    if (!root) throw new Error('The server returned no session');
    return {
      rootSessionID: rootID,
      title: root.info.title ?? rootID,
      projectID: root.info.projectID,
      sessionIDs: transfers.map((transfer) => transfer.info.id),
      fingerprint: fingerprint(transfers),
    };
  }

  archive(preview: ArchivePreview): Promise<{ id: string; path: string }> {
    return this.#exclusive(async () => {
      const transfers = await this.#capture(preview.rootSessionID);
      if (fingerprint(transfers) !== preview.fingerprint) {
        throw new Error(
          'The session family changed after preview. Nothing was deleted.',
        );
      }
      const bundle = Bundle.parse({
        format: 'opencode-session-archive',
        version: 1,
        id: randomUUID(),
        createdAt: Date.now(),
        rootSessionID: preview.rootSessionID,
        projectID: preview.projectID,
        sessions: transfers,
      });
      const saved = await this.#storage.save(bundle);
      const verified = await this.#storage.read(saved.id);
      if (
        saved.id !== bundle.id ||
        fingerprint(verified) !== fingerprint(bundle)
      ) {
        throw new Error(
          'The saved archive could not be verified. Nothing was deleted.',
        );
      }
      const fresh = await this.#capture(preview.rootSessionID);
      if (fingerprint(fresh) !== preview.fingerprint) {
        throw new Error(
          `The session family changed. Nothing was deleted. Backup retained: ${saved.id}`,
        );
      }
      try {
        await this.#sessions.remove(preview.rootSessionID);
      } catch {
        throw new Error(
          `Deletion did not complete. The verified backup is retained: ${saved.id}. Inspect existing IDs before restoring.`,
        );
      }
      try {
        const existing = await this.#sessions.existing();
        if (bundle.sessions.some((session) => existing.has(session.info.id))) {
          throw new Error('Some sessions still exist');
        }
      } catch {
        throw new Error(
          `Deletion could not be verified. The backup is retained: ${saved.id}. Inspect existing IDs before restoring.`,
        );
      }
      return saved;
    });
  }

  restore(
    id: string,
    expectedFingerprint?: string,
    restoreMappings: RestoreMapping[] = [],
  ): Promise<{ rootSessionID: string; sessionIDs: string[] }> {
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
      // Native import derives project identity from the location, not info.projectID.
      // Check the entire family before importing its root, including foreign projects.
      for (const transfer of transfers) {
        const projectID = await this.#sessions
          .resolveProject(transfer.info.location.directory)
          .catch(() => {
            throw new Error(
              `The restore location for ${transfer.info.id} is unavailable. Nothing was imported; the archive is retained. Restore the directory or configure an explicit restore mapping before retrying.`,
            );
          });
        if (projectID !== transfer.info.projectID)
          throw new Error(
            `The restore location for ${transfer.info.id} belongs to another project. Nothing was imported; the archive is retained. Restore the project identity or configure an explicit restore mapping before retrying.`,
          );
      }
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
      };
    });
  }
}
