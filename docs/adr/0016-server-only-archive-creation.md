# 0016: Keep archive creation on the server

## Status

Accepted. Implements the [session archive requirements](../session-archive.md).
Supersedes the terminal-local archive paths in
[ADR 0013](0013-native-archive-creation.md) and
[ADR 0014](0014-model-free-terminal-archive-and-delete.md).
[ADR 0015](0015-single-terminal-delete-command.md) remains unchanged.

## Context

The terminal lists server and local slash commands together. The local
`/archive-session` command bypasses the terminal's model check, but gives users
two commands for the same operation.

## Decision

Keep `/session-archive` as the only plugin command that creates an archive.
Remove the terminal-local slash command and archive palette action. Do not
patch OpenCode or replace the workaround with another local path. Keep the
terminal's server-result toasts and tab cleanup.

## Consequences

Desktop and terminal use the same command name. The stock terminal can still
reject it before dispatch if the selected model is unavailable. Restore and
delete are unchanged.
