# OpenCode Sessions Plugin

An OpenCode V2 plugin that saves session transcripts to private JSON files, then
deletes the live session tree. File restore imports the saved session IDs and
messages. Existing native archives also remain restorable. The plugin can also
permanently delete a session tree without an archive.

**Archive deletion is not atomic.** Stop other clients and automations from
changing the tree before archiving. A write or new descendant in the final
check-to-delete gap can be lost. Do not use this as a lossless backup of an
actively shared session.

Native archive creation is deferred: OpenCode 2.2.0's native TUI session picker
still includes archived sessions ([upstream issue #58364](https://github.com/anomalyco/opencode/issues/58364)).
New archives keep the file-backed behavior until the native picker hides archived
rows. The plugin does not replace or patch that picker. No files are migrated,
and existing native archives are left unchanged unless explicitly restored or
deleted.

## Commands

The server plugin adds slash commands in desktop and TUI. The TUI plugin adds
command-palette actions, without duplicate slash entries. Neither submits prompts
to a model:

- `/session-id`: show the exact current session ID in a result panel. No arguments
  are accepted; sessions and archive files are not changed.
- `/session-archive [session-id]`: save and verify the current session, or the
  supplied ID, and its descendants, then delete them without confirmation.
- `/session-restore [session-id | archive-id]`: clear the native archive flag for
  an archived family, or import a file archive. Root and descendant
  session IDs and archive UUIDs are supported. Without an ID, browse the
  current project's native and file archives and select one to restore immediately.
- `/session-delete [session-id]`: permanently delete the current session, or the
  supplied ID, and its descendants immediately, without confirmation. No archive
  is saved. Active work is stopped. Existing archive files are not changed.

Native archives are grouped under their highest archived ancestor. Session-ID
lookup restores that family, not only the supplied descendant. The root must
belong to the current project; the shared non-Git `global` project also requires
the exact current directory. File lookup retains explicitly mapped sources and
saved descendant IDs. One match restores immediately; multiple matches open a
matching-only picker. No match makes no changes. The combined picker sorts by
archive date, newest first, not by the last conversation activity.

`/session-restore` replaces `/session-unarchive` and `/session-archives`. The
old command names are not aliases. Existing archive files and IDs are unchanged.

Archive, restore, and delete run without confirmation in both desktop and TUI.
Selecting an archive restores it immediately; cancelling the picker makes no
changes. Commands run immediately and cannot be queued.

Terminal restore uses a compact, searchable picker. Type to match a title, root
session ID, or archive ID. Results stay newest first. Use Up/Down,
Ctrl+P/Ctrl+N, Page Up/Page Down, Home/End, Enter to restore, or Escape to
cancel. The terminal opens the restored session and shows a toast without
another acknowledgement. Desktop restore keeps native question panels and
returns restored sessions to the list without opening them. Other result panels
require acknowledgement, not approval of the completed operation. Archive slash
commands show a start toast and track completion for the invoking visible session.
The success or failure toast still appears if deletion sends that TUI home.
These events are not replayed after disconnection; errors still follow the normal
command error path. Desktop retains result panels when the invoking session
survives. No result panel is attached to a deleted session. After archiving or
deleting the open session through a slash command, open another session from the
session list afterward. Palette actions keep their own toast.

The terminal picker handles forms for the visible session. OpenCode does not
identify the client that started a form; another client viewing that session can
also see or answer it. Use one client for restore. If the plugin reloads during
selection, the pending form remains available in the native question UI.

Submitting `/session-delete` or running its TUI palette action starts deletion
without an approval step or a later cancellation step. Delete does not need a
settled or restorable transcript: it uses native deletion,
including for active, forked, or reverted sessions. The tree's IDs, parent links,
projects, locations, and titles are checked again before deletion;
changes stop deletion. This check is not atomic with native recursive deletion.
A new descendant created in that gap can also be deleted.
Stop other clients and automations if you need the captured set to stay fixed.
There is no backup or automatic recovery. Descendants from other projects are
also deleted. Native archives do not protect sessions from permanent deletion;
use an independent backup when one is required.

The TUI command palette retains **Archive session tree**, **Restore session
archive**, and **Delete session tree permanently** under **Session archives**.
Restore uses the same searchable TUI picker and opens the restored session.
Archive and delete act on the open session and leave the affected chat.

Slash commands require the server's existing managed-service registration. The
plugin authenticates with that registration and verifies that it connects to its
own hosting plugin instance before reading or changing sessions. It never starts
a second server. Standalone or embedded hosts without a matching registration
are refused; the TUI palette actions do not have this restriction.

The TUI palette actions use the server plugin's RPCs and their existing
authenticated client for session operations, so they never discover a different
local server. This also supports a remote OpenCode server: native archives stay
in its database, and file archives are stored and read on that server. Slash
commands also work when connected to a remote managed server; its service
registration is read on that server, not the client machine. The plugin does not
add custom desktop buttons.

## Install

Requires OpenCode V2.1.4 or newer, Git, Node 26.4 or newer, and pnpm 10.33.3.
Build the local checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Builds use Node 24 type declarations for compatibility with OpenTUI's
`EventEmitter` declarations. The runtime and CI use Node 26; strict library
checking remains enabled. pnpm
applies the tracked, version-specific OpenCode SDK declaration patch during
installation; no postinstall script or hoisted transitive dependency is needed.

Add the package to the relevant OpenCode configuration. Replace the paths with
absolute paths on the server. Do not point configuration at a temporary
implementation worktree:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-plugin-sessions/dist",
      "options": {
        "storageDirectory": "~/.opencode-session-archives",
      },
    },
  ],
}
```

Use the built `dist` directory for a local installation: OpenCode's local
directory loader looks for `index.js`, `tui.js`, and `rpc.js` there rather than
using the root package's exports.

The package exports both a server plugin and `./tui` for automatic terminal
plugin loading. A CLI plugin installed separately against a remote server still
needs the server plugin configured there for storage RPCs. This package is not
published to npm; installation uses the built checkout.

OpenCode supplies the plugin's Effect runtime. The pinned SDK packages must
match that runtime; after an OpenCode upgrade that changes Effect APIs, update
the SDK packages together, reinstall dependencies, and rebuild this checkout.

## Native restore and removed worktrees

Native restore only clears the archive flag. Session IDs, messages, parent links,
fork/revert state, and environment state remain in the database; they are not
recreated through import. Native archive state does not capture worktree recovery
metadata. Native restore does not recreate removed directories or worktrees,
restore project files, or apply `restoreMappings`. Make the required directory
and project files available separately; a missing location can cause the server
to reject the native update. Clearing native archive state does not stop active
work.

Native state does not record archive batches. Families follow adjacent archived
parent links; restore traverses the current subtree, including descendants
archived in separate operations. File archives instead restore their exact saved
trees.

## File restore and removed worktrees

Version-1 and version-2 JSON archives remain readable. Only this file restore path
imports sessions, uses `restoreMappings`, and can recreate missing Git worktrees.
New archives use the version-2 file format.

Version-2 files record linked-worktree repository, exact commit, root, branch
label, and dirty state. Restore automatically recreates missing Git worktrees
from that metadata, without repository, commit, path, or confirmation questions.
Recovery uses the recorded project and directory, not the branch's current tip.
A session can point inside the recorded worktree root.

Version-1 archives remain readable when their locations exist. If any missing
location lacks recorded recovery details, restoration stops before any worktree
creation or session import and retains the archive. Recreate the original
directory or configure an explicit mapping to an existing destination; the
plugin does not ask for manual details or guess a commit. This also applies to
missing mapped destinations.

Recreation uses detached Git worktrees so existing branches do not move. It does
not overwrite paths, force stale Git registrations, fetch repositories, or run
Git hooks, configured checkout filters, or OpenCode startup commands.
Filter-managed content such as Git LFS files stays in its committed form until
you explicitly run the relevant tool. Recovery requires the hosting server's
managed-service registration; ordinary TUI archive and restore remain available
without it.

These archives are not project backups. Only committed files are recreated;
uncommitted files, untracked files, dependencies, and local environment files
are not restored. The completed result reports recovery limits and warns when
the archived worktree contained uncommitted or untracked files. If creation or
later restore checks fail, keep the archive and any created worktrees for
inspection; the plugin does not automatically remove them. All restore locations
must still match their expected projects before any session is imported.

Optional server plugin `restoreMappings` explicitly relocate archived sessions.
The default is `[]`: restore uses the original project and directory.

```jsonc
"options": {
  "restoreMappings": [
    {
      "from": { "projectID": "old-project-id", "directory": "/absolute/old-worktree" },
      "to": { "projectID": "current-project-id", "directory": "/absolute/current-worktree" }
    }
  ]
}
```

Use actual OpenCode project IDs and absolute paths on the connected server. Each
rule matches the exact original project ID and directory together. There are no
prefix matches, automatic guesses, or mapping chains. Duplicate source pairs are
rejected. A mapped destination must exist, be readable, and resolve to the
specified destination project ID. Desktop and TUI read the same server rules.
Configured mappings apply to subsequent `/session-restore` calls, with or
without an archive ID; they do not affect archive creation, native restore, or
deletion.

Restore keeps session IDs, parent links, messages, and the original archive
unchanged. Only the imported project ID and directory change, plus the existing
removal of the native archive timestamp. The picker includes old root archives
only when their exact original root pair maps to the current project and
directory. Missing mapped-source folders are not created, archive files are not
moved, and ambiguous duplicate archive UUIDs are refused.

Paths inside messages, metadata, and permission rules are not rewritten. Review
saved permissions before resuming a relocated session; rules for the old paths
may no longer apply to the new directory. Workspace identity restoration is
still unsupported. Remove a mapping when it should no longer apply.

## File storage

`storageDirectory` accepts an absolute path or `~/...`. Without it, the plugin
uses `~/.opencode-session-archives` for file archives. Native archives
do not use this directory. For remote connections, `~` is the server
user's home, not the client's home. `XDG_DATA_HOME` does not change this
default. Existing archives are not moved; set `storageDirectory` to their
current directory if needed.

```text
~/.opencode-session-archives/
  my-project--<stable-project-hash>/
    <archive-uuid>.json
