# Architecture

Sideral is a Windows desktop application with a React/TypeScript workbench,
Monaco for editing, and Rust behind a Tauri 2 boundary. Native APIs own filesystem
access, processes, persistence, installation trust and desktop integration.
The frontend owns presentation and the lifetimes of editor surfaces.

See [development](DEVELOPMENT.md) for commands and build paths, and
[project rules](RULES.md) for required engineering constraints.

## Module map

| Location | Responsibility |
| --- | --- |
| [`src/app`](../src/app) | Workbench composition, navigation, shortcuts and failure boundary |
| [`src/components`](../src/components) | Reusable UI primitives |
| [`src/features/editor`](../src/features/editor) | Monaco models, theme, workers and JSON schema integration |
| [`src/features/workspace`](../src/features/workspace) | Documents, saves, tabs, root context and session restoration |
| [`src/features/explorer`](../src/features/explorer) | Lazy folder-tree presentation |
| [`src/features/file-opening`](../src/features/file-opening) | Ordered external file requests through injected callbacks |
| [`src/features/terminal`](../src/features/terminal) | Bottom panel, xterm shell and extension output views |
| [`src/features/sideral-extensions`](../src/features/sideral-extensions) | Extension UI, protocol validation and trusted Worker supervisor |
| [`src/features/settings`](../src/features/settings) | Desktop, locale, schema-trust and extension settings |
| [`src/features/i18n`](../src/features/i18n) | Typed messages and active locale |
| [`src/features/updates`](../src/features/updates) | Update resource and progress state |
| [`src/lib`](../src/lib), [`src/theme`](../src/theme) | Typed native clients, error normalization and shared theme |
| [`src-tauri/src`](../src-tauri/src) | Native commands and services |
| [`src-tauri/crates`](../src-tauri/crates) | Extension manifest, archive/signature validation and CLI |
| [`packages`](../packages), [`extensions`](../extensions) | Public SDK/testkit and independent extension implementations |

Native services stay split by domain: `documents.rs` handles bounded reads and
atomic saves; `workspace.rs`, `project_settings.rs` and `workspace_session.rs`
handle roots and their settings; `json_schemas.rs` handles schema resolution;
`desktop_integration` handles tray, startup and window policy; `integrated_terminal`
owns PTY processes; `file_opening` owns launch requests; `sideral_extensions` owns
the registry, runtime and capability broker.

## Documents and workspaces

The workspace owns each document's model, tab and save state. Reading validates
size, UTF-8 and binary content. Saving validates the destination and replaces the
file atomically. Reopening an existing document selects its model and preserves
unsaved content.

Roots use canonical paths. Each root has independent diagnostics and optional
`.sideral` configuration. The most specific matching open root owns a document's
settings. Ordered session restoration completes before external launch requests
are connected. [Workspaces](WORKSPACES.md) defines discovery and JSON formats.

Auto Save owns one cancellable timer per eligible dirty document. Untitled files
need an explicit save path. Removing a root changes membership while preserving
open documents; closing a document releases its owned model.

## Windows file opening

The official single-instance plugin is registered first. The launch parser does
no filesystem I/O; a bounded native queue retains each ordered request until the
frontend acknowledges its attempted files. A generation-owned Tauri `Channel`
delivers requests after workspace restoration.

The feature receives `openFile` and `reportError` callbacks rather than importing
workspace behavior. A bad file does not stop the rest of a request. New launches
reveal a tray-hidden or minimized window.

One [file-type catalog](../config/fileTypes.json) drives language selection and
generated NSIS hooks. Hooks register an available editor and remove only owned
entries; default applications and Windows `UserChoice` remain untouched.
[Windows file opening](FILE-OPENING.md) covers use, installation and validation.

## Workbench and terminal ownership

One tab strip represents documents, Settings and extension resources. Navigation
keeps their identity and focus explicit. Tab dragging owns pointer state and its
preview; ending or cancelling a drag releases that state.

