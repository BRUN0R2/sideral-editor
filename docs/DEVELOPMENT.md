# Development

Sideral's operational target is Windows. Run commands below from the repository
root unless a step explicitly changes directory.

## Prerequisites

| Tool | Requirement |
| --- | --- |
| Windows native tools | Microsoft C++ Build Tools with the Desktop development with C++ workload and Windows SDK |
| WebView | Microsoft Edge WebView2 Runtime |
| Rust | Stable MSVC toolchain, edition 2024; minimum version in [`Cargo.toml`](../src-tauri/Cargo.toml) |
| Node.js | Node 24 to match CI; the manifest accepts 22.12 or newer |
| npm | Exact `packageManager` version in [`package.json`](../package.json) |
| Security checks | `cargo-audit` at the version pinned in the [quality workflow](../.github/workflows/quality.yml) |

Follow [Tauri's Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
for native tools. CI pins Rust and audit versions explicitly. Manifests and
lockfiles are the source of truth for library versions.

## Install and run

```powershell
npm ci
npm run tauri dev
```

Use `npm ci` for a clean installation from the root lockfile. Repository npm
workspaces share tools and dependencies. After an intentional dependency
change, use `npm install` to update the lockfile. Installation scripts run only
when allowlisted in `package.json`.

`npm run dev` starts a browser-only visual preview. Native file dialogs,
translation-folder access, terminal processes and the updater require Tauri.

The optional `sideral.cmd` menu starts development, builds a local release or
cleans generated output. It reclaims port 1420 only from a stale project-owned
Vite process; an unrelated listener is reported and preserved.

## Build a Windows installer

```powershell
npm run tauri build
```

Tauri builds the frontend and native application, then creates the NSIS installer
under `build/cargo/release/bundle/nsis/`. The executable is
`build/cargo/release/sideral-editor.exe`. Install the NSIS package to register
Explorer integration; merely compiling or running the executable does not do so.

`npm run release:local` additionally creates development-signed first-party
extension packages. Editor and extensions remain separate installable artifacts.
Production update signing is covered in [updates](UPDATES.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Complete local and GitHub Actions quality gate |
| `npm run architecture` | Build layout, extension boundaries, scrollbar contract and file associations |
| `npm run docs:check` | Local Markdown links and heading targets |
| `npm run lint` / `npm run format` | Check / apply Biome formatting and lint fixes |
| `npm run typecheck` / `npm test` | Strict application types / frontend tests |
| `npm run rust:fmt` / `npm run rust:clippy` | Rust formatting / strict workspace lint |
| `npm run rust:test` | Rust workspace and documentation tests |
| `npm run sdk:build` / `npm run extensions:check` | Build SDK and testkit / check each extension |
| `npm run build` | Type-check, build SDK and extensions, bundle the frontend |
| `npm run extensions:package:dev` | Sign local extension packages with the retained development key |
| `npm run security` | JavaScript and Rust dependency-advisory checks |
| `npm run clean` | Remove the validated root `build/` directory |

`build` does not run tests or compile the native application. `check` runs
architecture and documentation checks, Biome, TypeScript, SDK/extension checks, frontend and Rust
tests, Rustfmt, Clippy, production bundle budgets and security checks.

## Generated output

| Directory | Owner |
| --- | --- |
| `build/cargo/` | Cargo, native executable and Tauri installers |
| `build/frontend/` | Vite production bundle |
| `build/packages/` | Compiled SDK and testkit |
| `build/extensions/<name>/` | Staged manifest, assets and Worker bundle |
| `build/extensions/packages/` | Signed first-party `.sideralx` packages |
| `build/windows/` | Generated NSIS association hooks |

Keep output in `build/`, not a root `target/` or source-local `dist/`. A manifest
entry such as `dist/extension.mjs` describes a path *inside* an extension package.
Configuration-generated files under `src-tauri/gen/` remain ignored.

## Validate changes

Run focused checks while editing, then the complete gate before submitting.
Desktop changes also need a live check in the native application. Use an isolated
application identifier and test directory when testing installer registration,
profiles or package trust.

For long-running resource diagnostics:

```powershell
npm run runtime:observe -- -ProcessId <editor-process-id>
```

The observer includes the native process and WebView descendants. Investigate
unowned growth before delivery; change budgets only from measured evidence.
On Windows, automated background builds, tests and helpers must use a windowless
process with `UseShellExecute=false`, `CreateNoWindow=true` and redirected logs.

## Diagnose a failed gate

Open the failed GitHub Actions job and find the first failing command and its
complete assertion or diagnostic. Run that focused command with the same
toolchain, fix the underlying cause, then rerun `npm run check`.

Windows can represent the same file through short names, long names or canonical
paths. Filesystem tests must compare the path contract returned by the native
API, while retaining exact ordering, containment and duplicate checks.

The Rust advisory policy lives in
[`check-rust-advisories.mjs`](../scripts/check-rust-advisories.mjs). Reviewed
target-specific findings are explicit; new advisories fail the gate. Do not
suppress a failure or loosen a budget to make an unrelated change pass.
