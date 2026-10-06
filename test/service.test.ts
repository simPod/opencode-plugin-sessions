import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  SessionInfo,
  SessionMessageInfo,
  SessionTransferData,
} from '@opencode/client';
import type { SessionGateway } from '../src/gateway.ts';
import type {
  ArchiveBundle,
  ArchiveStorage,
  ArchiveSummary,
} from '../src/schema.ts';
import { SessionArchive } from '../src/service.ts';

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
  readonly events: string[];
  afterSave: (() => void) | undefined;
  saveFailure = false;
  readFailure = false;
  corruptRead = false;

  constructor(events: string[]) {
    this.events = events;
  }

  async save(bundle: ArchiveBundle) {
    this.events.push('save');
    if (this.saveFailure) throw new Error('Disk full');
    this.bundles.set(bundle.id, structuredClone(bundle));
    this.afterSave?.();
    return { id: bundle.id, path: `/memory/${bundle.id}.json` };
  }

  async read(id: string): Promise<ArchiveBundle> {
    this.events.push('read');
    if (this.readFailure) throw new Error('Disk read failed');
    const stored = this.bundles.get(id);
    assert(stored, `Missing archive ${id}`);
    const result = structuredClone(stored);
    if (this.corruptRead) {
      const root = result.sessions[0];
      assert(root);
      root.messages = [];
    }
    return result;
  }

  async list(): Promise<ArchiveSummary[]> {
    return [...this.bundles.values()].map((bundle) => ({
      id: bundle.id,
      rootSessionID: bundle.rootSessionID,
      title: bundle.sessions[0]?.info.title ?? bundle.rootSessionID,
      createdAt: bundle.createdAt,
      sessionCount: bundle.sessions.length,
    }));
  }
}

class StatefulSessions implements SessionGateway {
  readonly state = new Map<string, SessionTransferData>();
  readonly running = new Set<string>();
  readonly queued = new Set<string>();
  readonly omittedExports = new Set<string>();
  readonly removes: string[] = [];
  readonly imports: SessionTransferData[] = [];
  readonly events: string[];
  afterExport: ((id: string) => void) | undefined;
  beforeRemove: (() => Promise<void>) | undefined;
  deletion: 'recursive' | 'throw' | 'partial-throw' | 'incomplete' =
    'recursive';
  importFailureID: string | undefined;

  constructor(events: string[]) {
    this.events = events;
    // Server enumeration order does not supply parent-first ordering to the service.
    for (const item of [
      transfer('ses_grandchild', 'ses_child'),
      transfer('ses_child', 'ses_root'),
      transfer('ses_root'),
    ]) {
      this.state.set(item.info.id, item);
    }
  }

  item(id: string): SessionTransferData {
    const item = this.state.get(id);
    assert(item, `Missing session ${id}`);
    return item;
  }

  async get(id: string): Promise<SessionInfo> {
    return structuredClone(this.item(id).info);
  }
  async children(id: string): Promise<SessionInfo[]> {
    return [...this.state.values()]
      .filter((item) => item.info.parentID === id)
      .map((item) => structuredClone(item.info));
  }
  async messages(id: string): Promise<SessionMessageInfo[]> {
    return structuredClone(this.item(id).messages);
  }
  async busy(id: string): Promise<boolean> {
    return this.running.has(id) || this.queued.has(id);
  }
  async existing(): Promise<Set<string>> {
    return new Set(this.state.keys());
  }
  async export(id: string): Promise<SessionTransferData> {
    const item = structuredClone(this.item(id));
    if (this.omittedExports.has(id)) item.messages.pop();
    this.afterExport?.(id);
    return item;
  }

  async remove(id: string): Promise<void> {
    this.removes.push(id);
    this.events.push(`remove:${id}`);
    await this.beforeRemove?.();
    if (this.deletion === 'throw') throw new Error('Native delete failed');
    if (this.deletion === 'partial-throw') {
      this.state.delete(id);
      throw new Error('Native recursive delete stopped');
    }
    if (this.deletion === 'incomplete') {
      this.state.delete(id);
      this.state.delete('ses_child');
      return;
    }
    const pending = [id];
    for (let index = 0; index < pending.length; index++) {
      for (const item of this.state.values()) {
        if (item.info.parentID === pending[index]) pending.push(item.info.id);
      }
    }
    for (const member of pending) this.state.delete(member);
  }

  async import(data: SessionTransferData): Promise<SessionInfo> {
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
    this.state.set(data.info.id, structuredClone(data));
    return structuredClone(data.info);
  }
}

