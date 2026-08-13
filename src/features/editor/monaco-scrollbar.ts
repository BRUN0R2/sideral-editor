import type { editor } from "monaco-editor";
import type { ResolvedScrollbarTheme } from "../../theme/scrollbar";

export function monacoScrollbarOptions(
  theme: ResolvedScrollbarTheme,
): editor.IEditorScrollbarOptions {
  return {
    vertical: "visible",
    horizontal: "visible",
    verticalHasArrows: theme.showButtons,
    horizontalHasArrows: false,
    arrowSize: theme.buttonSize,
    useShadows: false,
    verticalScrollbarSize: theme.trackSize,
    horizontalScrollbarSize: theme.trackSize,
    verticalSliderSize: theme.thumbSize,
    horizontalSliderSize: theme.thumbSize,
  };
}

export function monacoScrollbarColors(
  theme: ResolvedScrollbarTheme,
): Readonly<Record<string, string>> {
  return {
    "scrollbar.background": theme.trackColor,
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": theme.thumbColor,
    "scrollbarSlider.hoverBackground": theme.thumbHoverColor,
    "scrollbarSlider.activeBackground": theme.thumbActiveColor,
  };
}
