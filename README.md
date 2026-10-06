# OpenCode Sessions Plugin

An OpenCode V2 plugin that saves session transcripts to private JSON files, then
deletes the live sessions. Restoring an archive imports the original session IDs
and messages.

**Archive deletion is not atomic.** OpenCode V2 has no public session lock or
compare-and-delete operation. Before running an archive, stop other clients and
automations from changing that session or its children. A write in the final
check-to-delete gap can be lost. Do not use this plugin when you need a lossless
backup of an actively shared session.

## Commands

The plugin adds real desktop slash commands, plus TUI slash commands and
command-palette entries. It does not submit prompts to a model:

- `/session-archive [session-id]`: save and verify the current session, or the
  supplied ID, and its descendants, then delete them without confirmation.
- `/session-restore [archive-id]`: restore the supplied archive ID. Without an
  ID, browse the current project's archives and select one to restore
  immediately.

`/session-restore` replaces `/session-unarchive` and `/session-archives`. The
old command names are not aliases. Existing archive files and IDs are unchanged.

Archive and restore run without confirmation in both desktop and TUI. Selecting
an archive restores it immediately; cancelling the archive picker makes no
changes. Desktop commands use native question panels for archive selection and
results. Commands run immediately and cannot be queued. Result panels require
acknowledgement, not approval of the completed operation. When archiving the
open session, open another session from the sidebar afterward. Restore returns
the sessions to the list; it does not automatically open them in desktop.

Desktop commands require the server's existing managed-service registration. The
plugin authenticates with that registration and verifies that it connects to its
own hosting plugin instance before reading or changing sessions. It never starts
a second server. Standalone or embedded hosts without a matching registration
are refused; the TUI flow does not have this restriction.

The server plugin stores files through RPC. The TUI uses its existing
authenticated client for session operations, so it never discovers a different
local server. This also supports a remote OpenCode server: archive files are
stored on that server. Desktop commands also work when connected to a remote
managed server; its service registration is read on that server, not the desktop
machine. The plugin does not add custom desktop buttons. Successful TUI deletion
leaves the archived chat; TUI restoration opens it.

## Install

Requires OpenCode V2.0.24, Git, Node 26.4 or newer, and pnpm 10.33.3. Build the
local checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Builds use Node 24 type declarations because OpenTUI 0.5.14's `KeyHandler.emit`
declaration is incompatible with Node 26's expanded `EventEmitter` types. The
runtime and CI use Node 26; strict library checking remains enabled. pnpm
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

Use the built `dist` directory for a local installation: V2.0.24's local
directory loader looks for `index.js`, `tui.js`, and `rpc.js` there rather than
using the root package's exports.

The package exports both a server plugin and `./tui` for automatic terminal
plugin loading. A CLI plugin installed separately against a remote server still
needs the server plugin configured there for storage RPCs. This package is not
published to npm; installation uses the built checkout.

## Restore after a rename or removed worktree

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
without an archive ID; they do not affect archive export or deletion.

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

## Storage

`storageDirectory` accepts an absolute path or `~/...`. Without it, the plugin
uses `~/.opencode-session-archives`. For remote connections, `~` is the server
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

Directories must be private (`0700`) and files are created with `0600`. Existing
unsafe permissions or symlinks are rejected, not silently changed. Files contain
unsanitized transcripts and can contain secrets. They are not encrypted. Use
private storage and an encrypted disk or filesystem if needed. Do not commit
archive files to Git or expose their directory through HTTP.

Each versioned JSON file contains the root and all descendants in parent-first
order, their original project IDs and directories, and a SHA-256 checksum. A
family can span multiple projects, including non-Git locations. The whole
archive stays in the root project's folder; it is not split between descendant
projects. Writes are synced, published atomically without overwriting an
existing archive, and read back before deletion. The checksum detects accidental
damage, not malicious edits by someone who can write the directory.

## Safety and limitations

- Running sessions, queued inbox work, unfinished messages/tools, and
  fork/revert state prevent archiving, including in descendants from other
  projects.
- All message pages and descendants are collected. The plugin compares raw
  messages with the native export and rechecks the whole family immediately
  before deletion. These checks reduce the concurrency risk; they do not remove
  it.
- Delete removes descendants recursively. Every known descendant must have a
  verified copy before that operation.
- Restore refuses existing IDs and missing external parents. Parents are
  imported before children at their original working directories. Before any
  import, every saved directory must pass a fresh server filesystem check and
  resolve to its original project ID, or an explicitly configured mapped project
  ID. Recreate removed worktrees, restore the original project identity, or set
  a restore mapping before restoring. This project lookup can be cached, so the
  plugin also verifies each imported project ID, location, and transcript and
  stops if the server changes them. It does not silently remap project IDs.
- The root project's archive contains private transcripts from every descendant
  project. Project folders organize storage; they are not separate authorization
  boundaries. Use only a server and archive storage you trust for all these
  projects. Existing single-project archives remain readable; older plugin
  builds refuse new cross-project archives.
- V2.0.24's public HTTP API strips workspace IDs and cannot restore them.
  Visible workspace IDs are refused before archive writes or restore imports,
  but this API cannot detect every workspace-linked live session. Do not rely on
  this plugin to preserve workspace identity.
- Archives remain after successful or partial restoration and after deletion
  errors. There is no automatic rollback or deletion of restored sessions. After
  a partial restore, inspect existing IDs before trying recovery; a normal retry
  refuses those IDs.
- Restored sessions are non-archived, but their update time is changed by
  OpenCode. Export/import restores transcripts, not project files, snapshots,
  pending work, environment overrides, instruction entries, or original event
  history. Native import does not restore fork/revert state, so those sessions
  are refused rather than silently losing it.

Native delete/import operations publish OpenCode's normal session events. The
plugin does not fabricate native events or write SQLite.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

CI runs these commands. Tests use temporary files and a simulated API; they do
not delete or import real OpenCode sessions. See the
[requirements](docs/session-archive.md) and
[architecture decision](docs/adr/0001-file-backed-transcript-archives.md).
