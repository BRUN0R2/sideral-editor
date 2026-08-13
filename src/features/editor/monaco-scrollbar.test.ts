import { describe, expect, it } from "vitest";
import type { ResolvedScrollbarTheme } from "../../theme/scrollbar";
import { monacoScrollbarColors, monacoScrollbarOptions } from "./monaco-scrollbar";

const THEME: ResolvedScrollbarTheme = {
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
};

describe("Monaco scrollbar adapter", () => {
  it("maps shared geometry only through Monaco's public options", () => {
    expect(monacoScrollbarOptions(THEME)).toEqual({
      vertical: "visible",
      horizontal: "visible",
      verticalHasArrows: true,
      horizontalHasArrows: false,
      arrowSize: 22,
      useShadows: false,
      verticalScrollbarSize: 14,
      horizontalScrollbarSize: 14,
      verticalSliderSize: 10,
      horizontalSliderSize: 10,
    });
  });

  it("maps every interactive color state", () => {
    expect(monacoScrollbarColors(THEME)).toEqual({
      "scrollbar.background": "#00000000",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#4f5661",
      "scrollbarSlider.hoverBackground": "#69717d",
      "scrollbarSlider.activeBackground": "#7b8491",
    });
  });
});
