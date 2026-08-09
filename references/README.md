# External references

The official Visual Studio Code repository is cloned locally into `vscode/` as
an ignored, shallow research checkout:

```powershell
git clone --depth 1 https://github.com/microsoft/vscode.git references/vscode
```

Its source is not a build dependency and must not be copied into Sideral Editor.
Before adapting an idea, review the upstream license and reimplement only the
smallest product behavior needed by this project.

Current shallow reference checkout:

- repository: `https://github.com/microsoft/vscode.git`
- commit: `97f9937a4263a283f83868783cf93142d1389c16`
- checkout date: `2026-08-08`
