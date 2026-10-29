import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  SessionInfo,
  SessionMessageInfo,
  SessionTransferData,
} from '@opencode/client';
import type { SessionGateway } from '../src/gateway.ts';
import { fingerprint } from '../src/fingerprint.ts';
import type {
  ArchiveBundle,
  ArchiveStorage,
  ArchiveSummary,
  RestoreMapping,
  WorktreePlan,
  WorktreeSnapshot,
} from '../src/schema.ts';
import { SessionArchive } from '../src/service.ts';
import type { WorktreeGateway } from '../src/worktrees.ts';

const familyIDs = ['ses_root', 'ses_child', 'ses_grandchild'];

function transfer(id: string, parentID?: string): SessionTransferData {
  return {
    info: {
      id,
      ...(parentID ? { parentID } : {}),
      projectID: 'project-a',
      title: `Title ${id}`,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: {
        created: 1700000000000,
        updated: 1700000000001,
        archived: 1700000000002,
      },
      location: { directory: `/synthetic/${id}` },
      metadata: { private: 'č 🌱\n\u0000' },
    },
    messages: [
      {
        id: `msg_${id}user`,
        type: 'user',
        time: { created: 1700000000000 },
        text: `Private ${id}: č 🌱`,
      },
      {
        id: `msg_${id}idle`,
        type: 'idle',
        time: { created: 1700000000001 },
        outcome: 'succeeded',
      },
    ],
  };
}

class MemoryStorage implements ArchiveStorage {
  readonly bundles = new Map<string, ArchiveBundle>();

  async save(): Promise<{ id: string; path: string }> {
    assert.fail('Legacy restore must not create archives');
  }

  async read(id: string): Promise<ArchiveBundle> {
    const stored = this.bundles.get(id);
    assert(stored, `Missing archive ${id}`);
    return structuredClone(stored);
  }

  async list(): Promise<ArchiveSummary[]> {
    assert.fail('Legacy restore must read the selected archive directly');
  }
}

class StatefulSessions implements SessionGateway {
  readonly state = new Map<string, SessionTransferData>();
  readonly removes: string[] = [];
  readonly imports: SessionTransferData[] = [];
  readonly events: string[];
  readonly projects = new Map<string, string>([
    ['/synthetic/ses_root', 'project-a'],
    ['/synthetic/ses_child', 'project-a'],
    ['/synthetic/ses_grandchild', 'project-a'],
    ['/synthetic/non-git', 'global'],
  ]);
  readonly unavailableDirectories = new Set<string>();
  importFailureID: string | undefined;
  importedInfo: ((info: SessionInfo) => SessionInfo) | undefined;

  constructor(events: string[]) {
    this.events = events;
  }

  item(id: string): SessionTransferData {
    const item = this.state.get(id);
    assert(item, `Missing session ${id}`);
    return item;
  }

  async get(id: string): Promise<SessionInfo> {
    return structuredClone(this.item(id).info);
  }
  async resolveProject(directory: string): Promise<string> {
    if (this.unavailableDirectories.has(directory))
      throw new Error('The original directory is unavailable');
    const projectID = this.projects.get(directory);
    assert(projectID, 'The original project location is unavailable');
    return projectID;
  }
  async children(): Promise<SessionInfo[]> {
    assert.fail('Legacy restore must use the saved family');
  }
  async messages(id: string): Promise<SessionMessageInfo[]> {
    return structuredClone(this.item(id).messages);
  }
  async archived(): Promise<SessionInfo[]> {
    assert.fail('Legacy restore must not enumerate native archives');
  }
  async setArchived(): Promise<void> {
    assert.fail('Legacy restore must not update native archives');
  }
  async existing(): Promise<Set<string>> {
    return new Set(this.state.keys());
  }
  async remove(id: string): Promise<void> {
    this.removes.push(id);
    assert.fail('Legacy restore must not delete sessions');
  }

  async import(data: SessionTransferData): Promise<SessionInfo> {
    this.events.push(`import:${data.info.id}`);
    this.imports.push(structuredClone(data));
    if (data.info.id === this.importFailureID)
      throw new Error('Native import failed');
    assert(
      !this.state.has(data.info.id),
      'Native import cannot replace an existing ID',
    );
    if (data.info.parentID)
      assert(
        this.state.has(data.info.parentID),
        'Native import needs the parent first',
      );
    const restored = {
      ...data,
      info: this.importedInfo?.(data.info) ?? data.info,
    };
    this.state.set(restored.info.id, structuredClone(restored));
    return structuredClone(restored.info);
  }
}

