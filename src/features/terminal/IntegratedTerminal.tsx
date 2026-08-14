import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  Dispatch,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";
import type { OutputChannelView } from "../sideral-extensions/contracts";
import { connectIntegratedTerminal, type IntegratedTerminalConnection } from "./backend";
import type { TerminalEvent, TerminalSessionSnapshot } from "./contracts";
import { ExtensionOutputView } from "./ExtensionOutputView";
import type { TerminalPanelView, TerminalShellStatus } from "./panel-state";
import {
  TERMINAL_SHELL_PANEL_ID,
  TERMINAL_SHELL_TAB_ID,
  TerminalPanelTabs,
} from "./TerminalPanelTabs";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const DEFAULT_PANEL_HEIGHT = 360;
const MAX_PENDING_INPUT_CODE_UNITS = 65_536;
const MAX_PANEL_HEIGHT = 620;
const MIN_PANEL_HEIGHT = 160;
const PANEL_HEIGHT_STEP = 24;
const WORKSPACE_PANEL_RATIO = 0.7;

interface IntegratedTerminalProps {
  readonly active: boolean;
  readonly outputs: readonly OutputChannelView[];
  readonly shellVisible: boolean;
  readonly view: TerminalPanelView;
  readonly workspaceRoot: string | null;
  readonly onClose: () => void;
  readonly onCloseView: (view: TerminalPanelView) => void;
  readonly onSelectView: (view: TerminalPanelView) => void;
}

interface TerminalRuntime {
  readonly fitAddon: FitAddon;
  readonly terminal: Terminal;
}

interface PanelResize {
  readonly initialHeight: number;
  readonly initialPointerY: number;
  readonly pointerId: number;
}

interface TerminalSessionRequest {
  readonly generation: number;
  readonly running: boolean;
}

