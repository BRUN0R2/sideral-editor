export type TerminalPanelView =
  | { readonly kind: "shell" }
  | { readonly kind: "extensionOutput"; readonly resourceId: string };

export type TerminalShellStatus = "exited" | "failed" | "running" | "starting" | "stopped";

export interface TerminalPanelState {
  readonly closedOutputIds: readonly string[];
  readonly mounted: boolean;
  readonly open: boolean;
  readonly shellVisible: boolean;
  readonly view: TerminalPanelView;
}

export type TerminalPanelAction =
  | { readonly kind: "close" }
  | {
      readonly kind: "closeView";
      readonly outputResourceIds: readonly string[];
      readonly view: TerminalPanelView;
    }
  | { readonly kind: "revealOutput"; readonly resourceId: string }
  | { readonly kind: "selectView"; readonly view: TerminalPanelView }
  | { readonly kind: "synchronizeOutputs"; readonly resourceIds: readonly string[] }
  | { readonly kind: "toggle" };

export const SHELL_TERMINAL_VIEW: TerminalPanelView = { kind: "shell" };

export const INITIAL_TERMINAL_PANEL_STATE: TerminalPanelState = {
  closedOutputIds: [],
  mounted: false,
  open: false,
  shellVisible: true,
  view: SHELL_TERMINAL_VIEW,
};

export function reduceTerminalPanel(
  state: TerminalPanelState,
  action: TerminalPanelAction,
): TerminalPanelState {
  switch (action.kind) {
    case "close":
      return state.open ? { ...state, open: false } : state;
    case "closeView":
      return closeTerminalPanelView(state, action.view, action.outputResourceIds);
    case "revealOutput":
      return {
        closedOutputIds: state.closedOutputIds.filter(
          (resourceId) => resourceId !== action.resourceId,
        ),
        mounted: true,
        open: true,
        shellVisible: state.shellVisible,
        view: { kind: "extensionOutput", resourceId: action.resourceId },
      };
    case "selectView": {
      const selectedOutputId =
        action.view.kind === "extensionOutput" ? action.view.resourceId : null;
      const closedOutputIds =
        selectedOutputId !== null
          ? state.closedOutputIds.filter((resourceId) => resourceId !== selectedOutputId)
          : state.closedOutputIds;
      return {
        closedOutputIds,
        mounted: true,
        open: true,
        shellVisible: action.view.kind === "shell" ? true : state.shellVisible,
        view: action.view,
      };
    }
    case "synchronizeOutputs":
      return synchronizeTerminalOutputs(state, action.resourceIds);
    case "toggle":
      return state.open
        ? { ...state, open: false }
        : {
            ...state,
            mounted: true,
            open: true,
            shellVisible: true,
            view: SHELL_TERMINAL_VIEW,
          };
  }
}

function closeTerminalPanelView(
  state: TerminalPanelState,
  view: TerminalPanelView,
  outputResourceIds: readonly string[],
): TerminalPanelState {
  const views = visibleTerminalPanelViews(state, outputResourceIds);
  const closedIndex = views.findIndex((candidate) => terminalViewsEqual(candidate, view));
  if (closedIndex < 0) {
    return state;
  }
  const nextState =
    view.kind === "shell"
      ? { ...state, shellVisible: false }
      : { ...state, closedOutputIds: [...state.closedOutputIds, view.resourceId] };
  if (!terminalViewsEqual(state.view, view)) {
    return nextState;
  }
  const remainingViews = visibleTerminalPanelViews(nextState, outputResourceIds);
  const nextView = remainingViews[Math.min(closedIndex, remainingViews.length - 1)] ?? null;
  return {
    ...nextState,
    open: nextView !== null,
    view: nextView ?? SHELL_TERMINAL_VIEW,
  };
}

function synchronizeTerminalOutputs(
  state: TerminalPanelState,
  resourceIds: readonly string[],
): TerminalPanelState {
  const liveResourceIds = new Set(resourceIds);
  const closedOutputIds = state.closedOutputIds.filter((resourceId) =>
    liveResourceIds.has(resourceId),
  );
  const closedIdsChanged = closedOutputIds.length !== state.closedOutputIds.length;
  const selectedOutputUnavailable =
    state.view.kind === "extensionOutput" && !liveResourceIds.has(state.view.resourceId);
  if (!closedIdsChanged && !selectedOutputUnavailable) {
    return state;
  }
  const synchronized = closedIdsChanged ? { ...state, closedOutputIds } : state;
  if (!selectedOutputUnavailable) {
    return synchronized;
  }
  const nextView = visibleTerminalPanelViews(synchronized, resourceIds)[0] ?? null;
  return {
    ...synchronized,
    open: synchronized.open && nextView !== null,
    view: nextView ?? SHELL_TERMINAL_VIEW,
  };
}

function visibleTerminalPanelViews(
  state: TerminalPanelState,
  outputResourceIds: readonly string[],
): readonly TerminalPanelView[] {
  const views: TerminalPanelView[] = [];
  if (state.shellVisible) {
    views.push(SHELL_TERMINAL_VIEW);
  }
  for (const resourceId of outputResourceIds) {
    if (!state.closedOutputIds.includes(resourceId)) {
      views.push({ kind: "extensionOutput", resourceId });
    }
  }
  return views;
}

function terminalViewsEqual(left: TerminalPanelView, right: TerminalPanelView): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "shell" ||
      (right.kind === "extensionOutput" && left.resourceId === right.resourceId))
  );
}