function fixture(version: 1 | 2 = 1) {
  const events: string[] = [];
  const sessions = new StatefulSessions(events);
  const storage = new MemoryStorage();
  const bundle: ArchiveBundle = {
    format: 'opencode-session-archive',
    id: '7ea78c04-b799-43ed-92e9-aea32d5144b9',
    createdAt: 1700000000003,
    rootSessionID: 'ses_root',
    projectID: 'project-a',
    sessions: [
      transfer('ses_root'),
      transfer('ses_child', 'ses_root'),
      transfer('ses_grandchild', 'ses_child'),
    ],
    ...(version === 2 ? { version, worktrees: [] } : { version }),
  };
  storage.bundles.set(bundle.id, bundle);
  const service = new SessionArchive(sessions, storage);
  return { sessions, storage, service, events, bundle };
}

function onlyBundle(storage: MemoryStorage): ArchiveBundle {
  assert.equal(storage.bundles.size, 1);
  const bundle = storage.bundles.values().next().value;
  assert(bundle);
  return bundle;
}

test('restores saved families parent first with complete transcripts at original or mapped destinations', async (t) => {
  for (const mode of [
    'single project',
    'completed compaction',
    'legacy completed compaction',
    'cross-project descendants',
    'mapped descendant',
    'mapped root and descendant',
  ])
    await t.test(mode, async () => {
      const f = fixture(mode === 'completed compaction' ? 2 : 1);
      const original = f.bundle.sessions;
      if (mode.endsWith('compaction')) {
        const root = original[0];
        assert(root);
        const compaction = {
          id: 'msg_compaction',
          type: 'compaction' as const,
          time: { created: 1700000000001 },
          status: 'completed' as const,
          reason: 'auto' as const,
          summary: 'Preserved compacted context: č 🌱',
          ...(mode === 'legacy completed compaction'
            ? { recent: 'Preserved legacy recent context' }
            : {
                native: {
                  messages: [{ role: 'assistant', content: 'Replay context' }],
                },
              }),
        };
        root.messages.splice(1, 0, compaction);
      } else if (mode !== 'single project') {
        const child = original[1];
        const grandchild = original[2];
        assert(child && grandchild);
        child.info.projectID = 'project-b';
        grandchild.info.projectID = 'global';
        grandchild.info.location = {
          directory: '/synthetic/non-git',
        };
        f.sessions.projects.set(child.info.location.directory, 'project-b');
      }

      const mappings: RestoreMapping[] = [];
      const expectedTransfers = structuredClone(original);
      if (mode.startsWith('mapped')) {
        const child = expectedTransfers[1];
        assert(child);
        mappings.push({
          from: { projectID: 'project-b', directory: '/synthetic/ses_child' },
          to: {
            projectID: 'project-renamed',
            directory: '/synthetic/current-worktree',
          },
        });
        mappings.push({
          from: {
            projectID: 'project-renamed',
            directory: '/synthetic/current-worktree',
          },
          to: {
            projectID: 'project-chained',
            directory: '/synthetic/unavailable-chained-target',
          },
        });
        child.info.projectID = 'project-renamed';
        child.info.location.directory = '/synthetic/current-worktree';
        f.sessions.projects.set(
          '/synthetic/current-worktree',
          'project-renamed',
        );
        f.sessions.unavailableDirectories.add('/synthetic/ses_child');
      }
      if (mode === 'mapped root and descendant') {
        const root = expectedTransfers[0];
        assert(root);
        mappings.push({
          from: { projectID: 'project-a', directory: '/synthetic/ses_root' },
          to: {
            projectID: 'project-new-root',
            directory: '/synthetic/current-root',
          },
        });
        root.info.projectID = 'project-new-root';
        root.info.location.directory = '/synthetic/current-root';
        f.sessions.projects.set('/synthetic/current-root', 'project-new-root');
        f.sessions.unavailableDirectories.add('/synthetic/ses_root');
      }
      const archived = structuredClone(f.bundle);
      const restored = await f.service.restore(
        f.bundle.id,
        fingerprint(archived),
        mappings,
      );
      assert.deepEqual(restored, {
        rootSessionID: 'ses_root',
        sessionIDs: familyIDs,
      });
      assert.deepEqual(
        f.sessions.imports.map((item) => item.info.id),
        familyIDs,
      );
      for (const expected of expectedTransfers) {
        const actual = f.sessions.item(expected.info.id);
        const { archived: _archived, ...time } = expected.info.time;
        assert.deepEqual(actual, {
          ...expected,
          info: { ...expected.info, time },
        });
      }
      assert.deepEqual(onlyBundle(f.storage), archived);
    });
});

