# Documentation

New to Sideral? Start with [using the editor](USAGE.md). To change the project,
follow [development](DEVELOPMENT.md) and [contributing](../CONTRIBUTING.md).

## Using the editor

| Guide | Covers |
| --- | --- |
| [Getting started](USAGE.md) | Files, tabs, terminal, Settings and extensions |
| [External opening](FILE-OPENING.md) | Windows associations, Codex integration and executable troubleshooting |
| [Project workspaces](WORKSPACES.md) | Multiple folders, project settings and session restoration |
| [Translations](TRANSLATING.md) | Add a display language without build tools |

## Building and extending

| Guide | Covers |
| --- | --- |
| [Development](DEVELOPMENT.md) | Setup, commands, build output and validation |
| [Extension authoring](EXTENSIONS.md) | Scaffold, build, test, sign and install |
| [Extension API](EXTENSION-API.md) | Manifest, runtime capabilities and limits |
| [First-party extensions](../extensions/README.md) | Markdown Preview, AMXX Pawn and Discord Work Presence |
| [SDK](../packages/sideral-extension-sdk/README.md) | Type-only authoring contracts |
| [Testkit](../packages/sideral-extension-testkit/README.md) | Deterministic extension tests |

## Maintaining the project

| Guide | Covers |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Modules, native authority and resource ownership |
| [Project rules](RULES.md) | Required engineering and contribution standards |
| [Signed updates](UPDATES.md) | Release environment, signatures and portable updates |
| [Architecture decisions](decisions/README.md) | Reasons behind the extension design |
| [Discord artwork](../assets/discord/README.md) | Asset delivery and reproducible exports |
| [Research references](../references/README.md) | Recorded upstream research and its boundary |
| [TODO](TODO.md) | Current actionable follow-up work |

Guides describe implemented behavior. Exact dependency versions belong in
manifests and lockfiles; API types and native validators define the current
contract. Update the owning guide alongside a change instead of copying the
same instructions into several pages.
