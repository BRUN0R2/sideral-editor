import type { JsonValue, WorkspaceContext } from "@sideral/extension-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDesktopRuntime } from "../../lib/backend";
import { toApplicationError } from "../../lib/errors";
import { toExtensionTextDocument } from "../workspace/document-uri";
import type { EditorDocument, WorkspaceRoot } from "../workspace/types";
import {
  activateExtensionEvent,
  connectExtensionClient,
  dismissExtensionPreview,
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
  updateExtensionKeybinding,
} from "./backend";
import type {
  ExtensionClientInstruction,
  ExtensionSnapshot,
  KeybindingUpdate,
  OutputChannelView,
  PackageInspectionResult,
  PreviewDocumentView,
} from "./contracts";
import type { ExtensionHostConnection } from "./host/connection";
import { observeOutputChannel } from "./output-lifecycle";
import { applyPreviewChange, visiblePreviewMap } from "./preview-lifecycle";

const EMPTY_SNAPSHOT: ExtensionSnapshot = {
  sequence: 0,
  revision: 0,
  extensions: [],
  commands: [],
  keybindings: [],
  languages: [],
};
const MAX_NOTICES: number = 20;

export interface ExtensionNotice {
  readonly id: number;
  readonly extensionId: string | null;
  readonly severity: "information" | "warning" | "error";
  readonly message: string;
}

export interface ExtensionOutputReveal {
  readonly resourceId: string;
  readonly revealSequence: number;
}

export interface ExtensionSystem {
  readonly status: "unavailable" | "initializing" | "ready" | "failed";
  readonly snapshot: ExtensionSnapshot;
  readonly notices: readonly ExtensionNotice[];
  readonly outputs: readonly OutputChannelView[];
  readonly outputReveal: ExtensionOutputReveal | null;
  readonly previews: readonly PreviewDocumentView[];
  readonly busyExtensionIds: ReadonlySet<string>;
  readonly error: string | null;
  executeCommand(commandId: string, arguments_?: readonly JsonValue[]): Promise<JsonValue | null>;
  dismissPreview(resourceId: string, expectedSourceUri: string | null): Promise<void>;
  updateKeybinding(commandId: string, update: KeybindingUpdate): Promise<void>;
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
  reportError(reason: unknown): void;
  clearError(): void;
}

