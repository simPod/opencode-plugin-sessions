import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SessionInfo } from '@opencode/client';
import { NativeSessionArchive } from '../src/native-archive.ts';

function info(id: string, parentID?: string): SessionInfo {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    projectID: 'project-a',
    location: { directory: '/synthetic/project' },
    title: id,
    metadata: { retained: 'private state' },
    permissions: [{ action: 'shell', resource: '*', effect: 'deny' }],
    cost: 4,
    tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 5, write: 6 } },
    time: { created: 1, updated: 2 },
  };
}

function fixture() {
  const state = new Map([
    ['ses_grandchild', info('ses_grandchild', 'ses_child')],
    ['ses_root', info('ses_root')],
    ['ses_other', info('ses_other')],
    ['ses_child', { ...info('ses_child', 'ses_root'), projectID: 'project-b' }],
  ]);
  const updates: Array<{ id: string; archived: boolean }> = [];
  let failID: string | undefined;
  let ignoreID: string | undefined;
  const service = new NativeSessionArchive({
    async get(id) {
      const session = state.get(id);
      assert(session);
      return structuredClone(session);
    },
    async children(id) {
      return [...state.values()]
        .filter((session) => session.parentID === id)
        .map((session) => structuredClone(session));
    },
    async archived() {
      return [...state.values()]
        .filter((session) => session.time.archived !== undefined)
        .map((session) => structuredClone(session));
    },
    async setArchived(id, archived) {
      if (id === failID) throw new Error('Native update unavailable');
      const session = state.get(id);
      assert(session);
      updates.push({ id, archived });
      if (id === ignoreID) return;
      if (archived) session.time.archived = 100;
      else delete session.time.archived;
    },
  });
  return {
    service,
    state,
    updates,
    fail(id: string) {
      failID = id;
    },
    ignore(id: string) {
      ignoreID = id;
    },
  };
}

const scope = { projectID: 'project-a', directory: '/synthetic/project' };

test('native archive and descendant-ID restore preserve the entire current family without changing unrelated sessions', async () => {
  const f = fixture();
  const root = f.state.get('ses_root');
  const child = f.state.get('ses_child');
  assert(root && child);
  root.fork = {
    sessionID: 'ses_source',
    boundary: { type: 'through', messageID: 'msg_boundary' },
  };
  child.revert = { messageID: 'msg_reverted', snapshot: 'snapshot_retained' };
  const original = structuredClone(f.state);
  await f.service.archive(await f.service.preview('ses_root'));
  assert.deepEqual(f.updates, [
    { id: 'ses_grandchild', archived: true },
    { id: 'ses_child', archived: true },
    { id: 'ses_root', archived: true },
  ]);
  const choices = await f.service.list(scope, 'ses_grandchild');
  assert.deepEqual(choices, [
    {
      id: 'ses_root',
      rootSessionID: 'ses_root',
      title: 'ses_root',
      createdAt: 100,
      sessionCount: 3,
    },
  ]);
  const selected = choices[0];
  assert(selected);
  await f.service.restore(selected.id, scope, 'ses_grandchild');
  assert.deepEqual(f.updates.slice(3), [
    { id: 'ses_root', archived: false },
    { id: 'ses_child', archived: false },
    { id: 'ses_grandchild', archived: false },
  ]);
  assert.deepEqual(f.state, original);
});

test('native restore checks root project, global directory, and requested descendant before any update', async () => {
  const f = fixture();
  await f.service.archive(await f.service.preview('ses_root'));
  f.updates.length = 0;
  for (const [projectScope, target] of [
    [{ ...scope, projectID: 'project-b' }, undefined],
    [scope, 'ses_other'],
  ] as const) {
    await assert.rejects(
      f.service.restore('ses_root', projectScope, target),
      /not available/,
    );
    assert.deepEqual(f.updates, []);
  }
  const root = f.state.get('ses_root');
  assert(root);
  root.projectID = 'global';
  await assert.rejects(
    f.service.restore('ses_root', {
      projectID: 'global',
      directory: '/synthetic/other',
    }),
    /not available/,
  );
  assert.deepEqual(f.updates, []);
});

test('descendant lookup selects the target archived group or an archived ancestor for an unarchived target', async (t) => {
  for (const archivedTarget of [false, true])
    await t.test(
      archivedTarget ? 'separate inner archive' : 'unarchived child',
      async () => {
        const f = fixture();
        const root = f.state.get('ses_root');
        const grandchild = f.state.get('ses_grandchild');
        assert(root && grandchild);
        root.time.archived = 100;
        if (archivedTarget) grandchild.time.archived = 101;
        const target = archivedTarget ? 'ses_grandchild' : 'ses_child';
        const selected = archivedTarget ? 'ses_grandchild' : 'ses_root';
        assert.deepEqual(
          (await f.service.list(scope, target)).map((entry) => entry.id),
          [selected],
        );
        await f.service.restore(selected, scope, target);
        assert.equal(root.time.archived, archivedTarget ? 100 : undefined);
        assert.deepEqual(
          f.updates.map((update) => update.id),
          archivedTarget
            ? ['ses_grandchild']
            : ['ses_root', 'ses_child', 'ses_grandchild'],
        );
      },
    );
});

test('partial or unapplied native flags are not reported as complete and never reversed automatically', async (t) => {
  for (const mode of ['archive failure', 'restore failure', 'unapplied update'])
    await t.test(mode, async () => {
      const f = fixture();
      const restore = mode === 'restore failure';
      if (restore) await f.service.archive(await f.service.preview('ses_root'));
      f.updates.length = 0;
      if (mode === 'unapplied update') f.ignore('ses_child');
      else f.fail('ses_child');
      await assert.rejects(
        restore
          ? f.service.restore('ses_root', scope)
          : f.service.archive(await f.service.preview('ses_root')),
        /did not complete; 1 session\(s\) verified.*No sessions were deleted or imported/,
      );
      assert(f.updates.every((update) => update.archived === !restore));
      assert.equal(f.state.get('ses_grandchild')?.time.archived, 100);
      assert.equal(f.state.get('ses_root')?.time.archived, undefined);
      assert.equal(f.state.size, 4);
    });
});
