# Extension API reference

Current contracts: manifest v1, API v1, host/Worker protocol v4. Versions are
explicitly negotiated; unknown versions fail. This reference accompanies
[authoring](EXTENSIONS.md); exported [SDK types](../packages/sideral-extension-sdk/src/index.ts)
and native validators define the exact contract.

## Manifest

| Field | Contract |
| --- | --- |
| `manifestVersion` / `apiVersion` | Both `1` |
| `id`, `displayName`, `version` | Publisher-qualified identity, display label and semantic version |
| `engines.sideral` | Required supported editor-version range |
| `runtime` | Optional `{ kind: "worker", entry: "dist/extension.mjs" }` |
| `activationEvents` | `onWorkbenchReady` or `onLanguage:<id>`; declared commands imply command activation |
| `permissions` | Workspace level and exact network, process or Discord grants |
| `contributes` | Commands, keybindings, languages and configuration |
| `description` / `license` | Optional metadata |

Parsing is strict. IDs, paths, engine ranges, contributions and cross-references
are validated. Language contributions are available before Worker activation;
duplicate language IDs or extension associations are rejected.

Commands use `workbench` invocation by default. `activeTextDocument` requires
workspace read access and passes `TextDocument` to `registerTextEditorCommand`.
`documentSync` defaults to `snapshot`; `save` requires a named saved document.
Command IDs belong to the extension namespace. Keybindings reference declared
commands and can restrict matching language IDs.

See the full [manifest types](../packages/sideral-extension-sdk/src/manifest.ts).

## Runtime and cancellation

`activate(context, api)` may be synchronous or asynchronous. `context` contains
identity, activation reason, extension/storage URIs, cancellation and subscriptions.
`deactivate(reason)` is optional. Reasons are `applicationShutdown`, `disabled`
and `reload`.

Each extension has one serial command/event lane; independent extensions can run
concurrently. Nested local commands use cycle/depth checks. Every returned
disposable needs an owner. Cancellation invalidates native requests and startup
work before cleanup.

Native session tokens stay in the trusted supervisor. Runtime payloads and
responses are bounded and validated; TypeScript types alone do not grant native
authority.

## APIs and permissions

| API | Access and behavior |
| --- | --- |
| `commands` | Register declared commands and execute routed commands |
| `configuration.get(key)` | Read an effective declared string; Workers cannot modify user settings |
| `workspace.getContext()` / `onDidChangeContext` | Require `metadata`, `read` or `readWrite`; names and language IDs only |
| `workspace.readTextDocument` / `findFiles` | Require `read` or `readWrite` |
| `workspace.writeTextDocument` | Requires `readWrite` and matching expected version |
| `storage` | Per-extension JSON values: get, update, delete, sorted keys |
| `window` | Messages, output, previews and `active`/`idle` transitions |
| `network.request` | Exact signed origin and allowed method |
| `processes.execute` | Named signed process grant and its declared path inputs |
| `discordPresence` | Signed Application ID and exclusively owned local Discord session |

Metadata excludes document content and full paths. The window activity API sends
only state transitions; a host-owned five-minute idle timer never forwards input
contents or coordinates. Workspace and source events are serialized without
polling.

## Workspace files and storage

File APIs accept strict `file:` URIs within canonical open-root containment.
They reject credentials, query strings, fragments and paths escaping the roots.
Writes use optimistic version checks and atomic replacement.

`findFiles` uses forward-slash globs, deterministic traversal and one global
limit across roots. Overlapping roots do not duplicate results. Canonical paths
can differ from the caller's Windows short-path spelling.

| Resource | Limit |
| --- | ---: |
| Workspace text document | 4 MiB |
| File-search results | Default 100; maximum 1,000 |
| Entries traversed per search | 100,000 |
| Storage key | 128 bytes |
| Stored JSON value | 256 KiB |
| Storage document | 2 MiB |

## Configuration and native processes

Configuration contributes an ordered list of `text` or `executable` properties.
Text is trimmed, single-line and bounded; executable defaults are bare tool
names resolved from `PATH`. Native Settings validates explicitly selected
absolute executable overrides and persists them atomically.

