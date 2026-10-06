# 0003: Immediate archive and restore without confirmation

## Status

Accepted. Supersedes the confirmation requirements in
[ADR 0001](0001-file-backed-transcript-archives.md) and
[ADR 0002](0002-desktop-session-commands.md). Implements the updated
[session archive PRD](../session-archive.md). Descendant project refusals are
superseded by [ADR 0005](0005-cross-project-session-trees.md); root scope checks
remain.

## Context

The user accepts non-atomic deletion and explicitly requested removal of both
archive and restore confirmations. The desktop question panel adds a selection
and submission step; its renderer ignores defaults, so a plugin cannot preselect
the affirmative answer. Confirmation prevents accidental operations, but does
not supply a session lock or make export-and-delete atomic.

## Decision

Remove archive and restore confirmation dialogs from desktop and TUI. Treat
invoking archive or restore, or selecting an archive in the picker, as the user
action that starts the operation. Remove the archive service's confirmation
boolean rather than passing a fictional confirmation.

Retain internal snapshots, fingerprint rechecks, verified private export before
deletion, busy/queued/unfinished and project refusals, original-ID conflict
checks, parent-first imports, and retained backups. Keep archive selection and
its cancellation, operation guards, native result panels, and server-instance
verification unchanged.

## Consequences

Archive immediately deletes the chosen session and all descendants after export
verification. Restore with an ID or picker selection immediately imports the
archive. There is no later cancellation step. Users must stop other clients and
automations from writing to the tree before archiving. The accepted concurrent
write risk remains; this is not a lossless backup for an actively shared tree.

Desktop result panels still require acknowledgement after the operation; they
are not confirmation gates. Existing desktop navigation limits are unchanged.
