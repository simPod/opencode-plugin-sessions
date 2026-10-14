export function restoreRecoveryMessage(
  recovery: { worktreeCount: number; dirty: boolean } | undefined,
): string {
  if (!recovery) return '';
  const dirty = recovery.dirty
    ? ' Uncommitted or untracked files were not recovered.'
    : '';
  return `\n\nAutomatically recreated ${recovery.worktreeCount} Git worktree(s) at the recorded commits. Only committed files were restored. Dependencies and environment files were not restored.${dirty}`;
}
