# 0009: Confirmed Git worktree recreation during restore

## Status

Accepted. Implements the updated
[session archive requirements](../session-archive.md). Extends
[ADR 0006](0006-explicit-restore-relocations.md) without changing mappings.

## Context

Archived session families can include descendants whose disposable Git worktrees
have since been removed. Existing restore refuses the whole family before
import. Manually recreating each directory is unnecessary when the repository
and commit are known, but transcript archives do not preserve a working-copy
backup.

## Decision

Write version-2 bundles with recovery metadata for linked Git worktrees. Record
the server repository, worktree root, session directory, full commit, optional
branch label, and dirty state. Read existing version-1 bundles without rewriting
them. Ask for an existing server repository, ref, and worktree root when an
older archive or mapped location lacks metadata.

Before any import, check live-session conflicts and existing destination
projects. Resolve recovery refs to commits and require a native desktop or TUI
confirmation of the exact repository, destination, and commit. Gather all
choices before any creation; cancellation makes no changes. Run filesystem and
Git operations only on the server. Bind TUI mutation RPCs to an eligible
archive's fingerprint and effective restore locations. Source-project checks use
the same authenticated managed server as desktop commands.

Create exact-path detached worktrees with Git rather than OpenCode's naming and
startup-command worktree API. Do not force, prune, clone, fetch, move branches,
overwrite paths, or run checkout hooks, filesystem monitors, or configured Git
filters. Create without checkout, then populate the new worktree after
inspecting its own conditional filter configuration. Disable Git lazy fetching
so missing partial-clone objects cause a visible failure rather than running a
transport. Filter-managed files retain their committed form. Recheck every
resulting directory and project before parent-first session import. Keep
archives and created worktrees after partial failure; automatic rollback could
remove user work.

## Consequences

Users can restore missing worktrees with explicit approval. Existing-path and
project-identity checks remain mandatory, and ordinary restore needs no new
confirmation. Old plugins refuse new version-2 bundles rather than silently
discarding recovery metadata.

Only committed files are recreated. Dirty changes, untracked files,
dependencies, and local environment files remain outside the archive. Git
objects and an existing source checkout must still be available. A saved branch
is informational; recreation uses its saved commit, not the branch's current
tip. Worktree recovery requires a managed server; ordinary TUI operations retain
standalone support.