export function IntegratedTerminal({
  active,
  outputs,
  shellVisible,
  view,
  workspaceRoot,
  onClose,
  onCloseView,
  onSelectView,
}: IntegratedTerminalProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const connectionRef = useRef<IntegratedTerminalConnection | null>(null);
  const lifecycleQueue = useRef<Promise<void>>(Promise.resolve());
  const panelResizeRef = useRef<PanelResize | null>(null);
  const translateRef = useRef(t);
  const [connected, setConnected] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [runtime, setRuntime] = useState<TerminalRuntime | null>(null);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [shellStarted, setShellStarted] = useState(view.kind === "shell");
  const [sessionRequest, setSessionRequest] = useState<TerminalSessionRequest>({
    generation: 0,
    running: true,
  });
  const [status, setStatus] = useState<TerminalShellStatus>("starting");
  const selectedOutput =
    view.kind === "extensionOutput"
      ? (outputs.find((output) => output.resourceId === view.resourceId) ?? null)
      : null;
  const shellSelected = view.kind === "shell";
  translateRef.current = t;

  const reportFailure = useCallback((error: unknown) => {
    const message = toApplicationError(error).message;
    setFailure(message);
    setStatus("failed");
  }, []);

  useEffect(() => {
    if (active && shellSelected) {
      setShellStarted(true);
      setSessionRequest((current) =>
        current.running ? current : { generation: current.generation + 1, running: true },
      );
    }
  }, [active, shellSelected]);

  useEffect(() => {
    if (!shellStarted) {
      return;
    }
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const styles = getComputedStyle(container);
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: "block",
      drawBoldTextInBrightColors: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      scrollback: 5_000,
      smoothScrollDuration: 0,
      theme: {
        background: cssColor(styles, "--bg-panel", "#21252b"),
        cursor: cssColor(styles, "--text", "#c8ccd4"),
        cursorAccent: cssColor(styles, "--bg-panel", "#21252b"),
        foreground: cssColor(styles, "--text", "#c8ccd4"),
        selectionBackground: cssColor(styles, "--selection", "#3e4451"),
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    const ownedRuntime = { fitAddon, terminal } satisfies TerminalRuntime;
    setRuntime(ownedRuntime);

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitTerminal(ownedRuntime, container);
      } catch (error: unknown) {
        reportFailure(error);
      }
    });
    resizeObserver.observe(container);
    fitTerminal(ownedRuntime, container);

    return () => {
      resizeObserver.disconnect();
      setRuntime((current) => (current === ownedRuntime ? null : current));
      terminal.dispose();
    };
  }, [reportFailure, shellStarted]);

  useEffect(() => {
    if (runtime === null || !sessionRequest.running) {
      return;
    }
    let cancelled = false;
    let release: (() => void) | null = null;

    const runLifecycle = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      setConnected(false);
      setFailure(null);
      setSession(null);
      setStatus("starting");
      runtime.terminal.reset();
      const container = containerRef.current;
      if (container !== null) {
        fitTerminal(runtime, container);
      }

      let boundaryFailure: unknown | null = null;
      let connection: IntegratedTerminalConnection | null = null;
      let pendingDimensions: { readonly columns: number; readonly rows: number } | null = null;
      let pendingInput = "";
      let processRunning = true;
      let terminalEnded = false;
      const handleBoundaryFailure = (error: unknown): void => {
        if (cancelled) {
          return;
        }
        processRunning = false;
        boundaryFailure ??= error;
        reportFailure(error);
        release?.();
      };
      const handleEvent = (event: TerminalEvent): void => {
        if (cancelled) {
          return;
        }
        if (event.kind === "failure") {
          processRunning = false;
          handleBoundaryFailure(new Error(event.message));
          return;
        }
        processRunning = false;
        terminalEnded = true;
        setStatus("exited");
        runtime.terminal.writeln(
          `\r\n${translateRef.current("terminal.exited", { code: event.exitCode })}`,
        );
        release?.();
      };

      const input = runtime.terminal.onData((data) => {
        if (cancelled || !processRunning) {
          return;
        }
        if (connection === null) {
          if (pendingInput.length + data.length > MAX_PENDING_INPUT_CODE_UNITS) {
            handleBoundaryFailure(new Error(translateRef.current("terminal.startupInputLimit")));
            return;
          }
          pendingInput += data;
          return;
        }
        void connection.write(data).catch(handleBoundaryFailure);
      });
      const resize = runtime.terminal.onResize(({ cols, rows }) => {
        if (cancelled || !processRunning) {
          return;
        }
        const dimensions = { columns: cols, rows } as const;
        if (connection === null) {
          pendingDimensions = dimensions;
          return;
        }
        void connection.resize(dimensions).catch(handleBoundaryFailure);
      });

      try {
        connection = await connectIntegratedTerminal(
          {
            workspaceRoot,
            columns: runtime.terminal.cols,
            rows: runtime.terminal.rows,
          },
          (output) => {
            if (!cancelled) {
              runtime.terminal.write(output);
            }
          },
          handleEvent,
          handleBoundaryFailure,
        );
        if (cancelled || boundaryFailure !== null || terminalEnded) {
          return;
        }

        const startupInput = pendingInput;
        pendingInput = "";
        if (startupInput.length > 0) {
          await connection.write(startupInput);
        }
        const startupDimensions = pendingDimensions;
        pendingDimensions = null;
        if (startupDimensions !== null) {
          await connection.resize(startupDimensions);
        }
        if (cancelled || boundaryFailure !== null || terminalEnded) {
          return;
        }

        connectionRef.current = connection;
        setConnected(true);
        setSession(connection.snapshot);
        setStatus("running");
        await new Promise<void>((resolve) => {
          release = resolve;
          if (cancelled || terminalEnded) {
            resolve();
          }
        });
      } finally {
        processRunning = false;
        input.dispose();
        resize.dispose();
        if (connection !== null) {
          if (connectionRef.current === connection) {
            connectionRef.current = null;
          }
          await connection.dispose();
        }
        if (!cancelled) {
          setConnected(false);
        }
      }
    };

    const lifecycle = lifecycleQueue.current.then(runLifecycle).catch((error: unknown) => {
      if (cancelled) {
        console.error("The integrated terminal failed to shut down cleanly.", error);
      } else {
        reportFailure(error);
      }
    });
    lifecycleQueue.current = lifecycle;

    return () => {
      cancelled = true;
      release?.();
    };
  }, [reportFailure, runtime, sessionRequest, workspaceRoot]);

  useEffect(() => {
    if (!active || !shellSelected || !connected || runtime === null) {
      return;
    }
    const animationFrame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container !== null) {
        try {
          fitTerminal(runtime, container);
          runtime.terminal.focus();
        } catch (error: unknown) {
          reportFailure(error);
        }
      }
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [active, connected, reportFailure, runtime, shellSelected]);

  const restart = () => {
    setSessionRequest((current) => ({
      generation: current.generation + 1,
      running: true,
    }));
  };
  const stop = () => {
    setSessionRequest((current) => ({ ...current, running: false }));
    setConnected(false);
    setStatus("stopped");
  };
  const closeView = (closedView: TerminalPanelView) => {
    if (closedView.kind === "shell") {
      stop();
    }
    onCloseView(closedView);
  };
  const statusMessage = terminalStatusMessage(status, failure, t);

  return (
    <section
      className="terminal-panel"
      hidden={!active}
      style={{ height: panelHeight }}
      aria-label={t("terminal.title")}
    >
      <hr
        className="terminal-panel__resize-handle"
        aria-label={t("terminal.resize")}
        aria-orientation="horizontal"
        aria-valuemax={MAX_PANEL_HEIGHT}
        aria-valuemin={MIN_PANEL_HEIGHT}
        aria-valuenow={panelHeight}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setPanelHeight((height) => clampPanelHeight(height + PANEL_HEIGHT_STEP));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setPanelHeight((height) => clampPanelHeight(height - PANEL_HEIGHT_STEP));
          }
        }}
        onPointerDown={(event) => beginPanelResize(event, panelHeight, panelResizeRef)}
        onPointerMove={(event) => updatePanelResize(event, panelResizeRef, setPanelHeight)}
        onPointerUp={(event) => endPanelResize(event, panelResizeRef)}
        onPointerCancel={(event) => endPanelResize(event, panelResizeRef)}
      />
      <header className="terminal-panel__header">
        <TerminalPanelTabs
          outputs={outputs}
          shellName={session?.shellName ?? null}
          shellStatus={status}
          shellVisible={shellVisible}
          shellWorkingDirectory={session?.workingDirectory ?? null}
          view={view}
          onCloseView={closeView}
          onSelectView={onSelectView}
        />
        <div className="terminal-panel__actions">
          {shellSelected ? (
            <>
              <IconButton
                className="terminal-panel__action"
                label={t("terminal.clear")}
                icon="clearAll"
                disabled={runtime === null}
                onClick={() => runtime?.terminal.clear()}
              />
              <IconButton
                className="terminal-panel__action"
                label={t("terminal.restart")}
                icon="refresh"
                disabled={runtime === null}
                onClick={restart}
              />
              <IconButton
                className="terminal-panel__action"
                label={t("terminal.kill")}
                icon="trash"
                disabled={!connected}
                onClick={stop}
              />
            </>
          ) : null}
          <IconButton
            className="terminal-panel__action"
            label={t("terminal.closePanel")}
            icon="close"
            onClick={onClose}
          />
        </div>
      </header>
      <div className="terminal-panel__body">
        <div
          id={TERMINAL_SHELL_PANEL_ID}
          ref={containerRef}
          className="terminal-panel__viewport"
          role="tabpanel"
          aria-labelledby={TERMINAL_SHELL_TAB_ID}
          hidden={!shellSelected}
        />
        {shellSelected && status === "starting" ? (
          <div className="terminal-panel__overlay" role="status">
            {t("terminal.starting")}
          </div>
        ) : null}
        {shellSelected && failure !== null ? (
          <div className="terminal-panel__failure" role="alert">
            {failure}
          </div>
        ) : null}
        {shellSelected ? (
          <span className="terminal-panel__live-region" aria-live="polite">
            {statusMessage}
          </span>
        ) : null}
        {selectedOutput === null ? null : (
          <ExtensionOutputView active={active} output={selectedOutput} />
        )}
      </div>
    </section>
  );
}

