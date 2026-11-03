# 0012: Cancel the native restore form before terminal selection

## Status

Accepted. Implements the updated [session archive requirements](../session-archive.md).
Supersedes only [ADR 0010](0010-terminal-restore-and-automatic-recovery.md)'s
selection presentation and execution decision. Retains its automatic worktree
recovery and explicit-ID result handling, and
[ADR 0007](0007-server-owned-slash-commands.md)'s single server slash entry.

## Context

The searchable terminal popup leaves the native inline restore form visible
behind it. The requested presentation is the popup alone, not two copies of the
same choice. The installed SDK and runtime have no supported API to hide a form
or claim its rendering for one client. Public form cancellation removes the
pending question, but also ends the server's wait for its answer.

Adding a terminal slash command would duplicate completion entries. Removing the
server command would remove desktop support. Private form-cache changes or
renderer patches would depend on unsupported host internals.

## Decision

Keep the single server-owned slash entry and its native selection form for
desktop and clients without terminal takeover. Retain the selection metadata's
archive summaries and include the optional original `targetSessionID` constraint.

For a marked selection form in the visible session, the TUI awaits the public
form cancellation API at `event.location` before opening the searchable popup.
If cancellation fails, do not open the popup or run restore. The server's form
ask returns `undefined` on cancellation and exits without restoring anything.
Do not reply to a cancelled form.

After a popup choice, execute the exact selected archive directly through the
existing TUI restore engine, retaining `event.location` and the original target
session-ID constraint. In particular, do not parse a selected native archive's
session ID as fresh lookup input or open another picker. Keep the existing
eligibility checks, native/file restore paths, operation guard, refresh,
navigation, and toast behavior. Cancellation, failure, or unload before a choice
makes no session changes.

Unambiguous explicit-ID slash paths still restore on the server. Their marked
completed-result forms are automatically acknowledged by the TUI, which refreshes
the restored family without executing restore again. Desktop keeps native
question selection and its existing result behavior when no TUI takes over.

Do not add slash entries, remove desktop commands, use private cache or renderer
APIs, or add new concurrency safeguards. File-backed archive creation, permanent
deletion, native restore semantics, file restore validation, mappings, and
worktree recovery safeguards are unchanged.

## Consequences

The native form can appear briefly before cancellation completes. Once
cancellation succeeds, it no longer remains behind the popup. This is the
smallest supported handoff, not suppression of the host's initial rendering.

Forms are shared session state without originating-client identity. Cancellation
is not an exclusive claim by the invoking terminal; another client viewing the
same session can see or answer the form. Use one client for restore.

After cancellation, the server command has finished its selection path and the
popup is not durable. Cancelling or reloading before a choice makes no session
changes and requires running the command again. There is no guarantee of a
pending native-form fallback after that form has already been cancelled.
