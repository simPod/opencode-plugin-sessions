import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('server archive listing finds root and descendant session IDs without returning transcripts', async (t) => {
  const storageDirectory = await mkdtemp(join(tmpdir(), 'session-plugin-lookup-'));
  t.after(() => rm(storageDirectory, { recursive: true, force: true }));
  const script = `
    import { strict as assert } from 'node:assert';
    import { randomUUID } from 'node:crypto';
    import plugin from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    let archive;
    const cleanup = await plugin.setup({
      options: { storageDirectory: process.env.ARCHIVE_STORAGE },
      location: { directory: '/synthetic/project', project: {
        id: 'project-lookup', canonical: '/synthetic/project',
      } },
      rpc: { register: async (_definition, handlers) => {
        archive = handlers;
        return { dispose: async () => {} };
      } },
      command: { transform: async () => ({ dispose: async () => {} }) },
    });
    const info = {
      id: 'ses_root', projectID: 'project-lookup', title: 'Lookup session',
      location: { directory: '/synthetic/project' }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    };
    const bundle = {
      format: 'opencode-session-archive', version: 1, id: randomUUID(),
      createdAt: 3, projectID: info.projectID, rootSessionID: info.id,
      sessions: [
        { info, messages: [] },
        { info: { ...info, id: 'ses_child', parentID: info.id, projectID: 'other-project' }, messages: [] },
      ],
    };
    await archive.save({ bundle });
    const repeated = { ...bundle, id: randomUUID(), createdAt: 4 };
    await archive.save({ bundle: repeated });
    const unrelated = {
      ...bundle, id: randomUUID(), rootSessionID: 'ses_unrelated',
      sessions: [{ info: { ...info, id: 'ses_unrelated' }, messages: [] }],
    };
    await archive.save({ bundle: unrelated });
    for (const sessionID of ['ses_root', 'ses_child']) {
      const matches = await archive.list({ sessionID });
      assert.deepEqual(new Set(matches.map(item => item.id)), new Set([bundle.id, repeated.id]));
      assert(matches.every(item => !('sessions' in item)));
    }
    assert.deepEqual(await archive.list({ sessionID: 'ses_missing' }), []);
    assert.equal((await archive.list({})).length, 3);
    await cleanup();
  `;
  await execute(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { env: { ...process.env, ARCHIVE_STORAGE: storageDirectory } },
  );
});

test('server plugin uses its home-directory default and honors explicit storage overrides', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'session-plugin-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // A separate server process keeps HOME changes out of other tests. Share its
  // Effect runtime with transitive SDK imports, as the OpenCode host does.
  // Its RPC registration calls the real handler to create project storage.
  const script = `
    import { strict as assert } from 'node:assert';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'effect' || specifier.startsWith('effect/'))
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      return nextResolve(specifier, context);
    } });
    const { default: plugin } = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
    const commands = [];
    await plugin.setup({
      options: JSON.parse(process.env.ARCHIVE_OPTIONS),
      location: { directory: '/synthetic/project', project: {
        id: 'project-default-test', canonical: '/synthetic/project',
      } },
      rpc: { register: async (_definition, handlers) => {
        assert.deepEqual(await handlers.restoreMappings({}), JSON.parse(process.env.ARCHIVE_OPTIONS).restoreMappings ?? []);
        await handlers.list({});
        return { dispose: async () => {} };
      } },
      command: { transform: async (register) => {
        register({ add: (command) => commands.push(command.name) });
        return { dispose: async () => {} };
      } },
    });
    assert.deepEqual(commands.sort(), ['session-archive', 'session-delete', 'session-id', 'session-restore']);
  `;
  const cases = [
    {
      name: 'default ignores XDG_DATA_HOME',
      options: {},
      directory: join(home, '.opencode-session-archives'),
    },
    {
      name: 'home-relative override',
      options: { storageDirectory: '~/custom-archives' },
      directory: join(home, 'custom-archives'),
    },
    {
      name: 'absolute override',
      options: { storageDirectory: join(home, 'absolute-archives') },
      directory: join(home, 'absolute-archives'),
    },
    {
      name: 'server restore mappings are exposed through RPC',
      options: {
        restoreMappings: [
          {
            from: {
              projectID: 'project-old',
              directory: '/synthetic/old-project',
            },
            to: {
              projectID: 'project-default-test',
              directory: '/synthetic/project',
            },
          },
        ],
      },
      directory: join(home, '.opencode-session-archives'),
    },
  ];
  for (const row of cases)
    await t.test(row.name, async () => {
      await execute(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            HOME: home,
            XDG_DATA_HOME: join(home, 'xdg'),
            ARCHIVE_OPTIONS: JSON.stringify(row.options),
          },
        },
      );
      const folders = await readdir(row.directory);
      assert.equal(folders.length, 1);
      assert.match(folders[0] ?? '', /^project--[a-f0-9]{64}$/);
      assert.deepEqual(
        await readdir(join(row.directory, folders[0] ?? '')),
        [],
      );
    });
  for (const invalid of ['relative directory', 'duplicate source'])
    await t.test(`rejects ${invalid}`, async () => {
      const mapping = {
        from: { projectID: 'project-old', directory: '/synthetic/old-project' },
        to: {
          projectID: 'project-default-test',
          directory: '/synthetic/project',
        },
      };
      const restoreMappings = [mapping];
      if (invalid === 'relative directory') mapping.to.directory = 'relative';
      else restoreMappings.push(structuredClone(mapping));
      const untouched = join(home, `invalid-${invalid.replaceAll(' ', '-')}`);
      await assert.rejects(
        execute(
          process.execPath,
          ['--experimental-strip-types', '--input-type=module', '-e', script],
          {
            env: {
              ...process.env,
              HOME: home,
              ARCHIVE_OPTIONS: JSON.stringify({
                storageDirectory: untouched,
                restoreMappings,
              }),
            },
          },
        ),
        invalid === 'relative directory'
          ? /absolute server paths/
          : /Duplicate restore mapping source/,
      );
      await assert.rejects(readdir(untouched), { code: 'ENOENT' });
    });
  await assert.rejects(readdir(join(home, 'xdg')), { code: 'ENOENT' });
});

