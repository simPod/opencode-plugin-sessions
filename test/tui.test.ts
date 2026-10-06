import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('TUI registers only archive and restore, and restores by selection or ID without confirmation', async () => {
  // Drive the real plugin registration with native-client responses and a
  // stateful in-memory session/store. Never change a real OpenCode session.
  const script = `
    import { strict as assert } from 'node:assert';
    import plugin from ${JSON.stringify(new URL('../src/tui.ts', import.meta.url).href)};
    const original = { info: {
      id: 'ses_test', projectID: 'test-project', title: 'Test session',
      location: { directory: '/synthetic/project' },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }, messages: [] };
    const state = new Map([[original.info.id, structuredClone(original)]]);
    let bundle;
    let commands;
    let selections = 0;
    let route = { type: 'session', sessionID: 'ses_test' };
    const toasts = [];
    plugin.setup({
      location: { directory: '/synthetic/project' },
      client: {
        location: { get: async () => ({ project: { id: 'test-project' } }) },
        rpc: () => ({
          list: async () => bundle ? [{ id: bundle.id, title: 'Test session', createdAt: bundle.createdAt, sessionCount: 1, rootSessionID: 'ses_test' }] : [],
          read: async () => structuredClone(bundle),
          save: async (input) => { bundle = structuredClone(input.bundle); return { id: bundle.id, path: '/synthetic/archive.json' }; },
        }),
        session: {
          get: async ({ sessionID }) => structuredClone(state.get(sessionID).info),
          list: async ({ parentID }) => ({ data: [...state.values()].filter(item => !parentID || item.info.parentID === parentID).map(item => structuredClone(item.info)), cursor: {} }),
          active: async () => ({}), inbox: { list: async () => [] },
          export: async ({ sessionID }) => structuredClone(state.get(sessionID)),
          remove: async ({ sessionID }) => { state.delete(sessionID); },
          import: async (data) => { state.set(data.info.id, structuredClone(data)); return structuredClone(data.info); },
        },
        message: { list: async ({ sessionID }) => ({ data: structuredClone(state.get(sessionID).messages), cursor: {} }) },
      },
      keymap: { layer: (factory) => { commands = factory().commands; } },
      data: { session: { invalidate: () => {}, sync: async () => {} } },
      ui: {
        router: { current: () => route, navigate: (next) => { route = next; } },
        tabs: { enabled: () => false, open: () => {} },
        toast: { show: (toast) => toasts.push(toast) },
        dialog: {
          confirm: () => assert.fail('Confirmation must not be requested'),
          select: async () => { selections++; return bundle.id; },
        },
      },
    });
    assert.deepEqual(commands.map(command => command.slash.name), ['session-archive', 'session-restore']);
    assert(commands.every(command => !command.slash.aliases?.length));
    const archive = commands.find(command => command.slash.name === 'session-archive');
    await archive.run();
    assert.equal(state.size, 0);
    assert.deepEqual(bundle.sessions, [original]);
    assert.equal(route.type, 'home');
    const restore = commands.find(command => command.slash.name === 'session-restore');
    await restore.run();
    assert.equal(selections, 1);
    assert.equal(route.sessionID, 'ses_test');
    assert.deepEqual(state.get('ses_test').messages, original.messages);
    assert.equal(toasts.at(-1).variant, 'success');
    await archive.run();
    assert.equal(state.size, 0);
    await restore.run(bundle.id);
    assert.equal(selections, 1);
    assert.equal(route.sessionID, 'ses_test');
    assert.deepEqual(state.get('ses_test').messages, original.messages);
    assert.equal(toasts.at(-1).variant, 'success');
    console.log('Archive and selected restore completed without confirmation.');
  `;
  const result = await execute(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { timeout: 5_000 },
  );
  assert.match(result.stdout, /completed without confirmation/);
});
