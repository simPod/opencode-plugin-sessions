import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  FormAnswer,
  FormFields,
  FormMetadata,
  SessionTransferData,
} from '@opencode/client';
import { Session } from '@opencode/schema/session';
import type { DesktopHost } from '../src/desktop-client.ts';
import { desktopCommands } from '../src/desktop.ts';
import {
  Bundle,
  type ArchiveBundle,
  type ArchiveStorage,
  type RestoreMapping,
  type WorktreePlan,
  type WorktreeRequest,
  type WorktreeSnapshot,
} from '../src/schema.ts';
import type { WorktreeGateway } from '../src/worktrees.ts';

const archiveID = randomUUID();
function transfer(id: string, projectID = 'project-a'): SessionTransferData {
  return {
    info: {
      id,
      projectID,
      title: `Title ${id}`,
      location: { directory: '/synthetic/project' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 1, updated: 2 },
    },
    messages: [
      {
        id: `msg_${id}`,
        type: 'user',
        time: { created: 1 },
        text: `Private transcript ${id}: č 🌱`,
      },
    ],
  };
}

function fixture(
  restoreMappings: RestoreMapping[] = [],
  scope = { projectID: 'project-a', directory: '/synthetic/project' },
) {
  const state = new Map<string, SessionTransferData>([
    ['ses_owner', transfer('ses_owner')],
    ['ses_target', transfer('ses_target')],
  ]);
  const bundles = new Map<string, ArchiveBundle>();
  const questions: Array<{
    sessionID: string;
    title: string;
    fields: FormFields;
    metadata?: FormMetadata;
  }> = [];
  const reports: string[] = [];
  const reportMetadata: Array<FormMetadata | undefined> = [];
  const answers: Array<FormAnswer | undefined> = [];
  const events: string[] = [];
  const lookups: Array<string | undefined> = [];
  const recovery = {
    missing: false,
    captured: [] as WorktreeSnapshot[],
    requests: [] as WorktreeRequest[],
    recreated: [] as WorktreePlan[],
  };
  const worktrees: WorktreeGateway = {
    async capture() {
      return recovery.captured;
    },
    async missing(locations) {
      return recovery.missing ? locations : [];
    },
    async prepare(request) {
      recovery.requests.push(request);
      return {
        projectID: request.projectID,
        directory: request.directory,
        repository: request.repository,
        worktree: request.worktree,
        commit: 'a'.repeat(40),
      };
    },
    async recreate(plan) {
      events.push('recreate');
      recovery.recreated.push(plan);
    },
  };
  const abort = new AbortController();
  let beforeAnswer: (() => void) | undefined;
  let answerGate: Promise<void> | undefined;
  let reportFailure = false;
  const storage: ArchiveStorage = {
    async list(sessionID?: string) {
      lookups.push(sessionID);
      return [...bundles.values()]
        .filter((bundle) =>
          !sessionID ||
          bundle.sessions.some((session) => session.info.id === sessionID),
        )
        .map((bundle) => ({
          id: bundle.id,
          rootSessionID: bundle.rootSessionID,
          title: bundle.sessions[0]?.info.title ?? '',
          createdAt: bundle.createdAt,
          sessionCount: bundle.sessions.length,
        }));
    },
    async read(id) {
      const bundle = bundles.get(id);
      assert(bundle);
      return structuredClone(bundle);
    },
    async save(bundle) {
      assert.fail(`Commands must not create archive files: ${bundle.id}`);
    },
  };
  const host: DesktopHost = {
    sessions: {
      async resolveProject() {
        return 'project-a';
      },
      async get(id) {
        const item = state.get(id);
        assert(item);
        return structuredClone(item.info);
      },
      async children(id) {
        return [...state.values()]
          .filter((item) => item.info.parentID === id)
          .map((item) => structuredClone(item.info));
      },
      async messages(id) {
        const item = state.get(id);
        assert(item);
        return structuredClone(item.messages);
      },
      async existing() {
        return new Set(state.keys());
      },
      async archived() {
        return [...state.values()]
          .filter((item) => item.info.time.archived !== undefined)
          .map((item) => structuredClone(item.info));
      },
      async setArchived(id, archived) {
        const item = state.get(id);
        assert(item);
        events.push(`${archived ? 'archive' : 'restore'}:${id}`);
        if (archived) item.info.time.archived = 4;
        else delete item.info.time.archived;
      },
      async remove(id) {
        events.push('remove');
        const pending = [id];
        for (const parentID of pending) {
          for (const item of state.values())
            if (item.info.parentID === parentID) pending.push(item.info.id);
          state.delete(parentID);
        }
      },
      async import(data) {
        events.push('import');
        state.set(data.info.id, structuredClone(data));
        return structuredClone(data.info);
      },
    },
    async ask(sessionID, title, fields, metadata) {
      questions.push({
        sessionID,
        title,
        fields,
        ...(metadata === undefined ? {} : { metadata }),
      });
      beforeAnswer?.();
      await answerGate;
      return answers.shift();
    },
    async report(_sessionID, _title, message, metadata) {
      if (reportFailure) throw new Error('UI unavailable');
      reports.push(message);
      reportMetadata.push(metadata);
    },
  };
  const commands = desktopCommands(
    async () => host,
    storage,
    scope,
    abort.signal,
    restoreMappings,
    worktrees,
  );
  async function run(
    name: string,
    text = '',
    delivery: 'queue' | 'steer' = 'steer',
    sessionID = 'ses_owner',
  ) {
    const command = commands.find((item) => item.name === name);
    assert(command);
    await command.execute({
      sessionID: Session.ID.make(sessionID),
      prompt: { text },
      delivery,
    });
  }
  function archived(
    projectID = 'project-a',
    id = archiveID,
    descendant = false,
    snapshots?: WorktreeSnapshot[],
  ) {
    const child = transfer('ses_child', projectID);
    child.info.parentID = 'ses_archived';
    const bundle = Bundle.parse({
      format: 'opencode-session-archive',
      ...(snapshots ? { version: 2, worktrees: snapshots } : { version: 1 }),
      id,
      createdAt: 3,
      rootSessionID: 'ses_archived',
      projectID,
      sessions: [
        transfer('ses_archived', projectID),
        ...(descendant ? [child] : []),
      ],
    });
    bundles.set(bundle.id, bundle);
  }
  return {
    run,
    state,
    bundles,
    questions,
    reports,
    reportMetadata,
    answers,
    events,
    lookups,
    recovery,
    abort,
    sessions: host.sessions,
    archived,
    onAnswer(callback: () => void) {
      beforeAnswer = callback;
    },
    failReport() {
      reportFailure = true;
    },
    holdAnswer(gate: Promise<void>) {
      answerGate = gate;
    },
  };
}

