# Sideral Editor

Sideral Editor is a new, focused desktop code editor built with Rust, Tauri and
strict TypeScript. It takes product and architecture references from modern
editors while keeping its own small, explicit codebase.

The first working foundation includes:

- a native Tauri 2 shell for Windows;
- Monaco editing with explicit model and listener disposal;
- native open-folder, open-file and atomic save flows;
- secure JSON schema validation with real file URIs, native resolution,
  bounded caching and revocable remote trust;
- a lazy workspace explorer that does not crawl an entire project up front;
- English as the primary language and automatic system-language detection;
- drop-in JSON translations discovered from the app's locale directory;
- manual language selection with persisted native settings;
- a signed-update state machine with availability indicator, download progress,
  transfer percentage, ETA, install stage and restart action;
- signed `.sideralx` installation, explicit publisher-key trust, isolated
  Worker runtimes, a native capability broker, command palette, diagnostics,
  rollback, authoring SDK, testkit and packaging CLI;
- strict TypeScript, Rust safety lints, Biome checks and focused tests.

This is an original project. The ignored `references/vscode/` checkout is for
research only and is never a build or runtime dependency.

## Toolchain

- Rust 1.97.1, edition 2024
- Tauri 2.11
- TypeScript 7.0
- Vite 8.2
- React 19.2
- Monaco Editor 0.56

Use a current Node.js release supported by Vite (22.12 or newer) and the current
stable MSVC Rust toolchain.

## Run

```powershell
npm install
npm run tauri dev
```

On Windows, run `sideral.cmd` from the project root for a small menu that starts
the Tauri development mode, compiles a release, cleans build artifacts or exits.
Before development starts, the launcher reclaims port `1420` only from a stale
Vite process whose command line belongs to this project; unrelated listeners are
reported and left untouched.

Useful validation commands:

```powershell
npm run check
npm run build
```

`npm run dev` opens an explicit browser-only visual preview. Native file,
translation-folder and updater operations intentionally remain unavailable in
that preview.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Project rules](docs/RULES.md)
- [Creating a translation](docs/TRANSLATING.md)
- [Signed updates](docs/UPDATES.md)
- [Extension authoring](docs/EXTENSIONS.md)
- [Extension-system decisions](docs/decisions/0001-independent-extension-systems.md)
- [Next work](docs/TODO.md)
