import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  FormAnswer,
  FormFields,
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
} from '../src/schema.ts';

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
    messages: [],
  };
}

function fixture(restoreMappings: RestoreMapping[] = []) {
  const state = new Map<string, SessionTransferData>([
    ['ses_owner', transfer('ses_owner')],
    ['ses_target', transfer('ses_target')],
  ]);
  const bundles = new Map<string, ArchiveBundle>();
  const questions: Array<{
    sessionID: string;
    title: string;
    fields: FormFields;
  }> = [];
  const reports: string[] = [];
  const answers: Array<FormAnswer | undefined> = [];
  const events: string[] = [];
  const lookups: Array<string | undefined> = [];
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
      events.push('save');
      bundles.set(bundle.id, structuredClone(bundle));
      return { id: bundle.id, path: `/synthetic/${bundle.id}.json` };
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
      async busy() {
        return false;
      },
      async existing() {
        return new Set(state.keys());
      },
      async export(id) {
        const item = state.get(id);
        assert(item);
        return structuredClone(item);
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
    async ask(sessionID, title, fields) {
      questions.push({ sessionID, title, fields });
      beforeAnswer?.();
      await answerGate;
      return answers.shift();
    },
    async report(_sessionID, _title, message) {
      if (reportFailure) throw new Error('UI unavailable');
      reports.push(message);
    },
  };
  const commands = desktopCommands(
    async () => host,
    storage,
    { projectID: 'project-a', directory: '/synthetic/project' },
    abort.signal,
    restoreMappings,
  );
  async function run(
    name: string,
    text = '',
    delivery: 'queue' | 'steer' = 'steer',
  ) {
    const command = commands.find((item) => item.name === name);
    assert(command);
    await command.execute({
      sessionID: Session.ID.make('ses_owner'),
      prompt: { text },
      delivery,
    });
  }
  function archived(projectID = 'project-a', id = archiveID, descendant = false) {
    const child = transfer('ses_child', projectID);
    child.info.parentID = 'ses_archived';
    const bundle = Bundle.parse({
      format: 'opencode-session-archive',
      version: 1,
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
    answers,
    events,
    lookups,
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

test('desktop archive verifies storage and deletes immediately without a confirmation form', async () => {
  const f = fixture();
  await f.run('session-archive', 'ses_target');
  assert.deepEqual(f.events, ['save', 'remove']);
  assert(!f.state.has('ses_target'));
  assert(f.state.has('ses_owner'));
  assert.deepEqual(f.questions, []);
  assert.match(f.reports[0] ?? '', /Archive:/);
});

test('desktop can archive the open session without trying to report to the deleted tree', async () => {
  const f = fixture();
  await f.run('session-archive');
  assert(!f.state.has('ses_owner'));
  assert.deepEqual(f.events, ['save', 'remove']);
  assert.deepEqual(f.reports, []);
  assert.deepEqual(f.questions, []);
});

test('desktop delete confirms the whole tree without an archive and reports only to a surviving session', async (t) => {
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
      f.sessions.export = async () => assert.fail('Delete must not export');
      f.sessions.messages = async () =>
        assert.fail('Delete must not read transcripts');
      f.sessions.busy = async () => assert.fail('Native delete stops active work');
      f.answers.push({ action: 'delete' });
      await f.run('session-delete', target === 'ses_owner' ? '' : target);
      assert(!f.state.has(target));
      assert(!f.state.has('ses_child'));
      assert(!f.state.has('ses_grandchild'));
      assert.equal(f.state.size, 1);
      assert.deepEqual(f.bundles, originalArchives);
      assert.deepEqual(f.events, ['remove']);
      const question = f.questions[0];
      assert(question);
      const field = question.fields[0];
      assert(field?.type === 'string');
      assert.match(
        field.description ?? '',
        /3 session\(s\).*No archive.*cannot be undone/,
      );
      assert.equal(f.reports.length, target === 'ses_owner' ? 0 : 1);
      if (target !== 'ses_owner')
        assert.match(f.reports[0] ?? '', /No archive was saved/);
    });
});

test('desktop delete cancellation and invalid input make no changes', async (t) => {
  for (const answer of [undefined, { action: 'cancel' }, { action: 'other' }])
    await t.test(JSON.stringify(answer) ?? 'dismissed', async () => {
      const f = fixture();
      f.answers.push(answer);
      await f.run('session-delete');
      assert(f.state.has('ses_owner'));
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.bundles, new Map());
    });
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

test('desktop delete rechecks the confirmed tree and plugin lifetime before deletion', async (t) => {
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
      f.answers.push({ action: 'delete' });
      f.onAnswer(() => {
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
      });
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
      f.answers.push({ action: 'delete' });
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
      assert.deepEqual(f.events, ['import']);
      assert.match(f.reports[0] ?? '', /Open ses_archived/);
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
