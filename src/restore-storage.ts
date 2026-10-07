import { basename } from 'node:path';
import { ArchiveID, SessionID } from './schema.ts';
import type {
  ArchiveBundle,
  ArchiveStorage,
  ArchiveSummary,
  RestoreMapping,
} from './schema.ts';
import { FileArchiveStorage } from './storage.ts';

function matchesRoot(
  bundle: ArchiveBundle,
  location: RestoreMapping['from'],
): boolean {
  const root = bundle.sessions[0]?.info;
  return (
    root?.id === bundle.rootSessionID &&
    root.projectID === bundle.projectID &&
    root.projectID === location.projectID &&
    root.location.directory === location.directory
  );
}

function matchesMapping(
  bundle: ArchiveBundle,
  scope: RestoreMapping['to'],
  mapping: RestoreMapping,
): boolean {
  return (
    mapping.to.projectID === scope.projectID &&
    mapping.to.directory === scope.directory &&
    matchesRoot(bundle, mapping.from)
  );
}

export function canRestore(
  bundle: ArchiveBundle,
  scope: { projectID: string; directory: string },
  mappings: RestoreMapping[],
): boolean {
  const root = bundle.sessions[0]?.info;
  if (
    !root ||
    root.id !== bundle.rootSessionID ||
    root.projectID !== bundle.projectID
  )
    return false;
  if (
    root.projectID === scope.projectID &&
    (scope.projectID !== 'global' || root.location.directory === scope.directory)
  )
    return true;
  return mappings.some((mapping) => matchesMapping(bundle, scope, mapping));
}

export function restoreStorage(
  primary: FileArchiveStorage,
  options: {
    storageDirectory: string;
    projectID: string;
    directory: string;
    restoreMappings: RestoreMapping[];
  },
): ArchiveStorage {
  const folderKey = (location: RestoreMapping['from']): string =>
    JSON.stringify(
      location.projectID === 'global'
        ? [location.projectID, location.directory]
        : [location.projectID],
    );
  const groups = new Map<string, RestoreMapping[]>();
  for (const mapping of options.restoreMappings) {
    if (
      mapping.to.projectID !== options.projectID ||
      mapping.to.directory !== options.directory ||
      folderKey(mapping.from) === folderKey(options)
    )
      continue;
    const key = folderKey(mapping.from);
    const mappings = groups.get(key) ?? [];
    mappings.push(mapping);
    groups.set(key, mappings);
  }
  const stores = [
    { storage: primary, mappings: undefined },
    ...Array.from(groups.values(), (mappings) => {
      const from = mappings[0]!.from;
      return {
        storage: new FileArchiveStorage({
          storageDirectory: options.storageDirectory,
          projectID: from.projectID,
          projectName: basename(from.directory),
          projectDirectory: from.directory,
          readOnly: true,
        }),
        mappings,
      };
    }),
  ];
  const eligible = (
    bundle: ArchiveBundle,
    mappings: RestoreMapping[] | undefined,
  ): boolean =>
    mappings === undefined
      ? canRestore(bundle, options, options.restoreMappings)
      : mappings.some((mapping) => matchesMapping(bundle, options, mapping));

  async function discover(sessionID?: string) {
    const archives = new Map<string, ArchiveSummary>();
    for (const store of stores) {
      for (const summary of await store.storage.list(sessionID)) {
        const bundle = await store.storage.read(summary.id);
        if (!eligible(bundle, store.mappings)) continue;
        if (archives.has(summary.id))
          throw new Error('Duplicate eligible archive ID');
        archives.set(summary.id, summary);
      }
    }
    return archives;
  }

  return {
    save: (bundle) => primary.save(bundle),
    async list(sessionID) {
      if (sessionID !== undefined && !SessionID.safeParse(sessionID).success)
        throw new Error('Invalid session ID');
      try {
        return Array.from((await discover(sessionID)).values());
      } catch {
        throw new Error(
          'Cannot list archives: corrupt, unsafe, or ambiguous archive storage',
        );
      }
    },
    async read(id) {
      if (!ArchiveID.safeParse(id).success) throw new Error('Invalid archive ID');
      try {
        let found: ArchiveBundle | undefined;
        for (const store of stores) {
          const bundle = await store.storage.find(id);
          if (bundle === undefined || !eligible(bundle, store.mappings)) continue;
          if (found !== undefined)
            throw new Error('Duplicate eligible archive ID');
          found = bundle;
        }
        if (found === undefined) throw new Error('Missing archive');
        return found;
      } catch {
        throw new Error(
          'Cannot read archive: missing, corrupt, unsafe, or ambiguous archive',
        );
      }
    },
  };
}
