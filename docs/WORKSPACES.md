# Project workspaces

Use the Explorer's **Add folders to workspace** action to select one or several
folders. Adding folders preserves those already open. Each root has its own
expandable tree and configuration action. The remove action removes only the
root from the current session; project files and open editor tabs are preserved.

The gear beside a root opens `.sideral/settings.json`. On first use it creates
that file and `.sideral/workspace.json`, without replacing existing files. Both
files use strict JSON, schema version 1, and bundled JSON Schema validation and
completion in the editor. They can be committed to Git.

## Workspace identity

Place this marker in each folder that should be recognized as a workspace:

```json
{
  "$schema": "sideral://schemas/workspace",
  "schemaVersion": 1,
  "name": "API"
}
```

Its path is `.sideral/workspace.json`. `name` is a trimmed, nonempty label of up
to 128 characters. Canonical folder paths identify open roots; copied projects
do not share a persistent UUID.

For example:

```text
work/
  api/
    .sideral/workspace.json
    .sideral/settings.json
    src/
  website/
    .sideral/workspace.json
    .sideral/settings.json
    src/
  shared-assets/
```

Opening `work` adds `api` and `website` separately. `shared-assets` is not added
automatically, but can be added explicitly. Discovery examines direct children
only. If `work` has its own marker, it opens as one workspace containing its
projects; if no direct children have markers, it opens as one ordinary folder.
Opening or discovering folders does not create `.sideral` files.

## Project settings

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
  "files": {
    "autoSave": "afterDelay"
  }
}
```

| Setting | Values | Inherited value |
| --- | --- | --- |
| `editor.tabSize` | Integer from 1 to 8 | 4 |
| `editor.insertSpaces` | `true` or `false` | `true` |
| `editor.wordWrap` | `"off"` or `"on"` | `"off"` |
| `files.autoSave` | `"off"` or `"afterDelay"` | User's Auto Save preference |

Every setting except `schemaVersion` is optional. An empty `editor` or `files`
object inherits its settings. `null`, unsupported keys and future schema
versions are errors. The optional `$schema` must match the bundled schema URI.
Configuration files have a 64 KiB limit.

Settings apply to files within that root. For nested open roots, the longest
matching root wins. Files outside open roots use user/editor defaults. Saving
configuration or returning focus to Sideral reloads effective settings. Errors
appear beside the affected root; valid neighboring workspaces keep working.

## Session and terminal

The user profile stores the ordered folder collection in `workspace-session.json`
(schema version 2, up to 128 roots). Session files are not project configuration
and need not be committed. The current version does not load version 1 session
files; an unsupported session produces an error, and explicitly adding folders
creates a new current-format session. Missing folders remain listed for removal
or recovery.

Selecting a root or activating one of its files selects its context for new
files and terminal sessions. Switching selection preserves an existing terminal
and its current working directory. With several available roots, the terminal
selector chooses the directory used on explicit restart. The shell tab's path
always describes the running session. Closing the shell tab stops that process;
hiding the panel preserves it.

Do not put secrets, credentials or runtime state in shareable workspace files.
The format follows the per-folder configuration approach of
[VS Code multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
and uses [JSON Schema 2020-12](https://json-schema.org/specification).
