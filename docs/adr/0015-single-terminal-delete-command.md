# 0015: Keep one terminal delete command

## Status

Accepted. Supersedes the delete registration in
[ADR 0014](0014-model-free-terminal-archive-and-delete.md). Retains the
immediate deletion policy in [ADR 0008](0008-immediate-session-deletion.md).

## Context

Separate server and terminal delete names left two delete commands in terminal
autocomplete. Only the terminal-local handler bypasses the stock client's
model check. The server command catalog is shared with Desktop; the plugin
cannot hide a server command only from the terminal.

## Decision

Register `/session-delete` only on the terminal's existing model-free delete
handler. Remove `/delete-session` and the server delete registration. Archive
and restore command registration do not change.

## Consequences

The terminal has one delete slash command. Desktop users can delete sessions
through OpenCode's built-in Delete action, not a plugin slash command.
