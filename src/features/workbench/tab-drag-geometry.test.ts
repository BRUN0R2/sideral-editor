import { describe, expect, it } from "vitest";
import { hasTabDragStarted, isTabDropAllowed, tabDragScrollDirection } from "./tab-drag-geometry";

const bounds = { left: 100, right: 600, top: 30, bottom: 80 };

describe("tab drag boundaries", () => {
  it("allows the visible strip and blocks every outside edge", () => {
    expect(isTabDropAllowed({ x: bounds.left, y: bounds.top }, bounds)).toBe(true);
    expect(isTabDropAllowed({ x: bounds.right, y: bounds.bottom }, bounds)).toBe(true);
    for (const pointer of [
      { x: bounds.left - 1, y: 50 },
      { x: bounds.right + 1, y: 50 },
      { x: 300, y: bounds.top - 1 },
      { x: 300, y: bounds.bottom + 1 },
    ]) {
      expect(isTabDropAllowed(pointer, bounds)).toBe(false);
      expect(tabDragScrollDirection(pointer, bounds)).toBe(0);
    }
  });

  it("keeps click jitter separate from an intentional drag", () => {
    expect(hasTabDragStarted({ x: 100, y: 50 }, { x: 102, y: 52 })).toBe(false);
    expect(hasTabDragStarted({ x: 100, y: 50 }, { x: 110, y: 50 })).toBe(true);
    expect(hasTabDragStarted({ x: 100, y: 50 }, { x: 100, y: 60 })).toBe(true);
  });

  it("scrolls only at the horizontal edges inside the strip", () => {
    expect(tabDragScrollDirection({ x: 110, y: 50 }, bounds)).toBe(-1);
    expect(tabDragScrollDirection({ x: 590, y: 50 }, bounds)).toBe(1);
    expect(tabDragScrollDirection({ x: 350, y: 50 }, bounds)).toBe(0);
  });
});
