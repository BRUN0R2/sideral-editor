# External references

The official Visual Studio Code repository is cloned locally into `vscode/` as
an ignored, shallow research checkout:

```powershell
git clone --depth 1 https://github.com/microsoft/vscode.git references/vscode
```

Its source is not a build dependency and must not be copied into Aster Code.
Before adapting an idea, review the upstream license and reimplement only the
smallest product behavior needed by this project.
