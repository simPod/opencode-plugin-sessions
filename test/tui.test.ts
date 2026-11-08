import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type {
  LocationRef,
  OpenCodeEvent,
  SessionFormCancelInput,
  SessionFormReplyInput,
  SessionInfo,
  SessionTransferData,
} from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import type { ArchiveBundle } from '../src/schema.ts';

const execute = promisify(execFile);

// Serialize a typed scenario into the isolated child process used by the TUI test.
async function scenario(pluginURL: string) {
  const assert: typeof import('node:assert').strict = (
    await import('node:assert')
  ).strict;
  const { randomUUID } = await import('node:crypto');
  const { default: plugin }: typeof import('../src/tui.ts') =
    await import(pluginURL);
  type Layer = ReturnType<Parameters<Plugin.Context['keymap']['layer']>[0]>;
  const original: SessionTransferData = {
    info: {
      id: 'ses_test',
      projectID: 'test-project',
      title: 'Test session',
      location: { directory: '/synthetic/project' },
      cost: 1.25,
      tokens: {
        input: 37,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 1, updated: 2 },
    },
    messages: [
      {
        id: 'msg_test',
        type: 'user',
        time: { created: 1 },
        text: 'Private transcript: č 🌱',
      },
    ],
  };
  const state = new Map([[original.info.id, structuredClone(original)]]);
  const bundles = new Map<string, ArchiveBundle>();
  const savedID = randomUUID();
  let commands: Layer['commands'];
  const selections: Array<readonly { value: string }[]> = [];
  const lookups: Array<{ sessionID?: string }> = [];
  let route: ReturnType<Plugin.Context['ui']['router']['current']> = {
    type: 'session',
    sessionID: 'ses_test',
  };
  const toasts: Array<Parameters<Plugin.Context['ui']['toast']['show']>[0]> = [];
  let choice: string | undefined;
  let beforeSelect: (() => void) | undefined;
  let beforeRead: (() => void) | undefined;
  let selectionGate: Promise<void> | undefined;
  let beforeSessionGet: ((sessionID: string) => void) | undefined;
  const tabs: Array<{ sessionID: string }> = [];
  let imports = 0;
  let removals = 0;
  const updates: Array<{ sessionID: string; archived: boolean }> = [];
  function session(id: string) {
    const item = state.get(id);
    assert(item);
    return item;
  }
  function bundle(id: string) {
    const item = bundles.get(id);
    assert(item);
    return item;
  }
  const location: LocationRef = { directory: '/synthetic/project' };
  const context = {
    location,
    client: {
      file: { list: async () => ({ location, data: [] }) },
      location: { get: async () => ({ project: { id: 'test-project' } }) },
      rpc: () => ({
        events: { on: () => () => {} },
        restoreMappings: async () => [
          {
            from: {
              projectID: 'old-project',
              directory: '/synthetic/old-project',
            },
            to: { projectID: 'test-project', directory: '/synthetic/project' },
          },
        ],
        list: async (
          input: { sessionID?: string },
          options: { location: LocationRef },
        ) => {
          assert.deepEqual(options.location, location);
          lookups.push(input);
          return [...bundles.values()]
            .filter(
              (item) =>
                !input.sessionID ||
                item.sessions.some(
                  (session) => session.info.id === input.sessionID,
                ),
            )
            .map((item) => ({
              id: item.id,
              title: 'Test session',
              createdAt: item.createdAt,
              sessionCount: item.sessions.length,
              rootSessionID: item.rootSessionID,
            }));
        },
        read: async ({ id }: { id: string }) => {
          beforeRead?.();
          return structuredClone(bundle(id));
        },
        save: async () => assert.fail('Native archive must not save through RPC'),
        worktreeCapture: async () => [],
        worktreeMissing: async () => [],
      }),
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          beforeSessionGet?.(sessionID);
          return structuredClone(session(sessionID).info);
        },
        list: async ({
          parentID,
          archived,
        }: {
          parentID?: string;
          archived?: boolean;
        }) => ({
          data: [...state.values()]
            .filter(
              (item) =>
                (!parentID || item.info.parentID === parentID) &&
                (archived === undefined ||
                  (item.info.time.archived !== undefined) === archived),
            )
            .map((item) => structuredClone(item.info)),
          cursor: {},
        }),
        update: async ({
          sessionID,
          archived,
        }: {
          sessionID: string;
          archived: boolean;
        }) => {
          updates.push({ sessionID, archived });
          const info = session(sessionID).info;
          if (archived) info.time.archived = 4;
          else delete info.time.archived;
        },
        active: async () => ({}),
        inbox: { list: async () => [] },
        export: async () => assert.fail('Native archive must not export'),
        remove: async ({ sessionID }: { sessionID: string }) => {
          removals++;
          const pending = [sessionID];
          for (const parentID of pending) {
            for (const item of state.values())
              if (item.info.parentID === parentID) pending.push(item.info.id);
            state.delete(parentID);
          }
        },
        import: async (data: SessionTransferData) => {
          imports++;
          state.set(data.info.id, structuredClone(data));
          return structuredClone(data.info);
        },
      },
      message: {
        list: async ({ sessionID }: { sessionID: string }) => ({
          data: structuredClone(session(sessionID).messages),
          cursor: {},
        }),
      },
    },
    keymap: {
      layer: (factory: () => Layer) => {
        commands = factory().commands;
      },
    },
    data: {
      on: () => () => {},
      session: { invalidate: () => {}, sync: async () => {} },
    },
    ui: {
      router: {
        current: () => route,
        navigate: (next: typeof route) => {
          route = next;
        },
      },
      tabs: {
        enabled: () => tabs.length > 0,
        open: () => {},
        list: () => [...tabs],
        close: (sessionID: string) => {
          const index = tabs.findIndex((tab) => tab.sessionID === sessionID);
          if (index !== -1) tabs.splice(index, 1);
        },
      },
      toast: { show: (toast: (typeof toasts)[number]) => toasts.push(toast) },
      dialog: {
        confirm: () => assert.fail('Commands must not request confirmation'),
        select: async (options: { options: readonly { value: string }[] }) => {
          selections.push(options.options);
          beforeSelect?.();
          await selectionGate;
          return choice;
        },
      },
    },
  };
  // The test supplies only host capabilities used by this plugin.
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);
  assert(typeof cleanup === 'function');
  assert(commands);
  assert(
    commands.every((command) => !command.slash),
    'Only server commands must contribute slash entries',
  );
  const archive = commands.find(
    (command) => command.id === 'simpod.session-archive.archive',
  );
  const restore = commands.find(
    (command) => command.id === 'simpod.session-archive.restore',
  );
  const remove = commands.find(
    (command) => command.id === 'simpod.session-archive.delete',
  );
  assert(archive);
  assert(restore);
  assert(remove);
  assert(archive.palette);
  assert(restore.palette);
  assert(remove.palette);
  const nativeChild = structuredClone(original);
  nativeChild.info.id = 'ses_child';
  nativeChild.info.parentID = 'ses_test';
  nativeChild.info.projectID = 'foreign-project';
  nativeChild.info.location.directory = '/synthetic/foreign';
  nativeChild.info.cost = 3.25;
  nativeChild.info.tokens.input = 47;
  assert(nativeChild.messages[0]);
  nativeChild.messages[0].id = 'msg_child';
  state.set('ses_child', nativeChild);
  const unrelated = structuredClone(original);
  unrelated.info.id = 'ses_other';
  state.set('ses_other', unrelated);
  route = { type: 'session', sessionID: 'ses_child' };
  const expectedRestoredState = structuredClone(state);
  // Existing files remain untouched; new archives only update native flags.
  bundles.set(savedID, {
    format: 'opencode-session-archive',
    version: 1,
    id: savedID,
    createdAt: 3,
    rootSessionID: 'ses_test',
    projectID: 'test-project',
    sessions: [structuredClone(original)],
  });
  const legacyArchives = structuredClone(bundles);
  tabs.push(
    { sessionID: 'ses_test' },
    { sessionID: 'ses_child' },
    { sessionID: 'ses_other' },
  );
  const beforeArchiveToasts = toasts.length;
  await archive.run('ses_test');
  const expectedArchivedState = structuredClone(expectedRestoredState);
  for (const id of ['ses_test', 'ses_child']) {
    const item = expectedArchivedState.get(id);
    assert(item);
    item.info.time.archived = 4;
  }
  assert.deepEqual(state, expectedArchivedState);
  assert.deepEqual(updates, [
    { sessionID: 'ses_child', archived: true },
    { sessionID: 'ses_test', archived: true },
  ]);
  assert.deepEqual(bundles, legacyArchives);
  assert.deepEqual(route, { type: 'home' });
  assert.deepEqual(tabs, [{ sessionID: 'ses_other' }]);
  assert.equal(toasts.length, beforeArchiveToasts + 1);
  assert.equal(toasts.at(-1)?.variant, 'success');
  assert.match(toasts.at(-1)?.message ?? '', /archived natively/i);
  assert.match(toasts.at(-1)?.message ?? '', /\/session-restore ses_test/);
  assert.doesNotMatch(toasts.at(-1)?.message ?? '', /Server file|backup/i);
  await restore.run('ses_child');
  assert.deepEqual(state, expectedRestoredState);
  assert.deepEqual(route, { type: 'session', sessionID: 'ses_test' });
  assert.equal(imports, 0);
  assert.equal(removals, 0);
  assert.deepEqual(bundles, legacyArchives);
  lookups.length = 0;

  // Legacy restore remains available without migrating existing files.
  const archived = bundle(savedID);
  archived.projectID = 'old-project';
  const root = archived.sessions[0];
  assert(root);
  root.info.projectID = 'old-project';
  root.info.location.directory = '/synthetic/old-project';
  const child = structuredClone(root);
  child.info.id = 'ses_child';
  child.info.parentID = 'ses_test';
  assert(child.messages[0]);
  child.messages[0].id = 'msg_child';
  archived.sessions.push(child);
  const originalArchive = structuredClone(archived);

  for (const argument of [undefined, savedID, 'ses_test', 'ses_child']) {
    state.clear();
    route = { type: 'home' };
    choice = savedID;
    const before = selections.length;
    await restore.run(argument);
    assert.equal(selections.length, before + (argument === undefined ? 1 : 0));
    assert.deepEqual(route, { type: 'session', sessionID: 'ses_test' });
    assert.deepEqual(session('ses_test').messages, original.messages);
    assert.equal(session('ses_test').info.projectID, 'test-project');
    assert.equal(session('ses_child').info.parentID, 'ses_test');
    assert.equal(session('ses_child').info.location.directory, '/synthetic/project');
    assert.deepEqual(bundle(savedID), originalArchive);
    assert.equal(toasts.at(-1)?.variant, 'success');
  }
  assert.deepEqual(lookups, [
    {},
    { sessionID: 'ses_test' },
    { sessionID: 'ses_child' },
  ]);

  const secondID = randomUUID();
  const unrelatedID = randomUUID();
  bundles.set(secondID, { ...structuredClone(originalArchive), id: secondID });
  bundles.set(unrelatedID, {
    ...structuredClone(originalArchive),
    id: unrelatedID,
    sessions: [structuredClone(root)],
  });
  for (const outcome of ['restore', 'cancel', 'invalid', 'nonmatching', 'changed']) {
    state.clear();
    route = { type: 'home' };
    bundles.set(secondID, { ...structuredClone(originalArchive), id: secondID });
    choice =
      outcome === 'cancel'
        ? undefined
        : outcome === 'invalid'
          ? randomUUID()
          : outcome === 'nonmatching'
            ? unrelatedID
            : secondID;
    beforeSelect =
      outcome === 'changed'
        ? () => {
            bundle(secondID).sessions = [structuredClone(root)];
          }
        : undefined;
    const before: number = imports;
    await restore.run('ses_child');
    assert.deepEqual(selections.at(-1)?.map((option) => option.value), [
      savedID,
      secondID,
    ]);
    assert.equal(imports - before, outcome === 'restore' ? 2 : 0);
    if (outcome === 'restore') {
      assert.equal(session('ses_child').info.parentID, 'ses_test');
      assert.equal(toasts.at(-1)?.variant, 'success');
    } else {
      assert.equal(state.size, 0);
      if (outcome !== 'cancel') {
        assert.equal(toasts.at(-1)?.variant, 'error');
        assert.match(
          toasts.at(-1)?.message ?? '',
          outcome === 'changed'
            ? /does not contain.*ses_child/
            : /Select an archive/,
        );
      }
    }
  }
  beforeSelect = undefined;
  const before = imports;
  const pickerCount = selections.length;
  await restore.run('ses_missing');
  assert.match(
    toasts.at(-1)?.message ?? '',
    /No session archives.*ses_missing.*this project/,
  );
  assert.equal(selections.length, pickerCount);
  assert.equal(imports, before);

  // A single matching archive can also change between list and read.
  bundles.delete(secondID);
  const retainedID = savedID;
  beforeRead = () => {
    bundle(retainedID).sessions = [structuredClone(root)];
  };
  await restore.run('ses_child');
  assert.match(toasts.at(-1)?.message ?? '', /does not contain.*ses_child/);
  assert.equal(imports, before);
  beforeRead = undefined;
  bundles.set(savedID, structuredClone(originalArchive));

  // The no-argument picker must reject IDs not offered by the current project.
  choice = randomUUID();
  await restore.run();
  assert.match(toasts.at(-1)?.message ?? '', /Select an archive/);
  assert.equal(imports, before);

  const entered = new Promise<void>((resolve) => {
    beforeSelect = resolve;
  });
  let release: (() => void) | undefined;
  selectionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  choice = undefined;
  const pending = restore.run();
  await entered;
  try {
    await remove.run('ses_test');
    assert.equal(toasts.at(-1)?.variant, 'warning');
    assert.match(toasts.at(-1)?.message ?? '', /operation is in progress/);
  } finally {
    assert(release);
    release();
    await pending;
  }
  assert.equal(imports, before);

  // Deletion uses the connected client only, leaves archives unchanged, and
  // removes tabs for descendants without closing unrelated sessions.
  const retainedArchives = structuredClone(bundles);
  for (const outcome of [
    'changed',
    'delete-current',
    'delete-tree',
    'delete-by-id',
  ]) {
    state.clear();
    state.set('ses_test', structuredClone(original));
    const child = structuredClone(original);
    child.info.id = 'ses_child';
    child.info.parentID = 'ses_test';
    child.info.projectID = 'foreign-project';
    state.set('ses_child', child);
    const unrelated = structuredClone(original);
    unrelated.info.id = 'ses_other';
    state.set('ses_other', unrelated);
    tabs.splice(
      0,
      tabs.length,
      { sessionID: 'ses_test' },
      { sessionID: 'ses_child' },
      { sessionID: 'ses_other' },
    );
    const initialRoute = {
      type: 'session' as const,
      sessionID: outcome === 'delete-by-id' ? 'ses_other' : 'ses_child',
    };
    route = initialRoute;
    let reads = 0;
    beforeSessionGet =
      outcome === 'changed'
        ? (sessionID) => {
            if (sessionID !== 'ses_test' || ++reads !== 2) return;
            const added = structuredClone(child);
            added.info.id = 'ses_added';
            state.set('ses_added', added);
          }
        : undefined;
    // Current-session deletion can target a child without deleting its parent.
    const argument = outcome === 'delete-current' ? undefined : 'ses_test';
    await remove.run(argument);
    if (
      outcome === 'delete-current' ||
      outcome === 'delete-tree' ||
      outcome === 'delete-by-id'
    ) {
      assert(!state.has('ses_child'));
      assert.equal(state.has('ses_test'), outcome === 'delete-current');
      assert(state.has('ses_other'));
      assert.deepEqual(
        route,
        outcome === 'delete-by-id' ? initialRoute : { type: 'home' },
      );
      assert.deepEqual(
        tabs.map((tab) => tab.sessionID),
        outcome === 'delete-current' ? ['ses_test', 'ses_other'] : ['ses_other'],
      );
      assert.equal(toasts.at(-1)?.title, 'Session tree deleted');
      assert.equal(toasts.at(-1)?.variant, 'success');
    } else {
      assert(state.has('ses_test'));
      assert(state.has('ses_child'));
      assert.deepEqual(route, initialRoute);
      assert.equal(tabs.length, 3);
      assert.match(toasts.at(-1)?.message ?? '', /family changed/);
    }
    assert.deepEqual(bundles, retainedArchives);
  }
  beforeSessionGet = undefined;
  route = { type: 'home' };
  await remove.run();
  assert.match(toasts.at(-1)?.message ?? '', /Use \/session-delete/);
  await remove.run('invalid');
  assert.match(toasts.at(-1)?.message ?? '', /Use \/session-delete/);

  state.set('ses_test', structuredClone(original));
  const pendingChild = structuredClone(original);
  pendingChild.info.id = 'ses_child';
  pendingChild.info.parentID = 'ses_test';
  state.set('ses_child', pendingChild);
  beforeSessionGet = () => cleanup();
  const beforeUnload = structuredClone(state);
  await archive.run('ses_test');
  assert.deepEqual(state, beforeUnload);
  await remove.run('ses_test');
  assert(state.has('ses_test'));
  assert(state.has('ses_child'));
  assert.equal(toasts.at(-1)?.variant, 'error');
  assert.match(toasts.at(-1)?.message ?? '', /aborted/i);
  console.log('Archive, restore, and delete completed without confirmation.');
}

