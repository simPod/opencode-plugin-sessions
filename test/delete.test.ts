import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SessionInfo } from '@opencode/client';
import { SessionDelete } from '../src/delete.ts';
import type { SessionGateway } from '../src/gateway.ts';

function info(id: string, parentID?: string): SessionInfo {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    projectID: 'project-a',
    location: { directory: '/synthetic/project' },
    title: id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  };
}

function fixture() {
  const root = info('ses_root');
  const child = info('ses_child', root.id);
  const grandchild = info('ses_grandchild', child.id);
  const tree = [root, child, grandchild];
  const unexpected = () => assert.fail('Unexpected gateway operation for delete');
  const sessions: SessionGateway = {
    async get(id) {
      const session = tree.find((member) => member.id === id);
      assert(session);
      return structuredClone(session);
    },
    async children(id) {
      return structuredClone(tree.filter((member) => member.parentID === id));
    },
    resolveProject: unexpected,
    messages: unexpected,
    busy: unexpected,
    existing: unexpected,
    export: unexpected,
    archived: unexpected,
    setArchived: unexpected,
    remove: unexpected,
    import: unexpected,
  };
  return { root, grandchild, sessions, service: new SessionDelete(sessions) };
}

test('delete refuses changes to the captured tree identity before removing it', async (t) => {
  for (const change of ['project', 'parent', 'location', 'title'])
    await t.test(change, async () => {
      const { root, service } = fixture();
      const preview = await service.preview(root.id);
      if (change === 'project') root.projectID = 'project-b';
      else if (change === 'parent') root.parentID = 'ses_other';
      else if (change === 'location')
        root.location.directory = '/synthetic/moved';
      else root.title = 'Renamed';

      await assert.rejects(service.remove(preview), /family changed/);
    });
});

test('delete reports a failed removal, a surviving descendant or an unavailable verification read', async (t) => {
  for (const failure of ['remove', 'remaining descendant', 'verification'])
    await t.test(failure, async () => {
      const { root, grandchild, sessions, service } = fixture();
      const requests: string[] = [];
      sessions.remove = async (id) => {
        requests.push(`remove:${id}`);
        if (failure === 'remove') throw new Error('Disconnected');
      };
      sessions.existing = async () => {
        requests.push('existing');
        if (failure === 'verification') throw new Error('Disconnected');
        return new Set([grandchild.id]);
      };
      const preview = await service.preview(root.id);

      await assert.rejects(
        service.remove(preview),
        failure === 'remove'
          ? /Deletion did not complete\. No backup was created/
          : /Deletion could not be verified\. No backup was created/,
      );
      assert.deepEqual(
        requests,
        failure === 'remove'
          ? [`remove:${root.id}`]
          : [`remove:${root.id}`, 'existing'],
      );
    });
});
