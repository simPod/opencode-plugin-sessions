import { fingerprint } from './fingerprint.ts';
import type { SessionGateway } from './gateway.ts';
import { SessionID } from './schema.ts';

export interface DeletePreview {
  rootSessionID: string;
  projectID: string;
  sessionIDs: string[];
  fingerprint: string;
}

export class SessionDelete {
  readonly #sessions: SessionGateway;

  constructor(sessions: SessionGateway) {
    this.#sessions = sessions;
  }

  async preview(rootSessionID: string): Promise<DeletePreview> {
    SessionID.parse(rootSessionID);
    const root = await this.#sessions.get(rootSessionID);
    const family = [root];
    const seen = new Set([rootSessionID]);
    for (const parent of family) {
      const children = await this.#sessions.children(parent.id);
      children.sort((left, right) => left.id.localeCompare(right.id));
      for (const child of children) {
        if (seen.has(child.id) || child.parentID !== parent.id)
          throw new Error(
            'The session hierarchy changed or contains duplicate descendants.',
          );
        seen.add(child.id);
        family.push(child);
      }
    }
    return {
      rootSessionID,
      projectID: root.projectID,
      sessionIDs: family.map((session) => session.id),
      // Deletion does not preserve transcripts. Recheck tree identity rather
      // than blocking deletion when active work changes the transcript.
      fingerprint: fingerprint(
        family.map(({ id, parentID, projectID, location, title }) => ({
          id,
          parentID,
          projectID,
          location,
          title,
        })),
      ),
    };
  }

  async remove(preview: DeletePreview): Promise<void> {
    const fresh = await this.preview(preview.rootSessionID);
    if (fresh.fingerprint !== preview.fingerprint)
      throw new Error(
        'The session family changed after preview. Nothing was deleted.',
      );
    try {
      await this.#sessions.remove(preview.rootSessionID);
    } catch {
      throw new Error(
        'Deletion did not complete. No backup was created. Inspect the session list before retrying.',
      );
    }
    try {
      const existing = await this.#sessions.existing();
      if (preview.sessionIDs.some((id) => existing.has(id)))
        throw new Error('Some sessions still exist');
    } catch {
      throw new Error(
        'Deletion could not be verified. No backup was created. Inspect the session list before retrying.',
      );
    }
  }
}