test('session-id reports the exact current root or child ID without changing sessions or archives', async () => {
  const f = fixture();
  const child = transfer('ses_child');
  child.info.parentID = 'ses_owner';
  f.state.set('ses_child', child);
  f.archived();
  const sessions = structuredClone(f.state);
  const archives = structuredClone(f.bundles);
  await f.run('session-id');
  await f.run('session-id', '  ', 'steer', 'ses_child');
  assert.deepEqual(f.reports, ['ses_owner', 'ses_child']);
  assert.deepEqual(f.state, sessions);
  assert.deepEqual(f.bundles, archives);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.lookups, []);
});

test('session-id refuses a target argument instead of reporting another session', async () => {
  const f = fixture();
  await assert.rejects(f.run('session-id', 'ses_target'), /without arguments/);
  assert.deepEqual(f.reports, []);
});

test('desktop native archive and restore preserve the tree without exporting or deleting it', async () => {
  const f = fixture();
  const child = transfer('ses_child', 'project-b');
  child.info.parentID = 'ses_target';
  f.state.set('ses_child', child);
  const original = structuredClone(f.state);
  f.sessions.remove = async () => assert.fail('Native archive must not delete');
  f.sessions.import = async () => assert.fail('Native restore must not import');
  await f.run('session-archive', 'ses_target');
  assert.equal(f.state.get('ses_target')?.info.time.archived, 4);
  assert.equal(f.state.get('ses_child')?.info.time.archived, 4);
  assert.deepEqual(f.state.get('ses_owner'), original.get('ses_owner'));
  await f.run('session-restore', 'ses_child');
  assert.deepEqual(f.state, original);
  assert.deepEqual(f.events, [
    'archive:ses_child',
    'archive:ses_target',
    'restore:ses_target',
    'restore:ses_child',
  ]);
  assert.equal(f.bundles.size, 0);
  assert.deepEqual(f.questions, []);
  assert.match(f.reports[0] ?? '', /archived natively/);
  assert.match(f.reports[1] ?? '', /Open ses_target/);
});

