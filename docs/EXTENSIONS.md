# Sideral extension authoring

The modern Sideral API is intentionally small: an extension is one bundled ESM
module, runs in its own Web Worker and receives native capabilities only through
the typed broker. There is no Node runtime, direct Tauri IPC, ambient filesystem
access or shell-string execution.

## Quick start

From the repository root:

```powershell
npm run extension:tool -- scaffold acme sample D:\extensions\acme-sample
cd D:\extensions\acme-sample
npm install
npm run typecheck
npm run build
```

Back at the Sideral repository root, create a signing key outside the extension
project and keep it out of source control:

```powershell
npm run extension:tool -- check D:\extensions\acme-sample
npm run extension:tool -- keygen D:\private\acme-extension-key.json
npm run extension:tool -- pack D:\extensions\acme-sample D:\private\acme-extension-key.json D:\packages\acme-sample.sideralx
npm run extension:tool -- inspect D:\packages\acme-sample.sideralx
```

Open Extensions with `Ctrl+Shift+X`, choose the package, review its publisher
key, exact package hash and capabilities, then trust and install it. The tool
never overwrites a key, package or scaffold directory. Both `check` and `pack`
reject an `engines.sideral` range that excludes the Sideral version targeted by
the tool, so the supported workflow cannot produce an incompatible package.
Repository extension projects live in `extensions/<name>`, with their own
manifest, source, tests and runtime dependency declarations. They share npm
workspaces, one root lockfile and a hoisted installation of the pinned build
tools. Run `npm ci` at the root, then `npm run sdk:build` before checking
extensions. The main application build rebuilds and stages all first-party
extensions under `build/extensions`; focused tests and package validation remain
part of `npm run extensions:check`. Installed extension packages contain no
development dependencies or `node_modules`.
`extensions/markdown-preview` owns its Markdown parser and visual presentation.
`extensions/amxx-pawn` is a complete
third-party-style compiler extension with its own tests and package manifest.
`extensions/discord-presence` demonstrates metadata-only workspace events,
a signed literal Application ID and a local native integration without a
helper process, user configuration or community dependency.
New scaffolds use pinned Rolldown, strict TypeScript and a version-pinned,
type-only SDK snapshot under `vendor/`. They also include one deterministic
test and the matching testkit, so `npm install` works in a directory completely
outside this repository without waiting for registry publication. The `check`
command validates the strict manifest, built Worker, assets and size budgets
without creating or requiring a signing key. Vendored development files never
enter the `.sideralx` package.

For repository extensions, run the named root build command and pass its staged
directory to the package tool. For example:

```powershell
npm run extension:discord:build
npm run extension:tool -- check build/extensions/discord-presence
npm run extension:tool -- pack build/extensions/discord-presence D:\private\sideral-key.json build/extensions/sideral.discord-presence.sideralx
```

The manifest entry remains `dist/extension.mjs` because it describes the path
inside the signed package; the physical staging root remains the repository's
top-level `build/` directory.

For a normal local build, package every first-party extension with one stable
development publisher identity:

```powershell
npm run extensions:package:dev
```

The command creates or reuses
`%LOCALAPPDATA%\dev.sideral.editor\development\extension-signing-key.json` and
writes the installable files to `build/extensions/packages`. The private key is
never copied into the repository or build output. The first installation asks
the user to trust that development publisher key; subsequent packages reuse the
same identity. Production packaging uses `npm run extensions:package` and
requires `SIDERAL_EXTENSION_SIGNING_KEY` to point to the existing production
key, so release builds never invent or rotate publisher identity.

## Manifest v1

