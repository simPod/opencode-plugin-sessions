# Session Archive Requirements

## Goal

Hide conversations from the active OpenCode session list through native archive
state while retaining them in the database. Keep existing file archives
restorable and permanent session-tree deletion available.

## Commands and clients

Provide four desktop and TUI slash commands: `/session-id`,
`/session-archive [session-id]`, `/session-restore [session-id | archive-id]`, and
`/session-delete [session-id]`. Do not invoke a model. Keep the old
`/session-unarchive` and `/session-archives` names removed, without aliases.

Session ID shows the exact invoking session ID, including a child ID, in a native
result panel. Accept no arguments and do not change sessions or archive files.

Archive, restore, and delete run immediately without confirmation and cannot be
queued. Without an ID, archive and delete use the open session; restore opens a
picker. Selecting a row restores it immediately; cancellation makes no changes.

The server owns slash-command callbacks in both clients. Register TUI actions
only in the command palette, so each slash command appears once. Update archive
and restore descriptions to distinguish native state from legacy file import;
retain the permanent-delete warning.

Desktop uses native question panels. Terminal restore recognizes plugin-marked
selection forms, uses the same searchable picker as its palette action, and
replies to or cancels the original form through the connected client. Only the
server performs slash restoration. The terminal acknowledges its marked result,
refreshes the family, opens the restored root if the invoking session is still
visible, and shows a toast. Other slash results retain native panels. Palette
archive and delete leave the affected chat; palette delete closes only affected
tabs. Desktop restore does not automatically open a session.

Slash commands require the host's managed-service registration and verify that
the connection reaches the hosting plugin instance. Refuse standalone or
embedded slash hosts without it. TUI palette actions use their existing connected
client and server RPCs, including remote and standalone support. Never discover
or start another server. Forms have no originating-client identity: another
client viewing the same session can answer them. Use one client for restore;
pending forms after reload remain available in the native question UI.

## Native archive and restore

Require OpenCode 2.1.4 or newer. Use the public native session update API with
`archived: true` for archive and `archived: false` for restore. Each update affects
one session, so traverse the selected root and descendants explicitly, including
descendants in other projects. Keep root-project command scope; for the shared
non-Git `global` project, require the exact directory as well.

New archives must not create JSON files, export transcripts, delete sessions, or
import them. Do not fall back to destructive file archiving if the native API is
unavailable. Native archive must not apply legacy settled-transcript,
fork/revert, or import-compatibility restrictions. It does not stop active work.
IDs, messages, parent links, fork/revert state, and environment state remain in
OpenCode's database rather than being reconstructed from a transcript.

Group native archived sessions by adjacent archived parent links. A supplied root
or descendant ID selects its highest archived ancestor's family. Native state
does not record archive batches: restore traverses the current subtree, including
descendants archived in separate operations. This differs from a file archive's
exact saved tree.

Native archive does not record worktree snapshots or recovery metadata. Native
restore does not apply file mappings, recreate removed directories or worktrees,
or restore project files. Missing locations can cause native updates to fail in
server middleware; explain that the required location must be made available
separately.

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

## Legacy file restore

Keep version-1 and version-2 JSON archives readable, including cross-project
families and non-Git descendants. Retain checksums, private storage checks,
archive identity, and exact saved session trees. Storage still defaults to
`~/.opencode-session-archives` on the server, configurable by `storageDirectory`.
Stable project keys isolate repositories; Git worktrees share project storage
and non-Git locations include their directory. Native archives do not use it.

Retain exact `restoreMappings` from original project ID and absolute directory to
destination project ID and absolute directory. Default to none; do not infer
projects, match prefixes, chain mappings, or accept duplicate source pairs. Only
explicitly mapped root pairs make source files eligible in a destination picker.
Do not move files, create missing mapped-source folders, rewrite transcript paths
or permissions, or change archive bytes. Refuse duplicate eligible archive UUIDs.

Legacy restore imports parents before children at validated locations. Refuse
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
import needs inspection because a normal retry refuses existing IDs. Legacy
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
server and legacy storage trusted for all projects in a family. File transcripts
can contain secrets and are not encrypted; retain private permissions and never
publish them through Git or HTTP.

## Non-goals

No direct SQLite edits, synthetic events, automatic scheduled archiving, custom
desktop buttons, arbitrary-file imports, archive-file deletion, new file archive
creation, native worktree recovery, or full runtime/project backups. Do not
change global configuration or mutate real user sessions during validation.

## Acceptance and rollout

Tests must distinguish native flag updates from legacy imports. Cover current
and explicit archive targets; complete cross-project descendants; root scope and
exact `global` directory scope; native parent grouping; repeated archive state;
partial failures without rollback; retained native state; and no export, import,
deletion, or new file creation for native archive/restore. Cover unavailable API
failure without destructive fallback.

Cover mixed picker archive-date ordering, title/ID search, root and descendant
lookup, legacy UUIDs, matching-only selection, cancellation, and invalid input.
Retain legacy version-1/2, mapped scope, import validation, private storage,
exact-commit recovery, missing-metadata refusal, and partial-import coverage.
Retain delete checks, failure reporting, file preservation, tab cleanup, slash
and palette registration, native forms, server identity checks, and terminal
transport/navigation without a second restore.

Tests use temporary files and simulated APIs, not real user session mutations.
Keep the package unpublished on npm and install the built checkout. See
[ADR 0011](adr/0011-native-session-archives.md) for the native archive decision,
[ADR 0008](adr/0008-immediate-session-deletion.md) for deletion, and
[ADR 0010](adr/0010-terminal-restore-and-automatic-recovery.md) for terminal
presentation and legacy worktree recovery.
