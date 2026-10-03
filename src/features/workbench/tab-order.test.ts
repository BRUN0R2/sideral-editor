import { describe, expect, it } from "vitest";
import { reorderTabAt, synchronizeTabOrder } from "./tab-order";

const tabs = ["document:alpha", "resource:settings", "document:beta", "resource:extension:hello"];

describe("reorderTabAt", () => {
  it("moves documents across resource tabs in both directions", () => {
    expect(reorderTabAt(tabs, "document:alpha", 3)).toEqual([
      "resource:settings",
      "document:beta",
      "document:alpha",
      "resource:extension:hello",
    ]);
    expect(reorderTabAt(tabs, "document:beta", 1)).toEqual([
      "document:alpha",
      "document:beta",
      "resource:settings",
      "resource:extension:hello",
    ]);
  });

  it("moves settings and extension tabs to either end", () => {
    expect(reorderTabAt(tabs, "resource:settings", tabs.length)).toEqual([
      "document:alpha",
      "document:beta",
      "resource:extension:hello",
      "resource:settings",
    ]);
    expect(reorderTabAt(tabs, "resource:extension:hello", 0)).toEqual([
      "resource:extension:hello",
      "document:alpha",
      "resource:settings",
      "document:beta",
    ]);
  });

  it("preserves the order for adjacent insertion points and unknown tabs", () => {
    expect(reorderTabAt(tabs, "resource:settings", 1)).toBe(tabs);
    expect(reorderTabAt(tabs, "resource:settings", 2)).toBe(tabs);
    expect(reorderTabAt(tabs, "missing", 0)).toBe(tabs);
  });
});

describe("synchronizeTabOrder", () => {
  it("keeps the mixed order when document data or source ordering changes", () => {
    expect(
      synchronizeTabOrder(tabs, [
        "document:alpha",
        "document:beta",
        "resource:settings",
        "resource:extension:hello",
      ]),
    ).toBe(tabs);
  });

  it("removes closed tabs and appends new and reopened tabs", () => {
    const availableIds = ["document:alpha", "document:beta", "document:gamma"];
    const afterClose = synchronizeTabOrder(tabs, availableIds);
    expect(afterClose).toEqual(["document:alpha", "document:beta", "document:gamma"]);
    expect(synchronizeTabOrder(afterClose, ["resource:settings", ...availableIds])).toEqual([
      "document:alpha",
      "document:beta",
      "document:gamma",
      "resource:settings",
    ]);
    expect(synchronizeTabOrder(tabs, [])).toEqual([]);
  });

  it("keeps document and resource identities distinct", () => {
    expect(synchronizeTabOrder([], ["document:settings", "resource:settings"])).toEqual([
      "document:settings",
      "resource:settings",
    ]);
  });
});
