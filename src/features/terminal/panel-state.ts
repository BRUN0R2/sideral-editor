export type TerminalPanelView =
  | { readonly kind: "shell" }
  | { readonly kind: "extensionOutput"; readonly resourceId: string };

export type TerminalShellStatus = "exited" | "failed" | "running" | "starting" | "stopped";

export interface TerminalPanelState {
  readonly mounted: boolean;
  readonly open: boolean;
  readonly view: TerminalPanelView;
}

export type TerminalPanelAction =
  | { readonly kind: "close" }
  | { readonly kind: "outputUnavailable"; readonly resourceId: string }
  | { readonly kind: "revealOutput"; readonly resourceId: string }
  | { readonly kind: "selectView"; readonly view: TerminalPanelView }
  | { readonly kind: "toggle" };

export const SHELL_TERMINAL_VIEW: TerminalPanelView = { kind: "shell" };

export const INITIAL_TERMINAL_PANEL_STATE: TerminalPanelState = {
  mounted: false,
  open: false,
  view: SHELL_TERMINAL_VIEW,
};

export function reduceTerminalPanel(
  state: TerminalPanelState,
  action: TerminalPanelAction,
): TerminalPanelState {
  switch (action.kind) {
    case "close":
      return state.open ? { ...state, open: false } : state;
    case "outputUnavailable":
      return state.view.kind === "extensionOutput" && state.view.resourceId === action.resourceId
        ? { ...state, open: false, view: SHELL_TERMINAL_VIEW }
        : state;
    case "revealOutput":
      return {
        mounted: true,
        open: true,
        view: { kind: "extensionOutput", resourceId: action.resourceId },
      };
    case "selectView":
      return { mounted: true, open: true, view: action.view };
    case "toggle":
      return state.open
        ? { ...state, open: false }
        : { mounted: true, open: true, view: SHELL_TERMINAL_VIEW };
  }
}