function fixture() {
  const events: string[] = [];
  const sessions = new StatefulSessions(events);
  const storage = new MemoryStorage(events);
  const service = new SessionArchive(sessions, storage);
  return { sessions, storage, service, events };
}

type Fixture = ReturnType<typeof fixture>;

function onlyBundle(storage: MemoryStorage): ArchiveBundle {
  assert.equal(storage.bundles.size, 1);
  const bundle = storage.bundles.values().next().value;
  assert(bundle);
  return bundle;
}

function assertNoDelete({ sessions }: Fixture) {
  assert.deepEqual(sessions.removes, []);
  assert.deepEqual(sessions.imports, []);
  assert.deepEqual(new Set(sessions.state.keys()), new Set(familyIDs));
}

test('archives the complete family before native recursive deletion and restores original IDs parent first', async () => {
  const f = fixture();
  const original = [
    transfer('ses_root'),
    transfer('ses_child', 'ses_root'),
    transfer('ses_grandchild', 'ses_child'),
  ];
  const preview = await f.service.preview('ses_root');
  assert.equal(preview.title, 'Title ses_root');
  assert.equal(preview.rootSessionID, 'ses_root');
  assert.equal(preview.projectID, 'project-a');
  assert.deepEqual(preview.sessionIDs, familyIDs);
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
  f.sessions.beforeRemove = async () => {
    const bundle = onlyBundle(f.storage);
    assert.deepEqual(bundle.sessions, original);
    assert.deepEqual(await f.storage.read(bundle.id), bundle);
    assert.deepEqual(new Set(f.sessions.state.keys()), new Set(familyIDs));
  };

  const saved = await f.service.archive(preview);
  assert.deepEqual(f.events.slice(0, 3), ['save', 'read', 'remove:ses_root']);
  assert.deepEqual(f.sessions.removes, ['ses_root']);
  assert.equal(f.sessions.state.size, 0);

  const restored = await f.service.restore(saved.id);
  assert.deepEqual(restored, {
    rootSessionID: 'ses_root',
    sessionIDs: familyIDs,
  });
  assert.deepEqual(
    f.sessions.imports.map((item) => item.info.id),
    familyIDs,
  );
  for (const expected of original) {
    const actual = f.sessions.item(expected.info.id);
    const { archived: _archived, ...time } = expected.info.time;
    assert.deepEqual(actual, { ...expected, info: { ...expected.info, time } });
  }
  assert.deepEqual(onlyBundle(f.storage).sessions, original);
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
      shellID: 'shell_fixture',
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
      recent: '',
    },
  },
];

test('active, queued, unfinished, and export-omitted descendant work prevents archive writes and deletion', async (t) => {
  const cases: Array<{
    name: string;
    change: (f: Fixture) => void;
    error: RegExp;
  }> = [
    {
      name: 'running child',
      change: (f) => {
        f.sessions.running.add('ses_child');
      },
      error: /running or has queued work/,
    },
    {
      name: 'queued grandchild',
      change: (f) => {
        f.sessions.queued.add('ses_grandchild');
      },
      error: /running or has queued work/,
    },
    {
      name: 'starts during export',
      change: (f) => {
        f.sessions.afterExport = (id) => {
          if (id === 'ses_child') f.sessions.running.add(id);
        };
      },
      error: /started work during export/,
    },
    ...unsettled.map(({ name, message }) => ({
      name,
      change: (f: Fixture) => {
        f.sessions
          .item('ses_grandchild')
          .messages.push(structuredClone(message));
      },
      error: /unfinished work/,
    })),
    {
      name: 'export omits raw idle message',
      change: (f) => {
        f.sessions.omittedExports.add('ses_child');
      },
      error: /export omitted messages/,
    },
  ];
  for (const row of cases)
    await t.test(row.name, async () => {
      const f = fixture();
      const preview = await f.service.preview('ses_root');
      row.change(f);
      await assert.rejects(f.service.archive(preview), row.error);
      assert.equal(f.storage.bundles.size, 0);
      assertNoDelete(f);
    });
});

