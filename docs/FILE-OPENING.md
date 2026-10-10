# Opening files from Windows

The Windows NSIS installer registers Sideral Editor as an available editor for
the extensions in `config/fileTypes.json`. It adds **Open with Sideral Editor**
to their Explorer context menu and advertises the same types in **Open with**
and Windows default-app settings. Existing default applications are preserved.

## Use

Install a build containing this feature. Registration happens during installation,
including an upgrade; running the development executable alone does not register
Explorer integration.

- Right-click a supported file and choose **Open with Sideral Editor**, or choose
  **Open with → Sideral Editor**. Windows 11 can place the direct static command
  under **Show more options**.
- To use double-click, choose Sideral Editor as the default application for the
  desired extension in Windows **Open with** or **Settings → Apps → Default apps**.
  This remains a Windows user preference.
- Select multiple supported files to open them in the existing editor. The
  Windows `Document` selection model launches each file individually, with the
  usual Explorer selection limits; the single-instance plugin forwards each
  launch to the same window.
- A window hidden in the tray or minimized is shown and focused for an explicit
  file launch. Automatic minimized startup keeps its existing behavior.

The catalog includes source and configuration extensions, Markdown, plain `.txt`
files, `.gitignore`, `.editorconfig`, and the named files `Dockerfile` and
`Makefile`. Windows context-menu queries support those extensionless names;
Windows default associations are registered by extension, not by filename.
Unknown text files can still be opened through the editor's native file dialog.

The executable also accepts one or more paths, resolved against the launching
process's working directory:

```powershell
& 'C:\path\to\sideral-editor.exe' -- 'C:\project with spaces\ação.ts' 'C:\other\README.md'
```

`--` ends option parsing, including for filenames that begin with `-`.
`--windows-startup-minimized` is the only startup option. Unknown options, invalid
paths, unreadable files, binary files and invalid UTF-8 produce visible errors.
One failed file does not prevent the other files in a request from opening.

## Build and installation

Build from a checkout containing this integration, using `npm run tauri build`,
then install the NSIS package reported by the build. Compiling another branch or
only building the frontend does not update the executable registered with Windows.
Close existing editor processes before replacing the installed application;
an already-running process continues using its old executable code.

If Explorer creates another editor window and ignores the file, check which
executable its association launches. An installed build without the native launch
commands and the single-instance plugin cannot open forwarded files, even when
the source changes exist in a separate worktree. Reinstall a build from the
integrated checkout and launch the installed executable again.

## Runtime ownership

The feature has three boundaries:

1. `src-tauri/src/file_opening/launch.rs` parses startup and forwarded arguments
   without filesystem I/O. It preserves order, resolves absolute paths, removes
   duplicate paths within a launch and bounds argument count and bytes.
2. `queue.rs` and the Tauri adapter in `mod.rs` own pending requests. The official
   single-instance plugin is registered before the other plugins. A request stays
   queued until the frontend acknowledges that all files have been attempted.
   Queue capacity is bounded, and overflow is reported instead of silently dropped.
3. `src/features/file-opening` owns one validated, ordered Tauri `Channel`
   connection. The workbench connects after workspace restoration, supplies
   `openFile` and `reportError`, and switches to the editor when files arrive.
   The feature depends on those callbacks instead of the workspace implementation.

An interrupted connection leaves the request available for the next owner. Client
identifiers prevent stale cleanup from disconnecting a replacement connection.
Unmount, `pagehide` and native window destruction release their listeners and
channels. React StrictMode's discarded effect never registers a native connection.
There are no startup timers, polling loops or global file-opening events.

Document reads and model ownership remain with the workspace. Opening an existing
document selects its tab and preserves unsaved edits. Opening external files does
not replace the workspace or the other open documents. Filesystem reads retain the
existing UTF-8, binary and size validation.

## Installer ownership

`config/fileTypes.json` is the source for Monaco language selection and installer
registration. Add a format there instead of maintaining two lists.

Tauri's `beforeBundleCommand` runs `npm run desktop:associations` and generates
`build/windows/fileAssociations.nsh` from the catalog and the small source template
`src-tauri/windows/fileAssociations.nsh`. The build validates identifiers and fails
if a required template marker is missing or duplicated. Generated hooks are ignored
by Git and regenerated for each bundle.

The hooks use Tauri's `SHCTX` installation scope and register:

- an application-owned ProgID with a quoted executable and quoted `%1` argument;
- per-extension `OpenWithProgids` entries and `SystemFileAssociations` verbs;
- an `Applications` entry with `SupportedTypes`;
- `Capabilities` and `RegisteredApplications` for Windows default-app discovery;
- a filename-filtered static verb for `Dockerfile` and `Makefile`.

Uninstallation removes only Sideral-owned entries and empty parent keys. Command
ownership is checked against the installation path, so an old installation cannot
remove registrations pointing at a newer path. Neither installation nor removal
writes an extension's default value or Windows `UserChoice`.

The supported NSIS hooks are used because Tauri's built-in Windows
`bundle.fileAssociations` implementation writes extension defaults. The feature
needs registration as an available editor while preserving existing defaults.
The VS Code reference checkout supplied behavioral context; its code is neither
copied nor a dependency.

## Validation

`npm run architecture` validates catalog generation and rejects installer/query
injection. `npm test` exercises IPC validation, serial batch processing, per-file
failure and interrupted owners. Rust tests cover launch parsing, minimized startup,
request ordering and queue budgets. Build an NSIS bundle to verify the generated
hook with the actual Windows installer compiler.

For a live Windows smoke test, use a temporary `productName`, `identifier` and
`mainBinaryName`, then install into a separate directory. Compare extension defaults
and `UserChoice` before and after registration. Open a batch containing valid and missing files,
including paths with spaces and accents. Reopen an edited document through a second
process and check that its tab and unsaved content are preserved. Hide the window
in the tray and launch another file to check restoration. Finally uninstall the
temporary product and verify that its registrations are removed and the original
defaults remain unchanged.

Primary integration references:

- [Tauri single-instance plugin](https://v2.tauri.app/plugin/single-instance/)
- [Tauri NSIS installer hooks](https://v2.tauri.app/distribute/windows-installer/#installer-hooks)
- [Microsoft application and default-program registration](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs)
- [Microsoft static context-menu verbs](https://learn.microsoft.com/en-us/windows/win32/shell/context)
- [Microsoft canonical property queries](https://learn.microsoft.com/en-us/windows/win32/search/-search-3x-advancedquerysyntax)
