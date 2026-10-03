import type { AutoSaveMode, ProjectSettings, WorkspaceFolderSnapshot } from "../../lib/contracts";
import { workspacePathKey } from "./workspace-tree";

const defaultEditorSettings = { tabSize: 4, insertSpaces: true, wordWrap: "off" } as const;

export function workspaceFolderForPath<Folder extends { readonly path: string }>(
  folders: readonly Folder[],
  path: string | null,
): Folder | undefined {
  if (path === null) return undefined;
  const key = workspacePathKey(path);
  let owner: Folder | undefined;
  let ownerLength = -1;
  for (const folder of folders) {
    const rootKey = workspacePathKey(folder.path).replace(/\\+$/, "");
    if ((key === rootKey || key.startsWith(`${rootKey}\\`)) && rootKey.length > ownerLength) {
      owner = folder;
      ownerLength = rootKey.length;
    }
  }
  return owner;
}

export function editorSettings(settings?: ProjectSettings) {
  return {
    tabSize: settings?.editor?.tabSize ?? defaultEditorSettings.tabSize,
    insertSpaces: settings?.editor?.insertSpaces ?? defaultEditorSettings.insertSpaces,
    wordWrap: settings?.editor?.wordWrap ?? defaultEditorSettings.wordWrap,
  };
}

export function documentAutoSave(
  folders: readonly WorkspaceFolderSnapshot[],
  path: string | null,
  userPreference: AutoSaveMode,
): AutoSaveMode {
  return workspaceFolderForPath(folders, path)?.settings.files?.autoSave ?? userPreference;
}

export function isWorkspaceConfiguration(
  folders: readonly WorkspaceFolderSnapshot[],
  path: string,
): boolean {
  const folder = workspaceFolderForPath(folders, path);
  if (folder === undefined) return false;
  const key = workspacePathKey(path);
  const directory = `${workspacePathKey(folder.path).replace(/\\+$/, "")}\\.sideral\\`;
  return key === `${directory}settings.json` || key === `${directory}workspace.json`;
}
