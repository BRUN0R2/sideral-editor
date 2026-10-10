# Create a Sideral extension

An extension contributes commands, languages or views through a signed manifest
and one bundled ESM module. Its Web Worker receives typed host APIs; Rust validates
native requests against the signed capabilities.

Start here for the workflow. Use the [API reference](EXTENSION-API.md) for contracts
and limits, and [first-party extensions](../extensions/README.md) for complete
examples.

## Scaffold a standalone project

Install the [development prerequisites](DEVELOPMENT.md), run `npm ci` in the
Sideral repository, then:

```powershell
npm run extension:tool -- scaffold acme sample D:\extensions\acme-sample
cd D:\extensions\acme-sample
npm install
npm run typecheck
npm test
npm run build
```

Replace the example publisher, name and paths with your own. The destination must
not already exist. The scaffold includes strict TypeScript, Rolldown, a test and
pinned local SDK/testkit snapshots under `vendor/`. It builds outside the Sideral
repository without requiring published npm packages.

## Declare the extension

The generated `manifest.json` is the installable contract. This minimal example
declares a command without native filesystem, network or process grants:

```json
{
  "manifestVersion": 1,
  "apiVersion": 1,
  "id": "acme.sample",
  "displayName": "Acme Sample",
  "version": "0.1.0",
  "engines": { "sideral": "^0.1.1" },
  "runtime": { "kind": "worker", "entry": "dist/extension.mjs" },
  "contributes": {
    "commands": [
      { "id": "acme.sample.hello", "title": "Say hello" }
    ]
  }
}
```

Command invocation activates its owner automatically. Add `onWorkbenchReady` or
`onLanguage:<language-id>` to `activationEvents` only when earlier activation is
needed. Request the smallest capabilities that the feature needs.

## Implement and own resources

Put the module in `src/extension.ts`. The SDK is type-only:

```ts
import type { ExtensionModule } from "@sideral/extension-sdk";

export const activate: ExtensionModule["activate"] = (context, api) => {
  context.subscriptions.add(
    api.commands.registerCommand("acme.sample.hello", async () => {
      await api.window.showInformationMessage("Hello from Acme Sample.");
    }),
  );
};
```

Register commands, panels, output channels and listeners in
`context.subscriptions`. Use `context.cancellationSignal` for owned asynchronous
work. Cleanup attempts subscriptions in reverse order; optional `deactivate` can
perform remaining module cleanup. Avoid timers for startup coordination and
polling for source-document updates.

A text-editor command must declare `invocation: "activeTextDocument"` and use
`registerTextEditorCommand`. Its default `documentSync: "snapshot"` receives unsaved
content; `"save"` persists a named document before invocation. This requires a
workspace read grant.

## Test behavior

Use [the testkit](../packages/sideral-extension-testkit/README.md) for deterministic
commands, events, cancellation and cleanup. Provide explicit handlers for native
capabilities. It does not replace native containment, signature or installer
validation.

Build one minified Worker entry. Development dependencies, source maps and test
code must stay out of the installable package.

## Sign and install

Return to the Sideral repository root. Create the example parent directories
first; keep the private key outside both repositories:

```powershell
npm run extension:tool -- check D:\extensions\acme-sample
npm run extension:tool -- keygen D:\private\acme-extension-key.json
npm run extension:tool -- pack D:\extensions\acme-sample D:\private\acme-extension-key.json D:\packages\acme-sample.sideralx
npm run extension:tool -- inspect D:\packages\acme-sample.sideralx
```

`keygen` and `pack` do not overwrite existing output. Reuse a publisher key for
later versions. `check` and `pack` validate the manifest, Worker, assets, engine
range and size budgets.

In Sideral, press `Ctrl+Shift+X`, choose the package, review the publisher-key
fingerprint, package hash and capabilities, then trust and install it. A valid
signature identifies the publisher; it does not establish that the code is safe.
A Worker is a fault boundary, not an operating-system sandbox.

## Work inside this repository

Repository extensions share one root npm installation and lockfile. Run from the
root:

```powershell
npm ci
npm run sdk:build
npm run extensions:check
npm run extensions:package:dev
```

Local packages appear under `build/extensions/packages/`. The retained development
key lives at
`%LOCALAPPDATA%\dev.sideral.editor\development\extension-signing-key.json`.

For an individual extension, build it and check/sign the **staged** directory,
rather than its source directory:

```powershell
npm run extension:markdown:build
npm run extension:tool -- check build/extensions/markdown-preview
```

The archive entry remains `dist/extension.mjs`; physical repository output stays
under `build/`. See [the extension directory](../extensions/README.md) for each
build command.

Production packaging uses `npm run extensions:package` with
`SIDERAL_EXTENSION_SIGNING_KEY` set to the absolute path of an existing private
key. It never falls back to the development identity.

## Diagnose lifecycle failures

The Extensions view shows activation reason, state, durations, counters and
structured errors. Disable/reload cancels the current generation and its resources.
Late results cannot mutate the replacement generation. Restart a failed extension
explicitly; do not hide failures behind automatic retries.
