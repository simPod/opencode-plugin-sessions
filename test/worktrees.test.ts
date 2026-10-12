import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { WorktreeRequest } from '../src/schema.ts';
import { GitWorktrees } from '../src/worktrees.ts';

const execute = promisify(execFile);

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Worktree Test',
    '-c',
    'user.email=worktree@example.invalid',
    '-C',
    directory,
    ...args,
  ]);
  return stdout.trim();
}

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'session-archive-worktrees-')),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository');
  const worktree = join(directory, 'saved-worktree');
  await mkdir(repository);
  await git(repository, 'init', '--initial-branch=master');
  await mkdir(join(repository, 'src'));
  await writeFile(join(repository, 'src', 'file.txt'), 'saved content\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'Saved content');
  const commit = await git(repository, 'rev-parse', 'HEAD');
  const request: WorktreeRequest = {
    projectID: 'project-a',
    directory: join(worktree, 'src'),
    worktree,
    repository,
    ref: commit,
  };
  const backend = new GitWorktrees(async (source) => {
    assert.equal(source, repository);
    return 'project-a';
  });
  return { directory, repository, worktree, commit, request, backend };
}

test('capture and recreation retain the saved commit after the branch moves', async (t) => {
  const { repository, worktree, commit, request, backend } = await fixture(t);
  await git(repository, 'worktree', 'add', '-b', 'saved', worktree, commit);
  const location = {
    projectID: request.projectID,
    directory: request.directory,
  };
  const [snapshot] = await backend.capture([location]);
  assert(snapshot);
  assert.deepEqual(snapshot, {
    ...location,
    worktree,
    repository,
    commit,
    branch: 'saved',
    dirty: false,
  });
  await writeFile(join(worktree, 'untracked.txt'), 'untracked\n');
  assert.equal((await backend.capture([location]))[0]?.dirty, true);
  await rm(join(worktree, 'untracked.txt'));
  await writeFile(join(worktree, 'src', 'file.txt'), 'unsaved content\n');
  assert.equal((await backend.capture([location]))[0]?.dirty, true);
  await git(repository, 'worktree', 'remove', '--force', worktree);
  await writeFile(join(repository, 'src', 'file.txt'), 'new branch content\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'Move branch');
  await git(repository, 'branch', '-f', 'saved', 'HEAD');
  assert.notEqual(await git(repository, 'rev-parse', 'saved'), snapshot.commit);
  assert.deepEqual(await backend.missing([location]), [location]);
  const plan = await backend.prepare({ ...request, ref: snapshot.commit });
  await backend.recreate(plan);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), snapshot.commit);
  assert.equal(
    await readFile(join(worktree, 'src', 'file.txt'), 'utf8'),
    'saved content\n',
  );
  assert.deepEqual(await backend.missing([location]), []);
  const [restored] = await backend.capture([location]);
  assert(restored);
  assert.equal(restored.dirty, false);
  assert.equal(restored.branch, undefined);
});

test('capture excludes ordinary repositories and non-Git directories', async (t) => {
  const { directory, repository, backend } = await fixture(t);
  const plain = join(directory, 'plain');
  await mkdir(plain);
  assert.deepEqual(
    await backend.capture([
      { projectID: 'project-a', directory: repository },
      { projectID: 'global', directory: plain },
      { projectID: 'project-a', directory: join(directory, 'missing') },
    ]),
    [],
  );
});

test('missing distinguishes absent directories from broken symlinks and invalid paths', async (t) => {
  const { directory, request, backend } = await fixture(t);
  const location = {
    projectID: request.projectID,
    directory: request.directory,
  };
  assert.deepEqual(await backend.missing([location]), [location]);
  const broken = join(directory, 'broken');
  await symlink(join(directory, 'absent'), broken);
  for (const path of [broken, `${broken}/`, join(broken, 'child')])
    await assert.rejects(backend.missing([{ ...location, directory: path }]), {
      code: 'ENOENT',
    });
  const file = join(directory, 'file');
  await writeFile(file, 'not a directory');
  await assert.rejects(
    backend.missing([{ ...location, directory: file }]),
    /Not a directory/,
  );
  await assert.rejects(
    backend.missing([{ ...location, directory: join(file, 'child') }]),
    { code: 'ENOTDIR' },
  );
  const denied = join(directory, 'denied');
  await mkdir(denied);
  await chmod(denied, 0o000);
  try {
    await assert.rejects(
      backend.missing([{ ...location, directory: join(denied, 'child') }]),
      { code: 'EACCES' },
    );
  } finally {
    await chmod(denied, 0o700);
  }
});

test('a missing session subdirectory does not authorize replacing an existing worktree', async (t) => {
  const { repository, worktree, commit, request, backend } = await fixture(t);
  await git(repository, 'worktree', 'add', '--detach', worktree, commit);
  const location = {
    projectID: request.projectID,
    directory: join(worktree, 'absent-subdirectory'),
  };
  assert.deepEqual(await backend.missing([location]), [location]);
  await assert.rejects(
    backend.prepare({ ...request, directory: location.directory }),
    /already exists/,
  );
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), commit);
});

