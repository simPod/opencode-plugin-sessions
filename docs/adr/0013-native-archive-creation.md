# 0013: Create native archives and postpone file migration

## Status

Accepted. Implements the updated [session archive requirements](../session-archive.md).
Supersedes [ADR 0011](0011-native-session-archives.md)'s native-creation deferral,
continued file creation, and archive result forms for the invoking tree, and
[ADR 0001](0001-file-backed-transcript-archives.md)'s creation lifecycle. Retains
mixed-source restore, legacy file recovery, and
[ADR 0012](0012-popup-only-terminal-restore.md)'s exact-selection popup handoff.

## Context

File creation exports a settled transcript, saves JSON, and deletes the live
tree. Restore then imports it with runtime-state limits. Native archive flags
keep session identity, transcripts, and runtime state in place without this
destructive lifecycle.

ADR 0011 deferred native creation because the native TUI picker showed archived
rows. The user now reports that the picker hides them and requests native
creation first, with file migration postponed. This report is not independent
verification that [upstream issue #58364](https://github.com/anomalyco/opencode/issues/58364)
is fixed. A successful API flag update alone does not establish picker behavior.

The connected server reports OpenCode 2.2.6. Its TUI source navigates home for
native deletion, not for `session.archived`. Native creation therefore needs to
retain the plugin's successful-archive departure and affected-tab cleanup.

## Decision

Use native archive creation for slash and TUI palette actions. Preview the root
and current descendants, including other projects; retain root-project scope and
exact-directory scope for `global`. Set `archived: true` through the public API,
descendants before the root, and read back each flag. Do not export, delete,
import, or create JSON files, including as a fallback when the native API fails.

Keep IDs, transcripts, parent links, fork/revert state, workspace identity, and
other runtime fields in the database. Do not require a settled snapshot: flags
do not stop active runs. Keep the existing operation guard without new concurrency
safeguards. On failure, report verified progress and leave completed updates in
place; do not roll back, import, or delete sessions.

Keep the mixed-source picker and restore the exact selected native or file
archive without a new lookup. Native restore clears flags on the current subtree;
legacy file restore keeps its exact saved tree, validation, mappings, and recorded
worktree recovery. Do not rewrite, move, remove, or migrate existing archive files.
Do not replace or patch the native picker. Permanent deletion is unchanged.

Retain typed slash started/success/error events and normal command errors. Add
optional `sessionIDs: string[]` to `Archives.events.archiveResult`; native success supplies
the exact archived IDs, while started and error payloads stay unchanged. Accepted
success runs the existing `leaveTree(sessionIDs, false)` before its toast: return
home only when viewing that tree and close only its tabs. Keep unrelated views,
tabs, and result events unchanged. Track completion even after leaving the
invoking session; do not add generic native-event interception.

Archiving the invoking tree creates no pending result form; a surviving invoking
session outside that tree can retain its result panel. Successful palette archive
uses the same exact-tree departure and tab cleanup with its own native-archive
toast, not slash feedback. This is UI lifecycle behavior, not a new race guard.

## Consequences

New archives avoid file-import limits but are not backups or historical tree
snapshots. Per-session updates are non-atomic, do not lock the tree, and can leave
partial archive state. Users must inspect the session list before retrying.
Native archives remain subject to permanent deletion.

Native state has no automatic worktree recovery or project-file snapshot. Missing
locations can cause the server to reject native updates; users must make required
locations available separately. Legacy file recovery remains available only for
existing files with the required metadata. File migration is a separate future
decision, not a condition for using native creation now.
