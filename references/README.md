# External references

The official Visual Studio Code repository can be cloned into the ignored
`references/vscode/` directory for behavioral and architectural research.
Run from the Sideral repository root:

```powershell
git clone --depth 1 https://github.com/microsoft/vscode.git references/vscode
```

Its source is not a build dependency and must not be copied into Sideral Editor.
Before adapting an idea, review the upstream license and reimplement only the
smallest product behavior needed by this project.

Recorded research snapshot:

- repository: `https://github.com/microsoft/vscode.git`
- commit: `97f9937a4263a283f83868783cf93142d1389c16`
- checkout date: `2026-08-08`

This records research provenance, not a required upstream version. Sideral's build
and runtime never read this checkout. See [architecture](../docs/ARCHITECTURE.md)
and [project rules](../docs/RULES.md) before introducing an external integration.