```

The readable project name is only a label. The stable project ID determines
isolation, so repositories with the same name do not share archives. Worktrees
of one Git project share its folder. Non-Git locations use their directory as an
additional key because OpenCode gives them the shared `global` project ID.
Renaming a project's label reuses its existing ID-based folder.

Storage directories must be private (`0700`) and files private (`0600`).
Existing unsafe permissions or symlinks are rejected, not silently changed.
Files contain unsanitized transcripts and can contain secrets. They are not
encrypted. Use private storage and an encrypted disk or filesystem if needed.
Do not commit archive files to Git or expose their directory through HTTP.

Each versioned JSON file contains the root and all descendants in parent-first
order, their original project IDs and directories, optional Git recovery
metadata, and a SHA-256 checksum. A family can span multiple projects, including
non-Git locations. The whole archive stays in the root project's folder; it is
not split between descendant projects. Writes are synced, published atomically
without overwriting another archive, and read back before deletion. The checksum
detects accidental damage, not malicious edits by someone who can write the
directory. Restore does not change or remove these files.

## Safety and limitations

- File archive refuses running sessions, queued work, unfinished messages/tools,
  visible workspace IDs, and fork/revert state, including in descendants. It
  collects all message pages and descendants, checks the raw messages against
  native exports, saves and verifies the exact tree, then rechecks before native
  recursive deletion. These checks reduce but do not remove the final race.
- Native restore traverses descendants, including other projects, and clears
  `archived` on each session separately. Updates are not atomic and do not lock
  the family. On failure, inspect the session list before retrying; completed
  updates are not rolled back. An unavailable native API fails without a file
  export/delete/import fallback.
- Native deletion removes descendants recursively, including archived sessions.
  `/session-delete` makes no backup and leaves existing file archives unchanged.
- File restore refuses existing IDs and missing external parents. It
  checks every directory and project before parent-first import and verifies
  imported locations and transcripts. It does not silently remap projects.
- A root file archive contains private transcripts from every descendant
  project. Project folders organize storage; they are not separate authorization
  boundaries. Use only a server and archive storage you trust for all these
  projects. Existing single-project archives remain readable.
- File import cannot restore workspace identity and rejects visible
  workspace IDs. Its older transcript format is not a full runtime backup.
- File archives remain after successful or partial restoration. There is no
  automatic rollback or deletion of imported sessions. After a partial file
  restore, inspect existing IDs before recovery; a normal retry refuses those IDs.
- Imported sessions are non-archived, but their update time is changed by
  OpenCode. Export/import restores transcripts, not project files, snapshots,
  pending work, environment overrides, instruction entries, or original event
  history. Native import does not restore fork/revert state, so those sessions
  are refused rather than silently losing it.

Native update/delete/import operations publish OpenCode's normal session events.
The plugin does not fabricate native events or write SQLite.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

CI runs these commands. Tests use temporary files and a simulated API; they do
not archive, delete, or import real OpenCode sessions. See the
[requirements](docs/session-archive.md) and
[architecture decision](docs/adr/0011-native-session-archives.md).
