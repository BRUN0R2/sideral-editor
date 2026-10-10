# Sideral Extension SDK

This package contains the versioned compile-time contracts for Sideral manifest
v1, API v1 and host/Worker protocol v4. Install it as a development dependency
and use `import type`; it contributes zero runtime bytes to an extension bundle.
Projects created by the official scaffold receive an exact local snapshot of
this package, so they are immediately installable and buildable outside the
Sideral repository. A registry publication is not required for that workflow.

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
  engines: { sideral: "^0.1.1" },
  runtime: { kind: "worker", entry: "dist/extension.mjs" },
  permissions: { workspace: "read" },
  contributes: {
    languages: [
      {
        id: "sample-markdown",
        aliases: ["Sample Markdown"],
        extensions: [".samplemd"]
      }
    ],
    commands: [
      {
        id: "acme.sample.preview",
        title: "Toggle preview",
        invocation: "activeTextDocument",
        documentSync: "snapshot"
      }
    ],
    keybindings: [
      {
        command: "acme.sample.preview",
        key: "Ctrl+Shift+V",
        languages: ["sample-markdown"]
      }
    ]
  }
} satisfies ExtensionManifest;

export const activate: ExtensionModule["activate"] = (context, api) => {
  context.subscriptions.add(
    api.commands.registerTextEditorCommand("acme.sample.preview", async (document) => {
      const panel = api.window.createPreviewPanel({
        title: "Preview",
        format: "tree",
        content: [{ key: "document", tag: "pre", children: [document.content] }],
        sourceUri: document.uri
      });
      context.subscriptions.add(panel);
      await panel.show();
    })
  );
};
```

Native tools use signed, typed process grants. Runtime code can supply only the
named workspace-path inputs declared by the manifest:

```ts
await api.processes.execute({
  grant: "acme.compiler.run",
  inputs: {
    source: document.uri,
    output: document.uri.replace(/\.source$/u, ".output")
  }
});
```

The executable declaration is explicit as well. Use
`{ kind: "literal", value: "compiler" }` for an immutable executable or
reference a user-facing setting:

```ts
const manifest = {
  permissions: {
    processes: [
      {
        id: "acme.compiler.run",
        executable: { kind: "configuration", key: "compiler-path" },
        workingDirectory: "executable"
      }
    ]
  },
  contributes: {
    configuration: {
      title: "Acme Compiler",
      properties: [
        {
          kind: "executable",
          key: "compiler-path",
          title: "Compiler Path",
          default: "compiler"
        }
      ]
    }
  }
} satisfies Pick<ExtensionManifest, "permissions" | "contributes">;
```

Sideral renders the executable selector, validates and persists user overrides,
and resolves the effective value inside the native process broker. The signed
default is a bare executable name resolved from `PATH`; selected overrides are
absolute canonical paths. Worker code
may read a declared value with `api.configuration.get("compiler-path")`, but it
cannot change user configuration.

Use a `text` configuration property for bounded, trimmed single-line values.
Capabilities can require the matching type; for example, Discord Presence may
bind its public Application ID to a text setting and cannot bind it to an
executable selector.

Workspace metadata is event-driven and excludes content and paths:

```ts
const current = api.workspace.getContext();
context.subscriptions.add(
  api.workspace.onDidChangeContext(async (next) => {
    await api.discordPresence.setActivity({
      type: "playing",
      details: next.activeDocument === null ? "Browsing" : `🧑‍💻 ${next.activeDocument.name}`,
      state: next.workspaceName === null ? "📁 No workspace open" : `📁 ${next.workspaceName}`,
      buttons: [
        {
          label: "Download",
          url: "https://github.com/BRUN0R2/sideral-editor/releases/latest"
        }
      ]
    });
  })
);
void current;
```

The corresponding manifest needs `workspace: "metadata"` and an explicit
`discordPresence` grant. The native broker validates and owns the local IPC
session; the Worker never opens a socket or named pipe directly. Activities may
contain up to two buttons. Button labels are limited to 32 characters and URLs
to 512 characters; URLs must be absolute, credential-free HTTPS links.

Window activity is privacy-preserving and event-driven. It exposes only
`active` or `idle`; raw keyboard and pointer data never enter a Worker:

```ts
const currentState = api.window.getActivityState();
context.subscriptions.add(
  api.window.onDidChangeActivityState((state) => {
    void state;
  })
);
void currentState;
```

The corresponding manifest argument is an immutable
`{ kind: "literal", value }`, a validated
`{ kind: "workspaceFile", name, access, prefix?, extensions? }`, or a validated
`{ kind: "workspaceDirectory", name, access, prefix? }`. There is no shell API
or caller-defined argument array.

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
