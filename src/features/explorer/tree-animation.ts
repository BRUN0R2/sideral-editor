import type { WorkspaceNode } from "../workspace/types";

const MIN_DURATION_MS = 200;
const MAX_DURATION_MS = 440;
const BASE_DURATION_MS = 164;
const DURATION_PER_VISIBLE_ROW_MS = 12;
const MAX_FADE_DURATION_MS = 220;
const FADE_DURATION_OFFSET_MS = 60;

export interface TreeChildrenAnimationTiming {
  readonly durationMs: number;
  readonly fadeDurationMs: number;
}

export function getTreeChildrenAnimationTiming(
  children: readonly WorkspaceNode[] | null,
): TreeChildrenAnimationTiming {
  const visibleRows = countVisibleRows(children);
  const durationMs = Math.min(
    MAX_DURATION_MS,
    Math.max(MIN_DURATION_MS, BASE_DURATION_MS + visibleRows * DURATION_PER_VISIBLE_ROW_MS),
  );

  return {
    durationMs,
    fadeDurationMs: Math.min(MAX_FADE_DURATION_MS, durationMs - FADE_DURATION_OFFSET_MS),
  };
}

function countVisibleRows(nodes: readonly WorkspaceNode[] | null): number {
  if (nodes === null || nodes.length === 0) {
    return 1;
  }

  return nodes.reduce((total, node) => {
    const nestedRows =
      node.kind === "directory" && node.expanded && node.children !== null
        ? countVisibleRows(node.children)
        : 0;
    return total + 1 + nestedRows;
  }, 0);
}
