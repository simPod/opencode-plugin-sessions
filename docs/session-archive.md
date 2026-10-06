# Session Archive Requirements

## Goal

Remove completed conversations from the live OpenCode session list while keeping
their transcripts available for later restoration.

## Behavior

Provide desktop and TUI slash commands to archive a session family, browse
archives, and restore a family. Archive means verified JSON export followed by
recursive native deletion. Unarchive means native import with original IDs,
parents first. These commands must not invoke a model.

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

## Safety requirements

The user explicitly approved removing archive and restore confirmations. Refuse
busy, queued, incomplete, forked, reverted, or unsupported cross-project session
families. Save the complete settled transcript of every descendant privately and
verify it before deletion. Abort when the captured family changes.

Restore must not overwrite existing IDs. Keep archives after success or failure.
Do not automatically delete sessions after a partial restore.

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
Desktop and TUI coverage must show archive and restore without confirmation.
Desktop coverage must also show command registration, cancellable archive
selection, native question form compatibility, and refusal of a connection to a
different server. Desktop commands require a managed service registration on
their host; standalone and embedded servers fail closed. TUI remote connections
remain supported. Publish the repository privately. Install the built checkout
only after the user chooses to enable it. See
[ADR 0003](adr/0003-immediate-archive-and-restore.md).
