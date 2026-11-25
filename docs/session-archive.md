# Session Archive Requirements

## Goal

Remove conversations from the active OpenCode session list with native archive
flags while retaining their IDs, transcripts, and runtime state in the database.
Keep native and existing file archives restorable, with permanent deletion
available separately.

The native TUI picker must hide archived rows. Use native creation now; postpone
file migration. Do not rewrite, move, or remove
existing files, automatically change unrelated native archive state, replace the
native picker, or patch its filters.

## Commands and clients

Provide `/session-id`, `/session-archive [session-id]`, and
`/session-restore [session-id | archive-id]` in Desktop and the terminal. Do not
invoke a model. Keep the old
`/session-unarchive` and `/session-archives` names removed, without aliases.

Session ID shows the exact invoking session ID, including a child ID, in a native
result panel. Accept no arguments and do not change sessions or archive files.

Archive, restore, and delete run immediately without confirmation and cannot be
queued. Without an ID, archive and delete use the open session; restore opens a
picker. Selecting a row restores it immediately; cancellation makes no changes.

The TUI exposes `/archive-session [session-id]` and `/session-delete [session-id]`
through its palette handlers. These commands bypass the terminal model check.
Register delete only in the terminal, under `/session-delete`, without aliases.
Desktop keeps its built-in Delete action. Retain the permanent-delete warning.
See [ADR 0015](adr/0015-single-terminal-delete-command.md).

Desktop uses native question panels. Terminal restore recognizes plugin-marked
selection forms for the visible session. Await cancellation of the original form
through the public connected-client API before opening the searchable popup used
by the palette action. The native form may appear briefly before cancellation
completes, but must not remain behind the popup. Failed cancellation must not open
the popup or run restore. The server's cancelled selection returns no answer and
performs no restore. After a choice, the TUI restores the exact selected archive
through the existing restore engine, using the form event's location and any
original target session-ID constraint. Do not reply to the cancelled form, parse
the selected archive ID as a new lookup, or open a second picker. Cancellation,
failure, or plugin unload before a choice must make no session changes.

Unambiguous explicit-ID slash restore remains server-executed. The terminal
acknowledges its marked result and refreshes the family without repeating restore.
The popup path opens the restored root and shows a toast. The server-result path
opens it only if the invoking session is still visible. Desktop retains native
selection when no TUI takes over.
Archive slash results also use the typed live RPC
event `Archives.events.archiveResult` with
`{ operationID, sessionID, variant, message, sessionIDs? }`, where `variant` is
`started`, `success`, or `error`. The optional `sessionIDs` is a string array.
Native success includes the exact archived IDs; started and error payloads remain
unchanged without that field.
Track operations that start in the visible invoking session so navigation away
does not suppress completion. For accepted success events, clean up before the
toast: close only archived-tree
tabs and return home only when viewing that tree. Keep unrelated views and tabs.
Keep unrelated result events ignored. Show start and result toasts and unsubscribe
on TUI unload. Do not intercept generic native archive events for this cleanup.
These events are not replayed; disconnected
clients can miss them. Continue throwing errors through the normal command path.
Palette archive keeps its own toast without also publishing slash feedback.
Desktop retains result forms for invoking sessions outside the archived tree;
archiving the invoking tree must not create a pending result form. Never attach
a result form to a deleted session. Other slash results retain native panels.
Successful slash and palette archive return home when viewing the archived tree
and close only its tabs. Palette archive uses the same existing cleanup with the
exact archived IDs. Palette delete retains its existing departure and tab cleanup.
Desktop restore does not automatically open a session.

Server slash commands require the host's managed-service registration and verify
that the connection reaches the hosting plugin instance. Refuse standalone or
embedded server slash hosts without it. Terminal-local slash commands and
palette actions use their existing connected client and server RPCs, including
remote and standalone support. Never discover or start another server. Forms
have no originating-client identity: another
client viewing the same session can answer them. Use one client for restore;
the cancelled form is not an exclusive client claim. After successful cancellation,
the popup is not durable. Cancellation or reload before a choice requires running
the command again; do not promise a pending native-form fallback. Use no private
form-cache or renderer patches to hide forms.

