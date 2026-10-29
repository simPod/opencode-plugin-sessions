# 0011: Native session archive state with legacy file restoration

## Status

Accepted. Implements the updated [session archive requirements](../session-archive.md).
Supersedes [ADR 0001](0001-file-backed-transcript-archives.md)'s file-backed
creation and export/delete/import lifecycle for new archives. Existing file
restore, mappings, and recovery remain supported. Desktop/TUI command ownership
and permanent deletion are unchanged.

## Context

OpenCode 2.1.4 exposes native session updates with an `archived` boolean and
archived-session listing. The former file-backed approach copied transcripts,
then permanently deleted live trees. It could lose concurrent writes and could
not preserve all runtime state through import. Native archive state removes the
need for that destructive sequence, but existing version-1/2 files must remain
restorable.

The native endpoint changes only one session. It does not stop active work,
record a historical tree snapshot, or capture project files and Git recovery
metadata. Archived timestamps and parent links cannot identify archive batches.

## Decision

Require OpenCode 2.1.4 or newer. Traverse the selected session and descendants,
including cross-project descendants, and update each individually with
`archived: true` or `archived: false`. Keep root-project scope and exact-directory
scope for `global`. Do not export, import, delete, or create JSON files for new
archives. Do not fall back to destructive file archiving if the API is absent.

Combine native archived root families and eligible legacy file archives in the
existing restore picker, newest archive date first. Group native families by
adjacent archived parent links. A root or descendant ID selects its highest
archived ancestor's family; legacy archive UUIDs remain supported. Native restore
traverses the current subtree, not a saved batch, and can include descendants
archived separately. File restore keeps its exact saved tree.

Retain existing file validation, version-1/2 reading, exact mappings, parent-first
imports, and recorded-commit worktree recovery only for legacy files. Native
restore does not apply mappings or recreate removed locations. Report partial
native update progress without rollback; do not add transaction or race guards.
Keep permanent native deletion unchanged.

## Consequences

Session IDs, messages, hierarchy, fork/revert state, and environment state remain
in the native database rather than being reconstructed from transcripts. Native
archives are not backups and permanent deletion can remove them. Tree updates
are not atomic and do not stop active work; failures can leave partial state.

Missing locations can cause server middleware to reject native updates. Users
must restore required directories and project files separately. Legacy worktree
recovery remains available only where existing files contain the required
metadata. Supporting two restore sources preserves old data without creating
more file archives or imposing legacy import restrictions on native state.