function fitTerminal(runtime: TerminalRuntime, container: HTMLDivElement): void {
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    runtime.fitAddon.fit();
  }
}

function cssColor(styles: CSSStyleDeclaration, variable: string, fallback: string): string {
  const value = styles.getPropertyValue(variable).trim();
  return value.length > 0 ? value : fallback;
}

function terminalStatusMessage(
  status: TerminalShellStatus,
  failure: string | null,
  translate: ReturnType<typeof useI18n>["t"],
): string {
  switch (status) {
    case "exited":
      return translate("terminal.statusExited");
    case "failed":
      return translate("terminal.statusFailed", { message: failure ?? "" });
    case "running":
      return translate("terminal.statusRunning");
    case "starting":
      return translate("terminal.starting");
    case "stopped":
      return translate("terminal.statusStopped");
  }
}

function beginPanelResize(
  event: ReactPointerEvent<HTMLHRElement>,
  panelHeight: number,
  resizeRef: MutableRefObject<PanelResize | null>,
): void {
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  resizeRef.current = {
    initialHeight: panelHeight,
    initialPointerY: event.clientY,
    pointerId: event.pointerId,
  };
}

function updatePanelResize(
  event: ReactPointerEvent<HTMLHRElement>,
  resizeRef: MutableRefObject<PanelResize | null>,
  updateHeight: Dispatch<SetStateAction<number>>,
): void {
  const resize = resizeRef.current;
  if (resize === null || resize.pointerId !== event.pointerId) {
    return;
  }
  const workspaceHeight = event.currentTarget.parentElement?.parentElement?.clientHeight ?? 0;
  const dynamicMaximum = Math.min(
    MAX_PANEL_HEIGHT,
    Math.max(MIN_PANEL_HEIGHT, Math.floor(workspaceHeight * WORKSPACE_PANEL_RATIO)),
  );
  const requested = resize.initialHeight + resize.initialPointerY - event.clientY;
  updateHeight(Math.min(dynamicMaximum, Math.max(MIN_PANEL_HEIGHT, requested)));
}

function endPanelResize(
  event: ReactPointerEvent<HTMLHRElement>,
  resizeRef: MutableRefObject<PanelResize | null>,
): void {
  if (resizeRef.current?.pointerId !== event.pointerId) {
    return;
  }
  resizeRef.current = null;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
}

function clampPanelHeight(height: number): number {
  return Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, height));
}