test('visible workspace identity prevents all restoration imports', async () => {
  const f = fixture();
  const child = f.bundle.sessions[1];
  assert(child);
  Object.assign(child.info.location, { workspaceID: 'wrk_fixture' });
  await assert.rejects(
    f.service.restore(f.bundle.id),
    /cannot restore workspace identity/,
  );
  assert.deepEqual(f.sessions.imports, []);
  assert.equal(f.sessions.state.size, 0);
  assert.equal(onlyBundle(f.storage).id, f.bundle.id);
});

test('a changed archive is rejected before importing any session', async () => {
  const f = fixture();
  const expectedFingerprint = fingerprint(f.bundle);
  const child = f.bundle.sessions[1];
  assert(child);
  child.messages = [];
  const changed = structuredClone(f.bundle);
  await assert.rejects(
    f.service.restore(f.bundle.id, expectedFingerprint),
    /archive changed after inspection.*Nothing was imported/,
  );
  assert.deepEqual(f.sessions.imports, []);
  assert.equal(f.sessions.state.size, 0);
  assert.deepEqual(onlyBundle(f.storage), changed);
});

const unsettled: Array<{ name: string; message: SessionMessageInfo }> = [
  {
    name: 'unfinished assistant',
    message: {
      id: 'msg_unfinished',
      type: 'assistant',
      agent: 'agent',
      model: { providerID: 'provider', id: 'model' },
      time: { created: 1700000000000 },
      content: [],
    },
  },
  ...(['running', 'streaming'] as const).map((status) => ({
    name: `${status} tool in a completed assistant`,
    message: {
      id: 'msg_tool',
      type: 'assistant' as const,
      agent: 'agent',
      model: { providerID: 'provider', id: 'model' },
      time: { created: 1700000000000, completed: 1700000000001 },
      content: [
        {
          type: 'tool' as const,
          id: 'tool_fixture',
          name: 'shell',
          time: { created: 1700000000000 },
          state:
            status === 'running'
              ? { status, input: {}, metadata: {} }
              : { status, input: '{' },
        },
      ],
    },
  })),
  {
    name: 'running shell',
    message: {
      id: 'msg_shell',
      type: 'shell',
      time: { created: 1700000000000 },
      shellID: 'sh_fixture',
      command: 'sleep 1',
      status: 'running',
    },
  },
  {
    name: 'running compaction',
    message: {
      id: 'msg_compaction',
      type: 'compaction',
      time: { created: 1700000000000 },
      status: 'running',
      reason: 'manual',
      summary: '',
    },
  },
];

test('unfinished archived work prevents every restoration import', async (t) => {
  for (const { name, message } of unsettled)
    await t.test(name, async () => {
      const f = fixture();
      const grandchild = f.bundle.sessions[2];
      assert(grandchild);
      grandchild.messages.push(message);
      const original = structuredClone(f.bundle);
      await assert.rejects(f.service.restore(f.bundle.id), /unfinished work/);
      assert.deepEqual(f.sessions.imports, []);
      assert.equal(f.sessions.state.size, 0);
      assert.deepEqual(onlyBundle(f.storage), original);
    });
});

test('restore checks every ID conflict and missing external parent before importing anything', async (t) => {
  for (const blocker of ['descendant ID conflict', 'missing external parent'])
    await t.test(blocker, async () => {
      const f = fixture();
      const grandchild = f.bundle.sessions[2];
      const root = f.bundle.sessions[0];
      assert(grandchild && root);
      grandchild.info.projectID = 'project-b';
      f.sessions.projects.set('/synthetic/ses_grandchild', 'project-b');
      if (blocker === 'missing external parent')
        root.info.parentID = 'ses_external';
      if (blocker === 'descendant ID conflict')
        f.sessions.state.set('ses_grandchild', transfer('ses_grandchild'));
      const before = structuredClone([...f.sessions.state.values()]);
      await assert.rejects(
        f.service.restore(f.bundle.id),
        blocker === 'descendant ID conflict'
          ? /already exists/
          : /parent first/,
      );
      assert.deepEqual(f.sessions.imports, []);
      assert.deepEqual([...f.sessions.state.values()], before);
      assert.deepEqual(f.sessions.removes, []);
      assert.equal(onlyBundle(f.storage).id, f.bundle.id);
    });
});

