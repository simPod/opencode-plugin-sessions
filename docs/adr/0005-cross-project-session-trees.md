# 0005: Root-scoped archives for complete cross-project session trees

## Status

Accepted. Supersedes the descendant project refusals retained in
[ADR 0003](0003-immediate-archive-and-restore.md). Implements the updated
[session archive PRD](../session-archive.md). Original-location-only restoration
is superseded by [ADR 0006](0006-explicit-restore-relocations.md) for explicit
configured mappings.

## Context

OpenCode sessions can have child sessions in other repositories or non-Git
locations. The plugin rejected these families because it required every member
to have the root's project ID. A real session tree reproduced this refusal.
Native recursive deletion follows parent links across projects. Skipping or
splitting foreign descendants would permit deletion without a complete backup.

OpenCode V2.0.24 import preserves session and parent IDs, but derives the
project ID from the supplied location, not the archived `info.projectID`.
Restoring a removed or changed repository can therefore silently reassign a
session.

## Decision

Store the complete tree in the root project's archive folder. Keep the existing
version-1 envelope: its `projectID` identifies the root and storage scope; each
native transfer retains its own original project ID and directory. Require the
root to match the envelope and keep desktop, TUI, and file-storage root scope
checks. Permit differing descendant projects, not duplicate sessions, invalid
parent links, cycles, or duplicate message IDs across the family.

Capture and verify every descendant without project filters. Compare each export
with that session's captured project and location. Retain settled-work checks,
verified export before deletion, complete-family fingerprint rechecks, global ID
conflict checks, and parent-first native imports.

Before any restore import, use native file listing for a fresh server-side check
that each saved directory exists, is a directory, and is readable. An empty
directory is valid. Then resolve every saved directory through the connected
server and require its project ID to match the archive. Location metadata can be
cached, so this is a preflight check, not a freshness guarantee. After each
import, verify the session ID, parent ID, project ID, full returned location,
and transcript. Refuse a mismatch rather than silently remapping identity. Keep
the archive and any partial imports; do not write SQLite or remove sessions to
recover. Do not reload the server's location services to refresh metadata.

Reject visible workspace IDs before archive writes and restore imports. The
native HTTP import accepts only a directory and cannot preserve workspace
identity. Its public get/list/export responses also omit workspace IDs, so these
APIs cannot detect every workspace-linked live session. Do not claim full
runtime or workspace restoration.

## Consequences

Existing single-project archives remain valid. Older plugin builds reject new
cross-project archives safely; use the updated plugin to restore them. The root
archive can contain private transcripts and permissions from other projects;
folder separation is storage organization, not an authorization boundary.

Deleted worktrees and changed repository identities may need to be restored
before import. Archive files preserve original metadata but cannot rebuild
project files or force native import to accept a changed project identity.
Project-resolution races can still cause partial restoration; post-import checks
detect mismatches. The accepted export-to-delete race applies to every
descendant project. All relevant clients and automations must stop writing to
the complete tree before archiving.