```json
{
  "manifestVersion": 1,
  "apiVersion": 1,
  "id": "acme.sample",
  "displayName": "Acme Sample",
  "version": "0.1.0",
  "engines": { "sideral": "^0.1.1" },
  "runtime": { "kind": "worker", "entry": "dist/extension.mjs" },
  "activationEvents": ["onLanguage:sample-text"],
  "permissions": {
    "workspace": "readWrite",
    "network": [
      { "origin": "https://api.example.com", "methods": ["GET"] }
    ],
    "processes": [
      {
        "id": "acme.sample.formatter",
        "executable": {
          "kind": "configuration",
          "key": "formatter-path"
        },
        "workingDirectory": "executable",
        "arguments": [
          { "kind": "literal", "value": "--check" },
          {
            "kind": "workspaceFile",
            "name": "source",
            "access": "read",
            "extensions": [".sample"]
          },
          {
            "kind": "workspaceDirectory",
            "name": "include",
            "access": "read",
            "prefix": "-i"
          }
        ]
      }
    ]
  },
  "contributes": {
    "configuration": {
      "title": "Acme",
      "properties": [
        {
          "kind": "executable",
          "key": "formatter-path",
          "title": "Formatter Path",
          "description": "Formatter executable used by Acme commands.",
          "default": "formatter"
        }
      ]
    },
    "commands": [
      {
        "id": "acme.sample.run",
        "title": "Run",
        "category": "Acme",
        "invocation": "activeTextDocument",
        "documentSync": "save"
      }
    ],
    "keybindings": [
      {
        "command": "acme.sample.run",
        "key": "Ctrl+Shift+V",
        "mac": "Shift+Meta+V",
        "languages": ["sample-text"]
      }
    ],
    "languages": [
      {
        "id": "sample-text",
        "aliases": ["Sample Text"],
        "extensions": [".sample"]
      }
    ]
  }
}
```

Unknown properties and unsupported versions fail validation. IDs use lowercase
namespaced segments. Every command and process grant must begin with the
extension ID. Commands activate their owner automatically; do not add an
`onCommand` event. Supported explicit events are `onWorkbenchReady` and
`onLanguage:<id>`. Installation, re-enablement, Restart and rollback replay the
current workbench and active-language events, so a matching extension resumes
within the same editor session.

Commands use `workbench` invocation by default. `activeTextDocument` commands
must request workspace read access and register with
`commands.registerTextEditorCommand`; the host then supplies one immutable
snapshot of the active document with the command. Keybindings use a canonical,
single-chord form, may be scoped to language IDs and can be changed, disabled or
restored by the user. Conflicting shortcuts never execute until the conflict is
resolved. `documentSync: "save"` requires a named document and makes the host
persist its current content before invoking the extension; the default
`snapshot` mode does not touch the file.

Language contributions associate file extensions with a language ID before the
extension Worker is activated. They are declarative, require no host changes and
immediately update open named documents. Duplicate language IDs or file
extensions across installed packages are rejected instead of depending on load
order.

Configuration contributions are extension-scoped, typed and strict. Every
property declares a key, title, default and optional description. An
`executable` default is a required bare name resolved from `PATH`; its selected
override must be absolute, canonicalized and validated natively. A `text`
property may use an empty default and an optional placeholder; values are
single-line, trimmed and limited to 1,024 UTF-8 bytes. Settings renders the
matching selector or editable field generically. Reset removes the override and
restores the signed default. Workers can read declared effective values through
`api.configuration.get`; they cannot mutate user configuration.

`workspace: metadata` is the least-privilege workspace grant. It enables
`api.workspace.getContext()` and `onDidChangeContext()` with only the workspace
name plus the active document name and language ID. It does not authorize file
reads, searches, writes, full paths or contents. Listener promises are processed
serially and should be registered in `context.subscriptions`.

`api.window.getActivityState()` and `onDidChangeActivityState()` expose only the
bounded `active` and `idle` states, never keystrokes, pointer coordinates or
input contents. One host-owned timer transitions to idle after five minutes
without keyboard, pointer, wheel or focus activity. Only state transitions cross
the Worker boundary, and listeners run on the same serialized operation lane.

Discord Rich Presence is explicit and local. A manifest binds
`permissions.discordPresence.applicationId` to either a signed literal or a
declared `text` configuration key. `api.discordPresence.setActivity()` accepts
bounded typed activity fields and up to two action buttons; `clearActivity()`
releases the activity. Button labels contain at most 32 characters. Button URLs
contain at most 512 characters and must be credential-free absolute HTTPS URLs.
Rust revalidates the signed grant, application ID, field limits, URLs and
activity type, then owns Discord's named-pipe session for exactly one extension
generation.
Only one live extension may own the process-wide Discord presence; another
extension receives an explicit conflict instead of silently replacing it.

