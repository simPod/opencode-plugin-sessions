import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { LocationRef, SessionTransferData } from '@opencode/client';
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
  const state = new Map([[original.info.id, structuredClone(original)]]);
  const bundles = new Map<string, ArchiveBundle>();
  let savedID: string | undefined;
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
  let confirmed = false;
  let beforeConfirm: (() => void) | undefined;
  const confirmations: Array<{ message: string }> = [];
  const tabs: Array<{ sessionID: string }> = [];
  let imports = 0;
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
        save: async (input: { bundle: ArchiveBundle }) => {
          const item = structuredClone(input.bundle);
          savedID = item.id;
          bundles.set(item.id, item);
          return { id: item.id, path: '/synthetic/archive.json' };
        },
      }),
      session: {
        get: async ({ sessionID }: { sessionID: string }) =>
          structuredClone(session(sessionID).info),
        list: async ({ parentID }: { parentID?: string }) => ({
          data: [...state.values()]
            .filter((item) => !parentID || item.info.parentID === parentID)
            .map((item) => structuredClone(item.info)),
          cursor: {},
        }),
        active: async () => ({}),
        inbox: { list: async () => [] },
        export: async ({ sessionID }: { sessionID: string }) =>
          structuredClone(session(sessionID)),
        remove: async ({ sessionID }: { sessionID: string }) => {
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
    data: { session: { invalidate: () => {}, sync: async () => {} } },
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
        confirm: async (options: { message: string }) => {
          confirmations.push(options);
          beforeConfirm?.();
          return confirmed;
        },
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
  assert.deepEqual(commands.map((command) => command.slash?.name), [
    'session-archive',
    'session-restore',
    'session-delete',
  ]);
  assert(commands.every((command) => !command.slash?.aliases?.length));
  const archive = commands.find(
    (command) => command.slash?.name === 'session-archive',
  );
  const restore = commands.find(
    (command) => command.slash?.name === 'session-restore',
  );
  const remove = commands.find(
    (command) => command.slash?.name === 'session-delete',
  );
  assert(archive);
  assert(restore);
  assert(remove);
  await archive.run();
  assert.equal(state.size, 0);
  assert(savedID);
  assert.deepEqual(bundle(savedID).sessions, [original]);
  assert.equal(route.type, 'home');
  const archived = bundle(savedID);
  archived.projectID = 'old-project';
  const root = archived.sessions[0];
  assert(root);
  root.info.projectID = 'old-project';
  root.info.location.directory = '/synthetic/old-project';
  const child = structuredClone(root);
  child.info.id = 'ses_child';
  child.info.parentID = 'ses_test';
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
    const before = imports;
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
    await restore.run('ses_test');
    assert.equal(toasts.at(-1)?.variant, 'warning');
    assert.match(toasts.at(-1)?.message ?? '', /operation is in progress/);
  } finally {
    assert(release);
    release();
    await pending;
  }
  assert.equal(imports, before);
  assert.equal(confirmations.length, 0);

  // Deletion uses the connected client only, leaves archives unchanged, and
  // removes tabs for descendants without closing unrelated sessions.
  const retainedArchives = structuredClone(bundles);
  for (const outcome of [
    'cancel',
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
    confirmed = outcome !== 'cancel';
    beforeConfirm =
      outcome === 'changed'
        ? () => {
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
      if (outcome === 'changed')
        assert.match(toasts.at(-1)?.message ?? '', /family changed/);
    }
    assert.deepEqual(bundles, retainedArchives);
    assert.match(
      confirmations.at(-1)?.message ?? '',
      /Active work will stop.*No archive.*cannot be undone/,
    );
  }
  beforeConfirm = undefined;
  route = { type: 'home' };
  const confirmationCount = confirmations.length;
  await remove.run();
  assert.match(toasts.at(-1)?.message ?? '', /Use \/session-delete/);
  await remove.run('invalid');
  assert.match(toasts.at(-1)?.message ?? '', /Use \/session-delete/);
  assert.equal(confirmations.length, confirmationCount);

  state.set('ses_test', structuredClone(original));
  const pendingChild = structuredClone(original);
  pendingChild.info.id = 'ses_child';
  pendingChild.info.parentID = 'ses_test';
  state.set('ses_child', pendingChild);
  confirmed = true;
  beforeConfirm = () => cleanup();
  await remove.run('ses_test');
  assert(state.has('ses_test'));
  assert(state.has('ses_child'));
  assert.equal(toasts.at(-1)?.variant, 'error');
  assert.match(toasts.at(-1)?.message ?? '', /aborted/i);
  console.log('Archive and session-ID restore completed without confirmation.');
}

test('TUI archives, restores by ID or selection, and confirms deletion with tab cleanup', async () => {
  const script = `await (${scenario.toString()})(${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)});`;
  const result = await execute(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { timeout: 5_000 },
  );
  assert.match(result.stdout, /completed without confirmation/);
});
