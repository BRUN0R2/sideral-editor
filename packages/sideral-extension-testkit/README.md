# Sideral Extension Testkit

`createExtensionHarness` runs an extension against deterministic in-memory host
APIs. Tests can invoke commands, deliver events and inspect messages, output,
previews, configuration, storage and Discord activity without starting Tauri.

Native file, process and network behavior needs an explicit test handler.
The harness does not validate real signatures, native path containment or
operating-system behavior.

## Test an extension

In this repository, run `npm ci` and `npm run sdk:build` at the root.
Standalone scaffolds include the matching local testkit snapshot.

For the hello command in [the authoring example](../../docs/EXTENSIONS.md#implement-and-own-resources),
place a test beside the extension module:

```ts
import { createExtensionHarness } from "@sideral/extension-testkit";
import { expect, test } from "vitest";
import * as extension from "./extension";

test("shows the declared greeting", async () => {
  const harness = createExtensionHarness(extension);
  try {
    await harness.activate();
    await harness.executeCommand("acme.sample.hello");
    expect(harness.messages.map(({ message }) => message)).toEqual([
      "Hello from Acme Sample.",
    ]);
  } finally {
    await harness.dispose();
  }
});
```

Activate explicitly before running commands. Dispose in cleanup even when an
assertion fails.

## Drive events and capabilities

Options include `activeTextDocument`, `workspaceContext`, `configuration` and initial
`storage`. Native handlers include `readTextDocument`, `writeTextDocument`,
`findFiles`, `requestNetwork`, `executeProcess` and Discord activity handlers.

| Method or property | Purpose |
| --- | --- |
| `updateWorkspaceContext` | Deliver a serialized metadata change |
| `updateWindowActivityState` | Deliver `active` or `idle` |
| `updatePreviewSource` | Deliver unsaved source content to a bound panel |
| `messages` / `outputs` / `previews` | Inspect owned UI resources |
| `discordActivityUpdates` | Inspect activity and clear history |
| `storage` / `configuration` | Inspect cloned stored JSON and effective settings |

The harness mirrors production lifecycle contracts: idempotent activation,
one serial command/event lane, nested local command handling, cancellation before
cleanup and reverse-order subscription disposal. It attempts remaining cleanup
after a failure.

See [exported types](src/index.ts) for complete options and
[the API reference](../../docs/EXTENSION-API.md) for production enforcement.