Network permissions are exact origins and methods. HTTPS is required except for
an exact loopback origin used during local development. A process permission has
a signed executable source and argument schema. An executable is either a fixed
`{ "kind": "literal", "value": "tool" }` declaration or a
`{ "kind": "configuration", "key": "tool-path" }` reference to an
executable property declared by the same manifest. Literal arguments cannot be
changed at runtime. `workspaceFile` and `workspaceDirectory` arguments name one
input slot, declare read or write access and accept an optional fixed prefix;
file slots may additionally restrict extensions. The runtime may fill only
those slots with `file:` URIs contained by the active workspace. No API accepts
a shell string or an untyped argument array.

Process working directories are explicit: `workspace`, isolated
`extensionData`, or the resolved `executable` directory. The last option is
useful for compilers that keep standard includes beside the binary.

## Runtime entry

```ts
import type { ExtensionModule } from "@sideral/extension-sdk";

export const activate: ExtensionModule["activate"] = (context, api) => {
  const output = api.window.createOutputChannel("Acme Sample");

  context.subscriptions.add(
    output,
    api.commands.registerCommand("acme.sample.run", async () => {
      const previous = await api.storage.get("runs");
      const runs = typeof previous === "number" ? previous + 1 : 1;
      await api.storage.update("runs", runs);
      output.appendLine(`Run ${runs}`);
      await output.flush();
      output.show();
      return { runs, activatedBy: context.activationReason.kind };
    }),
  );
};

export const deactivate: ExtensionModule["deactivate"] = async (reason) => {
  // Optional bounded cleanup. Registered subscriptions are always disposed.
  void reason;
};
```

Add every listener or imperative resource to `context.subscriptions`. Disposal
is idempotent, reverse-order and exhaustive. `context.cancellationSignal`
represents the extension lifetime. Workspace, network and process operations
also accept explicit `AbortSignal` values where useful.

Command handlers and workspace-context callbacks share one serial operation lane
within an extension. Calling another command from the same extension executes
locally; cyclic calls are rejected. Different extensions remain independent.

Output channels appear as extension-owned tabs in the Sideral terminal panel.
`show()` reveals and selects the channel; `append` and `appendLine` buffer
bounded content, while `flush` updates the tab without repeatedly stealing
focus. Closing a channel tab hides its workbench view without disposing the
extension-owned channel; a later `show()` reveals it again. Output channels
never inject text into the interactive shell PTY.

Visual extensions create typed preview resources with `format: "tree"`.
`content` is an array of text strings and elements with a stable `key`, an
allowed semantic `tag`, `children`, optional bounded `attributes` and optional
inert inline `style` properties. Extensions own parsing and document
presentation; the editor renders the validated tree without knowing its source
language. Rust and the client reject executable elements, event handlers,
unsupported links, resource-loading CSS, positioning, duplicate sibling keys
and content beyond 192 KiB, 10,000 nodes or 24 levels of nesting.

HTTP(S) links use the native external-link boundary and local `file:` links
open through the editor's file boundary. The extension resolves relative links
against its source document. Arbitrary HTML and global CSS are never injected
into the workbench. Markdown Preview keeps raw HTML and images inert and owns
its GFM and PowerShell code-block presentation inside its Worker.

`panel.onDidChangeSourceDocument` delivers the current in-memory source,
including unsaved edits, only to the owning active extension with workspace
read access. The listener produces a new visual tree with `panel.update`.
Events are generation-scoped and serialized with commands; they are not
broadcast to other Workers and do not use polling or read the file again.

A panel with `sourceUri` is rendered only beside that active editor document.
Switching to another open tab removes the preview surface without destroying
the extension-owned panel, so returning to the source restores the explicit
panel state. Closing the source hides the panel with an expected-URI guard, so
a delayed close cannot hide the same resource after an extension has reused it
for another document. Hidden preview payloads are omitted from client
handshakes and client-side state until the extension explicitly shows the panel
again. The native resource remains bounded and extension-owned until
`dispose()`, reload, disable or shutdown.

```ts
api.commands.registerTextEditorCommand("acme.sample.preview", async (document) => {
  const panel = api.window.createPreviewPanel({
    title: "Preview",
    format: "tree",
    content: [{ key: "document", tag: "pre", children: [document.content] }],
    sourceUri: document.uri
  });
  await panel.show();
  context.subscriptions.add(panel);
  context.subscriptions.add(panel.onDidChangeSourceDocument(async (source) => {
    await panel.update({
      title: "Preview",
      format: "tree",
      content: [{ key: "document", tag: "pre", children: [source.content] }],
      sourceUri: source.uri
    });
  }));
});
```

