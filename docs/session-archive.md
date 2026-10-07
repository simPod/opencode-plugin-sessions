# Session Archive Requirements

## Goal

Remove completed conversations from the live OpenCode session list while keeping
their transcripts available for later restoration.

## Behavior

Provide two desktop and TUI slash commands: `/session-archive [session-id]` and
`/session-restore [session-id | archive-id]`. Without an ID, restore opens the
current project's archive picker. Remove `/session-unarchive` and
`/session-archives` without aliases. Archive means verified JSON export followed
by recursive native deletion. Restore means native import with original IDs,
parents first. These commands must not invoke a model.

Session-ID lookup matches any saved root or descendant in archives available to
the current project, including explicitly mapped sources. Restore the whole
saved family immediately when exactly one archive matches. For multiple matches,
show only those archives in the picker; never choose one automatically. No match,
cancellation, or a selection outside the matching set must not import sessions.
Keep archive UUID input compatible. Before import, check that the selected
archive still contains the supplied session ID. Do not widen project scope or
change saved files, archive identity, or restoration safeguards for this lookup.

Desktop commands must appear in the slash-command list. Use native question
forms for archive selection and results. Archive and restore run without
confirmation in both desktop and TUI. Selecting an archive restores it
immediately; cancelling the archive picker makes no changes. Commands cannot be
queued. After archiving the open session, the user can open another session from
the sidebar; restoring makes the original sessions available in the session list
without automatic navigation.

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

Mapped restore changes only imported project IDs and directories; retain session
IDs, parent links, transcripts, and original archive bytes. Mapped root archives
are visible in the destination picker only when their exact root pair explicitly
maps to the current project and directory. Do not move archives or create
missing source folders. Refuse duplicate eligible archive UUIDs rather than
guessing. Do not rewrite permission rules, metadata, or paths embedded in
transcripts.

## Safety requirements

The user explicitly approved removing archive and restore confirmations. Refuse
busy, queued, incomplete, forked, or reverted session families. Save the
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
two command names, archive and restore without confirmation, and restoration by
supplied ID or picker selection. Coverage must include lookup by root and
descendant session IDs, retained UUID input, a matching-only picker for repeated
archives, and no import for missing IDs or cancelled or invalid matching
selections. Server coverage must show filtered summary RPCs, without returning
transcript bodies or expanding project scope. Desktop coverage must also show
command registration, cancellable archive selection, native question form
compatibility, and refusal of a connection to a different server. Desktop
commands require a managed service registration on their host; standalone and
embedded servers fail closed. TUI remote connections remain supported. The
repository is public; the package remains unpublished on npm. Install the built
checkout only after the user chooses to enable it. See
[ADR 0003](adr/0003-immediate-archive-and-restore.md) and
[ADR 0005](adr/0005-cross-project-session-trees.md) and
[ADR 0006](adr/0006-explicit-restore-relocations.md).
