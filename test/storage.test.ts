import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { SessionInfo } from '@opencode/client';
import type {
  ArchiveBundle,
  ArchiveSummary,
  RestoreMapping,
} from '../src/schema.ts';
import { fingerprint } from '../src/fingerprint.ts';
import { restoreStorage } from '../src/restore-storage.ts';
import { FileArchiveStorage } from '../src/storage.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'session-archive-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storageDirectory = join(directory, 'archives');
  const storage = new FileArchiveStorage({
    storageDirectory,
    projectID: 'project-a',
    projectName: 'Sample project',
  });
  return { directory, storageDirectory, storage };
}

function bundle(
  projectID = 'project-a',
  id: string = randomUUID(),
  directory = '/synthetic/project',
): ArchiveBundle {
  const info: SessionInfo = {
    id: 'ses_fixture',
    projectID,
    title: 'Synthetic fixture',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1700000000000, updated: 1700000000001 },
    location: { directory },
    metadata: { fixture: 'Unicode: č 🌱\nNUL: \u0000\nquotes: " and \\' },
  };
  return {
    format: 'opencode-session-archive',
    version: 1,
    id,
    createdAt: 1700000000002,
    projectID,
    rootSessionID: info.id,
    sessions: [{ info, messages: [] }],
  };
}

test('private archive round-trip preserves exact JSON bytes and publishes without overwrite', async (t) => {
  const { storage, storageDirectory } = await fixture(t);
  const original = bundle();
  const root = original.sessions[0];
  assert(root);
  original.sessions.push({
    info: {
      ...root.info,
      id: 'ses_child',
      parentID: root.info.id,
      projectID: 'project-b',
      location: { directory: '/synthetic/other-project' },
    },
    messages: [],
  });
  const saved = await storage.save(original);
  assert.deepEqual(await storage.read(saved.id), original);
  const bytes = await readFile(saved.path);
  assert(
    bytes
      .subarray(bytes.indexOf('"bundle":') + '"bundle":'.length, -1)
      .equals(Buffer.from(JSON.stringify(original))),
  );
  assert(bytes.includes(Buffer.from('č 🌱')));
  assert(bytes.includes(Buffer.from('\\u0000')));
  assert.equal((await stat(storageDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(dirname(saved.path))).mode & 0o777, 0o700);
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(saved.path)), [`${saved.id}.json`]);
  const summaries: ArchiveSummary[] = [
    {
      id: original.id,
      rootSessionID: original.rootSessionID,
      title: 'Synthetic fixture',
      createdAt: original.createdAt,
      sessionCount: 2,
    },
  ];
  assert.deepEqual(await storage.list(), summaries);
  assert.deepEqual(await storage.list('ses_fixture'), summaries);
  assert.deepEqual(await storage.list('ses_child'), summaries);
  assert.deepEqual(await storage.list('ses_missing'), []);
  await assert.rejects(
    storage.save({ ...original, createdAt: original.createdAt + 1 }),
    /Cannot save archive/,
  );
  assert.deepEqual(await readFile(saved.path), bytes);
  assert.deepEqual(await readdir(dirname(saved.path)), [`${saved.id}.json`]);

  const current = new FileArchiveStorage({
    storageDirectory,
    projectID: 'project-new',
    projectName: 'New project',
  });
  const view = restoreStorage(current, {
    storageDirectory,
    projectID: 'project-new',
    directory: '/synthetic/new',
    restoreMappings: [
      {
        from: { projectID: 'project-a', directory: '/synthetic/project' },
        to: { projectID: 'project-new', directory: '/synthetic/new' },
      },
    ],
  });
  assert.deepEqual(await view.list(), summaries);
  assert.deepEqual(await view.list('ses_child'), summaries);
  assert.deepEqual(await view.list('ses_missing'), []);
  assert.deepEqual(await view.read(saved.id), original);
  const newBundle = bundle('project-new', randomUUID(), '/synthetic/new');
  const newSaved = await view.save(newBundle);
  assert.notEqual(dirname(newSaved.path), dirname(saved.path));
  assert.deepEqual(await current.read(newSaved.id), newBundle);
  assert.deepEqual(await readFile(saved.path), bytes);
  assert.equal((await stat(dirname(saved.path))).mode & 0o777, 0o700);
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
});

