# Session Archive Requirements

## Goal

Remove completed conversations from the live OpenCode session list while keeping
their transcripts available for later restoration, or permanently delete unwanted
session trees without keeping a transcript.

## Behavior

Provide four desktop and TUI slash commands: `/session-id`,
`/session-archive [session-id]`, `/session-restore [session-id | archive-id]`, and
`/session-delete [session-id]`.
Without an ID, restore opens the current project's archive picker. Remove
`/session-unarchive` and `/session-archives` without aliases. Archive means verified JSON export followed
by recursive native deletion. Restore means native import with original IDs,
parents first. These commands must not invoke a model.

Session ID shows the exact command invocation's session ID in a native result
panel, including when the current session is a child. Accept no arguments. Do not
read transcripts, change sessions, or read or change archive files.

Delete means permanent native recursive deletion without archive creation or
archive-file changes. Without an ID, delete uses the open session. The user
explicitly approved deletion on submit without confirmation in both slash
commands and the TUI palette action. Stop active work through native deletion.
Do not apply archive's
settled-transcript or import-compatibility restrictions to delete. Keep server
root-project scope and hosting-instance checks, and use the TUI palette's
connected client. Keep the shared operation guard; refuse queued commands.

Recheck the captured tree's IDs, parents, projects, locations, and titles before
deletion; refuse changes. Verify that all known IDs are absent after deletion.
Failures must not claim a backup, successful deletion, or automatic rollback.
Never attach server results to a deleted session. TUI palette deletion must leave
a deleted current tree and close its tabs without closing unrelated tabs.

Each command must appear once in the TUI slash-command list, even when both the
server and TUI plugins are loaded. The server owns slash-command callbacks in
both clients. Keep TUI command registrations palette-only. Terminal restore
recognizes the server's plugin-marked archive-selection forms and presents the
same searchable picker used by its palette action, then replies to or cancels
the original form through the connected client. The server performs restoration
once; the terminal bridge must not invoke another restore operation.

Keep archive rows compact: title, session count, and short archive date without
long IDs. Search must match title words, root session IDs, and archive IDs,
case-insensitively, while retaining newest-first order. Use native keyboard
navigation and scrolling; a cancelled picker makes no changes.

Session-ID lookup matches any saved root or descendant in archives available to
the current project, including explicitly mapped sources. Restore the whole
saved family immediately when exactly one archive matches. For multiple matches,
show only those archives in the picker; never choose one automatically. No
match, cancellation, or a selection outside the matching set must not import
sessions. Keep archive UUID input compatible. Before import, check that the
selected archive still contains the supplied session ID. Do not widen project
scope or change saved files, archive identity, or restoration safeguards for
this lookup.

Server commands must appear in both clients' slash-command lists. Desktop uses
native question forms for archive selection and results. Terminal restore
automatically acknowledges its marked result form, refreshes the restored
family, opens the restored root if the user is still viewing the invoking
session, and shows a toast. Other slash-command results retain native forms.
Archive, restore, and delete run without confirmation in both desktop and TUI.
Selecting an archive restores it immediately; cancelling the archive picker
makes no changes. Commands cannot be queued. After archiving or deleting the
open session, the user can open another session from the session list; desktop
restore makes the original sessions available without automatic navigation. TUI
palette archive leaves the archived chat, palette delete leaves the deleted
chat, and palette restore opens the restored session.

Storage defaults to `~/.opencode-session-archives` on the connected server and
remains configurable through `storageDirectory`. Project folders use a readable
label plus a stable project key. Worktrees of the same Git project share
storage; unrelated repositories and non-Git locations do not.

A session family can contain descendants from other projects, including non-Git
locations. Save the complete family in the root project's archive folder. Keep
each session's project ID, parent ID, directory, and transcript; do not skip or
split foreign-project descendants. The archive must match the root project, not
every descendant's project. Root command and storage scope checks remain.

Support optional server `restoreMappings` from an exact original project ID and
absolute directory to an explicit destination project ID and absolute directory.
The default is no mappings. Apply each match once; do not infer projects, match
directory prefixes, or chain rules. Reject duplicate source pairs. Desktop and
TUI use the same server configuration, without new commands or confirmations.

When an effective restore location is missing, automatically recreate its Git
worktree from exactly matching recorded project/directory metadata, without
repository, commit, path, or confirmation questions. New version-2 archives
record linked-worktree repository, root, commit, branch label, and dirty state.
Use the recorded commit, never the saved branch's current tip. Keep version-1
archives readable when their locations exist. Missing metadata for any effective
location, including a mapped destination, must stop restoration before all
creation and import. Retain the archive and explain that the original directory
must be recreated or explicitly mapped to an existing destination. Do not guess
a repository or commit. Preflight every target before creation. Use detached
worktrees without moving branches, replacing paths, fetching, running Git hooks
or configured filters, or running startup commands. Match the source repository
to the expected project and recheck all resulting session locations before
import. Never create arbitrary missing non-Git directories. Report that only
committed files are recreated and that dependencies and env files are not saved;
warn about dirty files in the completed result when the recovered metadata marks
them dirty. Keep created worktrees after partial failure for manual inspection.
Recovery is executed on the server; TUI clients must not run local Git commands.