test('TUI palette actions archive, restore, and delete immediately without duplicate slash entries', async () => {
  const script = `await (${scenario.toString()})(${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)});`;
  const result = await execute(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { timeout: 5_000 },
  );
  assert.match(result.stdout, /completed without confirmation/);
});

async function slashArchiveScenario(pluginURL: string) {
  const assert: typeof import('node:assert').strict = (
    await import('node:assert')
  ).strict;
  const { default: plugin }: typeof import('../src/tui.ts') =
    await import(pluginURL);
  type Result = import('zod').infer<typeof import('../src/rpc.ts').ArchiveResult>;
  const listeners = new Set<(event: { data: Result }) => void>();
  const emit = (data: Result) => {
    for (const listener of listeners) listener({ data });
  };
  let route: ReturnType<Plugin.Context['ui']['router']['current']> = {
    type: 'session',
    sessionID: 'ses_owner',
  };
  const toasts: Array<Parameters<Plugin.Context['ui']['toast']['show']>[0]> = [];
  const tabs = ['ses_owner', 'ses_child', 'ses_other'];
  const cleanup = await plugin.setup({
    client: {
      rpc: () => ({
        events: {
          on: (name: string, listener: (event: { data: Result }) => void) => {
            assert.equal(name, 'archiveResult');
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      }),
    },
    keymap: { layer: () => {} },
    data: { on: () => () => {} },
    ui: {
      router: {
        current: () => route,
        navigate: (next: typeof route) => {
          route = next;
        },
      },
      tabs: {
        enabled: () => true,
        list: () => tabs.map((sessionID) => ({ sessionID })),
        close: (sessionID: string) => {
          const index = tabs.indexOf(sessionID);
          if (index !== -1) tabs.splice(index, 1);
        },
      },
      toast: { show: (toast: (typeof toasts)[number]) => toasts.push(toast) },
    },
  } as unknown as Plugin.Context);
  assert.equal(listeners.size, 1, 'Slash archive results need a TUI listener');
  const success: Result = {
    operationID: '617c0d9d-667d-4dcb-86c6-48cbab235c09',
    sessionID: 'ses_owner',
    variant: 'success',
    sessionIDs: ['ses_owner', 'ses_child'],
    message: '2 sessions archived in the native archive. Restore with /session-restore ses_owner.',
  };
  emit({ ...success, sessionID: 'ses_foreign' });
  route = { type: 'home' };
  emit(success);
  assert.equal(toasts.length, 0);
  assert.deepEqual(tabs, ['ses_owner', 'ses_child', 'ses_other']);
  route = { type: 'session', sessionID: 'ses_owner' };
  const started: Result = {
    operationID: success.operationID,
    sessionID: success.sessionID,
    variant: 'started',
    message: 'Archiving session tree.',
  };
  emit(started);
  assert.equal(toasts.at(-1)?.variant, 'info');
  // Native archive emits no deletion event. Exact IDs must close the current
  // archived descendant and all archived tabs, without closing unrelated tabs.
  route = { type: 'session', sessionID: 'ses_child' };
  emit(success);
  assert.deepEqual(route, { type: 'home' });
  assert.deepEqual(tabs, ['ses_other']);

  // A correlated success must not leave an unrelated session the user opened.
  const secondStarted: Result = {
    ...started,
    operationID: '9e594bdf-8c62-48c5-a4db-2222dc5232cc',
  };
  route = { type: 'session', sessionID: 'ses_owner' };
  tabs.push('ses_owner', 'ses_child');
  emit(secondStarted);
  route = { type: 'session', sessionID: 'ses_other' };
  const secondSuccess: Result = {
    ...success,
    operationID: secondStarted.operationID,
  };
  emit(secondSuccess);
  assert.deepEqual(route, { type: 'session', sessionID: 'ses_other' });
  assert.deepEqual(tabs, ['ses_other']);
  // A completion already consumed through correlation is not shown again here.
  emit(success);
  const error: Result = {
    operationID: 'a48bc161-251c-401a-975f-589689dfb55c',
    sessionID: 'ses_other',
    variant: 'error',
    message: 'Native archive did not complete; 1 session(s) verified. No sessions were deleted or imported.',
  };
  const errorStarted: Result = {
    ...started,
    operationID: error.operationID,
    sessionID: error.sessionID,
  };
  emit(errorStarted);
  route = { type: 'home' };
  emit(error);
  assert.deepEqual(route, { type: 'home' });
  assert.deepEqual(tabs, ['ses_other']);
  assert.deepEqual(toasts, [
    { title: 'Session archive', variant: 'info', message: started.message },
    { title: 'Session archive', variant: success.variant, message: success.message },
    { title: 'Session archive', variant: 'info', message: secondStarted.message },
    { title: 'Session archive', variant: secondSuccess.variant, message: secondSuccess.message },
    { title: 'Session archive', variant: 'info', message: errorStarted.message },
    { title: 'Session archive', variant: error.variant, message: error.message },
  ]);
  assert(typeof cleanup === 'function');
  await cleanup();
  assert.equal(listeners.size, 0);
  emit(error);
  assert.equal(toasts.length, 6);
}

test('terminal slash archive follows correlated completion after navigation, ignores unrelated results, and unsubscribes', async () => {
  const script = `await (${slashArchiveScenario.toString()})(${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)});`;
  await execute(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { timeout: 5_000 },
  );
});

async function pickerScenario(pluginURL: string) {
  const assert: typeof import('node:assert').strict = (
    await import('node:assert')
  ).strict;
  const { default: plugin }: typeof import('../src/tui.ts') = await import(
    pluginURL
  );
  type Layer = ReturnType<Parameters<Plugin.Context['keymap']['layer']>[0]>;
  type Picker = Parameters<Plugin.Context['ui']['dialog']['select']>[0];
  let commands: Layer['commands'];
  let picker: Picker | undefined;
  const older = {
    id: 'dc7a0ecb-00e6-451e-90a5-8338d3862f90',
    rootSessionID: 'ses_older',
    title: 'Release notes',
    createdAt: 1_700_000_000_000,
    sessionCount: 1,
  };
  const newer = {
    id: 'efc6dac0-4055-4bb2-9438-8ba375cbe008',
    rootSessionID: 'ses_newer',
    title: 'Release API changes',
    createdAt: older.createdAt + 86_400_000,
    sessionCount: 3,
  };
  const native = {
    id: 'ses_native',
    projectID: 'test-project',
    title: 'Release native session',
    location: { directory: '/synthetic/project' },
    time: { created: 1, updated: 2, archived: newer.createdAt + 86_400_000 },
  };
  const cleanup = await plugin.setup({
    location: { directory: '/synthetic/project' },
    client: {
      location: { get: async () => ({ project: { id: 'test-project' } }) },
      rpc: () => ({
        events: { on: () => () => {} },
        restoreMappings: async () => [],
        list: async () => [older, newer],
        read: () =>
          assert.fail('Cancelling the picker must not read an archive'),
      }),
      session: {
        list: async ({ archived }: { archived?: boolean }) => {
          assert.equal(archived, true);
          return { data: [native], cursor: {} };
        },
        update: () => assert.fail('Cancelling must not restore a native session'),
      },
    },
    keymap: {
      layer: (factory: () => Layer) => {
        commands = factory().commands;
      },
    },
    data: { on: () => () => {} },
    ui: {
      router: { current: () => ({ type: 'home' }) },
      dialog: {
        select: async (options: Picker) => {
          picker = options;
        },
      },
      toast: {
        show: () => assert.fail('Cancelling must not report a restore'),
      },
    },
  } as unknown as Plugin.Context);
  assert(commands);
  const restore = commands.find(
    (command) => command.id === 'simpod.session-archive.restore',
  );
  assert(restore);
  await restore.run();
  assert(picker);
  assert(picker.search);
  const selectedPicker = picker;
  const search = picker.search;
  const values = (query: string) =>
    search(query, selectedPicker.options).map((option) => option.value);
  assert.deepEqual(values(''), [native.id, newer.id, older.id]);
  assert.deepEqual(values('  API RELEASE  '), [newer.id]);
  assert.deepEqual(values('SES_NATIVE'), [native.id]);
  assert.deepEqual(values('SES_OLDER'), [older.id]);
  assert.deepEqual(values(newer.id.slice(0, 8)), [newer.id]);
  assert.deepEqual(values('missing title'), []);
  assert(typeof cleanup === 'function');
  await cleanup();
}

test('TUI restore picker combines native and legacy IDs in searchable newest-first order', async () => {
  const script = `await (${pickerScenario.toString()})(${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)});`;
  await execute(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { timeout: 5_000 },
  );
});

async function slashPickerScenario(
  pluginURL: string,
  outcome:
    | 'select'
    | 'cancel'
    | 'cancel-error'
    | 'target-mismatch'
    | 'result'
    | 'refresh-error',
) {
  const assert: typeof import('node:assert').strict = (
    await import('node:assert')
  ).strict;
  const { default: plugin }: typeof import('../src/tui.ts') = await import(
    pluginURL
  );
  type Created = Extract<OpenCodeEvent, { type: 'form.created' }>;
  type Picker = Parameters<Plugin.Context['ui']['dialog']['select']>[0];
  const location = {
    directory: '/synthetic/project',
    workspaceID: 'workspace',
  };
  const archive = {
    id: 'ses_restored',
    rootSessionID: 'ses_restored',
    title: 'Archived session',
    createdAt: 1_700_000_000_000,
    sessionCount: 2,
  };
  const native: SessionInfo = {
    id: archive.id,
    projectID: 'test-project',
    title: archive.title,
    location,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1, updated: 2, archived: archive.createdAt },
  };
  const child: SessionInfo = {
    ...structuredClone(native),
    id: 'ses_child',
    parentID: native.id,
  };
  const sessions = new Map([
    [native.id, native],
    [child.id, child],
  ]);
  const originalSessions = structuredClone(sessions);
  const legacy = {
    ...archive,
    id: 'f29e8df0-88b2-4d1b-b0fc-edc5f924dc00',
  };
  let receive: ((event: Created) => void) | undefined;
  let unsubscribed = false;
  let inlineFormVisible = true;
  const pickers: Picker[] = [];
  const inlineAtPopup: boolean[] = [];
  let route = { type: 'session', sessionID: 'ses_owner' };
  const replies: SessionFormReplyInput[] = [];
  const cancellations: SessionFormCancelInput[] = [];
  const writes: Array<{ sessionID: string; archived: boolean }> = [];
  const refreshed: string[] = [];
  const opened: string[] = [];
  const toasts: Array<Parameters<Plugin.Context['ui']['toast']['show']>[0]> =
    [];
  const cleanup = await plugin.setup({
    // The form location, not the TUI default or its current session, owns restore.
    location: { directory: '/synthetic/default-project' },
    client: {
      location: {
        get: async (input: { location: LocationRef }) => {
          assert.deepEqual(input.location, location);
          return { project: { id: 'test-project' } };
        },
      },
      rpc: () => ({
        events: { on: () => () => {} },
        restoreMappings: async (
          _input: object,
          scope: { location: LocationRef },
        ) => {
          assert.deepEqual(scope.location, location);
          return [];
        },
        // A lookup of the selected native ID would find both formats and open
        // another picker instead of restoring the archive the user selected.
        list: async () => [legacy],
        read: () =>
          assert.fail('A native selection must not read a legacy archive'),
      }),
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = sessions.get(sessionID);
          assert(
            session,
            'Restore must use the form location, not look up its owner',
          );
          return structuredClone(session);
        },
        list: async ({
          parentID,
          archived,
        }: {
          parentID?: string;
          archived?: boolean;
        }) => ({
          data: [...sessions.values()]
            .filter(
              (session) =>
                (parentID === undefined || session.parentID === parentID) &&
                (archived === undefined ||
                  (session.time.archived !== undefined) === archived),
            )
            .map((session) => structuredClone(session)),
          cursor: {},
        }),
        update: async (input: { sessionID: string; archived: boolean }) => {
          writes.push(input);
          const session = sessions.get(input.sessionID);
          assert(session);
          assert.equal(input.archived, false);
          delete session.time.archived;
        },
        import: () => assert.fail('Native restore must not import a session'),
        remove: () => assert.fail('Native restore must not delete a session'),
      },
    },
    keymap: { layer: () => {} },
    data: {
      on: (_type: string, handler: NonNullable<typeof receive>) => {
        receive = handler;
        return () => {
          unsubscribed = true;
        };
      },
      session: {
        invalidate: (sessionID: string) => refreshed.push(sessionID),
        sync: async () => {
          if (outcome === 'refresh-error')
            throw new Error('Refresh unavailable');
        },
        form: {
          reply: async (input: SessionFormReplyInput, scope: LocationRef) => {
            assert.deepEqual(scope, location);
            replies.push(input);
          },
          cancel: async (input: SessionFormCancelInput, scope: LocationRef) => {
            assert.deepEqual(scope, location);
            cancellations.push(input);
            if (outcome === 'cancel-error')
              throw new Error('Cancel unavailable');
            // Clearing the inline form is asynchronous in the public host API.
            await Promise.resolve();
            inlineFormVisible = false;
          },
        },
      },
    },
    ui: {
      router: {
        current: () => route,
        navigate: (next: typeof route) => {
          route = next;
        },
      },
      tabs: { open: (sessionID: string) => opened.push(sessionID) },
      dialog: {
        select: async (options: Picker) => {
          pickers.push(options);
          inlineAtPopup.push(inlineFormVisible);
          assert.equal(
            pickers.length,
            1,
            'A selected native ID must not open another picker',
          );
          return outcome === 'cancel' ? undefined : archive.id;
        },
        confirm: () => assert.fail('Restore must not ask for confirmation'),
      },
      toast: {
        show: (toast: (typeof toasts)[number]) => {
          toasts.push(toast);
        },
      },
    },
  } as unknown as Plugin.Context);
  assert(receive);
  const event: Created = {
    id: 'evt_restore',
    created: 1,
    type: 'form.created',
    location,
    data: {
      form: {
        id: 'form_restore',
        sessionID: 'ses_owner',
        title: 'Session archives',
        fields: [
          {
            key: 'archive',
            type: 'string',
            options: [{ value: archive.id, label: archive.title }],
          },
        ],
        metadata: {
          'simpod.session-restore.archives': [archive, legacy],
          ...(outcome === 'cancel'
            ? {}
            : {
                'simpod.session-restore.targetSessionID':
                  outcome === 'target-mismatch' ? 'ses_missing' : 'ses_child',
              }),
        },
      },
    },
  };
  const foreign = structuredClone(event);
  foreign.data.form.sessionID = 'ses_other';
  receive(foreign);
  const unrelated = structuredClone(event);
  unrelated.data.form.metadata = { kind: 'question' };
  receive(unrelated);

  if (outcome === 'result' || outcome === 'refresh-error') {
    event.data.form.metadata = {
      'simpod.session-restore.result': {
        rootSessionID: archive.rootSessionID,
        sessionIDs: ['ses_restored', 'ses_child'],
        message: '2 sessions restored. Archive retained.',
      },
    };
    event.data.form.fields = [
      {
        key: 'acknowledged',
        type: 'string',
        options: [{ value: 'done', label: 'Done' }],
      },
    ];
  }
  receive(event);
  // All fake host operations settle immediately; drain the event listener's
  // asynchronous work, including the cancellation and optional native restore.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const isResult = outcome === 'result' || outcome === 'refresh-error';
  if (!isResult) {
    assert.deepEqual(cancellations, [
      { sessionID: 'ses_owner', formID: 'form_restore' },
    ]);
    assert.deepEqual(replies, []);
  } else {
    assert.deepEqual(replies, [
      {
        sessionID: 'ses_owner',
        formID: 'form_restore',
        answer: { acknowledged: 'done' },
      },
    ]);
    assert.deepEqual(cancellations, []);
  }
  if (!isResult) {
    assert.equal(pickers.length, outcome === 'cancel-error' ? 0 : 1);
    assert.deepEqual(inlineAtPopup, outcome === 'cancel-error' ? [] : [false]);
    if (outcome !== 'cancel-error') {
      const picker = pickers[0];
      assert(picker);
      assert.deepEqual(
        picker.options.map((option) => option.value),
        [archive.id, legacy.id],
      );
    }
    if (outcome === 'select') {
      assert.deepEqual(writes, [
        { sessionID: archive.id, archived: false },
        { sessionID: 'ses_child', archived: false },
      ]);
      assert(
        [...sessions.values()].every(
          (session) => session.time.archived === undefined,
        ),
      );
      assert.deepEqual(refreshed, [archive.id, 'ses_child']);
      assert.deepEqual(opened, [archive.id]);
      assert.deepEqual(route, { type: 'session', sessionID: archive.id });
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0]?.variant, 'success');
    } else {
      assert.deepEqual(writes, []);
      assert.deepEqual(sessions, originalSessions);
      assert.deepEqual(refreshed, []);
      assert.deepEqual(opened, []);
      assert.deepEqual(route, { type: 'session', sessionID: 'ses_owner' });
      if (outcome === 'cancel') {
        assert.deepEqual(toasts, []);
      } else {
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0]?.variant, 'error');
        assert.match(
          toasts[0]?.message ?? '',
          outcome === 'cancel-error'
            ? /Cancel unavailable/
            : /Nothing was restored/,
        );
      }
    }
  } else {
    assert.deepEqual(pickers, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(sessions, originalSessions);
    assert.deepEqual(refreshed, ['ses_restored', 'ses_child']);
    assert.deepEqual(opened, outcome === 'result' ? ['ses_restored'] : []);
    assert.equal(
      route.sessionID,
      outcome === 'result' ? 'ses_restored' : 'ses_owner',
    );
    assert.equal(
      toasts.at(-1)?.variant,
      outcome === 'result' ? 'success' : 'warning',
    );
    if (outcome === 'refresh-error')
      assert.match(toasts.at(-1)?.message ?? '', /do not restore it again/);
  }
  assert(typeof cleanup === 'function');
  await cleanup();
  assert(unsubscribed);
}