test('desktop archives the open session without adding a result form to its archived tree', async () => {
  const f = fixture();
  await f.run('session-archive');
  assert.equal(f.state.get('ses_owner')?.info.time.archived, 4);
  assert.deepEqual(f.events, ['archive:ses_owner']);
  assert.deepEqual(f.reports, []);
  assert.deepEqual(f.questions, []);
});

test('desktop native archive rejects roots outside its project or global directory before any update', async (t) => {
  for (const projectID of ['project-a', 'global'])
    await t.test(projectID, async () => {
      const f = fixture([], { projectID, directory: '/synthetic/project' });
      f.state.set('ses_owner', transfer('ses_owner', projectID));
      const foreign = transfer(
        'ses_foreign',
        projectID === 'global' ? 'global' : 'project-b',
      );
      foreign.info.location.directory = '/synthetic/other';
      f.state.set('ses_foreign', foreign);
      const original = structuredClone(f.state);
      await assert.rejects(
        f.run('session-archive', 'ses_foreign'),
        /another (project|directory)/,
      );
      assert.deepEqual(f.state, original);
      assert.deepEqual(f.events, []);
    });
});

test('desktop descendant lookup offers both native and legacy archives but excludes foreign native roots', async () => {
  const f = fixture();
  f.archived('project-a', archiveID, true);
  const file = f.bundles.get(archiveID);
  assert(file);
  file.createdAt = 6;
  const native = transfer('ses_native');
  native.info.time.archived = 4;
  const child = transfer('ses_child', 'project-b');
  child.info.parentID = 'ses_native';
  child.info.time.archived = 4;
  const foreign = transfer('ses_foreign', 'project-b');
  foreign.info.time.archived = 5;
  f.state.set(native.info.id, native);
  f.state.set(child.info.id, child);
  f.state.set(foreign.info.id, foreign);
  await f.run('session-restore');
  const field = f.questions[0]?.fields[0];
  assert(field?.type === 'string');
  assert.deepEqual(field.options?.map((option) => option.value), [
    archiveID,
    'ses_native',
  ]);
  f.answers.push({ archive: 'ses_native' });
  await f.run('session-restore', 'ses_child');
  assert.equal(f.questions.length, 2, 'Native and file matches need a picker');
  assert.deepEqual(f.events, ['restore:ses_native', 'restore:ses_child']);
  assert.equal(f.state.get('ses_foreign')?.info.time.archived, 5);
  assert(f.bundles.has(archiveID));
});

test('desktop delete removes the whole tree immediately without an archive and reports only to a surviving session', async (t) => {
  for (const target of ['ses_owner', 'ses_target'])
    await t.test(target, async () => {
      const f = fixture();
      f.archived();
      const originalArchives = structuredClone(f.bundles);
      const child = transfer('ses_child', 'project-b');
      child.info.parentID = target;
      f.state.set('ses_child', child);
      const grandchild = transfer('ses_grandchild', 'global');
      grandchild.info.parentID = 'ses_child';
      f.state.set('ses_grandchild', grandchild);
      f.sessions.messages = async () =>
        assert.fail('Delete must not read transcripts');
      await f.run('session-delete', target === 'ses_owner' ? '' : target);
      assert(!f.state.has(target));
      assert(!f.state.has('ses_child'));
      assert(!f.state.has('ses_grandchild'));
      assert.equal(f.state.size, 1);
      assert.deepEqual(f.bundles, originalArchives);
      assert.deepEqual(f.events, ['remove']);
      assert.deepEqual(f.questions, []);
      assert.equal(f.reports.length, target === 'ses_owner' ? 0 : 1);
      if (target !== 'ses_owner')
        assert.match(f.reports[0] ?? '', /No archive was saved/);
    });
});

