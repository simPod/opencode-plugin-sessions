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
import type { ArchiveBundle } from '../src/schema.ts';
import { fingerprint } from '../src/fingerprint.ts';
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
): ArchiveBundle {
  const info: SessionInfo = {
    id: 'ses_fixture',
    projectID,
    title: 'Synthetic fixture',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1700000000000, updated: 1700000000001 },
    location: { directory: '/synthetic/project' },
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
  assert.deepEqual(await storage.list(), [
    {
      id: original.id,
      rootSessionID: original.rootSessionID,
      title: 'Synthetic fixture',
      createdAt: original.createdAt,
      sessionCount: 1,
    },
  ]);
  await assert.rejects(
    storage.save({ ...original, createdAt: original.createdAt + 1 }),
    /Cannot save archive/,
  );
  assert.deepEqual(await readFile(saved.path), bytes);
  assert.deepEqual(await readdir(dirname(saved.path)), [`${saved.id}.json`]);
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
});

test('corrupt JSON, checksum, and native transfer data fail visibly without disclosing content', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(bundle());
  const valid = await readFile(saved.path, 'utf8');
  const invalid = {
    ...bundle('project-a', saved.id),
    sessions: [{ info: { id: 'ses_fixture' }, messages: [] }],
  };
  const variants = [
    '{"private-transcript":"secret text",',
    valid.replace(
      /"checksum":"[a-f0-9]{64}"/,
      `"checksum":"${'0'.repeat(64)}"`,
    ),
    JSON.stringify({ checksum: fingerprint(invalid), bundle: invalid }),
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
  const foreign = join(directory, 'foreign.json');
  const foreignBytes = await readFile(saved.path);
  await writeFile(foreign, foreignBytes, { mode: 0o600 });
  for (const id of ['../foreign', foreign, `${saved.id}/../../foreign`]) {
    await assert.rejects(storage.read(id), /Invalid archive ID/);
  }
  await rm(saved.path);
  await symlink(foreign, saved.path);
  await assert.rejects(storage.read(saved.id), /Cannot read archive/);
  await assert.rejects(storage.list(), /Cannot list archives/);
  await assert.rejects(
    storage.save(bundle('project-a', saved.id)),
    /Cannot save archive/,
  );
  assert.deepEqual(await readFile(foreign), foreignBytes);
  await rm(saved.path);
  await writeFile(saved.path, foreignBytes, { mode: 0o644 });
  await assert.rejects(storage.read(saved.id), /Cannot read archive/);
  await chmod(saved.path, 0o600);
  for (const path of [dirname(saved.path), storageDirectory]) {
    await chmod(path, 0o755);
    await assert.rejects(storage.list(), /Cannot list archives/);
    assert.equal((await stat(path)).mode & 0o777, 0o755);
    await chmod(path, 0o700);
  }
  const linkedRoot = join(directory, 'linked-root');
  await symlink(storageDirectory, linkedRoot);
  const linked = new FileArchiveStorage({
    storageDirectory: linkedRoot,
    projectID: 'project-a',
    projectName: 'Sample project',
  });
  await assert.rejects(linked.read(saved.id), /Cannot read archive/);
  const projectPath = dirname(saved.path);
  await rm(projectPath, { recursive: true });
  await symlink(directory, projectPath);
  await assert.rejects(storage.list(), /Cannot list archives/);
});