test('terminal slash restore clears its marked inline form before the picker and restores only the selected tree', async (t) => {
  for (const outcome of [
    'select',
    'cancel',
    'cancel-error',
    'target-mismatch',
  ] as const) {
    await t.test(outcome, async () => {
      const script = `await (${slashPickerScenario.toString()})(${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)}, ${JSON.stringify(outcome)});`;
      await execute(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        { timeout: 5_000 },
      );
    });
  }
});

test('terminal slash restore presents completed results without another question or restore', async (t) => {
  for (const outcome of ['result', 'refresh-error'] as const) {
    await t.test(outcome, async () => {
      const script = `await (${slashPickerScenario.toString()})(${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)}, ${JSON.stringify(outcome)});`;
      await execute(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        { timeout: 5_000 },
      );
    });
  }
});

test('TUI worktree recovery is automatic and uses scoped archive-bound RPC', async (t) => {
  const script = `
    import { strict as assert } from 'node:assert';
    import plugin from ${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)};
    import { fingerprint } from ${JSON.stringify(new URL('../src/fingerprint.ts', import.meta.url).href)};
    const scenario = process.env.RECOVERY_SCENARIO;
    const location = { directory: '/synthetic/worktree/app' };
    const target = { projectID: 'test-project', directory: location.directory };
    const snapshot = { ...target, repository: '/synthetic/source', worktree: '/synthetic/worktree',
      commit: 'b'.repeat(40), branch: 'archived-branch', dirty: true };
    const bundle = {
      format: 'opencode-session-archive', version: scenario === 'saved' ? 2 : 1,
      id: 'f29e8df0-88b2-4d1b-b0fc-edc5f924dc00', createdAt: 3,
      projectID: 'test-project', rootSessionID: 'ses_archived',
      ...(scenario === 'saved' ? { worktrees: [snapshot] } : {}),
      sessions: [{ info: {
        id: 'ses_archived', projectID: 'test-project', title: 'Archived', location,
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
      }, messages: [] }],
    };
    const reference = { id: bundle.id, fingerprint: fingerprint(bundle) };
    const state = new Map();
    const prepared = [];
    const events = [];
    const toasts = [];
    const refreshed = [];
    let commands;
    let route = { type: 'home' };
    const assertScope = scope => assert.deepEqual(scope, { location });
    plugin.setup({
      location,
      client: {
        file: { list: async () => ({ location, data: [] }) },
        location: { get: async () => ({ project: { id: 'test-project' } }) },
        rpc: () => ({
          events: { on: () => () => {} },
          restoreMappings: async () => [],
          read: async ({ id }, scope) => { assertScope(scope); assert.equal(id, bundle.id); return structuredClone(bundle); },
          worktreeMissing: async ({ locations }, scope) => {
            assertScope(scope); assert.deepEqual(locations, [target]); return [target];
          },
          worktreePrepare: async ({ archive, request }, scope) => {
            assertScope(scope); assert.deepEqual(archive, reference);
            assert.deepEqual(request, { ...target, repository: snapshot.repository, worktree: snapshot.worktree,
              ref: snapshot.commit });
            const { ref, ...source } = request;
            const plan = { ...source, commit: snapshot.commit };
            prepared.push(plan);
            return plan;
          },
          worktreeRecreate: async ({ archive, plan }, scope) => {
            assertScope(scope); assert.deepEqual(archive, reference);
            assert.deepEqual(plan, prepared[0]);
            events.push('recreate');
            return null;
          },
        }),
        session: {
          list: async () => ({ data: [...state.values()].map(item => item.info), cursor: {} }),
          import: async data => { events.push('import'); state.set(data.info.id, structuredClone(data)); return data.info; },
        },
        message: { list: async ({ sessionID }) => ({ data: state.get(sessionID).messages, cursor: {} }) },
      },
      keymap: { layer: factory => { commands = factory().commands; } },
      data: { on: () => () => {}, session: { invalidate: id => refreshed.push(id), sync: async () => {} } },
      ui: {
        router: { current: () => route, navigate: next => { route = next; } },
        tabs: { open: () => events.push('open') },
        toast: { show: toast => toasts.push(toast) },
        dialog: {
          prompt: () => assert.fail('Recovery must not ask for input'),
          confirm: () => assert.fail('Recovery must not ask for confirmation'),
        },
      },
    });
    await commands.find(command => command.id === 'simpod.session-archive.restore').run(bundle.id);
    if (scenario === 'saved') {
      assert.deepEqual(events, ['recreate', 'import', 'open']);
      assert.deepEqual(refreshed, ['ses_archived']);
      assert.equal(route.sessionID, 'ses_archived');
      assert.equal(toasts.at(-1).variant, 'success');
      assert.match(toasts.at(-1).message, /Uncommitted or untracked files were not recovered/);
    } else {
      assert.deepEqual(prepared, []);
      assert.deepEqual(events, []);
      assert.deepEqual(refreshed, []);
      assert.equal(state.size, 0);
      assert.deepEqual(route, { type: 'home' });
      assert.equal(toasts.at(-1).variant, 'error');
      assert.match(toasts.at(-1).message, /archive.*(metadata|recorded|repository)/i);
    }
  `;
  for (const scenario of ['saved', 'legacy']) {
    await t.test(scenario, async () => {
      await execute(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        {
          env: { ...process.env, RECOVERY_SCENARIO: scenario },
          timeout: 5_000,
        },
      );
    });
  }
});