export function useExtensionSystem(
  workspaceRoot: WorkspaceRoot | null,
  activeDocument: EditorDocument | null,
  hostConnection: Promise<ExtensionHostConnection> | null,
  saveDocument: (documentId: string) => Promise<boolean>,
): ExtensionSystem {
  const desktop = isDesktopRuntime();
  const [status, setStatus] = useState<ExtensionSystem["status"]>(
    desktop ? "initializing" : "unavailable",
  );
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot>(EMPTY_SNAPSHOT);
  const [notices, setNotices] = useState<readonly ExtensionNotice[]>([]);
  const [outputs, setOutputs] = useState<ReadonlyMap<string, OutputChannelView>>(new Map());
  const [outputReveal, setOutputReveal] = useState<ExtensionOutputReveal | null>(null);
  const [previews, setPreviews] = useState<ReadonlyMap<string, PreviewDocumentView>>(new Map());
  const [busyCounts, setBusyCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const reportError = useCallback((reason: unknown): void => {
    setError(errorMessage(reason));
  }, []);
  const nextNoticeId = useRef(1);
  const latestSnapshotSequence = useRef(0);
  const outputRevealSequences = useRef<ReadonlyMap<string, number>>(new Map());
  const workspaceRootRef = useRef(workspaceRoot);
  workspaceRootRef.current = workspaceRoot;
  const activeDocumentRef = useRef(activeDocument);
  activeDocumentRef.current = activeDocument;
  const saveDocumentRef = useRef(saveDocument);
  saveDocumentRef.current = saveDocument;
  const busyExtensionIds = useMemo(() => new Set(busyCounts.keys()), [busyCounts]);
  const workspaceName = workspaceRoot?.name ?? null;
  const activeDocumentName = activeDocument?.name ?? null;
  const activeDocumentLanguageId = activeDocument?.languageId ?? null;
  const workspaceContext = useMemo<WorkspaceContext>(
    () => createWorkspaceContext(workspaceName, activeDocumentName, activeDocumentLanguageId),
    [activeDocumentLanguageId, activeDocumentName, workspaceName],
  );
  const workspaceContextRef = useRef(workspaceContext);
  workspaceContextRef.current = workspaceContext;

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
    setPreviews(
      (current) =>
        new Map([...current].filter(([, preview]) => liveExtensions.has(preview.extensionId))),
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
        case "outputChanged": {
          const observation = observeOutputChannel(
            outputRevealSequences.current,
            instruction.channel,
          );
          if (observation.kind === "stale") {
            return;
          }
          outputRevealSequences.current = observation.sequences;
          setOutputs((current) => {
            const next = new Map(current);
            next.set(instruction.channel.resourceId, instruction.channel);
            return next;
          });
          if (observation.revealRequested) {
            setOutputReveal({
              resourceId: instruction.channel.resourceId,
              revealSequence: instruction.channel.revealSequence,
            });
          }
          return;
        }
        case "outputDisposed": {
          const nextRevealSequences = new Map(outputRevealSequences.current);
          nextRevealSequences.delete(instruction.resourceId);
          outputRevealSequences.current = nextRevealSequences;
          setOutputs((current) => {
            const next = new Map(current);
            next.delete(instruction.resourceId);
            return next;
          });
          setOutputReveal((current) =>
            current?.resourceId === instruction.resourceId ? null : current,
          );
          return;
        }
        case "previewChanged":
          setPreviews((current) => applyPreviewChange(current, instruction.preview));
          return;
        case "previewDisposed":
          setPreviews((current) => {
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
    if (!desktop || hostConnection === null) {
      return;
    }
    let cancelled = false;
    let connection: ExtensionClientConnection | null = null;
    setStatus("initializing");
    void (async () => {
      const host = await hostConnection;
      if (cancelled) {
        return;
      }
      host.updateWorkspaceContext(workspaceContextRef.current);
      await initializeExtensionSystem();
      const connected = await connectExtensionClient(acceptInstruction);
      if (cancelled) {
        await connected.dispose();
        return;
      }
      connection = connected;
      applySnapshot(connected.snapshot);
      const connectedOutputs = new Map(
        connected.outputs.map((output) => [output.resourceId, output] as const),
      );
      outputRevealSequences.current = new Map(
        connected.outputs.map((output) => [output.resourceId, output.revealSequence] as const),
      );
      setOutputs(connectedOutputs);
      setPreviews(visiblePreviewMap(connected.previews));
      await setExtensionWorkspace(workspaceRootRef.current?.path ?? null);
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
        void connection.dispose().catch((reason: unknown) => {
          console.error("The extension client connection failed to close.", reason);
        });
      }
    };
  }, [acceptInstruction, applySnapshot, desktop, hostConnection]);

  useEffect(() => {
    if (!desktop || hostConnection === null) {
      return;
    }
    let current = true;
    void hostConnection
      .then((host) => {
        if (current) {
          host.updateWorkspaceContext(workspaceContext);
        }
      })
      .catch((reason: unknown) => {
        if (current) {
          setError(errorMessage(reason));
        }
      });
    return () => {
      current = false;
    };
  }, [desktop, hostConnection, workspaceContext]);

  useEffect(() => {
    const liveOutputIds = new Set(outputs.keys());
    const nextRevealSequences = new Map(
      [...outputRevealSequences.current].filter(([resourceId]) => liveOutputIds.has(resourceId)),
    );
    outputRevealSequences.current = nextRevealSequences;
  }, [outputs]);

  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    void setExtensionWorkspace(workspaceRoot?.path ?? null).catch((reason: unknown) => {
      setError(errorMessage(reason));
    });
  }, [status, workspaceRoot?.path]);

  useEffect(() => {
    const activeLanguageId = activeDocument?.languageId ?? null;
    if (status !== "ready" || activeLanguageId === null) {
      return;
    }
    void activateExtensionEvent({ kind: "language", languageId: activeLanguageId }).catch(
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  }, [activeDocument?.languageId, status]);

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

  const dismissPreview = useCallback(
    async (resourceId: string, expectedSourceUri: string | null): Promise<void> => {
      setError(null);
      try {
        await dismissExtensionPreview(resourceId, expectedSourceUri);
      } catch (reason: unknown) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [],
  );

  return useMemo(
    () => ({
      status,
      snapshot,
      notices,
      outputs: [...outputs.values()],
      outputReveal,
      previews: [...previews.values()],
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
          const command = snapshot.commands.find((candidate) => candidate.id === commandId);
          const active = activeDocumentRef.current;
          if (command?.invocation === "activeTextDocument" && active === null) {
            throw new Error(`Command ${commandId} requires an active text document.`);
          }
          if (command?.documentSync === "save" && active !== null) {
            if (active.path === null) {
              throw new Error(`Command ${commandId} requires a saved workspace file.`);
            }
            const saved = await saveDocumentRef.current(active.id);
            if (!saved) {
              throw new Error(`The active document could not be saved before ${commandId}.`);
            }
          }
          const document =
            command?.invocation === "activeTextDocument" && active !== null
              ? toExtensionTextDocument(active)
              : null;
          return await executeExtensionCommand(commandId, arguments_, document);
        } catch (reason: unknown) {
          setError(errorMessage(reason));
          throw reason;
        } finally {
          if (extensionId !== undefined) {
            updateBusyCount(extensionId, -1);
          }
        }
      },
      dismissPreview,
      updateKeybinding(commandId, update) {
        const extensionId = snapshot.keybindings.find(
          (binding) => binding.commandId === commandId,
        )?.extensionId;
        return runExtensionMutation(extensionId ?? commandId, () =>
          updateExtensionKeybinding(commandId, update),
        );
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
      reportError,
      clearError() {
        setError(null);
      },
    }),
    [
      applySnapshot,
      busyExtensionIds,
      dismissPreview,
      error,
      notices,
      outputs,
      outputReveal,
      previews,
      reportError,
      runExtensionMutation,
      snapshot,
      status,
      updateBusyCount,
    ],
  );
}

function errorMessage(value: unknown): string {
  return toApplicationError(value).message;
}

function createWorkspaceContext(
  workspaceName: string | null,
  activeDocumentName: string | null,
  activeDocumentLanguageId: string | null,
): WorkspaceContext {
  return {
    workspaceName,
    activeDocument:
      activeDocumentName === null || activeDocumentLanguageId === null
        ? null
        : { name: activeDocumentName, languageId: activeDocumentLanguageId },
  };
}