test('desktop delete invalid input makes no changes', async () => {
  for (const [argument, delivery] of [
    ['invalid', 'steer'],
    ['ses_owner ses_target', 'steer'],
    ['', 'queue'],
  ] as const) {
    const f = fixture();
    await assert.rejects(
      f.run('session-delete', argument, delivery),
      delivery === 'queue' ? /cannot be queued/ : /Use \/session-delete/,
    );
    assert.deepEqual(f.questions, []);
    assert.deepEqual(f.events, []);
  }
  const f = fixture();
  f.state.set('ses_foreign', transfer('ses_foreign', 'project-b'));
  await assert.rejects(f.run('session-delete', 'ses_foreign'), /another project/);
  assert.deepEqual(f.questions, []);
  assert.deepEqual(f.events, []);
});

test('desktop delete rechecks the captured tree and plugin lifetime before deletion', async (t) => {
  for (const change of [
    'descendant',
    'project',
    'parent',
    'location',
    'title',
    'unload',
  ])
    await t.test(change, async () => {
      const f = fixture();
      const get = f.sessions.get;
      let reads = 0;
      f.sessions.get = async (id) => {
        if (id !== 'ses_target' || ++reads !== (change === 'unload' ? 1 : 2))
          return get(id);
        const target = f.state.get('ses_target');
        assert(target);
        if (change === 'descendant') {
          const child = transfer('ses_child');
          child.info.parentID = 'ses_target';
          f.state.set('ses_child', child);
        } else if (change === 'project') target.info.projectID = 'project-b';
        else if (change === 'parent') target.info.parentID = 'ses_owner';
        else if (change === 'location')
          target.info.location.directory = '/synthetic/moved';
        else if (change === 'title') target.info.title = 'Renamed';
        else f.abort.abort();
        return get(id);
      };
      await assert.rejects(
        f.run('session-delete', 'ses_target'),
        change === 'unload' ? { name: 'AbortError' } : /family changed/,
      );
      assert(f.state.has('ses_target'));
      assert.deepEqual(f.events, []);
    });
});

test('desktop delete reports incomplete or unverified deletion without claiming a backup', async (t) => {
  for (const failure of ['remove', 'remaining', 'verification', 'report'])
    await t.test(failure, async () => {
      const f = fixture();
      if (failure === 'remove')
        f.sessions.remove = async () => {
          throw new Error('Disconnected');
        };
      else if (failure === 'remaining') f.sessions.remove = async () => {};
      else if (failure === 'verification')
        f.sessions.existing = async () => {
          throw new Error('Disconnected');
        };
      else f.failReport();
      await assert.rejects(
        f.run('session-delete', 'ses_target'),
        failure === 'report'
          ? /was deleted.*No archive was saved/
          : /Deletion.*No backup was created/,
      );
      assert.deepEqual(f.bundles, new Map());
      assert.deepEqual(f.reports, []);
    });
});

test('desktop restore by archive, root, or descendant ID imports the whole tree without a picker', async (t) => {
  for (const argument of [archiveID, 'ses_archived', 'ses_child'])
    for (const mapped of [false, true])
      await t.test(
        `${argument} ${mapped ? 'mapped root' : 'original root'}`,
        async () => {
          const f = fixture(
            mapped
              ? [
                  {
                    from: {
                      projectID: 'project-old',
                      directory: '/synthetic/project',
                    },
                    to: {
                      projectID: 'project-a',
                      directory: '/synthetic/project',
                    },
                  },
                ]
              : [],
          );
          f.archived(mapped ? 'project-old' : 'project-a', archiveID, true);
          const original = structuredClone(f.bundles.get(archiveID));
          await f.run('session-restore', argument);
          assert(f.state.has('ses_archived'));
          assert(f.state.has('ses_child'));
          assert(f.bundles.has(archiveID));
          assert.deepEqual(f.questions, []);
          assert.deepEqual(f.events, ['import', 'import']);
          assert.deepEqual(f.lookups, argument === archiveID ? [] : [argument]);
          assert.equal(f.state.get('ses_archived')?.info.projectID, 'project-a');
          assert.deepEqual(f.bundles.get(archiveID), original);
        },
      );
});

