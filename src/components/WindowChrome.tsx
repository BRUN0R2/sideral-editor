import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isDesktopRuntime } from "../lib/backend";

type WindowAction = () => Promise<void>;
type WindowChromeDataset = DOMStringMap & { suppressHover?: string };

export function WindowChrome() {
  const controlsReference = useRef<HTMLDivElement>(null);
  const releaseFrameReference = useRef<number | null>(null);
  const appWindow = useMemo<TauriWindow | null>(
    () => (isDesktopRuntime() ? getCurrentWindow() : null),
    [],
  );

  const cancelScheduledRelease = useCallback((): void => {
    if (releaseFrameReference.current !== null) {
      window.cancelAnimationFrame(releaseFrameReference.current);
      releaseFrameReference.current = null;
    }
  }, []);

  const releaseHoverAfterPaint = useCallback((): void => {
    cancelScheduledRelease();
    releaseFrameReference.current = window.requestAnimationFrame(() => {
      releaseFrameReference.current = window.requestAnimationFrame(() => {
        const controls = controlsReference.current;
        if (controls !== null) {
          delete (controls.dataset as WindowChromeDataset).suppressHover;
        }
        releaseFrameReference.current = null;
      });
    });
  }, [cancelScheduledRelease]);

  const suppressHover = useCallback((): void => {
    const controls = controlsReference.current;
    if (controls !== null) {
      (controls.dataset as WindowChromeDataset).suppressHover = "true";
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  const runControlAction = useCallback(
    (action: WindowAction): void => {
      suppressHover();
      void action()
        .catch((error: unknown) => {
          console.error("Sideral Editor window action failed", error);
        })
        .finally(releaseHoverAfterPaint);
    },
    [releaseHoverAfterPaint, suppressHover],
  );

  useEffect(() => {
    if (appWindow === null) {
      return;
    }

    let active = true;
    let unlistenFocus: (() => void) | undefined;

    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused && active) {
          suppressHover();
          releaseHoverAfterPaint();
        }
      })
      .then((unlisten) => {
        if (active) {
          unlistenFocus = unlisten;
        } else {
          unlisten();
        }
      })
      .catch((error: unknown) => {
        console.error("Sideral Editor could not observe window focus", error);
      });

    return () => {
      active = false;
      unlistenFocus?.();
      cancelScheduledRelease();
    };
  }, [appWindow, cancelScheduledRelease, releaseHoverAfterPaint, suppressHover]);

  if (appWindow === null) {
    return null;
  }

  return (
    <div className="window-chrome">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Native title-bar drag regions intentionally use platform pointer behavior. */}
      <div
        className="window-chrome__drag-region"
        data-tauri-drag-region
        onDoubleClick={() => runControlAction(() => appWindow.toggleMaximize())}
      />
      <div className="window-chrome__controls" ref={controlsReference}>
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => runControlAction(() => appWindow.minimize())}
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          aria-label="Maximize or restore window"
          onClick={() => runControlAction(() => appWindow.toggleMaximize())}
        >
          <MaximizeIcon />
        </button>
        <button
          type="button"
          className="window-chrome__close"
          aria-label="Close window"
          onClick={() => runControlAction(() => appWindow.close())}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

function MinimizeIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
      <path d="M3 8.5h10" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 13 13">
      <rect x="2.5" y="2.5" width="8" height="8" rx="0.75" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
