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
npm run extension:tool -- keygen D:\private\acme-extension-key.json
npm run extension:tool -- pack D:\extensions\acme-sample D:\private\acme-extension-key.json D:\packages\acme-sample.sideralx
npm run extension:tool -- inspect D:\packages\acme-sample.sideralx
```

Open Extensions with `Ctrl+Shift+X`, choose the package, review its publisher
key, exact package hash and capabilities, then trust and install it. The tool
never overwrites a key, package or scaffold directory. `examples/hello-sideral`
is the minimal reference and `examples/markdown-preview` is the first visual,
document-aware reference extension.

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
  "activationEvents": ["onLanguage:typescript"],
  "permissions": {
    "workspace": "read",
    "network": [
      { "origin": "https://api.example.com", "methods": ["GET"] }
    ],
    "processes": [
      {
        "id": "acme.sample.formatter",
        "executable": "formatter",
        "arguments": ["--check"]
      }
    ]
  },
  "contributes": {
    "commands": [
      {
        "id": "acme.sample.run",
        "title": "Run",
        "category": "Acme",
        "invocation": "activeTextDocument"
      }
    ],
    "keybindings": [
      {
        "command": "acme.sample.run",
        "key": "Ctrl+Shift+V",
        "mac": "Shift+Meta+V",
        "languages": ["markdown"]
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
resolved.

Network permissions are exact origins and methods. HTTPS is required except for
an exact loopback origin used during local development. A process permission is
a fixed executable plus fixed arguments: runtime input cannot alter either.

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
`powershell` (or the compatible `pwsh` and `ps1` aliases) receive a PowerShell
terminal presentation, but their contents remain inert, selectable text and are
never executed.

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

## Available capabilities

| API | Manifest authority | Important behavior |
| --- | --- | --- |
| `commands` | Declared command IDs and invocation | Registration and active-document context are checked against the signed manifest |
| `workspace.readTextDocument` | `workspace: read` or `readWrite` | UTF-8, 4 MiB, canonical path containment |
| `workspace.writeTextDocument` | `workspace: readWrite` | Existing text files, expected version, atomic replacement |
| `workspace.findFiles` | `workspace: read` or `readWrite` | Forward-slash glob, deterministic order, bounded result/traversal |
| `storage` | Always isolated to the extension | Atomic JSON, bounded keys, values and document |
| `configuration` | Always isolated to the extension | Atomic extension-specific JSON |
| `network.request` | Exact origin and method | No proxy/cookies, redirects revalidated, DNS pinned, bounded UTF-8 body |
| `processes.execute` | Exact process grant | Fixed arguments, no stdin/shell, clean environment, bounded output |
| `window` | No extra grant | Bounded messages, output channels and typed preview panels owned by the extension |

Cancellation is cooperative. A canceled network request or process is stopped
and a canceled process is reaped. A remote server may still have observed a
request that was already transmitted.

## Unit testing

`@sideral/extension-testkit` runs an extension against deterministic in-memory
storage, configuration, messages and output. Native capabilities must be
provided explicitly, so a test cannot accidentally access the machine.

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
authority for the fixed command shown in the review dialog.

## Versioning and diagnostics

`manifestVersion`, `apiVersion` and the host protocol are independent. Version
1 rejects unknown API versions instead of guessing a fallback. `engines.sideral`
is checked before installation, enablement, rollback and bundle loading.

The Extensions view reports the runtime state, last error, activation count and
duration, and command count, failures and last duration. A failed extension
does not restart silently; use Restart after inspecting the error.
