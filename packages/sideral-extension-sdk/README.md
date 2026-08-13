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
  permissions: { workspace: "read" },
  contributes: {
    commands: [
      {
        id: "acme.sample.preview",
        title: "Toggle preview",
        invocation: "activeTextDocument"
      }
    ],
    keybindings: [
      {
        command: "acme.sample.preview",
        key: "Ctrl+Shift+V",
        languages: ["markdown"]
      }
    ]
  }
} satisfies ExtensionManifest;

export const activate: ExtensionModule["activate"] = (context, api) => {
  context.subscriptions.add(
    api.commands.registerTextEditorCommand("acme.sample.preview", async (document) => {
      const panel = api.window.createPreviewPanel({
        title: "Preview",
        format: "markdown",
        content: document.content,
        sourceUri: document.uri
      });
      context.subscriptions.add(panel);
      await panel.show();
    })
  );
};
```

Preview panels inherit the host scrollbar theme by default. A panel can safely
override it within its own surface without injecting CSS into the workbench:

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

Sizes are bounded integer pixels. `showButtons: false` removes the top and
bottom arrow buttons for a deliberately minimal variant. `arrowSize` controls
width, `arrowHeight` controls the vertical silhouette and `buttonSize` controls
the click target and breathing room. Colors accept `transparent` or
hexadecimal CSS colors, including alpha. The override is scoped to that preview
panel.

See `docs/EXTENSIONS.md` in the Sideral repository for the complete authoring,
capability, packaging, testing and trust model.