test('prepare rejects unavailable sources, wrong project identity, and unsafe targets', async (t) => {
  const { directory, repository, worktree, request, backend } =
    await fixture(t);
  await assert.rejects(
    backend.prepare({ ...request, repository: join(directory, 'absent') }),
    /source repository is unavailable/,
  );
  await assert.rejects(
    backend.prepare({ ...request, repository: join(repository, 'src') }),
    /repository root/,
  );
  await assert.rejects(
    backend.prepare({ ...request, projectID: 'other-project' }),
    /different project/,
  );
  await assert.rejects(
    backend.prepare({ ...request, projectID: 'global' }),
    /Global projects/,
  );
  await assert.rejects(
    backend.prepare({ ...request, directory: join(directory, 'outside') }),
    /inside the target/,
  );
  await assert.rejects(
    backend.prepare({ ...request, directory: `${worktree}-sibling` }),
    /inside the target/,
  );
  await mkdir(worktree);
  await assert.rejects(backend.prepare(request), /already exists/);
  await rm(worktree, { recursive: true });
  await symlink(join(directory, 'absent'), worktree);
  await assert.rejects(backend.prepare(request), /already exists/);
});

test('prepare resolves refs without interpreting options and recreate rechecks the target', async (t) => {
  const { repository, worktree, commit, request, backend } = await fixture(t);
  const plan = await backend.prepare({ ...request, ref: 'master' });
  assert.equal(plan.commit, commit);
  for (const ref of ['missing-ref', '--help', 'HEAD:src/file.txt'])
    await assert.rejects(backend.prepare({ ...request, ref }));
  await mkdir(worktree);
  await writeFile(join(worktree, 'keep.txt'), 'keep this directory');
  await assert.rejects(backend.recreate(plan), /already exists/);
  assert.equal(
    await readFile(join(worktree, 'keep.txt'), 'utf8'),
    'keep this directory',
  );
  await rm(worktree, { recursive: true });
  await rm(repository, { recursive: true });
  await assert.rejects(
    backend.recreate(plan),
    /source repository is unavailable/,
  );
});

test('stale worktree registration fails without forcing or pruning it', async (t) => {
  const { repository, worktree, commit, request, backend } = await fixture(t);
  await git(repository, 'worktree', 'add', '--detach', worktree, commit);
  await rm(worktree, { recursive: true });
  const plan = await backend.prepare(request);
  await assert.rejects(backend.recreate(plan), /already registered/);
  await assert.rejects(lstat(worktree), { code: 'ENOENT' });
  assert(
    (await git(repository, 'worktree', 'list', '--porcelain')).includes(
      worktree,
    ),
  );
});

test('capture and recreation suppress configured Git hooks, fsmonitor, and filters', async (t) => {
  const { directory, repository, request, backend } = await fixture(t);
  const marker = join(directory, 'command-ran');
  const hooks = join(directory, 'hooks');
  await mkdir(hooks);
  const hook = join(hooks, 'post-checkout');
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
  await chmod(hook, 0o700);
  await git(repository, 'config', 'core.hooksPath', hooks);
  await git(repository, 'config', 'core.fsmonitor', hook);
  await writeFile(
    join(repository, '.gitattributes'),
    'src/file.txt filter=unsafe\n',
  );
  await git(repository, 'add', '.gitattributes');
  await git(repository, 'commit', '-m', 'Configure a checkout filter');
  await git(repository, 'config', 'filter.unsafe.clean', hook);
  await git(repository, 'config', 'filter.unsafe.smudge', hook);
  await git(repository, 'config', 'filter.unsafe.process', hook);
  await git(repository, 'config', 'filter.unsafe.required', 'true');
  request.ref = 'HEAD';
  await backend.recreate(await backend.prepare(request));
  assert.equal(
    (
      await backend.capture([
        { projectID: request.projectID, directory: request.directory },
      ])
    )[0]?.dirty,
    false,
  );
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
});

test('recreation suppresses filters configured only for linked worktrees', async (t) => {
  const { directory, repository, request, backend } = await fixture(t);
  const marker = join(directory, 'filter-ran');
  const filter = join(directory, 'filter.sh');
  await writeFile(filter, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
  await chmod(filter, 0o700);
  await writeFile(
    join(repository, '.gitattributes'),
    'src/file.txt filter=conditional\n',
  );
  await git(repository, 'add', '.gitattributes');
  await git(repository, 'commit', '-m', 'Use a conditional checkout filter');
  const config = join(directory, 'conditional.config');
  await writeFile(config, `[filter "conditional"]\n\tsmudge = ${filter}\n`);
  await git(
    repository,
    'config',
    `includeIf.gitdir:${repository}/.git/worktrees/**.path`,
    config,
  );
  await backend.recreate(await backend.prepare({ ...request, ref: 'HEAD' }));
  assert.equal(
    await readFile(join(request.directory, 'file.txt'), 'utf8'),
    'saved content\n',
  );
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
});

test('missing partial-clone objects fail recreation without invoking a fetch transport', async (t) => {
  const { directory, repository, worktree, request } = await fixture(t);
  await git(repository, 'config', 'uploadpack.allowFilter', 'true');
  const partial = join(directory, 'partial');
  await git(
    directory,
    'clone',
    '--filter=blob:none',
    '--no-checkout',
    `file://${repository}`,
    partial,
  );
  const marker = join(directory, 'fetch-ran');
  const uploadpack = join(directory, 'uploadpack.sh');
  await writeFile(
    uploadpack,
    `#!/bin/sh\nprintf ran > '${marker}'\nexec git-upload-pack "$@"\n`,
  );
  await chmod(uploadpack, 0o700);
  await git(partial, 'config', 'remote.origin.uploadpack', uploadpack);
  const backend = new GitWorktrees(async () => 'project-a');
  const plan = await backend.prepare({ ...request, repository: partial });
  await assert.rejects(backend.recreate(plan));
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  await assert.rejects(lstat(join(worktree, 'src', 'file.txt')), {
    code: 'ENOENT',
  });
});
