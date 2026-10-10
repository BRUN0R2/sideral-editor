# Using Sideral Editor

Install a Windows build from
[GitHub Releases](https://github.com/BRUN0R2/sideral-editor/releases) when available,
or follow the [local build guide](DEVELOPMENT.md#build-a-windows-installer).
The NSIS installer sets up Windows **Open with** integration.

## Files and projects

Use **Open file** to edit a document, or **Add folders to workspace** in the
Explorer to open one or several project folders. Adding folders keeps the
existing collection. Reopening an already open file selects its tab and preserves
unsaved edits. Files opened from outside the workspace do not replace it.

Drag document, Settings and extension tabs to reorder them. Save new documents
to choose a path. Auto Save in Settings saves changed documents that already
have a path; it does not open save dialogs for untitled files.

| Windows shortcut | Action |
| --- | --- |
| `Ctrl+N` | New document |
| `Ctrl+O` | Open file |
| `Ctrl+Shift+O` | Add folders to workspace |
| `Ctrl+S` | Save active document |
| `Ctrl+,` | Open Settings |
| `Ctrl+Shift+P` or `F1` | Command palette |
| `Ctrl+Shift+X` | Extensions |

For Explorer setup, see [Windows file opening](FILE-OPENING.md).
For per-project settings, see [workspaces](WORKSPACES.md).

## Terminal and output

Open **Terminal** in the bottom panel to start a shell in the selected project
folder. With several roots, choose the directory for the next terminal restart.
Changing the selected root keeps the running shell and its current directory.

Hiding the panel preserves the shell. Closing its tab stops the process.
Extension output appears in separate output tabs; it never enters the shell.

## Settings and languages

Settings contains desktop preferences, Auto Save, display language, JSON schema
trust, extension configuration and updates. System-language selection uses an
available built-in or community locale; you can select a language manually.
Follow [the translation guide](TRANSLATING.md) to add another language.

JSON documents receive schema validation and completion. Workspace-local schemas
are resolved within their allowed folder; an unfamiliar remote schema can require
explicit trust. Review and revoke stored remote trust in Settings.

## Extensions

Open Extensions, choose a `.sideralx` package, review its publisher identity and
requested capabilities, then trust and install it. Signed packages can add
commands, languages, previews and native integrations. Review process and
network grants as part of deciding whether to trust a publisher.

The [first-party extensions](../extensions/README.md) are separate packages.
Building or downloading the editor does not automatically install them.
Installed commands appear in the command palette. The Extensions view shows
runtime diagnostics and controls for disable, reload, restart and rollback.

## Updates and errors

An updater-enabled build checks once per session and supports manual checks.
An available update appears in the top bar. Download progress is followed by an
installation stage and an explicit restart. Local builds without release signing
configuration do not enable updates; see [updates](UPDATES.md).

An error opening one file leaves other requested files available to open.
Project configuration errors are attached to the affected root. Extension errors
appear in diagnostics or the extension's output channel. Keep the full message
and relevant file path when reporting a problem.