Mapped restore changes only imported project IDs and directories; retain session
IDs, parent links, transcripts, and original archive bytes. Mapped root archives
are visible in the destination picker only when their exact root pair explicitly
maps to the current project and directory. Do not move archives or create
missing source folders. Refuse duplicate eligible archive UUIDs rather than
guessing. Do not rewrite permission rules, metadata, or paths embedded in
transcripts.

## Safety requirements

Delete is irreversible and has no backup. Its tree recheck does not lock the
session family: a descendant created in the final check-to-delete gap can be
removed without appearing in the captured tree. There is no later cancellation
or approval step. Disclose these limits and recommend
archive when a transcript must be retained. Never delete real sessions during
development or validation.

The user explicitly approved removing archive and restore confirmations. Archive
must refuse busy, queued, incomplete, forked, or reverted session families. Save the
complete settled transcript of every descendant privately and verify it before
deletion. Abort when the captured family changes.

Restore must not overwrite existing IDs. Keep archives after success or failure.
Do not automatically delete sessions after a partial restore. Before any import,
check that every restore directory exists and is readable on the server, and
that its location resolves to its saved project or explicit mapped destination.
Directory checks must be fresh even when location metadata is cached; after each
import, verify the project, complete returned location, parent ID, session ID,
and transcript. Refuse changed or unavailable restore destinations rather than
silently reassigning sessions. Reject duplicate message IDs across the whole
family. Existing single-project archives remain readable.

Reject visible workspace IDs before archive writes or restoration imports.
V2.0.24's public HTTP API strips workspace IDs, so it cannot prove that a live
tree has no workspace-linked sessions. Workspace identity restoration is outside
these transcript archive guarantees; disclose this API limitation.

The user explicitly accepted guarded, non-atomic deletion for the first version.
Communicate the remaining concurrent-write risk in documentation. Do not
describe this workflow as lossless. The user must stop other clients and
automations from writing to the session tree before invoking an archive.

## Non-goals

No direct SQLite edits, synthetic native events, automatic scheduled archiving,
custom web/desktop UI extensions, arbitrary-file imports, archive-file deletion,
or full runtime/project backups. Do not change global OpenCode configuration
during development or archive real user sessions as a validation step.

## Acceptance and rollout

Tests must show private, verified, no-overwrite storage; project isolation;
complete descendant handling; safe refusal; and parent-first restoration.
Coverage must include cross-project archive/restore, non-Git descendants, root
project isolation, and restoration refusal before any import when a descendant's
original project location is unavailable or changed. Coverage must include
mapped roots and descendants, exact source matching, destination preflight and
post-import verification, unchanged archive files, source-scope isolation, and
refusal of ambiguous archive IDs. Desktop and TUI coverage must show only the
four command names, the exact current root or child ID without session or archive
changes, archive, restore, and delete without confirmation, and
restoration by supplied ID or picker selection. Coverage must include lookup by root and
descendant session IDs, retained UUID input, a matching-only picker for repeated
archives, and no import for missing IDs or cancelled or invalid matching
selections. Delete coverage must include current and explicit targets,
cross-project descendants, immediate deletion without confirmation, changed-tree
refusal, scope and lifetime checks, failure reporting, retained archive files,
and TUI navigation and tab cleanup. Server coverage must show filtered summary
RPCs, without returning transcript bodies or expanding project scope. Desktop
coverage must also show command registration, cancellable archive selection,
native question form compatibility, and refusal of a connection to a different
server. TUI coverage must show palette actions with no slash registrations and
marked-form transport for terminal archive selection, cancellation, result
acknowledgement and navigation without a second restore, and a warning when
post-restore refresh fails. Search coverage must distinguish title-word
matching, root-ID and archive-ID matching, newest-first ordering, and no
matching results. Automatic recovery coverage must distinguish exact saved
commits, shared-root deduplication, full preflight refusal, missing metadata,
and existing-location restoration without recovery. Slash commands require a
managed service registration on their host; standalone and embedded servers fail
closed. TUI palette actions retain remote and standalone support. The
repository is public; the package remains unpublished on npm. Install the built
checkout only after the user chooses to enable it. See
[ADR 0003](adr/0003-immediate-archive-and-restore.md) and
[ADR 0005](adr/0005-cross-project-session-trees.md) and
[ADR 0006](adr/0006-explicit-restore-relocations.md) and
[ADR 0007](adr/0007-server-owned-slash-commands.md) and
[ADR 0008](adr/0008-immediate-session-deletion.md) and
[ADR 0009](adr/0009-confirmed-worktree-recreation.md). These terminal and
automatic-recovery requirements are implemented by
[ADR 0010](adr/0010-terminal-restore-and-automatic-recovery.md), which
supersedes ADR 0009's interactive recovery decision.
