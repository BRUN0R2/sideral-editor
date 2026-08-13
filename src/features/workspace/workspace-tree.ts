import type { DirectoryEntry } from "../../lib/contracts";
import type { WorkspaceNode } from "./types";

export function toWorkspaceNodes(entries: readonly DirectoryEntry[]): readonly WorkspaceNode[] {
  return entries.map((entry) => ({
    ...entry,
    expanded: false,
    loading: false,
    children: null,
  }));
}

export function insertWorkspaceFile(
  nodes: readonly WorkspaceNode[],
  path: string,
  name: string,
): readonly WorkspaceNode[] {
  if (nodes.some((node) => workspacePathKey(node.path) === workspacePathKey(path))) {
    return nodes;
  }

  return [
    ...nodes,
    {
      path,
      name,
      kind: "file" as const,
      expanded: false,
      loading: false,
      children: null,
    },
  ].sort(compareWorkspaceNodes);
}

export function findWorkspaceNode(
  nodes: readonly WorkspaceNode[],
  path: string,
): WorkspaceNode | undefined {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    if (node.children !== null) {
      const child = findWorkspaceNode(node.children, path);
      if (child !== undefined) {
        return child;
      }
    }
  }
  return undefined;
}

export function updateWorkspaceNode(
  nodes: readonly WorkspaceNode[],
  path: string,
  update: (node: WorkspaceNode) => WorkspaceNode,
): readonly WorkspaceNode[] {
  let changed = false;
  const updatedNodes = nodes.map((node) => {
    if (node.path === path) {
      const updatedNode = update(node);
      changed ||= updatedNode !== node;
      return updatedNode;
    }
    if (node.children === null) {
      return node;
    }
    const children = updateWorkspaceNode(node.children, path, update);
    if (children === node.children) {
      return node;
    }
    changed = true;
    return { ...node, children };
  });
  return changed ? updatedNodes : nodes;
}

export function workspacePathKey(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

export function workspaceFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function compareWorkspaceNodes(left: WorkspaceNode, right: WorkspaceNode): number {
  const rankDifference = workspaceNodeRank(left) - workspaceNodeRank(right);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  const foldedDifference = compareText(left.name.toLowerCase(), right.name.toLowerCase());
  return foldedDifference !== 0 ? foldedDifference : compareText(left.name, right.name);
}

function workspaceNodeRank(node: WorkspaceNode): number {
  switch (node.kind) {
    case "directory":
      return 0;
    case "file":
      return 1;
    case "symbolicLink":
      return 2;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}
