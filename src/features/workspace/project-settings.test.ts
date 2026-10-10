import { describe, expect, it } from "vitest";
import type { WorkspaceFolderSnapshot } from "../../lib/contracts";
import {
  documentAutoSave,
  editorSettings,
  isWorkspaceConfiguration,
  workspaceFolderForPath,
} from "./project-settings";

const folders: readonly WorkspaceFolderSnapshot[] = [
  {
    path: "C:\\work\\api",
    name: "API",
    available: true,
    workspaceFile: null,
    settings: {
      schemaVersion: 1,
      editor: { tabSize: 2, wordWrap: "on" },
      files: { autoSave: "off" },
    },
  },
  {
    path: "C:\\work\\web",
    name: "Web",
    available: true,
    workspaceFile: null,
    settings: {
      schemaVersion: 1,
      editor: { tabSize: 8, insertSpaces: false },
      files: { autoSave: "afterDelay" },
    },
  },
];

describe("project configuration scope", () => {
  it("selects the owner by path boundary and longest matching root", () => {
    expect(workspaceFolderForPath(folders, "c:/WORK/api/src/main.ts")).toBe(folders[0]);
    expect(workspaceFolderForPath(folders, "C:\\work\\api-old\\main.ts")).toBeUndefined();
    expect(workspaceFolderForPath(folders, null)).toBeUndefined();
    const nested = { ...folders[1], path: "C:\\work\\api\\nested" };
    expect(workspaceFolderForPath([...folders, nested], "C:\\work\\api\\nested\\main.ts")).toBe(
      nested,
    );
  });

  it("preserves case-sensitive folder ownership on Unix paths", () => {
    const roots = [{ path: "/projects/API" }, { path: "/projects/api" }];
    expect(workspaceFolderForPath(roots, "/projects/api/main.ts")).toBe(roots[1]);
    expect(workspaceFolderForPath(roots, "/projects/APIs/main.ts")).toBeUndefined();
  });

  it("inherits defaults without leaking another project's preferences", () => {
    expect(editorSettings(folders[0]?.settings)).toEqual({
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "on",
    });
    expect(editorSettings(folders[1]?.settings)).toEqual({
      tabSize: 8,
      insertSpaces: false,
      wordWrap: "off",
    });
    expect(editorSettings()).toEqual({ tabSize: 4, insertSpaces: true, wordWrap: "off" });
  });

  it("honors per-document auto-save and inherits the user setting outside roots", () => {
    expect(documentAutoSave(folders, "C:/work/api/main.ts", "afterDelay")).toBe("off");
    expect(documentAutoSave(folders, "C:/work/web/main.ts", "off")).toBe("afterDelay");
    expect(documentAutoSave(folders, "C:/other/main.ts", "afterDelay")).toBe("afterDelay");
    expect(documentAutoSave(folders, null, "off")).toBe("off");
  });

  it("refreshes only the configuration belonging to a workspace root", () => {
    expect(isWorkspaceConfiguration(folders, "c:/work/API/.sideral/settings.json")).toBe(true);
    expect(isWorkspaceConfiguration(folders, "C:/work/api/.sideral/workspace.json")).toBe(true);
    expect(isWorkspaceConfiguration(folders, "C:/work/api/vendor/.sideral/settings.json")).toBe(
      false,
    );
    expect(isWorkspaceConfiguration(folders, "C:/other/.sideral/settings.json")).toBe(false);
  });
});
