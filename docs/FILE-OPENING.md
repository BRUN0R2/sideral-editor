# Opening files from Windows

The Windows NSIS installer registers Sideral as an available editor for supported
file types. It adds **Open with Sideral Editor**, **Open with** discovery and
Windows default-app entries. It preserves existing defaults.

## Set up Explorer opening

1. [Build](DEVELOPMENT.md#build-a-windows-installer) or obtain an installer
   containing this feature, then install it. Development executables do not
   register Explorer commands.
2. Right-click a supported file and select **Open with Sideral Editor** or
   **Open with → Sideral Editor**. Windows 11 may put the static command under
   **Show more options**.
3. For double-click, choose Sideral for that extension in **Open with** or
   **Settings → Apps → Default apps**. This remains your Windows preference.

Multiple selected files are forwarded to the existing editor window. Windows
launches each individually through its `Document` selection model, with Explorer's
usual selection limits. A minimized or tray-hidden window is revealed and focused.
Reopening an existing document selects its tab and preserves unsaved edits.

The [catalog](../config/fileTypes.json) covers source/configuration files,
Markdown, plain text and special filenames. `Dockerfile` and `Makefile` have
filename-filtered context commands; Windows default associations use extensions.
Other text files remain openable through the editor's file dialog.

## Open from a command

```powershell
& 'C:\path\to\sideral-editor.exe' -- 'C:\project with spaces\ação.ts' 'C:\other\README.md'
# Add a folder to the current workspace.
& 'C:\path\to\sideral-editor.exe' -- 'C:\project with spaces'
```

Paths resolve relative to the launching process's directory. `--` ends option
parsing, including for a filename starting with `-`.
`--windows-startup-minimized` is the only startup option. Invalid options, missing
or unreadable files, binary content and invalid UTF-8 produce visible errors.
A failed file does not prevent the rest of the batch from opening.

Files open as documents. Directories are added to the current workspace and
selected in Explorer. Existing roots, project settings and unsaved documents are
preserved. Opening a directory does not create `.sideral` configuration.

## Open from Codex

Codex's editor menu has its own targets. Windows file associations alone do not
add an editor to that list. Use the official
[custom file handler configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#add-custom-file-handlers):

1. Save a Sideral PNG icon in a permanent location; the repository's
   [128 px icon](../src-tauri/icons/128x128.png) is suitable.
2. Add the following table to your user-level `~/.codex/config.toml`. Replace both
   paths with absolute paths to your installed executable and saved icon.

   ```toml
   [desktop.custom_file_handlers.sideral]
   label = "Sideral Editor"
   icon = 'C:\Users\you\.codex\icons\sideral.png'
   command = 'C:\path\to\sideral-editor.exe'
   args = ["--"]
   input = "path"
   supports_ssh = false
   ```

3. Restart Codex, then select **Sideral Editor** in its default file-opening
   setting or a project's **Open in** menu. A project-specific choice takes
   precedence over the global preference.

Codex discovers the handler when the command exists and launches the executable
directly with separate arguments. `--` protects filenames beginning with `-`;
spaces and Unicode need no shell wrapper. A base64 `data:image/png` URL is also
supported for `icon` when a self-contained configuration is preferable.

This handler opens local files and directories through Sideral's existing
single-instance flow. It deliberately uses Codex's `path` input contract; source
line/column context and remote SSH paths are not supported. Keep Windows
associations and Codex preferences independent. Do not rename the executable to
another editor's name or modify Codex application files.

## If another empty window opens

Check which executable Windows actually launches. An old installed executable
continues using old code even when a newer checkout has been built.

Close the editor, install the NSIS build from the integrated checkout, and launch
the installed application again. Building only the frontend does not update it.

For a portable copy, close the application and replace the executable at the
registered path. This preserves existing associations and updates file handling.
New Explorer registrations still require the installer. See
[portable updates](UPDATES.md#update-a-portable-copy).

## Implementation boundaries

| Owner | Responsibility |
| --- | --- |
| [Native launch parser](../src-tauri/src/file_opening/launch.rs) | Parse bounded arguments, preserve order and resolve paths without filesystem I/O |
| [Native queue](../src-tauri/src/file_opening/queue.rs) | Retain bounded requests until attempted-file acknowledgement |
| [Frontend feature](../src/features/file-opening) | Own one validated, serial Tauri `Channel` through `openPath` and `reportError` callbacks |
| [Filesystem service](../src-tauri/src/documents.rs) | Classify an external target and return a bounded text document or a canonical directory path in one command |
| [Workspace](../src/features/workspace) | Read files and own documents, models, tabs and unsaved changes |

The official single-instance plugin starts before other plugins. The workbench
connects after workspace restoration. An interrupted connection retains its
request; owner identifiers reject stale cleanup. Unmount, `pagehide` and window
destruction release channels and listeners. There are no startup delays or
polling loops. Queue overflow is an explicit error.

## Installer ownership and validation

[`config/fileTypes.json`](../config/fileTypes.json) drives both language selection
and installer registration. `npm run desktop:associations` generates ignored
`build/windows/fileAssociations.nsh` from the
[source template](../src-tauri/windows/fileAssociations.nsh) before bundling.

Hooks use Tauri's install scope and own ProgIDs, OpenWith entries, static verbs,
supported types and registered-application capabilities. Uninstall checks command
ownership against the installation path, removes only owned entries and leaves
extension defaults and `UserChoice` unchanged.

Custom NSIS hooks are necessary because Tauri's built-in Windows file-association
registration writes extension defaults. The VS Code research checkout supplies
behavioral context; its code is not a dependency.

Architecture, frontend and Rust checks cover generation, request validation,
ordered delivery, failure isolation and queue limits. Validate installer hooks
with an actual NSIS build. For a live check, use an isolated application identity
and installation directory; compare defaults before/after install and uninstall,
open paths with spaces/accents, mix a missing file with valid files, reopen an
unsaved document, add a folder without removing existing roots, and launch a
file while the window is hidden in the tray.

Primary references: [Tauri single-instance](https://v2.tauri.app/plugin/single-instance/),
[Tauri NSIS hooks](https://v2.tauri.app/distribute/windows-installer/#installer-hooks),
[Microsoft application registration](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs)
and [static context-menu verbs](https://learn.microsoft.com/en-us/windows/win32/shell/context).
