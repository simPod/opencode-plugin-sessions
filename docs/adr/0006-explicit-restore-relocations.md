# 0006: Explicit restore relocations without archive migration

## Status

Accepted. Supersedes original-location-only restoration in
[ADR 0005](0005-cross-project-session-trees.md) for explicit configured
mappings. Implements the updated [session archive PRD](../session-archive.md).

## Context

Renaming a Git remote can change OpenCode's project ID. Removed or renamed
worktrees also leave archived sessions pointing at unavailable directories.
Native HTTP import derives its project from the destination directory; it cannot
force an arbitrary historical project identity. Recreating obsolete checkouts is
not always desirable. The user requested restoration into the current checkout.

## Decision

Add optional server plugin `restoreMappings`, defaulting to an empty array. Each
rule has an exact `from` pair of project ID and absolute directory, and a `to`
pair of destination project ID and absolute directory. Reject duplicate source
pairs. Apply at most one match per original transfer; do not normalize paths,
infer projects, prefix-match directories, or chain mappings.

Expose the configured rules through authenticated location-scoped read-only RPC
for the TUI. Desktop commands use the same parsed server rules. Keep the two
existing commands and immediate execution behavior.

Validate the original archive and its fingerprint before constructing separate
import records. Change only each mapped record's project ID and directory, plus
the existing archive timestamp removal. Keep IDs, parents, messages,
permissions, and other metadata. Preflight all destination directories and
expected projects before any import, and verify each returned mapped identity
and transcript. Keep conflict checks, workspace refusals, retained backups, and
partial imports.

The restore storage view includes current archives and mapped source project
folders only when a rule's destination exactly matches the current project and
directory. Source roots must match the rule's original pair, even when multiple
Git worktrees share a folder. Deduplicate source stores, refuse ambiguous
eligible archive UUIDs, and perform source lookups without creating missing
folders. New archives are saved only in current project storage. Do not move or
rewrite files, change file permissions, or relax checksum, ownership, and
symlink safeguards.

## Consequences

Users can restore obsolete locations without keeping the original worktree or
remote URL. This intentionally changes imported location identity, not
historical archive contents. No archive format migration is needed. Unmapped
records retain their original identity, and removing the configuration restores
strict defaults.

Mappings apply to subsequent restore calls until removed. Their configuration is
authorization to relocate matching records and read matching root archives, not
authorization to overwrite live sessions. Paths embedded in transcripts and
saved permission rules remain historical; users must review permissions before
resuming relocated sessions. Native workspace identity limits, cached project
metadata, possible partial imports, and accepted non-atomic deletion remain.