test('restore discovery admits only exact mapped roots and deduplicates shared Git folders', async (t) => {
  const { storage, storageDirectory } = await fixture(t);
  const first = await storage.save(bundle());
  const second = await storage.save(
    bundle('project-a', randomUUID(), '/synthetic/second'),
  );
  const unmapped = await storage.save(
    bundle('project-a', randomUUID(), '/synthetic/unmapped'),
  );
  const current = new FileArchiveStorage({
    storageDirectory,
    projectID: 'project-new',
    projectName: 'New project',
  });
  const scope = { projectID: 'project-new', directory: '/synthetic/new' };
  const mappings: RestoreMapping[] = [
    { from: { projectID: 'project-a', directory: '/synthetic/project' }, to: scope },
    { from: { projectID: 'project-a', directory: '/synthetic/second' }, to: scope },
    {
      from: { projectID: 'project-a', directory: '/synthetic/unmapped' },
      to: { ...scope, directory: '/synthetic/other-worktree' },
    },
  ];
  const view = restoreStorage(current, {
    storageDirectory,
    ...scope,
    restoreMappings: mappings,
  });
  assert.deepEqual(
    new Set((await view.list()).map(({ id }) => id)),
    new Set([first.id, second.id]),
  );
  assert.deepEqual(
    new Set((await view.list('ses_fixture')).map(({ id }) => id)),
    new Set([first.id, second.id]),
  );
  assert.equal(
    (await view.read(first.id)).sessions[0]?.info.location.directory,
    '/synthetic/project',
  );
  assert.equal(
    (await view.read(second.id)).sessions[0]?.info.location.directory,
    '/synthetic/second',
  );
  await assert.rejects(view.read(unmapped.id), /Cannot read archive/);
  const wrongScope = restoreStorage(current, {
    storageDirectory,
    projectID: 'project-new',
    directory: '/synthetic/other',
    restoreMappings: mappings,
  });
  assert.deepEqual(await wrongScope.list(), []);
  assert.deepEqual(await wrongScope.list('ses_fixture'), []);
  await assert.rejects(wrongScope.read(first.id), /Cannot read archive/);
  const wrongProject = restoreStorage(current, {
    storageDirectory,
    projectID: 'project-other',
    directory: scope.directory,
    restoreMappings: mappings,
  });
  assert.deepEqual(await wrongProject.list(), []);
  await assert.rejects(wrongProject.read(first.id), /Cannot read archive/);

  const currentBundle = bundle('project-new', unmapped.id, scope.directory);
  await view.save(currentBundle);
  assert.deepEqual(
    new Set((await view.list()).map(({ id }) => id)),
    new Set([first.id, second.id, unmapped.id]),
  );
  assert.deepEqual(await view.read(unmapped.id), currentBundle);

  const own = restoreStorage(storage, {
    storageDirectory,
    projectID: 'project-a',
    directory: '/synthetic/another-worktree',
    restoreMappings: [
      {
        from: { projectID: 'project-a', directory: '/synthetic/project' },
        to: { projectID: 'project-a', directory: '/synthetic/another-worktree' },
      },
    ],
  });
  assert.equal((await own.list()).length, 3);
  assert.equal((await own.read(unmapped.id)).projectID, 'project-a');
});

test('global restore discovery keeps directories separate unless their exact pairs are mapped', async (t) => {
  const { storageDirectory } = await fixture(t);
  const createGlobal = (directory: string) =>
    new FileArchiveStorage({
      storageDirectory,
      projectID: 'global',
      projectName: 'Same name',
      projectDirectory: directory,
    });
  const scope = { projectID: 'global', directory: '/non-git/current' };
  const current = createGlobal(scope.directory);
  const own = await current.save(bundle('global', randomUUID(), scope.directory));
  const old = createGlobal('/non-git/old');
  const oldSaved = await old.save(bundle('global', randomUUID(), '/non-git/old'));
  const other = createGlobal('/non-git/other');
  const otherSaved = await other.save(
    bundle('global', randomUUID(), '/non-git/other'),
  );
  const unmapped = restoreStorage(current, {
    storageDirectory,
    ...scope,
    restoreMappings: [],
  });
  assert.deepEqual((await unmapped.list()).map(({ id }) => id), [own.id]);
  await assert.rejects(unmapped.read(oldSaved.id), /Cannot read archive/);
  const view = restoreStorage(current, {
    storageDirectory,
    ...scope,
    restoreMappings: [
      { from: { projectID: 'global', directory: '/non-git/old' }, to: scope },
      { from: { projectID: 'global', directory: '/non-git/other' }, to: scope },
    ],
  });
  assert.deepEqual(
    new Set((await view.list()).map(({ id }) => id)),
    new Set([own.id, oldSaved.id, otherSaved.id]),
  );
  assert.equal(
    (await view.read(oldSaved.id)).sessions[0]?.info.location.directory,
    '/non-git/old',
  );
  assert.equal(
    (await view.read(otherSaved.id)).sessions[0]?.info.location.directory,
    '/non-git/other',
  );
});