test('mapped restore refuses unexpected project or location reassignment and retains the archive and partial imports', async (t) => {
  const overrides: Array<{ name: string; info: Partial<SessionInfo> }> = [
    { name: 'project', info: { projectID: 'project-other' } },
    {
      name: 'directory',
      info: { location: { directory: '/synthetic/moved' } },
    },
    {
      name: 'workspace',
      info: {
        location: Object.assign(
          { directory: '/synthetic/current-worktree' },
          { workspaceID: 'wrk_other' },
        ),
      },
    },
  ];
  for (const row of overrides)
    await t.test(row.name, async () => {
      const f = fixture();
      const child = f.bundle.sessions[1];
      assert(child);
      child.info.projectID = 'project-b';
      f.sessions.projects.set('/synthetic/ses_child', 'project-b');
      f.sessions.projects.set('/synthetic/current-worktree', 'project-renamed');
      f.sessions.importedInfo = (info) =>
        info.id === 'ses_child' ? { ...info, ...row.info } : info;
      await assert.rejects(
        f.service.restore(f.bundle.id, undefined, [
          {
            from: { projectID: 'project-b', directory: '/synthetic/ses_child' },
            to: {
              projectID: 'project-renamed',
              directory: '/synthetic/current-worktree',
            },
          },
        ]),
        /1 session\(s\) were verified.*archive is retained/,
      );
      assert.deepEqual(
        new Set(f.sessions.state.keys()),
        new Set(['ses_root', 'ses_child']),
      );
      assert.equal(onlyBundle(f.storage).id, f.bundle.id);
      assert.deepEqual(f.sessions.removes, []);
    });
});

test('restore mappings require exact sources and validated destinations before any import', async (t) => {
  const cases = [
    { name: 'wrong source project', error: /unavailable/ },
    { name: 'source directory prefix', error: /unavailable/ },
    { name: 'wrong destination project', error: /another project/ },
    { name: 'missing destination', error: /unavailable/ },
    { name: 'duplicate source', error: /Duplicate restore mapping/ },
    { name: 'relative destination', error: /absolute server paths/ },
  ];
  for (const row of cases)
    await t.test(row.name, async () => {
      const f = fixture();
      const child = f.bundle.sessions[1];
      assert(child);
      child.info.projectID = 'project-b';
      const original = structuredClone(onlyBundle(f.storage));
      f.sessions.unavailableDirectories.add('/synthetic/ses_child');
      f.sessions.projects.set('/synthetic/current-worktree', 'project-renamed');
      const mapping: RestoreMapping = {
        from: { projectID: 'project-b', directory: '/synthetic/ses_child' },
        to: {
          projectID: 'project-renamed',
          directory: '/synthetic/current-worktree',
        },
      };
      const mappings = [mapping];
      switch (row.name) {
        case 'wrong source project':
          mapping.from.projectID = 'project-other';
          break;
        case 'source directory prefix':
          mapping.from.directory = '/synthetic';
          break;
        case 'wrong destination project':
          mapping.to.projectID = 'project-other';
          break;
        case 'missing destination':
          f.sessions.unavailableDirectories.add(mapping.to.directory);
          break;
        case 'duplicate source':
          mappings.push(structuredClone(mapping));
          break;
        case 'relative destination':
          mapping.to.directory = 'relative';
          break;
      }
      await assert.rejects(
        f.service.restore(f.bundle.id, undefined, mappings),
        row.error,
      );
      assert.equal(f.sessions.state.size, 0);
      assert.deepEqual(f.sessions.imports, []);
      assert.deepEqual(onlyBundle(f.storage), original);
    });
});

test('restore checks all original project locations before importing the root', async (t) => {
  for (const unavailable of [false, true])
    await t.test(
      unavailable
        ? 'missing descendant location'
        : 'changed descendant project',
      async () => {
        const f = fixture();
        const child = f.bundle.sessions[1];
        assert(child);
        child.info.projectID = 'project-b';
        f.sessions.projects.set('/synthetic/ses_child', 'project-b');
        if (unavailable)
          f.sessions.unavailableDirectories.add('/synthetic/ses_child');
        else f.sessions.projects.set('/synthetic/ses_child', 'project-other');
        await assert.rejects(
          f.service.restore(f.bundle.id),
          unavailable
            ? /location .*is unavailable.*Nothing was imported/
            : /another project.*Nothing was imported/,
        );
        assert.equal(f.sessions.state.size, 0);
        assert.deepEqual(f.sessions.imports, []);
        assert.equal(onlyBundle(f.storage).id, f.bundle.id);
      },
    );
});

