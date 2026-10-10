# Sideral Extension SDK

`@sideral/extension-sdk` supplies compile-time contracts for manifest v1, API v1
and host/Worker protocol v4. Use it as a development dependency with `import type`.
It emits declarations and contributes no runtime JavaScript to a Worker bundle.

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

The command must also be declared in the signed manifest. Native authority comes
from validated manifest grants, not from importing a type.

## Build and consume

In this repository, run `npm ci` and `npm run sdk:build` at the root.
Declarations are staged under `build/packages/sideral-extension-sdk/`.

Standalone projects created by `extension:tool scaffold` receive an exact SDK
snapshot under `vendor/`. They install and build outside the repository without
requiring registry publication. SDK version and manifest/API/protocol versions
are separate contracts; use the snapshot matching the target editor.

| Reference | Content |
| --- | --- |
| [Authoring](../../docs/EXTENSIONS.md) | Working extension, signing and installation |
| [API reference](../../docs/EXTENSION-API.md) | Capabilities, previews and limits |
| [Manifest types](src/manifest.ts) | Exact declarations and grants |
| [Runtime types](src/runtime.ts) | Host APIs and lifecycle |
| [Protocol types](src/protocol.ts) | Supervisor/Worker messages |
| [Testkit](../sideral-extension-testkit/README.md) | Deterministic tests |

Application source and native modules are not authoring dependencies. Extensions
use the public SDK and receive runtime behavior from the host.
