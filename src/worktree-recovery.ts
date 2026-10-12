import type { WorktreeRecovery } from './service.ts';
import type { WorktreePlan, WorktreeSnapshot } from './schema.ts';

export function recoveryMessage(
  plans: WorktreePlan[],
  snapshots: WorktreeSnapshot[],
): string {
  const targets = plans
    .map(
      (plan) =>
        `Repository: ${plan.repository}\nWorktree: ${plan.worktree}\nCommit: ${plan.commit}`,
    )
    .join('\n\n');
  const dirty = snapshots.some((snapshot) => snapshot.dirty)
    ? '\nThe archived worktree had uncommitted or untracked files. Those files were not saved and cannot be restored.'
    : '';
  return `${targets}\n\nCreate detached Git worktrees at these exact commits, then restore the sessions? Git hooks, checkout filters, and OpenCode startup commands will not run. Existing paths will not be replaced. Only committed files are recreated; environment files, dependencies, and unsaved changes are not restored.${dirty}`;
}

export function worktreeRecovery(interaction: {
  source(
    directory: string,
  ): Promise<{ repository: string; ref: string; worktree: string } | undefined>;
  confirm(message: string): Promise<boolean>;
}): WorktreeRecovery {
  return {
    async source(location, saved) {
      const source = saved
        ? {
            repository: saved.repository,
            ref: saved.commit,
            worktree: saved.worktree,
          }
        : await interaction.source(location.directory);
      return source ? { ...location, ...source } : undefined;
    },
    confirm: (plans, snapshots) =>
      interaction.confirm(recoveryMessage(plans, snapshots)),
  };
}
