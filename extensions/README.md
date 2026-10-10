# First-party extensions

These are independent signed packages. Source in this directory does not install
or enable an extension in the running editor.

| Extension | Purpose | Focused check |
| --- | --- | --- |
| [Markdown Preview](markdown-preview/README.md) | Live preview of unsaved Markdown | `npm run extension:markdown:check` |
| [AMXX Pawn](amxx-pawn/README.md) | Compile saved `.sma` files with an external compiler | `npm run extension:amxx:check` |
| [Discord Work Presence](discord-presence/README.md) | Share workspace/document names with desktop Discord | `npm run extension:discord:check` |

## Build and install locally

From the repository root:

```powershell
npm ci
npm run sdk:build
npm run extensions:check
npm run extensions:package:dev
```

Install the resulting `build/extensions/packages/*.sideralx` files through the
Extensions view after reviewing publisher trust and capabilities. The development
key is retained outside the repository; see [authoring](../docs/EXTENSIONS.md).

For one build, use `extension:markdown:build`, `extension:amxx:build` or
`extension:discord:build`. Manifest, optional assets and Worker bundle are staged
under `build/extensions/<name>/`. Pass that directory to `extension:tool check`
or `pack`, rather than the source directory.

## Repository structure

Each extension owns its manifest, package declaration, source and focused tests.
It uses the public SDK/testkit and never imports `src` or `src-tauri`. The
application never imports extension implementations.

npm workspaces share one lockfile and installation. Runtime dependencies are
declared by each extension; compatible versions can be deduplicated. Build tools
are pinned at the root. Tests and dependencies are not shipped in signed packages.

When adding a repository extension, register its name in
[`buildExtension.mjs`](../scripts/buildExtension.mjs) and
[`packageExtensions.mjs`](../scripts/packageExtensions.mjs), add root build/check
scripts and update the lockfile. Keep outputs under `build/`.

Production packaging uses `npm run extensions:package` with an absolute existing
`SIDERAL_EXTENSION_SIGNING_KEY` path. For complete manifest/capability contracts,
use [the API reference](../docs/EXTENSION-API.md).