## Native archive creation

Use native creation for both slash and TUI palette archive actions. Preview the
selected root and current descendants, including cross-project descendants. Keep
root-project scope and exact-directory scope for the shared non-Git `global`
project. Use the public session update API with `archived: true` for each session,
descendants before the root, and read back each flag to verify the update.

Archive and delete use the same project matching in their respective slash and
terminal palette paths.
Different root or invoking-session project IDs are allowed only when both known
projects are Git projects with the same canonical repository. Check that both
server directories remain readable and resolve to that canonical repository;
cached location metadata alone is insufficient. Reject unknown IDs, non-Git
aliases, and unrelated repositories. Preserve exact-directory scope for `global`.
This does not change restore lookup or eligibility, which still uses exact
project IDs and may require the native API to restore an aliased archive.

Preserve session IDs, transcripts, parent links, fork/revert state, workspace
identity, and other runtime fields in place. Do not export, delete, import, or
write JSON files. Do not require settled snapshots or reject active sessions
because of file-import limits: archive flags do not stop active runs. Do not add
new concurrency safeguards or change the existing operation guard.

These per-session updates are not atomic and do not freeze the tree or capture
a historical batch. Report verified partial progress on failure, leave completed
updates in place, and advise inspection before retrying. Do not roll back or fall
back to export/delete/import. Missing locations can cause the server to reject an
update. Native state is not a backup or automatic worktree recovery.

## Native archive restore

Require OpenCode 2.1.4 or newer. Use the public session update API with
`archived: false` to restore each session in the selected root and current subtree,
including descendants in other projects. Keep root-project and exact `global`
directory scope. An unavailable native API must fail without a file
export/delete/import fallback.

Group native archived sessions by adjacent archived parent links. A supplied root
or descendant ID selects its highest archived ancestor's family. Native state
does not record archive batches: restore traverses the current subtree, including
descendants archived in separate operations. This differs from a file archive's
exact saved tree.

Native archive state does not record worktree snapshots or recovery metadata.
Native restore does not apply file mappings, recreate removed directories or
worktrees, or restore project files. Missing locations can cause native updates
to fail in server middleware; explain that the required location must be made
available separately.

Tree updates are not atomic. Report verified partial progress on failure without
claiming rollback or full success. Leave completed updates in place and advise
inspection before retrying. Native archives are not backups and remain subject
to permanent native deletion.

## Combined restore picker

List eligible native archived root families and existing file archives together,
newest archive date first, not newest conversation activity first. Keep rows
compact: title, session count, and short archive date. Search title words, root
session IDs, and archive IDs case-insensitively without changing date order. Use
native keyboard navigation and scrolling.

Session-ID lookup searches eligible root and descendant IDs in both sources.
One match restores immediately; multiple matches show only matching rows. No
match, cancellation, or invalid selection makes no changes. Recheck the selected
family's eligibility before restoration. Keep legacy archive UUID input
compatible. Native scope uses the archived root's project, plus exact directory
for `global`; file scope retains explicit mapped-source eligibility. Do not
return transcript bodies in summary RPCs or widen project scope.

## Legacy file restore and storage

Keep version-1 and version-2 JSON archives readable, including cross-project
families and non-Git descendants. Do not create new file archives or migrate
existing ones. Retain checksums, private storage checks, archive identity, and
exact saved session trees. Storage still defaults to
`~/.opencode-session-archives` on the server, configurable by `storageDirectory`.
Stable project keys isolate repositories; Git worktrees share project storage
and non-Git locations include their directory. Native archives do not use it.

Retain exact `restoreMappings` from original project ID and absolute directory to
destination project ID and absolute directory. Default to none; do not infer
projects, match prefixes, chain mappings, or accept duplicate source pairs. Only
explicitly mapped root pairs make source files eligible in a destination picker.
Do not move files, create missing mapped-source folders, rewrite transcript paths
or permissions, or change archive bytes. Refuse duplicate eligible archive UUIDs.

