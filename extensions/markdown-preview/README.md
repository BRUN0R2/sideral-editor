# Markdown Preview

`sideral.markdown-preview` owns Markdown parsing, GFM structures, link resolution,
inert HTML and image placeholders, PowerShell code-block presentation and all
document styling. Its only Sideral dependency is the public extension SDK.

The Worker sends a typed visual tree to the generic preview API. The preview
host does not parse Markdown or import this extension's parser or source.
Opening a Markdown document and running **Toggle Markdown Preview**, or
pressing `Ctrl+Shift+V`, creates or toggles one source-bound panel. Source
document events refresh unsaved changes without polling. Closing, disabling
or reloading releases the owned panel and listeners.

From the repository root:

```powershell
npm ci
npm run sdk:build
npm run extension:markdown:check
```

Run `npm run extension:markdown:build` to build only the extension. This directory
declares the Markdown parser; build tools and the lockfile are shared at the
repository root. The existing rendering and lifecycle tests live beside the
implementation and are not part of the editor's release build.

Use the signing and packaging workflow in `docs/EXTENSIONS.md` with
`extensions/markdown-preview` as the project directory to install it in Sideral.
