# Project workspaces

Use the Explorer's **Add folders to workspace** action to select one or several
folders. Each root has an independent tree and settings. Adding folders preserves
the existing collection; removing a root preserves its files and open tabs.

## Create project configuration

The gear beside a root opens `.sideral/settings.json`. First use creates that file
and `.sideral/workspace.json` without replacing existing files. Both are strict JSON
with bundled schema validation and completion. Commit them when the settings
should be shared.

The workspace marker gives a folder its display name:

```json
{
  "$schema": "sideral://schemas/workspace",
  "schemaVersion": 1,
  "name": "API"
}
```

`name` must be trimmed, nonempty and at most 128 characters. Canonical paths
identify roots; copying a project does not reuse a persistent workspace UUID.

## Open a parent containing projects

When opening a folder:

1. Its own marker takes precedence: the folder opens as one root.
2. Otherwise, marked direct children open as independent roots in sorted order.
3. Without marked direct children, the folder opens as an ordinary root.

For example, opening `work/` with marked `api/` and `website/` children adds both
projects. An unmarked `shared-assets/` child is not added automatically; add it
explicitly if needed. Discovery does not recurse into grandchildren or directory
symlinks, and opening folders does not create configuration files.

## Set project preferences

Example `.sideral/settings.json`:

```json
{
  "$schema": "sideral://schemas/project-settings",
  "schemaVersion": 1,
  "editor": {
    "tabSize": 2,
    "insertSpaces": true,
    "wordWrap": "on"
  },
  "files": { "autoSave": "afterDelay" }
}
```

| Setting | Values | Value when omitted |
| --- | --- | --- |
| `editor.tabSize` | Integer 1–8 | 4 |
| `editor.insertSpaces` | Boolean | `true` |
| `editor.wordWrap` | `"off"` / `"on"` | `"off"` |
| `files.autoSave` | `"off"` / `"afterDelay"` | User Auto Save preference |

Only `schemaVersion` is required. Empty settings objects inherit defaults.
Unknown keys, `null` and unsupported versions fail; optional `$schema` must match
the bundled URI. Each configuration file is limited to 64 KiB.

The most specific matching open root supplies a document's settings. Files
outside open roots use user/editor defaults. Saving configuration or returning
focus reloads effective settings. Invalid configuration produces a root diagnostic;
valid neighboring roots keep working with their own settings.

## Session and terminal

The profile's `workspace-session.json` stores up to 128 ordered roots using
schema version 2. It is runtime state, not shareable project configuration.
Unsupported older sessions fail visibly; explicitly adding folders creates a
current-format session. Missing roots remain available for removal or recovery.

Selecting a root or one of its files sets the context for new files and terminal
sessions. It preserves a running shell's directory. With several roots, the
terminal selector chooses the next restart directory; the shell tab describes
the running session. Closing the tab stops the process, while hiding the panel
preserves it.

Keep secrets, credentials and runtime state out of shared configuration.
See [using the editor](USAGE.md) for everyday actions and
[architecture](ARCHITECTURE.md#documents-and-workspaces) for ownership.