test('desktop restore without an ID restores immediately after selection and retains its archive', async (t) => {
  for (const mapped of [false, true])
    await t.test(mapped ? 'mapped root' : 'original root', async () => {
      const f = fixture(
        mapped
          ? [
              {
                from: {
                  projectID: 'project-old',
                  directory: '/synthetic/project',
                },
                to: { projectID: 'project-a', directory: '/synthetic/project' },
              },
            ]
          : [],
      );
      f.archived(mapped ? 'project-old' : 'project-a');
      const original = structuredClone(f.bundles.get(archiveID));
      f.answers.push({ archive: archiveID });
      await f.run('session-restore');
      assert(f.state.has('ses_archived'));
      assert(f.bundles.has(archiveID));
      assert.equal(f.questions.length, 1);
      assert.deepEqual(f.questions[0]?.metadata, {
        'simpod.session-restore.archives': [
          {
            id: archiveID,
            rootSessionID: 'ses_archived',
            title: 'Title ses_archived',
            createdAt: 3,
            sessionCount: 1,
          },
        ],
      });
      assert.deepEqual(f.events, ['import']);
      assert.match(f.reports[0] ?? '', /Open ses_archived/);
      const result = f.reportMetadata[0]?.['simpod.session-restore.result'];
      assert(result && typeof result === 'object' && !Array.isArray(result));
      assert.equal(result.rootSessionID, 'ses_archived');
      assert.deepEqual(result.sessionIDs, ['ses_archived']);
      assert.equal(f.state.get('ses_archived')?.info.projectID, 'project-a');
      assert.deepEqual(f.bundles.get(archiveID), original);
    });
});

test('desktop restore picker cancellation, invalid selection, and project mismatch never import', async (t) => {
  for (const answers of [[undefined], [{ archive: randomUUID() }]]) {
    await t.test(JSON.stringify(answers), async () => {
      const f = fixture();
      f.archived();
      f.answers.push(...answers);
      if (answers[0]?.archive && answers[0].archive !== archiveID)
        await assert.rejects(f.run('session-restore'), /Select an archive/);
      else await f.run('session-restore');
      assert.deepEqual(f.events, []);
    });
  }
  const f = fixture();
  f.archived('project-b');
  await assert.rejects(f.run('session-restore', archiveID), /another project/);
  assert.deepEqual(f.events, []);
});

test('desktop session lookup limits repeated archives to the picker and rejects other selections', async (t) => {
  for (const outcome of ['restore', 'cancel', 'invalid', 'nonmatching', 'changed'])
    await t.test(outcome, async () => {
      const f = fixture();
      const secondID = randomUUID();
      const unrelatedID = randomUUID();
      f.archived('project-a', archiveID, true);
      f.archived('project-a', secondID, true);
      f.archived('project-a', unrelatedID);
      f.answers.push(
        outcome === 'cancel'
          ? undefined
          : {
              archive:
                outcome === 'invalid'
                  ? randomUUID()
                  : outcome === 'nonmatching'
                    ? unrelatedID
                    : secondID,
            },
      );
      if (outcome === 'changed')
        f.onAnswer(() => {
          f.archived('project-a', secondID);
        });
      if (outcome === 'invalid' || outcome === 'nonmatching')
        await assert.rejects(
          f.run('session-restore', 'ses_child'),
          /Select an archive/,
        );
      else if (outcome === 'changed')
        await assert.rejects(
          f.run('session-restore', 'ses_child'),
          /does not contain.*ses_child/,
        );
      else await f.run('session-restore', 'ses_child');
      const question = f.questions[0];
      assert(question);
      const field = question.fields[0];
      assert(field.type === 'string');
      assert.deepEqual(field.options?.map((option) => option.value), [
        archiveID,
        secondID,
      ]);
      assert.deepEqual(f.lookups, ['ses_child']);
      assert.deepEqual(f.events, outcome === 'restore' ? ['import', 'import'] : []);
      assert.equal(f.state.has('ses_child'), outcome === 'restore');
    });
});