Terminal creation is lazy. A shell session owns a native PTY, process, readers,
writers and bounded ordered transport. Changing workspace context leaves an
existing shell in its current directory. Closing the shell tab kills and reaps
the process; hiding the panel preserves it.

PowerShell candidates follow an explicit validation order, with Command Prompt
as a bounded operational fallback. Failed candidates remain visible in
diagnostics. The `portable-pty` integration is isolated in Rust so native PTY
handling does not require project-owned unsafe code. Output channels remain
separate from shell input. Shutdown closes, reaps and joins native work.

## Extension boundary

Each extension owns its source, manifest, dependencies, tests and ESM Worker
bundle. npm workspaces share development tooling; application modules never
import extension implementations. The SDK supplies types only.

Rust owns signed package validation, publisher trust, installation/rollback,
runtime generations, command routing and native capability enforcement. The main
document owns one trusted supervisor; its native session token never reaches a
Worker. Each active extension owns one Worker and a serial command/event lane.

Activation and shutdown use explicit acknowledgements. Finite deadlines enforce
failure boundaries, not startup scheduling. Disable or reload invalidates the
generation, cancels broker work and rejects late results. A failed extension needs
an explicit restart; a failed supervisor needs a fresh main-document lifecycle.

Workers receive only signed, declared native capabilities. Their isolation limits
faults and native authority; it is not an operating-system sandbox. Publisher
trust remains a security decision. See [authoring](EXTENSIONS.md),
[the API reference](EXTENSION-API.md) and [decisions](decisions/README.md).

Preview extensions own parsing and presentation. The host validates and renders
a bounded inert visual tree, routes links natively, and delivers source-document
events. It does not parse Markdown or import a language-specific renderer.
Panel disposal or generation shutdown releases events and resources.

## Schema, configuration and network trust

Monaco does not fetch schemas directly. Rust resolves workspace-local references
inside canonical containment boundaries and resolves remote HTTPS references
through validated DNS, pinned destinations, bounded responses and independently
validated redirects. Transitive references share graph budgets.

Built-in `sideral://` schemas require no network request. Vetted remote sources
are explicit; other URLs or origins require revocable user trust. Persistence is
atomic, caches are bounded, and in-flight work loses authority on disposal.
JSON schemas are data, never executable code.

Settings and community translations use versioned strict contracts. Unknown
fields, invalid values and unsupported versions fail visibly. English defines
the message keys. Missing selected-locale keys are errors; language selection has
an explicit English fallback. [Translations](TRANSLATING.md) describes the format.

## Theme and desktop policy

Scrollbar defaults live in [`scrollbars.css`](../src/styles/scrollbars.css).
Native surfaces and the Monaco adapter consume the same tokens. Version-sensitive
Monaco selectors stay isolated and are protected by architecture checks. Preview
appearance overrides apply only within the owning panel.

WebView devtools and zoom hotkeys are disabled by configuration. The capture-phase
shortcut policy preserves Monaco handling and ordinary copy/context-menu actions.
These choices are UI behavior; CSP, native command permissions and runtime
validation enforce the security boundary.

## Resource and release contract

Every model, listener, timer, channel, Worker, task and process has one owner and
a deterministic cleanup path. Rust uses RAII and cancellation; TypeScript removes
listeners, aborts work and disposes imperative instances. Subscription cleanup
attempts every resource in reverse order even after one failure.

Release configuration validates the version tag, HTTPS updater endpoint and public
key before producing signed update artifacts. Development does not invent an
update identity. Updater resources close on replacement or disposal.
[Updates](UPDATES.md) describes release operation and portable installation.

Architecture checks enforce the output layout and extension boundaries. The
complete gate also checks types, lifecycle contracts, bundle budgets and explicit
dependency-advisory policy. Live validation is required where desktop behavior or
long-running resource ownership is the material risk.
