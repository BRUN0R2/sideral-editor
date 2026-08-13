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
never overwrites a key, package or scaffold directory. `examples/hello-sideral`
is the minimal reference and `examples/markdown-preview` is the first visual,
document-aware reference extension. `extensions/amxx-pawn` is a complete
third-party-style compiler extension with its own tests and package manifest.
New scaffolds use pinned Rolldown, strict TypeScript and a version-pinned,
type-only SDK snapshot under `vendor/`. They also include one deterministic
test and the matching testkit, so `npm install` works in a directory completely
outside this repository without waiting for registry publication. The `check`
command validates the strict manifest, built Worker, assets and size budgets
without creating or requiring a signing key. Vendored development files never
enter the `.sideralx` package.

## Manifest v1

```json
{
  "manifestVersion": 1,
  "apiVersion": 1,
  "id": "acme.sample",
  "displayName": "Acme Sample",
  "version": "0.1.0",
  "engines": { "sideral": "^0.1.0" },
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
`onLanguage:<id>`.

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

Configuration contributions are extension-scoped and strict. Manifest v1
supports the `executable` property kind: every property declares a key, title,
required bare executable default resolved from `PATH` and optional description.
The Settings view renders these
declarations generically as `<section> › <property>` executable selectors. A
selected file is required to be absolute, canonicalized and validated natively
before its override is written atomically. Reset removes the override and
restores the signed default. Workers can read declared effective values through
`api.configuration.get`; they cannot mutate user configuration.

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

Command handlers are serial within one extension. Calling another command from
the same extension executes locally; cyclic calls are rejected. Commands from
different extensions remain independent.

Visual extensions create typed preview resources rather than sending HTML to
the workbench. A Markdown panel receives Markdown text plus an optional source
URI. When that URI belongs to an open editor document, the workbench renders
the current in-memory content, including unsaved changes, without polling or
repeated full-document IPC. The host parses Markdown into React elements; raw
HTML is displayed as text and remote images are not fetched. HTTP(S) links use
the native external-link boundary. Relative document links are resolved only
from a local `file:` source URI and open through the editor's native file
boundary; unsupported schemes remain inert. Fenced blocks identified as
`powershell` receive a compact
PowerShell code-block presentation, but their contents remain inert, selectable
text and are never executed.

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
    format: "markdown",
    content: document.content,
    sourceUri: document.uri
  });
  await panel.show();
  context.subscriptions.add(panel);
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
| `workspace.readTextDocument` | `workspace: read` or `readWrite` | UTF-8, 4 MiB, canonical path containment |
| `workspace.writeTextDocument` | `workspace: readWrite` | Existing text files, expected version, atomic replacement |
| `workspace.findFiles` | `workspace: read` or `readWrite` | Forward-slash glob, deterministic order, bounded result/traversal |
| `storage` | Always isolated to the extension | Atomic JSON, bounded keys, values and document |
| `configuration.get` | Declared extension configuration key | Read-only effective value; user overrides are validated and atomically persisted by the native Settings flow |
| `network.request` | Exact origin and method | No proxy/cookies, redirects revalidated, DNS pinned, bounded UTF-8 body |
| `processes.execute` | Exact process grant | Signed literal/typed workspace-path arguments, explicit working directory, no stdin/shell, clean environment, bounded output and deterministic reap |
| `window` | No extra grant | Bounded messages, output channels and typed preview panels owned by the extension |

Cancellation is cooperative. A canceled network request or process is stopped
and a canceled process is reaped. A remote server may still have observed a
request that was already transmitted.

## Unit testing

`@sideral/extension-testkit` runs an extension against deterministic in-memory
storage, configuration, messages and output. Native capabilities must be
provided explicitly, so a test cannot accidentally access the machine. The
official scaffold pins the matching testkit locally together with the SDK.

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

The harness serializes commands, supports nested local commands, clones stored
JSON and attempts every registered cleanup even when one fails.

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
  channel without crashing the Worker on a normal compilation failure.

The extension does not redistribute AMX Mod X binaries. Install the compiler
separately, then select `amxxpc` (`amxxpc.exe` on Windows) in Settings. Keeping
it on `PATH` is sufficient when using the signed default.

The opt-in real compiler tests use `SIDERAL_AMXXPC_E2E_COMPILER`,
`SIDERAL_AMXXPC_E2E_WORKSPACE` and `SIDERAL_AMXXPC_E2E_SOURCE`. They compile a
temporary source copy inside the workspace through both the extension command
and native broker, verify a non-empty `.amxx`, and remove the temporary tree.

## Versioning and diagnostics

`manifestVersion`, `apiVersion` and the host protocol are independent. Version
1 rejects unknown API versions instead of guessing a fallback. `engines.sideral`
is checked before installation, enablement, rollback and bundle loading.

The Extensions view reports the runtime state, last error, activation count and
duration, and command count, failures and last duration. A failed extension
does not restart silently; use Restart after inspecting the error.
