import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { fingerprint } from './fingerprint.ts';
import { ArchiveID, Bundle, Summary } from './schema.ts';
import type {
  ArchiveBundle,
  ArchiveStorage,
  ArchiveSummary,
} from './schema.ts';

const Envelope = z.strictObject({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  bundle: Bundle,
});

function privateEntry(stats: Stats, directory: boolean): void {
  if (
    (directory ? !stats.isDirectory() : !stats.isFile()) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(
      'Archive storage must contain only private directories and regular files',
    );
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Archive storage must be owned by the current user');
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class FileArchiveStorage implements ArchiveStorage {
  private readonly storageDirectory: string;
  private readonly projectID: string;
  private readonly projectFolder: string;
  private readonly projectSuffix: string;
  private readonly projectDirectory: string | undefined;

  constructor(options: {
    storageDirectory: string;
    projectID: string;
    projectName: string;
    projectDirectory?: string;
  }) {
    if (!options.storageDirectory || !options.projectID)
      throw new Error('Invalid archive storage configuration');
    this.storageDirectory = resolve(options.storageDirectory);
    this.projectID = options.projectID;
    this.projectDirectory = options.projectDirectory;
    const key =
      options.projectID === 'global'
        ? `${options.projectID}\0${options.projectDirectory ?? options.projectName}`
        : options.projectID;
    this.projectSuffix = `--${createHash('sha256').update(key).digest('hex')}`;
    const name =
      options.projectName
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'project';
    this.projectFolder = `${name}${this.projectSuffix}`;
  }

  private async directory(): Promise<string> {
    await mkdir(this.storageDirectory, { recursive: true, mode: 0o700 });
    privateEntry(await lstat(this.storageDirectory), true);
    const matches = (await readdir(this.storageDirectory)).filter((name) =>
      name.endsWith(this.projectSuffix),
    );
    if (matches.length > 1)
      throw new Error('Ambiguous archive project directories');
    const path = join(this.storageDirectory, matches[0] ?? this.projectFolder);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    privateEntry(await lstat(path), true);
    return path;
  }

  private id(value: string): string {
    const parsed = ArchiveID.safeParse(value);
    if (!parsed.success) throw new Error('Invalid archive ID');
    return parsed.data;
  }

  private async readFile(
    directory: string,
    id: string,
  ): Promise<ArchiveBundle> {
    privateEntry(await lstat(directory), true);
    const path = join(directory, `${id}.json`);
    privateEntry(await lstat(path), false);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      privateEntry(await file.stat(), false);
      const value: unknown = JSON.parse(
        await file.readFile({ encoding: 'utf8' }),
      );
      const parsed = Envelope.safeParse(value);
      if (!parsed.success) throw new Error('Invalid archive contents');
      const { bundle, checksum } = parsed.data;
      if (
        bundle.id !== id ||
        bundle.projectID !== this.projectID ||
        fingerprint(bundle) !== checksum ||
        (this.projectID === 'global' &&
          this.projectDirectory !== undefined &&
          bundle.sessions[0]?.info.location.directory !== this.projectDirectory)
      ) {
        throw new Error('Invalid archive identity or checksum');
      }
      return bundle;
    } finally {
      await file.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      privateEntry(await handle.stat(), true);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async save(input: ArchiveBundle): Promise<{ id: string; path: string }> {
    try {
      const bundle = Bundle.parse(input);
      if (bundle.projectID !== this.projectID)
        throw new Error('Archive belongs to another project');
      if (
        this.projectID === 'global' &&
        this.projectDirectory !== undefined &&
        bundle.sessions[0]?.info.location.directory !== this.projectDirectory
      ) {
        throw new Error('Archive belongs to another non-Git location');
      }
      const id = this.id(bundle.id);
      const directory = await this.directory();
      const path = join(directory, `${id}.json`);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      const checksum = fingerprint(bundle);
      const file = await open(temporary, 'wx', 0o600);
      try {
        try {
          privateEntry(await file.stat(), false);
          await file.writeFile(JSON.stringify({ checksum, bundle }), {
            encoding: 'utf8',
          });
          await file.sync();
        } finally {
          await file.close();
        }
        privateEntry(await lstat(directory), true);
        await link(temporary, path);
      } finally {
        await unlink(temporary);
      }
      await this.syncDirectory(directory);
      const verified = await this.readFile(directory, id);
      if (fingerprint(verified) !== checksum)
        throw new Error('Archive read-back verification failed');
      return { id, path };
    } catch {
      // Do not expose validation details, JSON fragments, or session text in errors.
      throw new Error(
        'Cannot save archive: invalid data, unsafe storage, or an existing archive ID',
      );
    }
  }

  async read(value: string): Promise<ArchiveBundle> {
    const id = this.id(value);
    try {
      return await this.readFile(await this.directory(), id);
    } catch {
      throw new Error(
        'Cannot read archive: missing, corrupt, or unsafe archive',
      );
    }
  }

  async list(): Promise<ArchiveSummary[]> {
    try {
      const directory = await this.directory();
      const summaries: ArchiveSummary[] = [];
      for (const name of (await readdir(directory)).sort()) {
        if (!name.endsWith('.json')) continue;
        const id = this.id(name.slice(0, -5));
        const bundle = await this.readFile(directory, id);
        summaries.push(
          Summary.parse({
            id: bundle.id,
            rootSessionID: bundle.rootSessionID,
            title: bundle.sessions[0]?.info.title ?? 'Untitled session',
            createdAt: bundle.createdAt,
            sessionCount: bundle.sessions.length,
          }),
        );
      }
      return summaries;
    } catch {
      throw new Error(
        'Cannot list archives: corrupt or unsafe archive storage',
      );
    }
  }
}
