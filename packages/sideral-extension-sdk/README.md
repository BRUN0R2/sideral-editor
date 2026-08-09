# Sideral Extension SDK

This package contains the versioned compile-time contracts for Sideral manifest
v1, API v1 and the host/Worker protocol. Install it as a development dependency
and use `import type`; it contributes zero runtime bytes to an extension bundle.

An extension ships one bundled ESM worker entry and its manifest. The editor
supplies every runtime capability through `ExtensionApi`.

```ts
import type { ExtensionManifest, ExtensionModule } from "@sideral/extension-sdk";

export const manifest = {
  manifestVersion: 1,
  apiVersion: 1,
  id: "acme.sample",
  displayName: "Acme Sample",
  version: "0.1.0",
  engines: { sideral: "^0.1.0" },
  runtime: { kind: "worker", entry: "dist/extension.mjs" },
  contributes: { commands: [{ id: "acme.sample.run", title: "Run" }] }
} satisfies ExtensionManifest;

export const activate: ExtensionModule["activate"] = (context, api) => {
  context.subscriptions.add(
    api.commands.registerCommand("acme.sample.run", () => ({ ok: true }))
  );
};
```

See `docs/EXTENSIONS.md` in the Sideral repository for the complete authoring,
capability, packaging, testing and trust model.