test('partial native import failure keeps verified restored sessions and the archive for manual recovery', async () => {
  const f = fixture();
  f.sessions.importFailureID = 'ses_grandchild';
  await assert.rejects(
    f.service.restore(f.bundle.id),
    /2 session\(s\) were verified.*archive is retained/,
  );
  assert.deepEqual(
    f.sessions.imports.map((item) => item.info.id),
    familyIDs,
  );
  assert.deepEqual(
    new Set(f.sessions.state.keys()),
    new Set(['ses_root', 'ses_child']),
  );
  assert.deepEqual(
    f.sessions.item('ses_root').messages,
    transfer('ses_root').messages,
  );
  assert.deepEqual(
    f.sessions.item('ses_child').messages,
    transfer('ses_child', 'ses_root').messages,
  );
  assert.deepEqual(f.sessions.removes, []);
  assert.deepEqual(
    onlyBundle(f.storage).sessions.map((item) => item.info.id),
    familyIDs,
  );
});

function worktreeFixture() {
  const f = fixture(2);
  assert(f.bundle.version === 2);
  const snapshot: WorktreeSnapshot = {
    projectID: 'project-a',
    directory: '/synthetic/ses_child',
    worktree: '/synthetic/ses_child',
    repository: '/synthetic/repository',
    commit: 'a'.repeat(40),
    branch: 'feature',
    dirty: true,
  };
  const grandchild = f.bundle.sessions[2];
  assert(grandchild);
  grandchild.info.location.directory = `${snapshot.directory}/nested`;
  f.sessions.projects.set(`${snapshot.directory}/nested`, snapshot.projectID);
  f.bundle.worktrees = [
    snapshot,
    { ...snapshot, directory: `${snapshot.directory}/nested`, dirty: false },
  ];
  const recreated: WorktreePlan[] = [];
  const worktrees: WorktreeGateway = {
    capture: async () => assert.fail('Legacy restore must not capture worktrees'),
    missing: async (locations) =>
      locations.filter((location) =>
        [...f.sessions.unavailableDirectories].some(
          (directory) =>
            location.directory === directory ||
            location.directory.startsWith(`${directory}/`),
        ),
      ),
    prepare: async (request) => ({
      projectID: request.projectID,
      directory: request.directory,
      worktree: request.worktree,
      repository: request.repository,
      commit: request.ref,
    }),
    async recreate(plan) {
      f.events.push('recreate');
      recreated.push(plan);
      f.sessions.unavailableDirectories.delete(plan.worktree);
    },
  };
  return {
    ...f,
    service: new SessionArchive(f.sessions, f.storage, worktrees),
    snapshot,
    recreated,
  };
}

test('automatically restores a shared missing worktree at its recorded commit before importing parent first', async () => {
  const f = worktreeFixture();
  const original = structuredClone(onlyBundle(f.storage));
  f.sessions.unavailableDirectories.add(f.snapshot.directory);
  const result = await f.service.restore(f.bundle.id);
  assert.deepEqual(result, {
    rootSessionID: 'ses_root',
    sessionIDs: familyIDs,
    recovery: { worktreeCount: 1, dirty: true },
  });
  assert.deepEqual(f.recreated, [
    {
      projectID: f.snapshot.projectID,
      directory: `${f.snapshot.directory}/nested`,
      repository: f.snapshot.repository,
      worktree: f.snapshot.worktree,
      commit: f.snapshot.commit,
    },
  ]);
  assert.deepEqual(f.events, [
    'recreate',
    'import:ses_root',
    'import:ses_child',
    'import:ses_grandchild',
  ]);
  assert.deepEqual(onlyBundle(f.storage), original);
});

test('restore at existing worktrees does not report recovery even when the saved snapshot was dirty', async () => {
  const f = worktreeFixture();
  assert.deepEqual(await f.service.restore(f.bundle.id), {
    rootSessionID: 'ses_root',
    sessionIDs: familyIDs,
  });
  assert.deepEqual(f.recreated, []);
});