A process grant declares its ID, executable source, working directory and argument
shape. Executables use `literal` or a `configuration` reference to an executable
property. Working directory is `workspace`, `extensionData` or `executable`.

Arguments are immutable literals or typed `workspaceFile`/`workspaceDirectory`
slots with named inputs, `read`/`write` access, optional prefixes and file-extension
constraints. Runtime code supplies only those inputs:

```ts
const result = await api.processes.execute({
  grant: "acme.compiler.run",
  inputs: { source: document.uri, output: outputUri },
  signal: context.cancellationSignal,
});
```

This fragment assumes a matching signed grant and a validated `outputUri`.
See the [AMXX manifest](../extensions/amxx-pawn/manifest.json) for a complete
compiler grant. There is no shell string, caller-defined argument array or stdin
API. The broker validates containment, bounds output and duration, sanitizes the
environment, and kills/reaps cancelled processes.

## Network and Discord

Network grants permit exact origins and methods. Requests use HTTPS, with an
explicit loopback exception for local services. DNS destinations are validated
and pinned; every redirect is validated independently. Responses are bounded UTF-8
data without ambient browser cookies or proxy authority.

Discord grants use a signed literal Application ID or a reference to a declared
text property. Activity types are `playing`, `listening`, `watching` and `competing`.
Up to two buttons are allowed: labels at most 32 characters, credential-free
absolute HTTPS URLs at most 512 characters.

One extension generation owns the native Discord session globally. Conflicting
owners fail explicitly. Clear, disable, reload, host loss and shutdown close the
session. Windows desktop Discord is required. The
[Discord extension](../extensions/discord-presence/README.md) is the reference client.

## Output and previews

Output channels buffer `append`/`appendLine` and support `flush`, `clear` and `show`.
Updates do not steal focus. Closing an output tab hides it; disposing its channel
or extension frees it.

Previews use `format: "tree"` and an array of text or keyed elements:

```ts
const panel = api.window.createPreviewPanel({
  title: "Source preview",
  format: "tree",
  sourceUri: document.uri,
  content: [{ key: "source", tag: "pre", children: [document.content] }],
});
context.subscriptions.add(panel);
await panel.show();
```

The [runtime types](../packages/sideral-extension-sdk/src/runtime.ts) enumerate
allowed tags, attributes and styles. Trees are inert: no executable HTML, event
handlers, resource-loading CSS or positioning. Rust and the frontend reject
unsupported values and duplicate sibling keys.

| Preview resource | Limit |
| --- | ---: |
| Serialized content | 192 KiB |
| Nodes | 10,000 |
| Depth | 24 |

A file `sourceUri` binds a panel to its document. With workspace read access,
`panel.onDidChangeSourceDocument` delivers unsaved edits on the owner's serial
lane. Register its disposable. Changing active documents hides source-bound
panels without destroying them; returning can restore them. `dispose` or generation
shutdown releases the panel. Hidden payloads are omitted from native snapshots.

The host opens supported external HTTP/HTTPS links natively and local `file:`
links in the editor. Extensions resolve relative document links. Unsupported
schemes stay inert.

`appearance.scrollbar` overrides only that panel. Sizes use bounded integer
pixels; colors are `transparent` or 3/4/6/8-digit hex. Track/button sizes are 8–32,
thumb size is 4 through track size, and arrows fit their track/button. Omitted
dependent sizes are clamped. Omit appearance to inherit the host theme.

## Package and trust

An archive contains `manifest.json`, the declared Worker bundle, optional
`assets/` and `signature.json`. Ed25519 signatures cover canonical file digests.
No `node_modules`, test code, source maps, links or path traversal are allowed.

| Artifact | Limit |
| --- | ---: |
| Manifest | 64 KiB |
| Worker bundle | 256 KiB recommended; 2 MiB maximum |
| Compressed package | 10 MiB |
| Uncompressed package | 20 MiB |

Publisher trust uses the public-key SHA-256 fingerprint. Installation rechecks
the exact reviewed package hash. Active and rollback archives stay compressed
and are revalidated before loading. See [ADR 0001](decisions/0001-native-extension-system.md).
