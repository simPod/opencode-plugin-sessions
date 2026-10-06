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

function fixture() {
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
  const abort = new AbortController();
  let beforeAnswer: (() => void) | undefined;
  let answerGate: Promise<void> | undefined;
  let reportFailure = false;
  const storage: ArchiveStorage = {
    async list() {
      return [...bundles.values()].map((bundle) => ({
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
        state.delete(id);
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
    'project-a',
    abort.signal,
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
  function archived(projectID = 'project-a') {
    const bundle = Bundle.parse({
      format: 'opencode-session-archive',
      version: 1,
      id: archiveID,
      createdAt: 3,
      rootSessionID: 'ses_archived',
      projectID,
      sessions: [transfer('ses_archived', projectID)],
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
    abort,
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

test('desktop archive browser restores immediately after selection and retains its archive', async () => {
  const f = fixture();
  f.archived();
  f.answers.push({ archive: archiveID });
  await f.run('session-archives');
  assert(f.state.has('ses_archived'));
  assert(f.bundles.has(archiveID));
  assert.equal(f.questions.length, 1);
  assert.deepEqual(f.events, ['import']);
  assert.match(f.reports[0] ?? '', /Open ses_archived/);
});

test('desktop restore picker cancellation, invalid selection, and project mismatch never import', async (t) => {
  for (const answers of [[undefined], [{ archive: randomUUID() }]]) {
    await t.test(JSON.stringify(answers), async () => {
      const f = fixture();
      f.archived();
      f.answers.push(...answers);
      if (answers[0]?.archive && answers[0].archive !== archiveID)
        await assert.rejects(f.run('session-archives'), /Select an archive/);
      else await f.run('session-archives');
      assert.deepEqual(f.events, []);
    });
  }
  const f = fixture();
  f.archived('project-b');
  await assert.rejects(
    f.run('session-unarchive', archiveID),
    /another project/,
  );
  assert.deepEqual(f.events, []);
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
  await assert.rejects(f.run('session-archives'), {
    name: 'AbortError',
  });
  assert.deepEqual(f.events, []);
});

test('desktop shows an empty archive list without starting restoration', async () => {
  const f = fixture();
  await f.run('session-archives');
  assert.match(f.reports[0] ?? '', /No session archives/);
  assert.deepEqual(f.events, []);
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
  const pending = f.run('session-archives');
  await entered;
  try {
    await assert.rejects(f.run('session-archives'), /operation is in progress/);
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
    f.run('session-unarchive', archiveID),
    /was restored.*do not restore it again/,
  );
  assert(f.state.has('ses_archived'));
  assert(f.bundles.has(archiveID));
  assert.deepEqual(f.questions, []);
});
