# 0011: Defer native archive creation and retain both restore sources

## Status

Accepted. Implements the updated [session archive requirements](../session-archive.md).
Retains [ADR 0001](0001-file-backed-transcript-archives.md)'s file-backed creation
lifecycle while adding restore support for existing native archives. Does not
authorize file migration. Desktop/TUI command ownership and permanent deletion
are unchanged.

## Context

OpenCode 2.1.4 exposes native session updates with an `archived` boolean and
archived-session listing. Keeping sessions in the database would avoid the
file-backed export/delete/import lifecycle and preserve more runtime state.
However, OpenCode 2.2.0's native TUI picker still includes archived rows, so setting
the flag does not meet the goal of removing conversations from that picker.
[Upstream issue #58364](https://github.com/anomalyco/opencode/issues/58364) tracks
the picker problem. Existing native archives must remain accessible, but no file
migration should start while the native picker behavior remains unsuitable.

The native endpoint changes only one session. It does not stop active work,
record a historical tree snapshot, or capture project files and Git recovery
metadata. Archived timestamps and parent links cannot identify archive batches.

## Decision

Keep file-backed creation for slash and TUI palette archive actions: capture a
settled tree, save and verify an exact private JSON archive, recheck, then use
native recursive deletion. Retain the existing final check-to-delete race; do
not add concurrency safeguards. Native creation is disabled until the native TUI
picker excludes archived sessions. Do not replace the native picker or patch its
filters. Do not migrate, rewrite, or remove existing archive files, and do not
automatically change existing native archive state.

Keep the minimum OpenCode version at 2.1.4 for native restore. Traverse the
selected family and clear `archived` on each session, including cross-project
descendants. Keep root-project scope and exact-directory scope for `global`.
Native restore must not export, import, delete, or create JSON files, and must not
fall back to the file lifecycle if its API is unavailable.

Combine native archived root families and eligible file archives in the
existing restore picker, newest archive date first. Group native families by
adjacent archived parent links. A root or descendant ID selects its highest
archived ancestor's family; file archive UUIDs remain supported. Native restore
traverses the current subtree, not a saved batch, and can include descendants
archived separately. File restore keeps its exact saved tree.

Retain file validation, version-1/2 reading, version-2 creation, exact mappings,
parent-first imports, and recorded-commit worktree recovery for file archives.
Native restore does not apply mappings or recreate removed locations. Report
partial native update progress without rollback; do not add transaction or race
guards. Keep permanent native deletion unchanged.

Deliver archive slash feedback through the typed live
`Archives.events.archiveResult` event containing operation ID, session ID,
started/success/error variant, and message. TUI listeners track operations started
in the visible invoking session. Start and completion toasts remain visible even
if deletion sends that TUI home; unrelated operations are ignored. Listeners
unsubscribe on unload. Events are not replayed and disconnected
clients can miss them; command errors are still thrown normally. Palette actions
keep their own toast, not slash feedback. Desktop retains result forms when the
invoking session survives; never attach forms to deleted sessions. Do not add
duplicate slash entries.

## Consequences

New archives still depend on transcript export/import limits and destructive
deletion. Rechecks cannot prevent writes or new descendants in the final gap
from being lost. Users must stop other clients and automations before archiving.
Files remain private, unencrypted transcript copies, not full runtime or project
backups.

Existing native archives preserve their database state until explicitly restored
or deleted. Native archives are not backups and permanent deletion can remove
them. Native restore updates are not atomic and do not stop active work; failures
can leave partial state.

Missing locations can cause server middleware to reject native updates. Users
must restore required directories and project files separately. File worktree
recovery remains available where files contain the required metadata. Supporting
both restore sources avoids leaving existing native archives inaccessible while
native creation and migration remain deferred.
