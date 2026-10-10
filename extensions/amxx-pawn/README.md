# AMXX Pawn Compiler

Adds the `amxxpawn` language for `.sma`/`.inc` and compiles the active saved
`.sma` document into an adjacent `.amxx` file.

## Use

1. Install the AMX Mod X compiler separately; this extension ships no compiler.
2. Install the signed extension package.
3. In **Settings → AMXX Pawn → Compiler Path**, select `amxxpc.exe`, or make
   `amxxpc` available on `PATH` for the signed default.
4. Keep standard includes beside the compiler. Open a project containing the
   source file, then run **AMXX Pawn: Compile active plugin** or `Ctrl+Shift+B`.

The compiler starts from its executable directory. A top-level project `include/`
with `.inc` files becomes a validated `-i` argument. Output and native exit status
appear in the extension's output channel; negative Windows statuses also include
their hexadecimal form.

## Develop and package

From the repository root:

```powershell
npm ci
npm run sdk:build
npm run extension:amxx:check
npm run extensions:package:dev
```

For a focused build use `npm run extension:amxx:build`. Package validation/signing
uses `build/extensions/amxx-pawn`. Follow [the authoring guide](../../docs/EXTENSIONS.md#sign-and-install)
for production keys and individual packages.

The [manifest](manifest.json) declares workspace read/write access, the executable
setting and typed source/include/output grants. The Worker has no direct
filesystem, shell or Tauri access. [API contracts](../../docs/EXTENSION-API.md#configuration-and-native-processes)
explain how those grants are enforced.