test('restore discovery refuses duplicate eligible IDs instead of choosing a store', async (t) => {
  const { storage, storageDirectory } = await fixture(t);
  const original = bundle();
  await storage.save(original);
  const current = new FileArchiveStorage({
    storageDirectory,
    projectID: 'project-new',
    projectName: 'New project',
  });
  await current.save(bundle('project-new', original.id, '/synthetic/new'));
  const view = restoreStorage(current, {
    storageDirectory,
    projectID: 'project-new',
    directory: '/synthetic/new',
    restoreMappings: [
      {
        from: { projectID: 'project-a', directory: '/synthetic/project' },
        to: { projectID: 'project-new', directory: '/synthetic/new' },
      },
    ],
  });
  await assert.rejects(view.list(), /Cannot list archives/);
  await assert.rejects(view.read(original.id), /Cannot read archive/);
});

test('direct restores and backup verification ignore unrelated corrupt archives', async (t) => {
  for (const corruptLocation of ['primary', 'mapped source']) {
    await t.test(corruptLocation, async (t) => {
      const { storage, storageDirectory } = await fixture(t);
      const source = new FileArchiveStorage({
        storageDirectory,
        projectID: 'project-old',
        projectName: 'Old project',
      });
      const primaryBundle = bundle();
      const sourceBundle = bundle('project-old', randomUUID(), '/synthetic/old');
      await storage.save(primaryBundle);
      await source.save(sourceBundle);
      const corrupt =
        corruptLocation === 'primary'
          ? await storage.save(bundle())
          : await source.save(bundle('project-old', randomUUID(), '/synthetic/old'));
      await writeFile(corrupt.path, '{"private-transcript":"secret text",');
      const view = restoreStorage(storage, {
        storageDirectory,
        projectID: 'project-a',
        directory: '/synthetic/project',
        restoreMappings: [
          {
            from: { projectID: 'project-old', directory: '/synthetic/old' },
            to: { projectID: 'project-a', directory: '/synthetic/project' },
          },
        ],
      });
      for (const operation of [
        () => view.list(),
        () => view.read(corrupt.id),
      ]) {
        await assert.rejects(operation, (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /Cannot (read|list) archive/);
          assert(!error.message.includes('secret text'));
          return true;
        });
      }
      const newBundle = bundle();
      const newlySaved = await view.save(newBundle);
      assert.deepEqual(
        await Promise.all([
          view.read(primaryBundle.id),
          view.read(sourceBundle.id),
          view.read(newlySaved.id),
        ]),
        [primaryBundle, sourceBundle, newBundle],
      );
      if (corruptLocation === 'primary')
        await source.save(bundle('project-old', corrupt.id, '/synthetic/old'));
      else await view.save(bundle('project-a', corrupt.id));
      await assert.rejects(view.read(corrupt.id), /Cannot read archive/);
    });
  }
});