test('server worktree RPC inspects server paths and binds recovery to the selected mapped archive', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'session-plugin-rpc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `
    import { strict as assert } from 'node:assert';
    import { join } from 'node:path';
    import { writeFile } from 'node:fs/promises';
    import plugin from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    import { fingerprint } from ${JSON.stringify(new URL('../src/fingerprint.ts', import.meta.url).href)};
    const directory = process.env.RPC_DIRECTORY;
    const old = { projectID: 'old-project', directory: '/synthetic/old-worktree' };
    const target = { projectID: 'server-project', directory: join(directory, 'missing-worktree') };
    let handlers;
    const dispose = await plugin.setup({
      options: { storageDirectory: join(directory, 'archives'), restoreMappings: [{ from: old, to: target }] },
      location: { directory: target.directory, project: { id: 'server-project', canonical: directory } },
      rpc: { register: async (_definition, registered) => { handlers = registered; return { dispose: async () => {} }; } },
      command: { transform: async register => { register({ add: () => {} }); return { dispose: async () => {} }; } },
    });
    try {
      const present = { projectID: 'server-project', directory };
      assert.deepEqual(await handlers.worktreeCapture({ locations: [present] }), []);
      assert.deepEqual(await handlers.worktreeMissing({ locations: [present, target] }), [target]);
      const bundle = {
        format: 'opencode-session-archive', version: 2, worktrees: [],
        id: 'db67c1d5-89e7-45c0-b2fa-636df671623c', createdAt: 3,
        projectID: old.projectID, rootSessionID: 'ses_archived',
        sessions: [{ info: {
          id: 'ses_archived', projectID: old.projectID, title: 'Archived', location: { directory: old.directory },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
        }, messages: [] }],
      };
      // Save to the source project's archive storage, as a mapped archive would be.
      const { FileArchiveStorage } = await import(${JSON.stringify(new URL('../src/storage.ts', import.meta.url).href)});
      const sourceStorage = new FileArchiveStorage({
        storageDirectory: join(directory, 'archives'), projectID: old.projectID,
        projectName: 'old-worktree', projectDirectory: old.directory,
      });
      const saved = await sourceStorage.save(bundle);
      assert.deepEqual(await handlers.read({ id: bundle.id }), bundle);
      const archive = { id: bundle.id, fingerprint: fingerprint(bundle) };
      const source = { repository: join(directory, 'unavailable-repository'), worktree: target.directory };
      const request = { ...target, ...source, ref: 'feature/session' };
      const plan = { ...target, ...source, commit: 'c'.repeat(40) };
      for (const [method, field, payload] of [
        ['worktreePrepare', 'request', request], ['worktreeRecreate', 'plan', plan],
      ]) {
        await assert.rejects(handlers[method]({ archive: { ...archive, fingerprint: '0'.repeat(64) }, [field]: payload }), /archive changed after inspection/);
        await assert.rejects(handlers[method]({ archive, [field]: { ...payload, directory: join(directory, 'unrelated') } }), /must belong to the selected archive/);
        await assert.rejects(handlers[method]({ archive, [field]: { ...payload, ...old } }), /must belong to the selected archive/);
        // Matching mapped targets pass the archive guard and reach server Git validation.
        await assert.rejects(handlers[method]({ archive, [field]: payload }), /source repository is unavailable/);
      }
      const changed = { ...bundle, createdAt: 4 };
      await writeFile(saved.path, JSON.stringify({ checksum: fingerprint(changed), bundle: changed }));
      await assert.rejects(handlers.worktreeRecreate({ archive, plan }), /archive changed after inspection/);
      assert.deepEqual(await handlers.worktreeMissing({ locations: [target] }), [target]);
    } finally {
      await dispose();
    }
  `;
  await execute(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      env: { ...process.env, RPC_DIRECTORY: directory },
      timeout: 10_000,
    },
  );
});