Preview scrollbars inherit the workbench theme. Extensions that need a distinct
appearance can use the bounded, panel-scoped contract below; arbitrary CSS is
never injected into the host document:

```ts
appearance: {
  scrollbar: {
    trackSize: 16,
    thumbSize: 10,
    trackColor: "transparent",
    thumbColor: "#8b5cf6",
    thumbHoverColor: "#a78bfa",
    thumbActiveColor: "#c4b5fd",
    showButtons: true,
    buttonSize: 18,
    arrowSize: 10,
    arrowHeight: 5,
    arrowColor: "#ddd6fe",
    arrowHoverColor: "#ede9fe",
    arrowActiveColor: "#ffffff",
    cornerRadius: 12
  }
}
```

Sizes are integer pixels (`trackSize` and `buttonSize` 8–32, `thumbSize`
4–`trackSize`, `arrowSize` 4–the smaller track or button size, `arrowHeight`
3–the smaller arrow width or button size, radius 0–999).
`showButtons` controls the solid vertical arrow buttons. Colors accept
`transparent` or 3, 4, 6 or 8-digit hexadecimal CSS colors. Omitting any field
preserves the corresponding host default; omitted thumb and arrow sizes are
clamped automatically when a narrower track or button is requested.
`arrowSize` controls width, `arrowHeight` controls the vertical silhouette and
`buttonSize` controls both the click target and the breathing room around the
arrow shape.

## Available capabilities

| API | Manifest authority | Important behavior |
| --- | --- | --- |
| `commands` | Declared command IDs and invocation | Registration and active-document context are checked against the signed manifest |
| `workspace.getContext`, `workspace.onDidChangeContext` | `workspace: metadata`, `read` or `readWrite` | Names and language ID only; event-driven, serial listeners, no paths or contents |
| `workspace.readTextDocument` | `workspace: read` or `readWrite` | UTF-8, 4 MiB, canonical path containment |
| `workspace.writeTextDocument` | `workspace: readWrite` | Existing text files, expected version, atomic replacement |
| `workspace.findFiles` | `workspace: read` or `readWrite` | Forward-slash glob, deterministic order, bounded result/traversal |
| `storage` | Always isolated to the extension | Atomic JSON, bounded keys, values and document |
| `configuration.get` | Declared extension configuration key | Read-only effective value; user overrides are validated and atomically persisted by the native Settings flow |
| `discordPresence.setActivity`, `discordPresence.clearActivity` | `discordPresence` with literal or text-configured Application ID | Official local RPC framing, bounded fields and HTTPS buttons, generation ownership, finite I/O and cancellation |
| `network.request` | Exact origin and method | No proxy/cookies, redirects revalidated, DNS pinned, bounded UTF-8 body |
| `processes.execute` | Exact process grant | Signed literal/typed workspace-path arguments, explicit working directory, no stdin/shell, clean environment, console-independent Windows launch, bounded output and deterministic reap |
| `window` | No extra grant | Typed active/idle transitions plus bounded output channels and preview panels owned by the extension |

Cancellation is cooperative. A canceled network request or process is stopped
and a canceled process is reaped. A remote server may still have observed a
request that was already transmitted.

## Unit testing

`@sideral/extension-testkit` runs an extension against deterministic in-memory
storage, configuration, workspace metadata, Discord activity history, messages
and output. Native capabilities must be
provided explicitly, so a test cannot accidentally access the machine. The
official scaffold pins the matching testkit locally together with the SDK.

Root type checking resolves the in-repository SDK and testkit directly from
their sources. Extensions use these public packages, whose declarations and
harness are built explicitly with `npm run sdk:build` before extension checks.
CI installs every workspace from the shared root lockfile with `npm ci`.

```ts
import { createExtensionHarness } from "@sideral/extension-testkit";
import * as extension from "../src/extension";

const harness = createExtensionHarness(extension, {
  activationReason: { kind: "command", commandId: "acme.sample.run" }
});

await harness.activate();
await harness.executeCommand("acme.sample.run");
await harness.dispose();
```

