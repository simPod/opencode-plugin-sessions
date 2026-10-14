# 0010: Searchable terminal restore and automatic worktree recovery

## Status

Accepted. Implements the updated
[session archive requirements](../session-archive.md). Supersedes
[ADR 0009](0009-confirmed-worktree-recreation.md)'s interactive recovery
decision and extends [ADR 0007](0007-server-owned-slash-commands.md)'s terminal
presentation.

## Context

The terminal's server-owned restore command uses a question list that is hard to
search and navigate. OpenCode combines server and terminal slash entries without
deduplication. A same-name terminal command changes execution but adds a
duplicate completion entry. The public API provides form events and replies, not
a client-specific server-command renderer.

Recovery currently asks for manual repository, ref, and path details when an
archive lacks metadata, then asks for confirmation. The requested restore flow
must have no recovery questions. Archive metadata contains exact commits, not
working-copy backups; missing metadata cannot support a reliable automatic
choice.

## Decision

Keep the server's single slash command. Add namespaced metadata to its archive
selection and completed-result forms. The terminal listens for these forms only
when their session is visible, presents a native searchable select, and replies
to or cancels the original form through the connected client's location-scoped
form API. The server remains the only owner of slash restoration. Desktop keeps
native question forms; terminal palette restore uses the same compact options.

Rows show title, session count, and a short date. Match title words, root
session IDs, and archive IDs case-insensitively without changing newest-first
order. Use the host's scrolling and keyboard controls. Automatically acknowledge
a completed restore result, refresh the family, show a toast, and open its root
only if the invoking session is still visible. Do not execute restore again.

Automatically prepare and recreate missing worktrees using exact recorded
project/directory pairs and full saved commits. Preflight the whole family
before any creation. Remove manual-source and confirmation callbacks. If any
missing location has no recorded repository and commit, refuse creation and
import, retain the archive, and explain how to use an existing directory or an
explicit mapping. Version-1 archives remain usable at existing locations.

Retain detached Git recreation, source-project validation, archive fingerprint
checks, no-overwrite rules, disabled hooks/filters/fetching, parent-first
imports, and post-import verification. Report created-worktree count and backup
limits; warn when recovered snapshots were dirty. Keep archives and created
worktrees after failures rather than attempting destructive rollback.

## Consequences

Terminal restore needs one archive choice, with no recovery or result-approval
questions. It does not need new slash registrations, RPC methods, or global
configuration. Old archives with missing directories cannot recover
automatically without metadata; the plugin does not invent a commit.

Only committed files are recreated. Uncommitted/untracked files, dependencies,
and environment files remain unavailable. A source repository and its saved Git
objects must still exist on the server.

Forms are shared session state and have no originating-client identity. Other
clients viewing the same session can see or answer the same form; the terminal
overlay is not an exclusive replacement for the underlying question renderer.
Use one client for restore. Existing pending forms after plugin reload remain
available through the host's native question UI.
