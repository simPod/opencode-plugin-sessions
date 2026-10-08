# 0007: Server-owned slash commands and TUI palette actions

## Status

Accepted. Refines command exposure in
[ADR 0002](0002-desktop-session-commands.md). Implements the single-entry
requirement in the [session archive PRD](../session-archive.md).

## Context

OpenCode V2 combines server and TUI slash-command lists without removing duplicate
names. Registering archive, restore, and delete in both lists displays each
command twice.
The public plugin API cannot hide a server command in one client, and changing
TUI command IDs or layer priority does not affect the combined list.

## Decision

Register `/session-archive`, `/session-restore`, and `/session-delete` only on the
server. Both desktop and TUI slash invocations use the server callbacks and native
question forms. Keep the TUI callbacks as command-palette actions without slash names or
aliases. Retain their dialogs, connected-client operations, and navigation.

## Consequences

Each slash command appears once without changing OpenCode or introducing new
names. Slash-based restore no longer opens the restored session automatically in
TUI, and slash-based archive or delete does not leave the deleted chat
automatically. Use the TUI palette actions for that navigation.

Slash commands in both clients require the host's managed-service registration.
TUI palette actions retain support for remote and standalone hosts through the
existing authenticated client. Storage and archive/restore safeguards are
unchanged.
