import type { OpenCodeClient, Project } from '@opencode/client';

export interface ProjectLocation {
  projectID: string;
  directory: string;
}

export interface ProjectScopes {
  list(): Promise<Array<Pick<Project, 'id' | 'canonical' | 'vcs'>>>;
  resolve(directory: string): Promise<{ id: string; canonical: string }>;
}

export function projectScopes(
  client: OpenCodeClient,
  signal?: AbortSignal,
): ProjectScopes {
  const options = signal ? { signal } : undefined;
  return {
    list: () => client.project.list({ archived: true }, options),
    async resolve(directory) {
      // Location metadata can survive a removed worktree. Check the server's
      // filesystem as well; the TUI may be connected to a remote server.
      await client.file.list({ location: { directory } }, options);
      return (await client.location.get({ location: { directory } }, options))
        .project;
    },
  };
}

export async function matchesProject(
  projects: ProjectScopes,
  scope: ProjectLocation,
  target: ProjectLocation,
): Promise<boolean> {
  if (scope.projectID === target.projectID)
    return scope.projectID !== 'global' || scope.directory === target.directory;
  if (scope.projectID === 'global' || target.projectID === 'global') return false;

  const known = await projects.list();
  const current = known.find((project) => project.id === scope.projectID);
  const recorded = known.find((project) => project.id === target.projectID);
  if (
    current?.vcs !== 'git' ||
    recorded?.vcs !== 'git' ||
    current.canonical !== recorded.canonical
  )
    return false;

  const locations = await Promise.all([
    projects.resolve(scope.directory),
    projects.resolve(target.directory),
  ]);
  return locations.every((project) => project.canonical === current.canonical);
}