test('read-only source lookup leaves missing folders absent and refuses writes', async (t) => {
  const { directory, storageDirectory, storage } = await fixture(t);
  const missingRoot = join(directory, 'missing');
  for (const root of [missingRoot, storageDirectory]) {
    if (root === storageDirectory) await mkdir(root, { mode: 0o700 });
    const source = new FileArchiveStorage({
      storageDirectory: root,
      projectID: 'project-missing',
      projectName: 'Missing source',
      readOnly: true,
    });
    assert.deepEqual(await source.list(), []);
    assert.equal(await source.find(randomUUID()), undefined);
    await assert.rejects(source.read(randomUUID()), /Cannot read archive/);
    await assert.rejects(
      source.save(bundle('project-missing')),
      /Cannot save archive/,
    );
  }
  await assert.rejects(stat(missingRoot), { code: 'ENOENT' });
  assert.deepEqual(await readdir(storageDirectory), []);
  const saved = await storage.save(bundle());
  const scope = { projectID: 'project-a', directory: '/synthetic/project' };
  const view = restoreStorage(storage, {
    storageDirectory,
    ...scope,
    restoreMappings: [
      {
        from: { projectID: 'project-missing', directory: '/synthetic/missing' },
        to: scope,
      },
    ],
  });
  assert.deepEqual(await view.read(saved.id), await storage.read(saved.id));
  assert.equal((await view.list()).length, 1);
  assert.deepEqual(await readdir(storageDirectory), [
    basename(dirname(saved.path)),
  ]);
});

test('project identity survives renames and isolates projects with the same name', async (t) => {
  const { storage, storageDirectory } = await fixture(t);
  const original = bundle();
  const first = await storage.save(original);
  const renamed = new FileArchiveStorage({
    storageDirectory,
    projectID: 'project-a',
    projectName: '../../Renamed',
  });
  const second = await renamed.save(bundle());
  assert.equal(dirname(second.path), dirname(first.path));
  assert.deepEqual(await renamed.read(first.id), original);
  const other = new FileArchiveStorage({
    storageDirectory,
    projectID: 'project-b',
    projectName: 'Sample project',
  });
  const isolated = await other.save(bundle('project-b', original.id));
  assert.notEqual(dirname(isolated.path), dirname(first.path));
  assert.equal((await other.list()).length, 1);
  await assert.rejects(other.save(original), /Cannot save archive/);
  const wrongRoot = bundle();
  const root = wrongRoot.sessions[0];
  assert(root);
  root.info.projectID = 'project-b';
  await assert.rejects(storage.save(wrongRoot), /Cannot save archive/);
  await copyFile(first.path, isolated.path);
  await assert.rejects(other.read(first.id), /Cannot read archive/);
  const globalA = new FileArchiveStorage({
    storageDirectory,
    projectID: 'global',
    projectName: 'Sample project',
    projectDirectory: '/non-git/a',
  });
  const globalB = new FileArchiveStorage({
    storageDirectory,
    projectID: 'global',
    projectName: 'Sample project',
    projectDirectory: '/non-git/b',
  });
  const globalBundle = (directory: string): ArchiveBundle => {
    const value = bundle('global', original.id);
    const session = value.sessions[0];
    assert(session);
    session.info.location.directory = directory;
    return value;
  };
  const globalFirst = await globalA.save(globalBundle('/non-git/a'));
  const globalSecond = await globalB.save(globalBundle('/non-git/b'));
  assert.notEqual(dirname(globalFirst.path), dirname(globalSecond.path));
  await copyFile(globalFirst.path, globalSecond.path);
  await assert.rejects(globalB.read(globalFirst.id), /Cannot read archive/);
  const suffix = basename(dirname(first.path)).slice('Sample-project'.length);
  await mkdir(join(storageDirectory, `duplicate${suffix}`), { mode: 0o700 });
  await assert.rejects(renamed.list(), /Cannot list archives/);
  await assert.rejects(renamed.read(first.id), /Cannot read archive/);
  await assert.rejects(renamed.find(randomUUID()), /Cannot read archive/);
});

