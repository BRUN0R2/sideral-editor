import { describe, expect, it } from "vitest";
import type { LocaleBundle, LocaleSelection } from "../../lib/contracts";
import { localeSelectionsEqual } from "./locale-selection";

describe("localeSelectionsEqual", () => {
  it("recognizes equivalent selections returned by a native refresh", () => {
    expect(localeSelectionsEqual(createSelection("Close"), createSelection("Close"))).toBe(true);
  });

  it("detects changed translations", () => {
    expect(localeSelectionsEqual(createSelection("Close"), createSelection("Dismiss"))).toBe(false);
  });

  it("detects changed validation issues", () => {
    const current = createSelection("Close");
    const changed: LocaleSelection = {
      ...current,
      catalog: {
        ...current.catalog,
        issues: [{ file: "custom.json", reason: "invalid schema" }],
      },
    };

    expect(localeSelectionsEqual(current, changed)).toBe(false);
  });
});

function createSelection(closeLabel: string): LocaleSelection {
  const bundle: LocaleBundle = {
    locale: "en",
    name: "English",
    direction: "ltr",
    builtIn: true,
    messages: { "action.close": closeLabel } as LocaleBundle["messages"],
  };
  return {
    preference: "system",
    active: bundle,
    unavailablePreference: null,
    catalog: {
      directory: "locales",
      locales: [bundle],
      issues: [],
    },
  };
}
