# 0014: Model-free terminal archive and delete commands

## Status

Accepted. Refines [ADR 0007](0007-server-owned-slash-commands.md) for archive and
delete. Implements the updated [session archive requirements](../session-archive.md).

## Context

The OpenCode terminal checks the selected model before sending a server slash
command. It rejects archive and delete when an older session's saved model is
unavailable, even though neither operation needs a model. The terminal runs
argument-taking local slash commands before that check. It displays both local
and server commands and does not deduplicate names.

## Decision

Register `/archive-session` and `/delete-session` on the existing terminal
palette handlers. Keep the server command names and restore behavior unchanged.
Do not patch OpenCode or change any saved model.

## Consequences

Terminal users can archive or delete by typing the new names in stock OpenCode.
Desktop users retain `/session-archive` and `/session-delete`. The server names
remain visible in the terminal, but they do not bypass the terminal's model check.
