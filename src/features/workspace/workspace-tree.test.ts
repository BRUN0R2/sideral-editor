import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "./types";
import {
  findWorkspaceNode,
  insertWorkspaceFile,
  toWorkspaceNodes,
  updateWorkspaceNode,
  workspaceFileName,
  workspacePathKey,
} from "./workspace-tree";

const nestedFile: WorkspaceNode = {
  path: "C:\\project\\src\\index.ts",
  name: "index.ts",
  kind: "file",
  expanded: false,
  loading: false,
  children: null,
};

const tree: readonly WorkspaceNode[] = [
  {
    path: "C:\\project\\src",
    name: "src",
    kind: "directory",
    expanded: true,
    loading: false,
    children: [nestedFile],
  },
];

describe("workspace tree", () => {
  it("creates closed, unloaded nodes from directory entries", () => {
    expect(
      toWorkspaceNodes([{ path: "C:\\project\\src", name: "src", kind: "directory" }]),
    ).toEqual([
      {
        path: "C:\\project\\src",
        name: "src",
        kind: "directory",
        expanded: false,
        loading: false,
        children: null,
      },
    ]);
  });

  it("inserts files deterministically and ignores normalized duplicates", () => {
    const nodes = toWorkspaceNodes([
      { path: "C:\\project\\z-link", name: "z-link", kind: "symbolicLink" },
      { path: "C:\\project\\src", name: "src", kind: "directory" },
      { path: "C:\\project\\z.ts", name: "z.ts", kind: "file" },
    ]);
    const inserted = insertWorkspaceFile(nodes, "C:\\project\\A.ts", "A.ts");

    expect(inserted.map((node) => node.name)).toEqual(["src", "A.ts", "z.ts", "z-link"]);
    expect(insertWorkspaceFile(inserted, "c:/PROJECT/a.ts", "a.ts")).toBe(inserted);
  });

  it("finds nested nodes and preserves identity for missing updates", () => {
    expect(findWorkspaceNode(tree, nestedFile.path)).toBe(nestedFile);
    expect(updateWorkspaceNode(tree, "C:\\missing", (node) => node)).toBe(tree);
  });

  it("clones only the changed branch", () => {
    const updated = updateWorkspaceNode(tree, nestedFile.path, (node) => ({
      ...node,
      loading: true,
    }));

    expect(updated).not.toBe(tree);
    expect(updated[0]).not.toBe(tree[0]);
    expect(updated[0]?.children?.[0]?.loading).toBe(true);
  });

  it("normalizes Windows path keys and extracts either separator style", () => {
    expect(workspacePathKey("C:/Project/SRC")).toBe("c:\\project\\src");
    expect(workspaceFileName("C:\\project/src/index.ts")).toBe("index.ts");
  });
});
