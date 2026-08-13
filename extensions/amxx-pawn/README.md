# AMXX Pawn Compiler for Sideral

This is a standalone Sideral extension. It contributes the `amxxpawn` language
association for `.sma` and `.inc` files and compiles the active saved `.sma`
file into an adjacent `.amxx` file.

When the workspace has a top-level `include` directory containing `.inc`
files, the extension passes it to `amxxpc` as a validated `-i` argument. The
compiler's own standard includes continue to resolve beside its executable.

## Requirements

- Install the AMX Mod X compiler for your platform.
- Select `amxxpc` (`amxxpc.exe` on Windows) under
  **Settings › AMXX Pawn › Compiler Path**. The signed default also resolves
  `amxxpc` from `PATH`.
- Keep the compiler's standard include directory beside the executable. Sideral
  intentionally starts the compiler from that directory.

No compiler binary is redistributed by this package.

## Develop

From this directory:

```powershell
npm install
npm run typecheck
npm test
npm run build
```

The extension uses only `@sideral/extension-sdk`. Its worker has no Node.js,
filesystem, shell or Tauri access. The signed manifest contributes the compiler
selector and grants that declared configuration as the executable source plus
typed workspace-path arguments: a readable `.sma` source, an optional readable
project include directory and a writable `.amxx` target.

## Package and install

From the Sideral repository root, after building the extension:

```powershell
npm run extension:tool -- check extensions\amxx-pawn
npm run extension:tool -- keygen D:\private\sideral-amxx-key.json
npm run extension:tool -- pack extensions\amxx-pawn D:\private\sideral-amxx-key.json D:\packages\sideral-amxx-pawn.sideralx
npm run extension:tool -- inspect D:\packages\sideral-amxx-pawn.sideralx
```

Install the resulting `.sideralx` from the Sideral Extensions view. Open a
saved `.sma` file and run **AMXX Pawn: Compile active plugin** from the command
palette or press `Ctrl+Shift+B` (`Cmd+Shift+B` on macOS).
