# Contributing

Start with the [development guide](docs/DEVELOPMENT.md) and
[project rules](docs/RULES.md). The [architecture guide](docs/ARCHITECTURE.md)
explains which module owns each responsibility.

## Make a change

1. Create a focused branch from an up-to-date `main`. Automated branches use
   the `codex/` prefix.
2. Resolve the underlying problem in the owning module. Keep interfaces small,
   failures visible and resource cleanup explicit.
3. Update the relevant guide when behavior, commands or contracts change.
4. Run focused checks, then `npm run check` before submitting. Validate native
   behavior in the desktop application when applicable.
5. Commit each completed logical change with a short English imperative message.
6. Open a pull request against `main`. Explain the problem, resulting behavior,
   validation and any remaining limitation.

Use current supported stable technologies and verify external integrations
against official documentation. Keep generated output under `build/`;
never commit private keys, credentials, logs or dependencies. Text files use LF;
Batch scripts use CRLF as defined in [`.gitattributes`](.gitattributes).

## Choose where to work

| Change | Starting point |
| --- | --- |
| Editor or workbench behavior | [`src/features`](src/features), [`src/app`](src/app) |
| Native filesystem or desktop behavior | [`src-tauri/src`](src-tauri/src) |
| Extension implementation | [First-party extensions](extensions/README.md) |
| Extension contract or packaging | [API reference](docs/EXTENSION-API.md), [decisions](docs/decisions/README.md) |
| Community language | [Translation guide](docs/TRANSLATING.md) |

Use [TODO](docs/TODO.md) for concrete unfinished work. A failed GitHub Actions
check belongs to the change: inspect its log, fix the cause and rerun the gate.
