import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ProductIcon } from "../../components/ProductIcon";
import { TabCloseButton } from "../../components/TabCloseButton";
import { useI18n } from "../i18n/I18nProvider";
import type { OutputChannelView } from "../sideral-extensions/contracts";
import {
  SHELL_TERMINAL_VIEW,
  type TerminalPanelView,
  type TerminalShellStatus,
} from "./panel-state";

export const TERMINAL_SHELL_PANEL_ID = "terminal-shell-panel";
export const TERMINAL_SHELL_TAB_ID = "terminal-shell-tab";

interface TerminalPanelTabsProps {
  readonly outputs: readonly OutputChannelView[];
  readonly shellFallbackReason: string | null;
  readonly shellName: string | null;
  readonly shellStatus: TerminalShellStatus;
  readonly shellVisible: boolean;
  readonly shellWorkingDirectory: string | null;
  readonly view: TerminalPanelView;
  readonly onCloseView: (view: TerminalPanelView) => void;
  readonly onSelectView: (view: TerminalPanelView) => void;
}

export function TerminalPanelTabs({
  outputs,
  shellFallbackReason,
  shellName,
  shellStatus,
  shellVisible,
  shellWorkingDirectory,
  view,
  onCloseView,
  onSelectView,
}: TerminalPanelTabsProps) {
  const { t } = useI18n();
  const shellSelected = view.kind === "shell";
  const baseShellLabel = shellName ?? t("terminal.shell");
  const shellLabel =
    shellName !== null && shellFallbackReason !== null
      ? t("terminal.shellFallbackLabel", { shell: shellName })
      : baseShellLabel;
  const shellTitle =
    shellFallbackReason === null
      ? (shellWorkingDirectory ?? undefined)
      : shellWorkingDirectory === null
        ? t("terminal.shellFallbackReason", { reason: shellFallbackReason })
        : `${t("terminal.shellFallbackReason", { reason: shellFallbackReason })}\n${shellWorkingDirectory}`;
  return (
    <div className="terminal-panel__tabs" role="tablist" aria-label={t("terminal.views")}>
      {shellVisible ? (
        <div
          className={`workbench-tab terminal-panel__tab ${shellSelected ? "workbench-tab--active" : ""}`}
        >
          <button
            id={TERMINAL_SHELL_TAB_ID}
            type="button"
            className="workbench-tab__main"
            role="tab"
            aria-controls={TERMINAL_SHELL_PANEL_ID}
            aria-selected={shellSelected}
            tabIndex={shellSelected ? 0 : -1}
            title={shellTitle}
            onClick={() => onSelectView(SHELL_TERMINAL_VIEW)}
            onKeyDown={handleTerminalTabKeyDown}
          >
            <span className={`terminal-panel__state terminal-panel__state--${shellStatus}`} />
            <ProductIcon name="terminal" />
            <span>{shellLabel}</span>
          </button>
          <TabCloseButton label={shellLabel} onClose={() => onCloseView(SHELL_TERMINAL_VIEW)} />
        </div>
      ) : null}
      {outputs.map((output) => {
        const outputView = {
          kind: "extensionOutput",
          resourceId: output.resourceId,
        } satisfies TerminalPanelView;
        const selected = view.kind === "extensionOutput" && view.resourceId === output.resourceId;
        return (
          <div
            key={output.resourceId}
            className={`workbench-tab terminal-panel__tab ${selected ? "workbench-tab--active" : ""}`}
          >
            <button
              id={terminalOutputTabId(output.resourceId)}
              type="button"
              className="workbench-tab__main"
              role="tab"
              aria-controls={terminalOutputPanelId(output.resourceId)}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={`${output.extensionId} · ${output.name}`}
              onClick={() => onSelectView(outputView)}
              onKeyDown={handleTerminalTabKeyDown}
            >
              <ProductIcon name="extensions" />
              <span>{output.name}</span>
            </button>
            <TabCloseButton label={output.name} onClose={() => onCloseView(outputView)} />
          </div>
        );
      })}
    </div>
  );
}

export function terminalOutputTabId(resourceId: string): string {
  return `terminal-output-tab-${resourceId}`;
}

export function terminalOutputPanelId(resourceId: string): string {
  return `terminal-output-panel-${resourceId}`;
}

function handleTerminalTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowRight":
    case "Home":
    case "End":
      break;
    default:
      return;
  }
  const tabList = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
  if (tabList === null) {
    return;
  }
  const tabs = [...tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length === 0) {
    return;
  }
  event.preventDefault();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}
