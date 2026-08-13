import { describe, expect, it } from "vitest";
import {
  readScrollbarTheme,
  SCROLLBAR_CSS_VARIABLES,
  scrollbarCustomProperties,
} from "./scrollbar";

const DEFAULT_VALUES: Readonly<Record<string, string>> = {
  [SCROLLBAR_CSS_VARIABLES.trackSize]: "14px",
  [SCROLLBAR_CSS_VARIABLES.thumbSize]: "10px",
  [SCROLLBAR_CSS_VARIABLES.trackColor]: "#00000000",
  [SCROLLBAR_CSS_VARIABLES.thumbColor]: "#4f5661",
  [SCROLLBAR_CSS_VARIABLES.thumbHoverColor]: "#69717d",
  [SCROLLBAR_CSS_VARIABLES.thumbActiveColor]: "#7b8491",
  [SCROLLBAR_CSS_VARIABLES.buttonDisplay]: "block",
  [SCROLLBAR_CSS_VARIABLES.buttonSize]: "22px",
  [SCROLLBAR_CSS_VARIABLES.arrowSize]: "11px",
  [SCROLLBAR_CSS_VARIABLES.arrowHeight]: "6px",
  [SCROLLBAR_CSS_VARIABLES.arrowColor]: "#69717d",
  [SCROLLBAR_CSS_VARIABLES.arrowHoverColor]: "#929aa6",
  [SCROLLBAR_CSS_VARIABLES.arrowActiveColor]: "#c2c7cf",
  [SCROLLBAR_CSS_VARIABLES.cornerRadius]: "999px",
};

describe("scrollbar theme contract", () => {
  it("resolves the complete CSS token contract", () => {
    expect(readScrollbarTheme(propertyReader(DEFAULT_VALUES))).toEqual({
      trackSize: 14,
      thumbSize: 10,
      trackColor: "#00000000",
      thumbColor: "#4f5661",
      thumbHoverColor: "#69717d",
      thumbActiveColor: "#7b8491",
      showButtons: true,
      buttonSize: 22,
      arrowSize: 11,
      arrowHeight: 6,
      arrowColor: "#69717d",
      arrowHoverColor: "#929aa6",
      arrowActiveColor: "#c2c7cf",
      cornerRadius: 999,
    });
  });

  it("rejects missing, relative and incompatible geometry", () => {
    expect(() =>
      readScrollbarTheme(
        propertyReader({ ...DEFAULT_VALUES, [SCROLLBAR_CSS_VARIABLES.thumbColor]: "" }),
      ),
    ).toThrow("Required scrollbar token is missing");
    expect(() =>
      readScrollbarTheme(
        propertyReader({ ...DEFAULT_VALUES, [SCROLLBAR_CSS_VARIABLES.trackSize]: "1rem" }),
      ),
    ).toThrow("absolute pixel value");
    expect(() =>
      readScrollbarTheme(
        propertyReader({ ...DEFAULT_VALUES, [SCROLLBAR_CSS_VARIABLES.thumbSize]: "16px" }),
      ),
    ).toThrow("thumb size");
    expect(() =>
      readScrollbarTheme(
        propertyReader({ ...DEFAULT_VALUES, [SCROLLBAR_CSS_VARIABLES.arrowSize]: "16px" }),
      ),
    ).toThrow("arrow size");
    expect(() =>
      readScrollbarTheme(
        propertyReader({ ...DEFAULT_VALUES, [SCROLLBAR_CSS_VARIABLES.arrowHeight]: "12px" }),
      ),
    ).toThrow("arrow height");
    expect(() =>
      readScrollbarTheme(
        propertyReader({ ...DEFAULT_VALUES, [SCROLLBAR_CSS_VARIABLES.buttonDisplay]: "flex" }),
      ),
    ).toThrow("must be block or none");
  });

  it("converts a scoped override into namespaced custom properties", () => {
    expect(
      scrollbarCustomProperties({
        trackSize: 16,
        thumbSize: 10,
        trackColor: "transparent",
        thumbColor: "#8b5cf6",
        thumbHoverColor: "#a78bfa",
        thumbActiveColor: "#c4b5fd",
        showButtons: false,
        buttonSize: 18,
        arrowSize: 10,
        arrowHeight: 5,
        arrowColor: "#ddd6fe",
        arrowHoverColor: "#ede9fe",
        arrowActiveColor: "#ffffff",
        cornerRadius: 12,
      }),
    ).toEqual({
      "--sideral-scrollbar-track-size": "16px",
      "--sideral-scrollbar-thumb-size": "10px",
      "--sideral-scrollbar-track-color": "transparent",
      "--sideral-scrollbar-thumb-color": "#8b5cf6",
      "--sideral-scrollbar-thumb-hover-color": "#a78bfa",
      "--sideral-scrollbar-thumb-active-color": "#c4b5fd",
      "--sideral-scrollbar-button-display": "none",
      "--sideral-scrollbar-button-size": "18px",
      "--sideral-scrollbar-arrow-size": "10px",
      "--sideral-scrollbar-arrow-height": "5px",
      "--sideral-scrollbar-arrow-color": "#ddd6fe",
      "--sideral-scrollbar-arrow-hover-color": "#ede9fe",
      "--sideral-scrollbar-arrow-active-color": "#ffffff",
      "--sideral-scrollbar-corner-radius": "12px",
    });
  });

  it("clamps an inherited arrow when a scoped track becomes narrower", () => {
    expect(scrollbarCustomProperties({ trackSize: 8 })).toMatchObject({
      "--sideral-scrollbar-track-size": "8px",
      "--sideral-scrollbar-thumb-size": "8px",
      "--sideral-scrollbar-arrow-size": "8px",
    });
  });

  it("keeps breathing room around the host arrow shape", () => {
    const theme = readScrollbarTheme(propertyReader(DEFAULT_VALUES));
    expect((theme.buttonSize - theme.arrowHeight) / 2).toBeGreaterThanOrEqual(8);
    expect(theme.arrowSize - theme.thumbSize).toBeLessThanOrEqual(1);
  });
});

function propertyReader(values: Readonly<Record<string, string>>) {
  return {
    getPropertyValue(name: string): string {
      return values[name] ?? "";
    },
  };
}
