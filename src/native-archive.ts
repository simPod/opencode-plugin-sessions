import type { SessionInfo } from '@opencode/client';
import type { SessionGateway } from './gateway.ts';
import { SessionID, type ArchiveStorage, type RestoreSummary } from './schema.ts';

type NativeSessions = Pick<
  SessionGateway,
  'get' | 'children' | 'archived' | 'setArchived'
>;

interface NativeArchivePreview {
  rootSessionID: string;
  projectID: string;
  directory: string;
  sessionIDs: string[];
}

export class NativeSessionArchive {
  readonly #sessions: NativeSessions;

  constructor(sessions: NativeSessions) {
    this.#sessions = sessions;
  }

  async #preview(rootSessionID: string): Promise<NativeArchivePreview> {
    SessionID.parse(rootSessionID);
    const root = await this.#sessions.get(rootSessionID);
    const family = [root];
    const seen = new Set([rootSessionID]);
    for (const parent of family) {
      for (const child of await this.#sessions.children(parent.id)) {
        if (seen.has(child.id) || child.parentID !== parent.id)
          throw new Error('Invalid session hierarchy. Nothing was changed.');
        seen.add(child.id);
        family.push(child);
      }
    }
    return {
      rootSessionID,
      projectID: root.projectID,
      directory: root.location.directory,
      sessionIDs: family.map((session) => session.id),
    };
  }

  async #update(sessionIDs: string[], archived: boolean): Promise<void> {
    let completed = 0;
    try {
      for (const id of sessionIDs) {
        await this.#sessions.setArchived(id, archived);
        const session = await this.#sessions.get(id);
        if ((session.time.archived !== undefined) !== archived)
          throw new Error('The server did not apply the archive state.');
        completed++;
      }
    } catch {
      throw new Error(
        `Native ${archived ? 'archive' : 'restore'} did not complete; ${completed} session(s) verified. No sessions were deleted or imported. Inspect the session list before retrying.`,
      );
    }
  }

  async list(
    scope: { projectID: string; directory: string },
    targetSessionID?: string,
  ): Promise<RestoreSummary[]> {
    const archived = await this.#sessions.archived();
    const byID = new Map(archived.map((session) => [session.id, session]));
    const groups = new Map<string, SessionInfo[]>();
    for (const session of archived) {
      let root = session;
      const seen = new Set([root.id]);
      while (root.parentID) {
        const parent = byID.get(root.parentID);
        if (!parent) break;
        if (seen.has(parent.id))
          throw new Error('Invalid archived session hierarchy.');
        seen.add(parent.id);
        root = parent;
      }
      const family = groups.get(root.id) ?? [];
      family.push(session);
      groups.set(root.id, family);
    }
    const summaries: RestoreSummary[] = [];
    for (const [id, family] of groups) {
      const root = byID.get(id)!;
      if (
        root.projectID !== scope.projectID ||
        (scope.projectID === 'global' &&
          root.location.directory !== scope.directory)
      )
        continue;
      if (
        targetSessionID &&
        !family.some((session) => session.id === targetSessionID) &&
        (byID.has(targetSessionID) ||
          !(await this.#preview(id)).sessionIDs.includes(targetSessionID))
      )
        continue;
      summaries.push({
        id,
        rootSessionID: id,
        title: root.title ?? id,
        createdAt: root.time.archived!,
        sessionCount: family.length,
      });
    }
    return summaries;
  }

  async restore(
    rootSessionID: string,
    scope: { projectID: string; directory: string },
    targetSessionID?: string,
  ): Promise<{ rootSessionID: string; sessionIDs: string[] }> {
    const eligible = await this.list(scope, targetSessionID);
    if (!eligible.some((session) => session.id === rootSessionID))
      throw new Error(
        'The archived session is not available in this project. Nothing was restored.',
      );
    const preview = await this.#preview(rootSessionID);
    await this.#update(preview.sessionIDs, false);
    return { rootSessionID, sessionIDs: preview.sessionIDs };
  }
}

export async function restoreArchives(
  native: NativeSessionArchive,
  storage: ArchiveStorage,
  scope: { projectID: string; directory: string },
  targetSessionID?: string,
): Promise<RestoreSummary[]> {
  const [sessions, files] = await Promise.all([
    native.list(scope, targetSessionID),
    storage.list(targetSessionID),
  ]);
  return [...sessions, ...files].sort(
    (left, right) => right.createdAt - left.createdAt,
  );
}