test('recovery preflights every recorded source and rejects conflicts before creating any worktree', async (t) => {
  for (const failure of [
    'invalid source',
    'conflicting commit',
    'changed archive',
  ])
    await t.test(failure, async () => {
      const f = worktreeFixture();
      const stored = onlyBundle(f.storage);
      assert(stored.version === 2);
      const grandchild = stored.sessions[2];
      assert(grandchild);
      grandchild.info.location.directory = '/synthetic/nested';
      stored.worktrees = [
        f.snapshot,
        {
          ...f.snapshot,
          directory: '/synthetic/nested',
          ...(failure === 'conflicting commit'
            ? { commit: 'b'.repeat(40) }
            : {}),
        },
      ];
      f.sessions.unavailableDirectories.add(f.snapshot.directory);
      f.sessions.unavailableDirectories.add('/synthetic/nested');
      const worktrees: WorktreeGateway = {
        capture: async () => [],
        missing: async (locations) =>
          locations.filter((location) =>
            f.sessions.unavailableDirectories.has(location.directory),
          ),
        async prepare(request) {
          if (request.directory === '/synthetic/nested') {
            if (failure === 'invalid source')
              throw new Error('The source repository is unavailable');
            if (failure === 'changed archive') stored.createdAt++;
          }
          return {
            projectID: request.projectID,
            directory: request.directory,
            worktree: request.worktree,
            repository: request.repository,
            commit: request.ref,
          };
        },
        recreate: async () =>
          assert.fail('Preflight must finish before recreation'),
      };
      await assert.rejects(
        new SessionArchive(f.sessions, f.storage, worktrees).restore(f.bundle.id),
        failure === 'invalid source'
          ? /source repository is unavailable/
          : failure === 'conflicting commit'
            ? /Conflicting recorded recovery metadata/
            : /archive changed after inspection/,
      );
      assert.deepEqual(f.sessions.imports, []);
      assert(f.storage.bundles.has(f.bundle.id));
    });
});

test('missing recorded metadata for any target prevents all recreation and imports', async (t) => {
  for (const mode of [
    'legacy',
    'missing descendant metadata',
    'mapped destination',
    'wrong metadata project',
    'directory prefix',
  ])
    await t.test(mode, async () => {
      const f = worktreeFixture();
      const stored = onlyBundle(f.storage);
      assert(stored.version === 2);
      const mappings: RestoreMapping[] = [];
      f.sessions.unavailableDirectories.add(f.snapshot.directory);
      if (mode === 'legacy') {
        const { worktrees: _worktrees, ...fields } = stored;
        f.storage.bundles.set(f.bundle.id, { ...fields, version: 1 });
      } else if (mode === 'missing descendant metadata') {
        const grandchild = stored.sessions[2];
        assert(grandchild);
        stored.worktrees = [f.snapshot];
        grandchild.info.location.directory = '/synthetic/unsaved';
        f.sessions.unavailableDirectories.add('/synthetic/unsaved');
      } else if (mode === 'mapped destination') {
        mappings.push({
          from: { projectID: 'project-a', directory: f.snapshot.directory },
          to: { projectID: 'project-a', directory: '/synthetic/mapped' },
        });
        f.sessions.unavailableDirectories.add('/synthetic/mapped');
      } else {
        const destination = {
          projectID:
            mode === 'wrong metadata project' ? 'project-other' : 'project-a',
          directory:
            mode === 'directory prefix'
              ? '/synthetic/ses_child/other'
              : f.snapshot.directory,
        };
        mappings.push({
          from: { projectID: 'project-a', directory: f.snapshot.directory },
          to: destination,
        });
        f.sessions.unavailableDirectories.add(destination.directory);
      }
      const original = structuredClone(onlyBundle(f.storage));
      await assert.rejects(
        f.service.restore(f.bundle.id, undefined, mappings),
        /archive lacks a recorded repository and commit.*Nothing was imported.*archive is retained.*exact original directory.*explicit restore mapping/,
      );
      assert.deepEqual(f.recreated, []);
      assert.deepEqual(f.sessions.imports, []);
      assert.deepEqual(onlyBundle(f.storage), original);
    });
});

test('an existing destination with the wrong project blocks recovery before filesystem changes', async () => {
  const f = worktreeFixture();
  f.sessions.unavailableDirectories.add(f.snapshot.directory);
  f.sessions.projects.set('/synthetic/ses_root', 'project-other');
  await assert.rejects(f.service.restore(f.bundle.id), /another project/);
  assert.deepEqual(f.recreated, []);
  assert.deepEqual(f.sessions.imports, []);
});
