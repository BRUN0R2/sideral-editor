import type { JsonValue } from "@sideral/extension-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDesktopRuntime } from "../../lib/backend";
import {
  activateExtensionEvent,
  connectExtensionClient,
  type ExtensionClientConnection,
  executeExtensionCommand,
  initializeExtensionSystem,
  inspectExtensionPackage,
  installExtensionPackage,
  restartExtension,
  rollbackExtension,
  setExtensionEnabled,
  setExtensionWorkspace,
  uninstallExtension,
} from "./backend";
import type {
  ExtensionClientInstruction,
  ExtensionSnapshot,
  OutputChannelView,
  PackageInspectionResult,
} from "./contracts";

const EMPTY_SNAPSHOT: ExtensionSnapshot = {
  sequence: 0,
  revision: 0,
  extensions: [],
  commands: [],
};
const MAX_NOTICES = 20;

export interface ExtensionNotice {
  readonly id: number;
  readonly extensionId: string | null;
  readonly severity: "information" | "warning" | "error";
  readonly message: string;
}

export interface ExtensionSystem {
  readonly status: "unavailable" | "initializing" | "ready" | "failed";
  readonly snapshot: ExtensionSnapshot;
  readonly notices: readonly ExtensionNotice[];
  readonly outputs: readonly OutputChannelView[];
  readonly busyExtensionIds: ReadonlySet<string>;
  readonly error: string | null;
  executeCommand(commandId: string, arguments_?: readonly JsonValue[]): Promise<JsonValue | null>;
  inspectPackage(path: string): Promise<PackageInspectionResult>;
  installPackage(
    path: string,
    expectedPackageSha256: string,
    approvePublisher: boolean,
  ): Promise<void>;
  setEnabled(extensionId: string, enabled: boolean): Promise<void>;
  restart(extensionId: string): Promise<void>;
  rollback(extensionId: string): Promise<void>;
  uninstall(extensionId: string): Promise<void>;
  dismissNotice(id: number): void;
  clearError(): void;
}

