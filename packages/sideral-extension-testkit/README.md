# Sideral Extension Test Kit

`createExtensionHarness` activates an extension module against deterministic,
in-memory implementations of the Sideral API. Tests can execute registered
commands, push serialized workspace metadata and window activity changes, and inspect Discord
activity history, messages, output, read-only configuration and storage without
starting the desktop application. Native capabilities are unavailable unless a
test provides an explicit handler.

The harness mirrors the production lifecycle where it matters to unit tests:
activation is idempotent, commands and workspace callbacks share one serial
operation lane, nested local commands cannot deadlock, cancellation precedes
cleanup, and every subscription is attempted in reverse order. Stored JSON is
cloned at the boundary.

```ts
const harness = createExtensionHarness(extension, {
  activationReason: { kind: "workbenchReady" },
  configuration: { "compiler-path": "D:\\Tools\\compiler.exe" },
  workspaceContext: {
    workspaceName: "fixture",
    activeDocument: { name: "sample.txt", languageId: "text" }
  },
  readTextDocument: async (uri) => ({
    uri,
    languageId: "text",
    version: 1,
    content: "fixture"
  })
});

await harness.updateWorkspaceContext({
  workspaceName: "fixture",
  activeDocument: { name: "next.txt", languageId: "text" }
});
await harness.updateWindowActivityState("idle");
```
