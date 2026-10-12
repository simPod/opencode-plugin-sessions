import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RestoreLocation, WorktreePlan, WorktreeRequest } from './schema.ts';
import type { WorktreeSnapshot } from './schema.ts';

export interface WorktreeGateway {
  capture(locations: RestoreLocation[]): Promise<WorktreeSnapshot[]>;
  missing(locations: RestoreLocation[]): Promise<RestoreLocation[]>;
  prepare(request: WorktreeRequest): Promise<WorktreePlan>;
  recreate(plan: WorktreePlan): Promise<void>;
}

const execute = promisify(execFile);

function code(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

// ENOENT can also mean that an ancestor is a broken symlink. Check ancestors
// before reporting a directory as missing, and propagate all other failures.
async function missingDirectory(directory: string): Promise<boolean> {
  const path = resolve(directory);
  let current = path;
  while (true) {
    try {
      await lstat(current);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
      continue;
    }
    if (!(await stat(current)).isDirectory())
      throw new Error(`Not a directory: ${current}`);
    return current !== path;
  }
}

function inside(directory: string, worktree: string): boolean {
  const suffix = relative(resolve(worktree), resolve(directory));
  return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix);
}

export class GitWorktrees implements WorktreeGateway {
  readonly #resolveProject: (directory: string) => Promise<string>;
  readonly #signal: AbortSignal | undefined;

  constructor(
    resolveProject: (directory: string) => Promise<string>,
    signal?: AbortSignal,
  ) {
    this.#resolveProject = resolveProject;
    this.#signal = signal;
  }

  async #git(directory: string, args: string[]): Promise<string> {
    this.#signal?.throwIfAborted();
    // Git's inherited repository overrides must not replace the requested repo.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const base = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-C',
      directory,
    ];
    const options = {
      encoding: 'utf8',
      env: {
        ...env,
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
      ...(this.#signal ? { signal: this.#signal } : {}),
    } as const;
    // A checkout or status can execute repository-defined filters, even without
    // hooks. Disable every configured driver for this command only.
    let filters = '';
    try {
      filters = (
        await execute(
          'git',
          [
            ...base,
            'config',
            '--null',
            '--name-only',
            '--get-regexp',
            '^filter\\..*\\.(clean|smudge|process|required)$',
          ],
          options,
        )
      ).stdout;
    } catch (error) {
      if (code(error) !== 1) throw error;
    }
    const drivers = new Set(
      filters
        .split('\0')
        .filter(Boolean)
        .map((key) => key.replace(/\.(clean|smudge|process|required)$/, '')),
    );
    const overrides = Array.from(drivers).flatMap((driver) => [
      '-c',
      `${driver}.clean=`,
      '-c',
      `${driver}.smudge=`,
      '-c',
      `${driver}.process=`,
      '-c',
      `${driver}.required=false`,
    ]);
    const { stdout } = await execute(
      'git',
      [...base, ...overrides, ...args],
      options,
    );
    return stdout;
  }

  async capture(locations: RestoreLocation[]): Promise<WorktreeSnapshot[]> {
    const snapshots: WorktreeSnapshot[] = [];
    for (const input of locations) {
      this.#signal?.throwIfAborted();
      const location = RestoreLocation.parse(input);
      if (await missingDirectory(location.directory)) continue;
      let worktree: string;
      try {
        worktree = (
          await this.#git(location.directory, ['rev-parse', '--show-toplevel'])
        ).replace(/\n$/, '');
      } catch (error) {
        if (
          code(error) === 128 &&
          error instanceof Error &&
          'stderr' in error &&
          typeof error.stderr === 'string' &&
          error.stderr.includes('not a git repository')
        )
          continue;
        throw error;
      }
      const gitDirectory = (
        await this.#git(worktree, ['rev-parse', '--absolute-git-dir'])
      ).replace(/\n$/, '');
      const commonDirectory = (
        await this.#git(worktree, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).replace(/\n$/, '');
      if ((await realpath(gitDirectory)) === (await realpath(commonDirectory)))
        continue;
      const list = await this.#git(worktree, [
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ]);
      const first = list.split('\0')[0];
      if (!first?.startsWith('worktree '))
        throw new Error('Git did not return a source repository');
      const repository = first.slice('worktree '.length);
      if (await missingDirectory(repository)) continue;
      if (!inside(location.directory, worktree))
        throw new Error('The session directory is outside its Git worktree');
      const commit = (
        await this.#git(worktree, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          'HEAD^{commit}',
        ])
      ).trim();
      let branch: string | undefined;
      try {
        branch = (
          await this.#git(worktree, [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
          ])
        ).replace(/\n$/, '');
      } catch (error) {
        if (code(error) !== 1) throw error;
      }
      const dirty =
        (await this.#git(worktree, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
        ])) !== '';
      snapshots.push({
        ...location,
        worktree,
        repository,
        commit,
        dirty,
        ...(branch === undefined ? {} : { branch }),
      });
    }
    return snapshots;
  }

  async missing(locations: RestoreLocation[]): Promise<RestoreLocation[]> {
    const missing: RestoreLocation[] = [];
    for (const input of locations) {
      this.#signal?.throwIfAborted();
      const location = RestoreLocation.parse(input);
      if (await missingDirectory(location.directory)) missing.push(location);
    }
    return missing;
  }

  async prepare(input: WorktreeRequest): Promise<WorktreePlan> {
    this.#signal?.throwIfAborted();
    const request = WorktreeRequest.parse(input);
    if (request.projectID === 'global')
      throw new Error('Global projects cannot recreate Git worktrees');
    if (!inside(request.directory, request.worktree))
      throw new Error(
        'The session directory must be inside the target worktree',
      );
    let exists = true;
    try {
      await lstat(request.worktree);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      exists = false;
    }
    if (exists) throw new Error('The target worktree already exists');
    await missingDirectory(request.worktree);
    if (await missingDirectory(request.repository))
      throw new Error('The source repository is unavailable');
    const repository = await realpath(request.repository);
    const root = (
      await this.#git(repository, ['rev-parse', '--show-toplevel'])
    ).replace(/\n$/, '');
    if ((await realpath(root)) !== repository)
      throw new Error('The source must be a Git repository root');
    if ((await this.#resolveProject(repository)) !== request.projectID)
      throw new Error('The source repository belongs to a different project');
    this.#signal?.throwIfAborted();
    const commit = (
      await this.#git(repository, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${request.ref}^{commit}`,
      ])
    ).trim();
    return WorktreePlan.parse({
      projectID: request.projectID,
      directory: request.directory,
      worktree: request.worktree,
      repository,
      commit,
    });
  }

  async recreate(input: WorktreePlan): Promise<void> {
    const plan = WorktreePlan.parse(input);
    const verified = await this.prepare({
      projectID: plan.projectID,
      directory: plan.directory,
      worktree: plan.worktree,
      repository: plan.repository,
      ref: plan.commit,
    });
    await this.#git(verified.repository, [
      'worktree',
      'add',
      '--detach',
      '--no-checkout',
      '--',
      verified.worktree,
      verified.commit,
    ]);
    // Conditional configuration can differ in the newly registered worktree.
    // Resolve its applicable filters before populating this new, empty checkout.
    await this.#git(verified.worktree, [
      'read-tree',
      '--reset',
      '-u',
      verified.commit,
    ]);
  }
}
