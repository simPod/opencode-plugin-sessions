# 0001: File-backed transcript archives through native V2 APIs

## Status

Accepted. Guarded non-atomic deletion was explicitly approved for the first
version. Implements the [session archive requirements](../session-archive.md).

## Context

OpenCode V2.0.24 retains an archive timestamp but has no public archive/restore
API, atomic compare-and-delete, or admission lock. Its server plugin context
does not expose the complete transfer, hierarchy, or activity API. The TUI's
connected client does. Direct SQLite writes bypass native events and do not hide
sessions consistently across clients.

## Decision

Use a server plugin for project-scoped private JSON storage over validated RPC,
and a TUI plugin for confirmed session operations through its existing
authenticated client. Use native export, recursive delete, and import. Do not
discover a second server, mutate SQLite, or imitate native events.

Adopt a version-1 envelope containing project identity, root ID, original native
transfer records in parent-first order, archive UUID, creation time, and a
checksum. Validate native records with OpenCode's V2 schema. Use configurable
server-side storage, stable per-project directories, private permissions, and
atomic no-overwrite file publication. Retain all archives after restoration.

## Consequences

Native lifecycle events keep clients informed, and unrelated projects have
separate storage. File archives contain private data and need protected,
optionally encrypted storage. RPC transport does not make an archive a full
runtime backup, and TUI commands do not add web/desktop controls.

Rechecks and explicit exclusive-use confirmation reduce but cannot eliminate the
export-to-delete race. Concurrent writes can still be lost. Busy sessions and
state that native import does not restore are refused. Existing IDs prevent
restore, and partial restoration needs manual inspection rather than unsafe
automatic rollback. A future atomic native archive API should replace this
destructive sequence and supersede this ADR.

The V2.0.24 SDK's published declarations omit explicit `undefined` from two
generic constraints used by its own generated types. Keep strict checking and
apply a declaration-only package patch until the SDK fixes those constraints.
Install TUI type peers for builds; do not disable library checking to avoid
them.