File restore imports parents before children at validated locations. Refuse
existing session IDs, missing external parents, duplicate message IDs, and
visible workspace IDs. Before any import, check every effective directory exists,
is readable, and resolves to its expected original or mapped project. Use fresh
filesystem checks and verify imported IDs, parent links, projects, locations, and
transcripts. Do not silently reassign projects.

Retain automatic missing-worktree recovery from version-2 metadata: exact source
repository, project/directory pair, worktree root, saved commit, branch label,
and dirty state. Never use the branch's current tip. Preflight the whole family
before creation or import. Missing recovery metadata, including for a mapped
destination, stops recovery and import; version-1 files still restore at existing
locations. Explain how to recreate the location or map to an existing destination.

Create detached worktrees without moving branches, replacing paths, fetching,
running hooks, configured filters, or startup commands. Never create arbitrary
missing non-Git directories. Recovery runs on the server and requires its
managed-service registration. Revalidate resulting locations before import.
Report that only committed files are recreated, not dirty/untracked files,
dependencies, or environment files; warn when saved metadata marks dirty files.

Retain archive files and created worktrees after success or partial failure. Do
not roll back by deleting imported sessions or created worktrees. A partial
import needs inspection because a normal retry refuses existing IDs. File
transcript import does not restore full runtime state, workspace identity, or
fork/revert state. These limits do not apply to native flag changes.

## Permanent deletion and safety

Delete remains native recursive deletion, without archive creation or file
changes. It stops active work and accepts active, forked, or reverted trees.
Retain root scope, hosting-instance checks, connected-client use, and the shared
operation guard. Recheck captured IDs, parents, projects, locations, and titles
before deletion; refuse changes. Verify known IDs are absent afterward. Never
attach results to a deleted session.

Deletion is irreversible, includes cross-project descendants, and has no backup
or later cancellation step. The tree recheck is not atomic with recursive
deletion: a new descendant in the final gap can also be removed. Recommend
stopping other clients and automation when the captured set must stay fixed.
Native archive is not protection from permanent deletion. Never claim automatic
rollback or a backup after failure.

Project folders and picker scope are not separate authorization boundaries. Use a
server and file storage trusted for all projects in a family. File transcripts
can contain secrets and are not encrypted; retain private permissions and never
publish them through Git or HTTP.

## Non-goals

No direct SQLite edits, synthetic native events, automatic scheduled archiving,
custom desktop buttons, arbitrary-file imports, archive-file deletion, new file
archive creation, file migration, custom native picker/filter patches, native
worktree recovery, or full runtime/project backups. Do not change global
configuration or mutate real user sessions during validation.

## Acceptance and rollout

Verify that both archive entry paths update and read back native flags with the
root last, without file writes, transcript export/import, or session deletion.
Verify that native restore clears flags without transcript import. Retain
mixed-source picker and ID lookup coverage, private file validation, exact-commit recovery,
partial-failure reporting without rollback, deletion guards, and distinct
slash/palette feedback. Verify that native creation preserves IDs, transcripts,
and runtime fields, accepts active trees, and creates no pending result form when
it archives the invoking tree. Verify that accepted slash success includes exact
archived IDs, cleans up affected tabs and views before its toast, and leaves
unrelated views, tabs, and result events alone. Started and error events retain
their existing payloads and feedback.
Verify cancellation completes before popup selection, failed cancellation cannot
start restore, and the selected archive is restored exactly once without a form
reply or another lookup. Retain server-executed explicit-ID restore and desktop
native selection.
No rollout step migrates files or automatically rewrites unrelated native
archives. File migration remains postponed and is not a prerequisite for native
creation.

Tests use temporary files and simulated APIs, not real user session mutations.
Keep the package unpublished on npm and install the built checkout. See
[ADR 0013](adr/0013-native-archive-creation.md) for native creation and
[ADR 0011](adr/0011-native-session-archives.md) for the earlier deferral and retained
mixed-source restore decisions,
[ADR 0008](adr/0008-immediate-session-deletion.md) for deletion, and
[ADR 0010](adr/0010-terminal-restore-and-automatic-recovery.md) for terminal
restore history and legacy worktree recovery, refined by
[ADR 0012](adr/0012-popup-only-terminal-restore.md) for popup-only selection.