test('corrupt JSON, checksum, and native transfer data fail visibly without disclosing content', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(bundle());
  const valid = await readFile(saved.path, 'utf8');
  const invalid = {
    ...bundle('project-a', saved.id),
    sessions: [{ info: { id: 'ses_fixture' }, messages: [] }],
  };
  const wrongRoot = bundle('project-a', saved.id);
  const root = wrongRoot.sessions[0];
  assert(root);
  root.info.projectID = 'project-b';
  const duplicateMessages = bundle('project-a', saved.id);
  const duplicateRoot = duplicateMessages.sessions[0];
  assert(duplicateRoot);
  duplicateRoot.messages.push({
    id: 'msg_duplicate',
    type: 'user',
    time: { created: 1700000000000 },
    text: 'Synthetic message',
  });
  duplicateMessages.sessions.push({
    info: {
      ...duplicateRoot.info,
      id: 'ses_child',
      parentID: duplicateRoot.info.id,
      projectID: 'project-b',
    },
    messages: structuredClone(duplicateRoot.messages),
  });
  const variants = [
    '{"private-transcript":"secret text",',
    valid.replace(
      /"checksum":"[a-f0-9]{64}"/,
      `"checksum":"${'0'.repeat(64)}"`,
    ),
    JSON.stringify({ checksum: fingerprint(invalid), bundle: invalid }),
    JSON.stringify({ checksum: fingerprint(wrongRoot), bundle: wrongRoot }),
    JSON.stringify({
      checksum: fingerprint(duplicateMessages),
      bundle: duplicateMessages,
    }),
  ];
  for (const corrupt of variants) {
    await writeFile(saved.path, corrupt);
    for (const operation of [
      () => storage.read(saved.id),
      () => storage.list(),
    ]) {
      await assert.rejects(operation, (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /Cannot (read|list) archive/);
        assert(!error.message.includes('secret text'));
        return true;
      });
    }
  }
});

test('unsafe permissions, symlinks, and non-UUID paths cannot expose foreign files', async (t) => {
  const { directory, storageDirectory, storage } = await fixture(t);
  const saved = await storage.save(bundle());
  const readers = [
    storage,
    new FileArchiveStorage({
      storageDirectory,
      projectID: 'project-a',
      projectName: 'Read-only source',
      readOnly: true,
    }),
  ];
  const current = new FileArchiveStorage({
    storageDirectory,
    projectID: 'project-new',
    projectName: 'New project',
  });
  const view = restoreStorage(current, {
    storageDirectory,
    projectID: 'project-new',
    directory: '/synthetic/new',
    restoreMappings: [
      {
        from: { projectID: 'project-a', directory: '/synthetic/project' },
        to: { projectID: 'project-new', directory: '/synthetic/new' },
      },
    ],
  });
  const newSaved = await view.save(
    bundle('project-new', randomUUID(), '/synthetic/new'),
  );
  const foreign = join(directory, 'foreign.json');
  const foreignBytes = await readFile(saved.path);
  await writeFile(foreign, foreignBytes, { mode: 0o600 });
  for (const id of ['../foreign', foreign, `${saved.id}/../../foreign`]) {
    for (const reader of readers)
      await assert.rejects(reader.read(id), /Invalid archive ID/);
  }
  await rm(saved.path);
  await symlink(foreign, saved.path);
  for (const reader of readers) {
    await assert.rejects(reader.read(saved.id), /Cannot read archive/);
    await assert.rejects(reader.list(), /Cannot list archives/);
  }
  await assert.rejects(
    storage.save(bundle('project-a', saved.id)),
    /Cannot save archive/,
  );
  assert.deepEqual(await readFile(foreign), foreignBytes);
  await rm(saved.path);
  await writeFile(saved.path, foreignBytes, { mode: 0o644 });
  for (const reader of readers)
    await assert.rejects(reader.read(saved.id), /Cannot read archive/);
  await chmod(saved.path, 0o600);
  for (const path of [dirname(saved.path), storageDirectory]) {
    await chmod(path, 0o755);
    for (const reader of readers)
      await assert.rejects(reader.list(), /Cannot list archives/);
    await assert.rejects(view.read(newSaved.id), /Cannot read archive/);
    assert.equal((await stat(path)).mode & 0o777, 0o755);
    await chmod(path, 0o700);
  }
  const linkedRoot = join(directory, 'linked-root');
  await symlink(storageDirectory, linkedRoot);
  const linked = new FileArchiveStorage({
    storageDirectory: linkedRoot,
    projectID: 'project-a',
    projectName: 'Sample project',
    readOnly: true,
  });
  await assert.rejects(linked.read(saved.id), /Cannot read archive/);
  const projectPath = dirname(saved.path);
  await rm(projectPath, { recursive: true });
  await symlink(directory, projectPath);
  for (const reader of readers)
    await assert.rejects(reader.list(), /Cannot list archives/);
  await assert.rejects(view.read(newSaved.id), /Cannot read archive/);
});
