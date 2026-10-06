# Session Archive Requirements

## Goal

Remove completed conversations from the live OpenCode session list while keeping
their transcripts available for later restoration.

## Behavior

Provide TUI slash commands to archive a session family, browse archives, and
restore a family. Archive means verified JSON export followed by recursive
native deletion. Unarchive means native import with original IDs, parents first.
These commands must not invoke a model.

Storage is configurable and resides on the connected server. Project folders use
a readable label plus a stable project key. Worktrees of the same Git project
share storage; unrelated repositories and non-Git locations do not.

## Safety requirements

Require explicit confirmation and exclusive use before deletion. Refuse busy,
queued, incomplete, forked, reverted, or unsupported cross-project session
families. Save the complete settled transcript of every descendant privately and
verify it before deletion. Abort when the confirmed family changes.

Restore must not overwrite existing IDs. Keep archives after success or failure.
Do not automatically delete sessions after a partial restore.

The user explicitly accepted guarded, non-atomic deletion for the first version.
Communicate the remaining concurrent-write risk in documentation and the archive
confirmation. Do not describe this workflow as lossless.

## Non-goals

No direct SQLite edits, synthetic native events, automatic scheduled archiving,
web/desktop UI controls, arbitrary-file imports, archive-file deletion, or full
runtime/project backups. Do not change global OpenCode configuration during
development or archive real user sessions as a validation step.

## Acceptance and rollout

Tests must show private, verified, no-overwrite storage; project isolation;
complete descendant handling; safe refusal; and parent-first restoration.
Publish the repository privately. Install the built checkout only after the user
chooses to enable it. See
[ADR 0001](adr/0001-file-backed-transcript-archives.md).
