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
  // A separate server process keeps HOME changes out of other tests. Its RPC
  // registration calls the real handler, which creates project-scoped storage.
  const script = `
    import { strict as assert } from 'node:assert';
    import plugin from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
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
    assert.deepEqual(commands.sort(), ['session-archive', 'session-delete', 'session-restore']);
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
