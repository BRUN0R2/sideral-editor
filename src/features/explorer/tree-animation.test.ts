import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "../workspace/types";
import { getTreeChildrenAnimationTiming } from "./tree-animation";

describe("tree children animation timing", () => {
  it("keeps the original compact timing for a small folder", () => {
    expect(getTreeChildrenAnimationTiming(files(3))).toEqual({
      durationMs: 200,
      fadeDurationMs: 140,
    });
  });

  it("gives taller folders more time to expand", () => {
    const small = getTreeChildrenAnimationTiming(files(3));
    const large = getTreeChildrenAnimationTiming(files(20));

    expect(large).toEqual({ durationMs: 404, fadeDurationMs: 220 });
    expect(large.durationMs).toBeGreaterThan(small.durationMs);
  });

  it("counts expanded descendants and ignores collapsed descendants", () => {
    const nestedChildren = files(20);
    const collapsed = [directory("folder", nestedChildren, false)];
    const expanded = [directory("folder", nestedChildren, true)];

    expect(getTreeChildrenAnimationTiming(collapsed).durationMs).toBe(200);
    expect(getTreeChildrenAnimationTiming(expanded).durationMs).toBe(416);
  });

  it("caps very large folders so the interaction remains responsive", () => {
    expect(getTreeChildrenAnimationTiming(files(100))).toEqual({
      durationMs: 440,
      fadeDurationMs: 220,
    });
  });
});

function files(count: number): readonly WorkspaceNode[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `file-${index}.txt`,
    name: `file-${index}.txt`,
    kind: "file" as const,
    expanded: false,
    loading: false,
    children: null,
  }));
}

function directory(
  name: string,
  children: readonly WorkspaceNode[],
  expanded: boolean,
): WorkspaceNode {
  return {
    path: name,
    name,
    kind: "directory",
    expanded,
    loading: false,
    children,
  };
}
