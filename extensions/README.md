# Sideral extensions

Every extension lives in `extensions/<name>`. Each directory owns its manifest,
package manifest, source, focused tests and Worker bundle. Application code never
imports an extension implementation; extensions use the public SDK and run in
isolated Workers.

Repository extensions share npm workspaces, one root lockfile and one hoisted
installation. TypeScript, Vitest and Rolldown are pinned once at the root.
Each extension declares its own runtime dependencies, which npm deduplicates
when versions are compatible. A local `node_modules` directory is generated
installation state, not part of an extension's required source structure.

The repository currently contains Markdown Preview, AMXX Pawn and Discord
Work Presence. Extensions are installed in the running editor only through
reviewed, signed `.sideralx` packages; their presence in this directory does
not install or enable them.

From the repository root:

```powershell
npm ci
npm run sdk:build
npm run extensions:check
```

For one extension, use `npm run build --workspace <package-name>` or its named
root script, such as `npm run extension:markdown:build`. Repository builds stage
the manifest, optional assets and Worker bundle in
`build/extensions/<name>`; package checks and signing use that staged directory.
The public SDK and testkit are development packages under `packages/`;
extensions do not depend on `src` or `src-tauri`. The SDK contributes types
only. Tests, the testkit and `node_modules` never enter production extension
packages.

`npm run build` and the release launcher rebuild every first-party extension
before the frontend and native application. Tests and package checks remain
explicit verification commands. New repository extensions follow this
structure, register their staging name in `scripts/buildExtension.mjs` and
update the root lockfile with `npm install`. Generated dependencies and build
output remain ignored.

`npm run extensions:package:dev` creates installable local packages in
`build/extensions/packages` with a persistent development key stored outside
the repository. Production package generation uses `npm run extensions:package`
and an absolute `SIDERAL_EXTENSION_SIGNING_KEY` path; it never falls back to a
development identity.
