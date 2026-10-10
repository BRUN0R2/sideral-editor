# Sideral Editor

Sideral is an open-source desktop code editor for Windows. It combines Monaco
editing with a Rust backend and a Tauri 2 desktop shell.

Open several project folders, edit and reorder tabs, use an integrated terminal,
and install signed extensions. Windows file opening sends documents to the
existing editor window, including files launched through **Open with**.
English and Brazilian Portuguese are included; community translations use JSON.

The project is under active development. Windows is the supported operational
target. Published installers belong on
[GitHub Releases](https://github.com/BRUN0R2/sideral-editor/releases); you can also
[build an installer locally](docs/DEVELOPMENT.md#build-a-windows-installer).

## Start developing

Install the [Windows prerequisites](docs/DEVELOPMENT.md#prerequisites), then run
these commands from the repository root:

```powershell
npm ci
npm run tauri dev
```

Use `npm run check` for the complete project gate. The optional `sideral.cmd`
launcher offers development, local release and cleanup actions.

## Find your guide

| I want to… | Guide |
| --- | --- |
| Use the editor | [Getting started](docs/USAGE.md) |
| Open files from Explorer | [Windows file opening](docs/FILE-OPENING.md) |
| Configure several projects | [Project workspaces](docs/WORKSPACES.md) |
| Build or debug the application | [Development](docs/DEVELOPMENT.md) |
| Contribute a change | [Contributing](CONTRIBUTING.md) |
| Create an extension | [Extension authoring](docs/EXTENSIONS.md) |
| Understand the code | [Architecture](docs/ARCHITECTURE.md) |

The [documentation index](docs/README.md) includes API contracts, translations,
release setup, engineering rules and architecture decisions.

Sideral has its own extension format and runtime. The ignored `references/vscode/`
checkout is research material and is never a build or runtime dependency.

## License

[MIT](LICENSE). Bundled third-party artwork retains its
[original notices](assets/vscode-theme-seti/THIRD_PARTY_NOTICES.txt).