export function useExtensionSystem(
  workspaceRootPath: string | null,
  activeLanguageId: string | null,
): ExtensionSystem {
  const desktop = isDesktopRuntime();
  const [status, setStatus] = useState<ExtensionSystem["status"]>(
    desktop ? "initializing" : "unavailable",
  );
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot>(EMPTY_SNAPSHOT);
  const [notices, setNotices] = useState<readonly ExtensionNotice[]>([]);
  const [outputs, setOutputs] = useState<ReadonlyMap<string, OutputChannelView>>(new Map());
  const [busyCounts, setBusyCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const nextNoticeId = useRef(1);
  const latestSnapshotSequence = useRef(0);
  const workspaceRootRef = useRef(workspaceRootPath);
  workspaceRootRef.current = workspaceRootPath;
  const busyExtensionIds = useMemo(() => new Set(busyCounts.keys()), [busyCounts]);

  const updateBusyCount = useCallback((extensionId: string, change: 1 | -1): void => {
    setBusyCounts((current) => {
      const next = new Map(current);
      const count = (next.get(extensionId) ?? 0) + change;
      if (count <= 0) {
        next.delete(extensionId);
      } else {
        next.set(extensionId, count);
      }
      return next;
    });
  }, []);

  const applySnapshot = useCallback((nextSnapshot: ExtensionSnapshot) => {
    if (nextSnapshot.sequence < latestSnapshotSequence.current) {
      return;
    }
    latestSnapshotSequence.current = nextSnapshot.sequence;
    setSnapshot(nextSnapshot);
    const liveExtensions = new Set(
      nextSnapshot.extensions
        .filter(
          (extension) =>
            extension.enabled &&
            (extension.runtime.state === "starting" ||
              extension.runtime.state === "activating" ||
              extension.runtime.state === "active"),
        )
        .map((extension) => extension.id),
    );
    setOutputs(
      (current) =>
        new Map([...current].filter(([, output]) => liveExtensions.has(output.extensionId))),
    );
  }, []);

  const acceptInstruction = useCallback(
    (instruction: ExtensionClientInstruction) => {
      switch (instruction.kind) {
        case "snapshot":
          applySnapshot(instruction.snapshot);
          return;
        case "showMessage":
          setNotices((current) => [
            ...current.slice(-(MAX_NOTICES - 1)),
            {
              id: nextNoticeId.current++,
              extensionId: instruction.extensionId,
              severity: instruction.severity,
              message: instruction.message,
            },
          ]);
          return;
        case "outputChanged":
          setOutputs((current) => {
            const next = new Map(current);
            next.set(instruction.channel.resourceId, instruction.channel);
            return next;
          });
          return;
        case "outputDisposed":
          setOutputs((current) => {
            const next = new Map(current);
            next.delete(instruction.resourceId);
            return next;
          });
          return;
      }
    },
    [applySnapshot],
  );

  useEffect(() => {
    if (!desktop) {
      return;
    }
    let cancelled = false;
    let connection: ExtensionClientConnection | null = null;
    setStatus("initializing");
    void (async () => {
      await initializeExtensionSystem();
      const connected = await connectExtensionClient(acceptInstruction);
      if (cancelled) {
        await connected.dispose();
        return;
      }
      connection = connected;
      applySnapshot(connected.snapshot);
      setOutputs(new Map(connected.outputs.map((output) => [output.resourceId, output] as const)));
      await setExtensionWorkspace(workspaceRootRef.current);
      setStatus("ready");
      void activateExtensionEvent({ kind: "workbenchReady" }).catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorMessage(reason));
        }
      });
    })().catch((reason: unknown) => {
      if (!cancelled) {
        setError(errorMessage(reason));
        setStatus("failed");
      }
    });
    return () => {
      cancelled = true;
      if (connection !== null) {
        void connection.dispose().catch(() => undefined);
      }
    };
  }, [acceptInstruction, applySnapshot, desktop]);

  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    void setExtensionWorkspace(workspaceRootPath).catch((reason: unknown) => {
      setError(errorMessage(reason));
    });
  }, [status, workspaceRootPath]);

  useEffect(() => {
    if (status !== "ready" || activeLanguageId === null) {
      return;
    }
    void activateExtensionEvent({ kind: "language", languageId: activeLanguageId }).catch(
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  }, [activeLanguageId, status]);

  const runExtensionMutation = useCallback(
    async (extensionId: string, operation: () => Promise<ExtensionSnapshot>): Promise<void> => {
      updateBusyCount(extensionId, 1);
      setError(null);
      try {
        applySnapshot(await operation());
      } catch (reason: unknown) {
        setError(errorMessage(reason));
        throw reason;
      } finally {
        updateBusyCount(extensionId, -1);
      }
    },
    [applySnapshot, updateBusyCount],
  );

  return useMemo(
    () => ({
      status,
      snapshot,
      notices,
      outputs: [...outputs.values()],
      busyExtensionIds,
      error,
      async executeCommand(commandId: string, arguments_: readonly JsonValue[] = []) {
        const extensionId = snapshot.commands.find(
          (command) => command.id === commandId,
        )?.extensionId;
        if (extensionId !== undefined) {
          updateBusyCount(extensionId, 1);
        }
        setError(null);
        try {
          return await executeExtensionCommand(commandId, arguments_);
        } catch (reason: unknown) {
          setError(errorMessage(reason));
          throw reason;
        } finally {
          if (extensionId !== undefined) {
            updateBusyCount(extensionId, -1);
          }
        }
      },
      async inspectPackage(path: string) {
        setError(null);
        try {
          return await inspectExtensionPackage(path);
        } catch (reason: unknown) {
          setError(errorMessage(reason));
          throw reason;
        }
      },
      async installPackage(path, expectedPackageSha256, approvePublisher) {
        setError(null);
        try {
          applySnapshot(
            await installExtensionPackage(path, expectedPackageSha256, approvePublisher),
          );
        } catch (reason: unknown) {
          setError(errorMessage(reason));
          throw reason;
        }
      },
      setEnabled(extensionId, enabled) {
        return runExtensionMutation(extensionId, () => setExtensionEnabled(extensionId, enabled));
      },
      restart(extensionId) {
        return runExtensionMutation(extensionId, () => restartExtension(extensionId));
      },
      rollback(extensionId) {
        return runExtensionMutation(extensionId, () => rollbackExtension(extensionId));
      },
      uninstall(extensionId) {
        return runExtensionMutation(extensionId, () => uninstallExtension(extensionId));
      },
      dismissNotice(id) {
        setNotices((current) => current.filter((notice) => notice.id !== id));
      },
      clearError() {
        setError(null);
      },
    }),
    [
      applySnapshot,
      busyExtensionIds,
      error,
      notices,
      outputs,
      runExtensionMutation,
      snapshot,
      status,
      updateBusyCount,
    ],
  );
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message.length > 0) {
    return value.message;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return "The extension operation failed.";
}