test('a title, transcript, or new descendant change invalidates the snapshot before or after backup save', async (t) => {
  const changes: Array<{ name: string; change: (f: Fixture) => void }> = [
    {
      name: 'title',
      change: (f) => {
        f.sessions.item('ses_child').info.title = 'Changed title';
      },
    },
    {
      name: 'transcript',
      change: (f) => {
        f.sessions.item('ses_grandchild').messages.push({
          id: 'msg_new',
          type: 'system',
          time: { created: 1700000000003 },
          text: 'New raw message',
        });
      },
    },
    {
      name: 'new child',
      change: (f) => {
        f.sessions.state.set(
          'ses_newchild',
          transfer('ses_newchild', 'ses_root'),
        );
      },
    },
  ];
  for (const timing of ['after preview', 'after save'] as const) {
    for (const row of changes)
      await t.test(`${row.name} ${timing}`, async () => {
        const f = fixture();
        const preview = await f.service.preview('ses_root');
        if (timing === 'after save') f.storage.afterSave = () => row.change(f);
        else row.change(f);
        await assert.rejects(
          f.service.archive(preview),
          /session family changed/,
        );
        assert.deepEqual(f.sessions.removes, []);
        assert.deepEqual(f.sessions.imports, []);
        assert.deepEqual(
          new Set(f.sessions.state.keys()),
          new Set(
            row.name === 'new child'
              ? [...familyIDs, 'ses_newchild']
              : familyIDs,
          ),
        );
        assert.equal(f.storage.bundles.size, timing === 'after save' ? 1 : 0);
        if (timing === 'after save')
          assert.deepEqual(onlyBundle(f.storage).sessions, [
            transfer('ses_root'),
            transfer('ses_child', 'ses_root'),
            transfer('ses_grandchild', 'ses_child'),
          ]);
      });
  }
});

test('save failure, unreadable backup, and corrupt read-back prevent native deletion', async (t) => {
  for (const fault of ['saveFailure', 'readFailure', 'corruptRead'] as const)
    await t.test(fault, async () => {
      const f = fixture();
      const preview = await f.service.preview('ses_root');
      f.storage[fault] = true;
      await assert.rejects(
        f.service.archive(preview),
        fault === 'saveFailure'
          ? /Disk full/
          : fault === 'readFailure'
            ? /Disk read failed/
            : /could not be verified/,
      );
      assertNoDelete(f);
      assert.equal(f.storage.bundles.size, fault === 'saveFailure' ? 0 : 1);
    });
});

test('native recursive deletion failure and incomplete deletion retain backup without automatic rollback', async (t) => {
  const cases = [
    { mode: 'throw', remaining: familyIDs, error: /Deletion did not complete/ },
    {
      mode: 'partial-throw',
      remaining: ['ses_child', 'ses_grandchild'],
      error: /Deletion did not complete/,
    },
    {
      mode: 'incomplete',
      remaining: ['ses_grandchild'],
      error: /Deletion could not be verified/,
    },
  ] as const;
  for (const row of cases)
    await t.test(row.mode, async () => {
      const f = fixture();
      const preview = await f.service.preview('ses_root');
      f.sessions.deletion = row.mode;
      await assert.rejects(f.service.archive(preview), row.error);
      assert.deepEqual(
        new Set(f.sessions.state.keys()),
        new Set(row.remaining),
      );
      assert.deepEqual(f.sessions.removes, ['ses_root']);
      assert.deepEqual(f.sessions.imports, []);
      assert.deepEqual(
        onlyBundle(f.storage).sessions.map((item) => item.info.id),
        familyIDs,
      );
    });
});

test('restore checks every ID conflict and missing external parent before importing anything', async (t) => {
  for (const blocker of ['descendant ID conflict', 'missing external parent'])
    await t.test(blocker, async () => {
      const f = fixture();
      if (blocker === 'missing external parent')
        f.sessions.item('ses_root').info.parentID = 'ses_external';
      const saved = await f.service.archive(
        await f.service.preview('ses_root'),
      );
      if (blocker === 'descendant ID conflict')
        f.sessions.state.set('ses_grandchild', transfer('ses_grandchild'));
      const before = structuredClone([...f.sessions.state.values()]);
      await assert.rejects(
        f.service.restore(saved.id),
        blocker === 'descendant ID conflict'
          ? /already exists/
          : /parent first/,
      );
      assert.deepEqual(f.sessions.imports, []);
      assert.deepEqual([...f.sessions.state.values()], before);
      assert.deepEqual(f.sessions.removes, ['ses_root']);
      assert.equal(onlyBundle(f.storage).id, saved.id);
    });
});

test('partial native import failure keeps verified restored sessions and the archive for manual recovery', async () => {
  const f = fixture();
  const saved = await f.service.archive(await f.service.preview('ses_root'));
  f.sessions.importFailureID = 'ses_grandchild';
  await assert.rejects(
    f.service.restore(saved.id),
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
  assert.deepEqual(f.sessions.removes, ['ses_root']);
  assert.deepEqual(
    onlyBundle(f.storage).sessions.map((item) => item.info.id),
    familyIDs,
  );
});
