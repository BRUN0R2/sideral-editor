import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toApplicationError } from "../../lib/errors";
import { applyDownloadEvent, type DownloadProgress, initialDownloadProgress } from "./progress";

export type UpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export interface UpdateState {
  readonly phase: UpdatePhase;
  readonly currentVersion: string;
  readonly nextVersion: string | null;
  readonly releaseNotes: string | null;
  readonly releaseDate: string | null;
  readonly progress: DownloadProgress | null;
  readonly error: string | null;
}

interface UpdateContextValue {
  readonly state: UpdateState;
  readonly checkForUpdates: () => Promise<void>;
  readonly downloadAndInstall: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly transferActive: boolean;
  readonly indicatorVisible: boolean;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateProvider({
  enabled,
  currentVersion,
  children,
}: {
  readonly enabled: boolean;
  readonly currentVersion: string;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState<UpdateState>(() => emptyState(enabled, currentVersion));
  const updateResource = useRef<Update | null>(null);
  const checkRequest = useRef<Promise<void> | null>(null);
  const installRequest = useRef<Promise<void> | null>(null);
  const autoCheckStarted = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const resource = updateResource.current;
      updateResource.current = null;
      if (resource !== null) {
        void resource.close();
      }
    };
  }, []);

  const checkForUpdates = useCallback((): Promise<void> => {
    if (!enabled) {
      return Promise.resolve();
    }
    if (checkRequest.current !== null) {
      return checkRequest.current;
    }
    if (installRequest.current !== null) {
      return installRequest.current;
    }

    const request = (async () => {
      setState((current) => ({ ...current, phase: "checking", error: null }));
      try {
        const previous = updateResource.current;
        updateResource.current = null;
        if (previous !== null) {
          await previous.close();
        }
        const update = await check();
        if (!mounted.current) {
          if (update !== null) {
            await update.close();
          }
          return;
        }
        updateResource.current = update;
        if (update === null) {
          setState({
            ...emptyState(true, currentVersion),
            phase: "upToDate",
          });
          return;
        }
        setState({
          phase: "available",
          currentVersion: update.currentVersion,
          nextVersion: update.version,
          releaseNotes: update.body ?? null,
          releaseDate: update.date ?? null,
          progress: null,
          error: null,
        });
      } catch (error) {
        if (mounted.current) {
          setState((current) => ({
            ...current,
            phase: "error",
            error: toApplicationError(error).message,
          }));
        }
      }
    })().finally(() => {
      if (checkRequest.current === request) {
        checkRequest.current = null;
      }
    });
    checkRequest.current = request;
    return request;
  }, [currentVersion, enabled]);

  useEffect(() => {
    if (enabled && !autoCheckStarted.current) {
      autoCheckStarted.current = true;
      void checkForUpdates();
    }
  }, [checkForUpdates, enabled]);

  const downloadAndInstall = useCallback((): Promise<void> => {
    if (installRequest.current !== null) {
      return installRequest.current;
    }
    const update = updateResource.current;
    if (update === null) {
      return Promise.resolve();
    }

    const request = (async () => {
      let progress = initialDownloadProgress(performance.now());
      setState((current) => ({ ...current, phase: "downloading", progress, error: null }));
      try {
        await update.download((event) => {
          progress = applyDownloadEvent(progress, event, performance.now());
          if (mounted.current) {
            setState((current) => ({ ...current, progress }));
          }
        });
        if (mounted.current) {
          setState((current) => ({
            ...current,
            phase: "installing",
            progress: {
              ...progress,
              percent: 100,
              etaSeconds: 0,
            },
          }));
        }
        await update.install();
        if (mounted.current) {
          setState((current) => ({ ...current, phase: "ready" }));
        }
      } catch (error) {
        if (mounted.current) {
          setState((current) => ({
            ...current,
            phase: "error",
            error: toApplicationError(error).message,
          }));
        }
      }
    })().finally(() => {
      if (installRequest.current === request) {
        installRequest.current = null;
      }
    });
    installRequest.current = request;
    return request;
  }, []);

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      checkForUpdates,
      downloadAndInstall,
      restart: relaunch,
      transferActive: state.phase === "downloading" || state.phase === "installing",
      indicatorVisible:
        state.phase === "available" ||
        state.phase === "downloading" ||
        state.phase === "installing" ||
        state.phase === "ready",
    }),
    [checkForUpdates, downloadAndInstall, state],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdates(): UpdateContextValue {
  const context = useContext(UpdateContext);
  if (context === null) {
    throw new Error("useUpdates must be used inside UpdateProvider");
  }
  return context;
}

function emptyState(enabled: boolean, currentVersion: string): UpdateState {
  return {
    phase: enabled ? "idle" : "disabled",
    currentVersion,
    nextVersion: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    error: null,
  };
}
