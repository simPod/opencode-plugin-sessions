# 0002: Desktop session commands through a verified service connection

## Status

Accepted. Supersedes the TUI-only interaction and server-storage-only parts of
[ADR 0001](0001-file-backed-transcript-archives.md). Implements the desktop
requirements in the [session archive PRD](../session-archive.md). Archive
format, storage, transfer safeguards, and the accepted non-atomic workflow are
unchanged. The confirmation requirements are superseded by
[ADR 0003](0003-immediate-archive-and-restore.md).

## Context

The user needs archive and restore commands in the desktop app. OpenCode V2.0.24
discovers server command registrations there, but the server plugin context does
not expose native export, import, activity, inbox, or form APIs. The desktop
cannot load a TUI plugin. Casting the context cannot add the missing runtime
capabilities. Custom commands execute immediately, outside the inbox, and have
no success-response payload or desktop navigation API.

## Decision

Register the same command names through the server's command transform. Use the
existing archive service and native HTTP forms, without model prompts or
synthetic transcript events. The desktop displays forms with `kind: question`
and string-choice fields. Require an exact affirmative answer; decline all other
answers. Keep previews, exclusive-use confirmation, and project checks. Reject
queued commands and cancel pending confirmations on timeout or unload.

For desktop execution only, discover the host's existing managed-service
registration and use its authentication headers. Never start a second server.
Before session access, call a read-only instance RPC in the command's location
and compare a fresh plugin-instance UUID. Refuse the operation if the discovered
service does not serve that exact plugin instance. The UUID proves routing, not
user authorization; native HTTP authentication still applies.

Use native question forms for selection and surviving-session results. After
deleting the invoking session, do not attach a result to the deleted tree. Warn
before confirmation that the user must open another session afterward.
Restoration returns sessions to the list; it cannot navigate the desktop. Keep
the TUI's existing connected-client dialogs and navigation.

## Consequences

Desktop commands work with the installed managed service, including desktop
clients connected remotely to that managed host. Standalone or embedded hosts
without a matching service registration fail closed. This constraint can be
removed when the server plugin SDK exposes the required native capabilities.
`@opencode/client` becomes a direct runtime dependency; no new package is added.

Native question results require acknowledgement. Deleting the viewed session can
leave the desktop's session-not-found view until the user changes sessions.
Desktop agent/model selection can record native selection events before command
execution, but the plugin never starts a model or submits a prompt.

Concurrent writes remain outside the plugin's guarantees. The user accepted that
limitation; keep existing guards and confirmation, not a claim of atomicity.