The harness puts commands and workspace-context listeners on the same serial
operation lane, supports nested local commands, clones stored JSON, records
successful Discord activity updates and attempts every registered cleanup even
when one fails.

## Package and trust model

A `.sideralx` archive contains `manifest.json`, the declared runtime bundle,
optional `assets/*` and generated `signature.json`. Ed25519 signs a canonical
list containing the SHA-256 digest of every non-signature file. The validator
also enforces file-count and compressed/uncompressed size limits, portable paths
and exact package contents.

The editor stores the archive unchanged, retains active and rollback slots and
revalidates its signature, package hash, bundle hash, publisher identity and
signed manifest before every load. A package changed between review and install
is rejected. Trust is attached to the exact publisher public-key digest, not
only to a display name.

The Worker is a fault-isolation boundary, not an operating-system sandbox.
Install only publishers you trust, and treat a process grant as native-code
authority for the signed executable source and argument schema shown in the
review dialog. A configuration-backed source runs only the executable selected
by the user or its signed `PATH` default.

## AMXX Pawn compiler reference

`extensions/amxx-pawn` demonstrates the intended end-to-end author experience:

- `.sma` and `.inc` are associated with `amxxpawn` by the extension manifest;
- the build command is available from the palette and `Ctrl+Shift+B` only for
  that language;
- the host saves the active named `.sma` before execution;
- a top-level `include` directory is discovered declaratively and passed as a
  validated `-i` workspace-directory argument when present;
- **AMXX Pawn › Compiler Path** is generated from the signed manifest and lets
  the user select the compiler without any AMXX-specific host code;
- the grant uses that configuration, falls back to resolving `amxxpc` from
  `PATH`, starts it beside its standard include directory, validates the
  readable `.sma` and writable `.amxx` paths, and never invokes a shell;
- compiler stdout/stderr and the exit code are reported in an owned output
  channel without crashing the Worker on a normal compilation failure; negative
  native statuses include their unsigned hexadecimal representation.

The extension does not redistribute AMX Mod X binaries. Install the compiler
separately, then select `amxxpc` (`amxxpc.exe` on Windows) in Settings. Keeping
it on `PATH` is sufficient when using the signed default.

The opt-in real compiler tests use `SIDERAL_AMXXPC_E2E_COMPILER`,
`SIDERAL_AMXXPC_E2E_WORKSPACE` and `SIDERAL_AMXXPC_E2E_SOURCE`. They compile a
temporary source copy inside the workspace through both the extension command
and native broker, verify a non-empty `.amxx`, and remove the temporary tree.

## Discord Work Presence reference

`extensions/discord-presence` is the first native-integration reference:

- its only workspace authority is `metadata`, so it cannot read source code or
  filesystem paths;
- the public Discord Application ID is a signed manifest literal, so users do
  not need a Developer Portal account, bot token, secret or OAuth flow;
- active-document changes are event-driven and identical activities are
  deduplicated;
- workspace, document and idle lines use `📁`, `🧑‍💻` and `☕` respectively;
- five minutes without Sideral window activity changes the presence to
  `Stopped for a coffee ☕`; the next interaction restores it immediately;
- Worker activation does not await Discord IPC; controller-owned initialization
  continues on the same serialized queue and remains observable and disposable;
- Toggle persists an explicit enabled state and Refresh retries connectivity
  failures;
- the Worker owns its listener, commands, output channel and controller through
  reverse-order subscriptions;
- the native broker owns and cancels the corresponding IPC task and pipe with
  the extension generation.

See `extensions/discord-presence/README.md` for setup and development commands.

## Versioning and diagnostics

`manifestVersion`, `apiVersion` and the host protocol are independent. Manifest
and API version 1 reject unknown versions instead of guessing a fallback. The
internal host/Worker protocol is version 4 and is upgraded atomically with the
editor; there is no compatibility branch. `engines.sideral`
is checked during project validation and packaging, then again before
installation, enablement, rollback and bundle loading.
The editor and official extension CLI inherit one Cargo workspace version, so
their engine-compatibility target cannot drift between releases.

The Extensions view reports the runtime state, last error, activation count and
duration, and command count, failures and last duration. A failed extension
does not restart silently; use Restart after inspecting the error.
