# OpenCode Sessions Plugin

An OpenCode V2 plugin that saves session transcripts to private JSON files, then
deletes the live sessions. Restoring an archive imports the original session IDs
and messages.

**Archive deletion is not atomic.** OpenCode V2 has no public session lock or
compare-and-delete operation. Before confirming an archive, stop other clients
and automations from changing that session or its children. A write in the final
check-to-delete gap can be lost. Do not use this plugin when you need a lossless
backup of an actively shared session.

## Commands

The TUI plugin adds real slash commands and command-palette entries. It does not
submit prompts to a model:

- `/session-archive [session-id]`: preview the current session, or the supplied
  ID, and its descendants. Confirm exclusive use before saving and deleting.
- `/session-unarchive [archive-id]`: restore a saved archive, or select one from
  the current project's archive list.
- `/session-archives`: browse the current project's archives and select one to
  restore after confirmation.

The server plugin stores files through RPC. The TUI uses its existing
authenticated client for session operations, so it never discovers a different
local server. This also supports a remote OpenCode server: archive files are
stored on that server. These commands are TUI features, not web/desktop UI
buttons. Successful deletion leaves the archived chat; restoration opens it.

## Install

Requires OpenCode V2.0.24, Git, and Node 24 or newer. Build the private
checkout:

```sh
npm ci
npm run build
```

Add the package to the relevant OpenCode configuration. Replace the paths with
absolute paths on the server. Do not point configuration at a temporary
implementation worktree:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-plugin-sessions",
      "options": {
        "storageDirectory": "~/.opencode-session-archives",
      },
    },
  ],
}
```

The package exports both a server plugin and `./tui` for automatic terminal
plugin loading. A CLI plugin installed separately against a remote server still
needs the server plugin configured there for storage RPCs. This package is not
published to npm; installation uses the built checkout.

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
order, their original locations, and a SHA-256 checksum. Writes are synced,
published atomically without overwriting an existing archive, and read back
before deletion. The checksum detects accidental damage, not malicious edits by
someone who can write the directory.

## Safety and limitations

- Running sessions, queued inbox work, unfinished messages/tools, cross-project
  descendants, and fork/revert state prevent archiving.
- All message pages and descendants are collected. The plugin compares raw
  messages with the native export and rechecks the whole family immediately
  before deletion. These checks reduce the concurrency risk; they do not remove
  it.
- Delete removes descendants recursively. Every known descendant must have a
  verified copy before that operation.
- Restore refuses existing IDs and missing external parents. Parents are
  imported before children at their original working directories. A removed
  worktree may need to be recreated before restoration.
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
npm run typecheck
npm test
npm run build
```

CI runs these commands. Tests use temporary files and a simulated API; they do
not delete or import real OpenCode sessions. See the
[requirements](docs/session-archive.md) and
[architecture decision](docs/adr/0001-file-backed-transcript-archives.md).
