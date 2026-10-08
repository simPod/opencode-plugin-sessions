# 0008: Immediate session deletion without confirmation

## Status

Accepted. Replaces the initial delete confirmation requirement in the
[session archive PRD](../session-archive.md). Extends the immediate operation
policy in [ADR 0003](0003-immediate-archive-and-restore.md) to deletion without a
backup.

## Context

The user explicitly requests permanent deletion on submit, without a confirmation
question. Delete uses native recursive removal, stops active work, and does not
create an archive. A confirmation cannot make the existing tree recheck and
native deletion atomic.

## Decision

Remove the confirmation question from server slash commands and the TUI delete
palette action. Treat command submission or palette invocation as the user action
that starts deletion. Keep the current-session default, explicit IDs, tree
identity recheck, scope and lifetime checks, shared operation guards, deletion
verification, results, and TUI palette navigation. Keep existing archive files
unchanged.

## Consequences

Deletion starts without a later cancellation or approval step. Accidental command
submission can permanently remove a session and all descendants, including those
in other projects. There is no backup or automatic recovery. A new descendant
created in the check-to-delete gap can also be removed. Users must choose archive
instead when they need to retain a transcript. Result panels acknowledge a
completed operation; they do not approve deletion.