test('desktop missing-directory restore without recorded metadata fails without questions or writes', async () => {
  const f = fixture();
  f.archived();
  f.recovery.missing = true;
  await assert.rejects(
    f.run('session-restore', archiveID),
    /archive lacks a recorded repository and commit/,
  );
  assert.deepEqual(f.questions, []);
  assert.deepEqual(f.events, []);
  assert(!f.state.has('ses_archived'));
  assert(f.bundles.has(archiveID));
});

test('desktop automatically recovers saved worktrees without questions and reports recovery limits', async () => {
  const f = fixture();
  const saved: WorktreeSnapshot = {
    projectID: 'project-a',
    directory: '/synthetic/project',
    repository: '/synthetic/source',
    worktree: '/synthetic/project',
    commit: 'a'.repeat(40),
    branch: 'old-branch',
    dirty: true,
  };
  f.archived('project-a', archiveID, false, [saved]);
  f.recovery.missing = true;
  await f.run('session-restore', archiveID);
  assert.deepEqual(f.questions, []);
  const message = f.reports[0] ?? '';
  assert.match(message, /Open ses_archived/);
  assert.match(message, /Archive retained:/);
  assert.match(
    message,
    /Automatically recreated 1 Git worktree\(s\) at the recorded commits/,
  );
  assert.match(message, /Only committed files were restored/);
  assert.match(message, /Dependencies and environment files were not restored/);
  assert.match(message, /Uncommitted or untracked files were not recovered/);
  assert.equal(f.recovery.requests[0]?.ref, saved.commit);
  assert.deepEqual(f.events, ['recreate', 'import']);
});

test('desktop refuses queued commands and stops before writes when the plugin unloads during selection', async () => {
  const f = fixture();
  await assert.rejects(
    f.run('session-archive', '', 'queue'),
    /cannot be queued/,
  );
  assert.deepEqual(f.questions, []);
  f.archived();
  f.answers.push({ archive: archiveID });
  f.onAnswer(() => f.abort.abort());
  await assert.rejects(f.run('session-restore'), {
    name: 'AbortError',
  });
  assert.deepEqual(f.events, []);
});

test('desktop reports no archives for the project or requested session without restoration', async (t) => {
  for (const argument of ['', 'ses_missing'])
    await t.test(argument || 'project', async () => {
      const f = fixture();
      if (argument) f.archived();
      await f.run('session-restore', argument);
      assert.match(
        f.reports[0] ?? '',
        argument
          ? /No session archives.*ses_missing.*this project/
          : /No session archives/,
      );
      assert.deepEqual(f.questions, []);
      assert.deepEqual(f.events, []);
    });
});

test('desktop refuses a second operation while another command waits for archive selection', async () => {
  const f = fixture();
  const entered = new Promise<void>((resolve) => f.onAnswer(resolve));
  let release!: () => void;
  f.holdAnswer(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.archived();
  const pending = f.run('session-restore');
  await entered;
  try {
    await assert.rejects(f.run('session-delete'), /operation is in progress/);
  } finally {
    release();
    await pending;
  }
  assert.deepEqual(f.events, []);
});

test('desktop result failure states that restoration completed and must not be retried', async () => {
  const f = fixture();
  f.archived();
  f.failReport();
  await assert.rejects(
    f.run('session-restore', archiveID),
    /was restored.*do not restore it again/,
  );
  assert(f.state.has('ses_archived'));
  assert(f.bundles.has(archiveID));
  assert.deepEqual(f.questions, []);
});
