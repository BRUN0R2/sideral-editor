import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createTextFile,
  isDesktopRuntime,
  listDirectory,
  openWorkspace,
  readTextFile,
  restoreWorkspace,
  writeTextFile,
} from "../../lib/backend";
import type { AutoSaveMode, DirectoryEntry, WorkspaceSnapshot } from "../../lib/contracts";
import { ApplicationError, toApplicationError } from "../../lib/errors";
import { AUTO_SAVE_DELAY_MS, autoSaveDocuments } from "./auto-save";
import { reorderDocumentAt } from "./document-order";
import { languageForFile } from "./language";
import {
  type CursorPosition,
  type EditorDocument,
  isDocumentDirty,
  type WorkspaceNode,
  type WorkspaceRoot,
} from "./types";

const INITIAL_CURSOR: CursorPosition = { line: 1, column: 1 };

interface AutoSaveTimer {
  readonly content: string;
  readonly timerId: number;
}

export function useWorkspace(autoSave: AutoSaveMode) {
  const [workspaceRoot, setWorkspaceRoot] = useState<WorkspaceRoot | null>(null);
  const [entries, setEntries] = useState<readonly WorkspaceNode[]>([]);
  const [documents, setDocuments] = useState<readonly EditorDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<CursorPosition>(INITIAL_CURSOR);
  const [error, setError] = useState<ApplicationError | null>(null);
  const [restoringWorkspace, setRestoringWorkspace] = useState(isDesktopRuntime);
  const untitledSequence = useRef(0);
  const directoryRequests = useRef(new Map<string, Promise<readonly DirectoryEntry[]>>());
  const fileRequests = useRef(new Map<string, Promise<void>>());
  const saveRequests = useRef(new Map<string, Promise<boolean>>());
  const autoSaveTimers = useRef(new Map<string, AutoSaveTimer>());
  const workspaceRequestSequence = useRef(0);
  const openFolderRequest = useRef<Promise<void> | null>(null);
  const workspaceRootRef = useRef(workspaceRoot);
  const documentsRef = useRef(documents);
  workspaceRootRef.current = workspaceRoot;
  documentsRef.current = documents;

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documents],
  );

  const reportError = useCallback((value: unknown) => {
    setError(toApplicationError(value));
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }

    const requestId = ++workspaceRequestSequence.current;
    let cancelled = false;
    void restoreWorkspace()
      .then((snapshot) => {
        if (snapshot === null) {
          return;
        }
        if (cancelled || workspaceRequestSequence.current !== requestId) {
          return;
        }
        applyWorkspaceSnapshot(snapshot, setWorkspaceRoot, setEntries);
      })
      .catch((caught: unknown) => {
        if (!cancelled && workspaceRequestSequence.current === requestId) {
          reportError(caught);
        }
      })
      .finally(() => {
        if (!cancelled && workspaceRequestSequence.current === requestId) {
          setRestoringWorkspace(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reportError]);

  const createFile = useCallback(() => {
    untitledSequence.current += 1;
    const sequence = untitledSequence.current;
    const name = sequence === 1 ? "Untitled" : `Untitled-${sequence}`;
    const document: EditorDocument = {
      id: `untitled-${sequence}`,
      path: null,
      name,
      content: "",
      savedContent: "",
      languageId: "plaintext",
      version: 1,
    };
    setDocuments((current) => [...current, document]);
    setActiveDocumentId(document.id);
    setCursor(INITIAL_CURSOR);
  }, []);

  const createWorkspaceFile = useCallback(async (name: string) => {
    const root = workspaceRootRef.current;
    if (root === null) {
      throw new ApplicationError("workspace_required", "Open a folder before creating a file.");
    }
    if (!isDesktopRuntime()) {
      throw new ApplicationError("native_only", "Creating files requires the desktop app.");
    }

    const payload = await createTextFile(root.path, name);
    const document: EditorDocument = {
      id: `file:${pathKey(payload.path)}`,
      path: payload.path,
      name: payload.name,
      content: payload.content,
      savedContent: payload.content,
      languageId: languageForFile(payload.name),
      version: 1,
    };

    setDocuments((current) =>
      current.some((item) => item.id === document.id) ? current : [...current, document],
    );
    setActiveDocumentId(document.id);
    setCursor(INITIAL_CURSOR);

    if (pathKey(workspaceRootRef.current?.path ?? "") === pathKey(root.path)) {
      setEntries((current) => insertWorkspaceFile(current, payload.path, payload.name));
    }
  }, []);

  const openFile = useCallback(
    async (requestedPath?: string) => {
      try {
        if (!isDesktopRuntime()) {
          throw new ApplicationError("native_only", "Opening files requires the desktop app.");
        }
        const selectedPath =
          requestedPath ??
          (await open({
            multiple: false,
            directory: false,
            title: "Open file",
          }));
        if (typeof selectedPath !== "string") {
          return;
        }

        const key = pathKey(selectedPath);
        const existing = documentsRef.current.find(
          (document) => document.path !== null && pathKey(document.path) === key,
        );
        if (existing !== undefined) {
          setActiveDocumentId(existing.id);
          return;
        }
        const pending = fileRequests.current.get(key);
        if (pending !== undefined) {
          return pending;
        }

        const request = readTextFile(selectedPath)
          .then((payload) => {
            const document: EditorDocument = {
              id: `file:${pathKey(payload.path)}`,
              path: payload.path,
              name: payload.name,
              content: payload.content,
              savedContent: payload.content,
              languageId: languageForFile(payload.name),
              version: 1,
            };
            setDocuments((current) => {
              const alreadyOpen = current.some((item) => item.id === document.id);
              return alreadyOpen ? current : [...current, document];
            });
            setActiveDocumentId(document.id);
            setCursor(INITIAL_CURSOR);
          })
          .finally(() => {
            fileRequests.current.delete(key);
          });
        fileRequests.current.set(key, request);
        return request;
      } catch (caught) {
        reportError(caught);
      }
    },
    [reportError],
  );

  const openFolder = useCallback((): Promise<void> => {
    const currentRequest = openFolderRequest.current;
    if (currentRequest !== null) {
      return currentRequest;
    }

    const request = (async () => {
      try {
        if (!isDesktopRuntime()) {
          throw new ApplicationError("native_only", "Opening folders requires the desktop app.");
        }
        const selectedPath = await open({
          multiple: false,
          directory: true,
          title: "Open folder",
        });
        if (typeof selectedPath !== "string") {
          return;
        }
        const requestId = ++workspaceRequestSequence.current;
        setRestoringWorkspace(false);
        const snapshot = await openWorkspace(selectedPath);
        if (workspaceRequestSequence.current !== requestId) {
          return;
        }
        applyWorkspaceSnapshot(snapshot, setWorkspaceRoot, setEntries);
      } catch (caught) {
        reportError(caught);
      }
    })();
    openFolderRequest.current = request;
    const releaseRequest = () => {
      if (openFolderRequest.current === request) {
        openFolderRequest.current = null;
      }
    };
    void request.then(releaseRequest, releaseRequest);
    return request;
  }, [reportError]);

  const toggleDirectory = useCallback(
    async (path: string) => {
      const node = findNode(entries, path);
      if (node === undefined || node.kind !== "directory") {
        return;
      }
      if (node.children !== null) {
        setEntries((current) =>
          updateNode(current, path, (item) => ({ ...item, expanded: !item.expanded })),
        );
        return;
      }
      if (directoryRequests.current.has(path)) {
        return;
      }

      setEntries((current) =>
        updateNode(current, path, (item) => ({ ...item, expanded: true, loading: true })),
      );
      try {
        const children = await loadDirectory(path, directoryRequests.current);
        setEntries((current) =>
          updateNode(current, path, (item) => ({
            ...item,
            expanded: true,
            loading: false,
            children: toWorkspaceNodes(children),
          })),
        );
      } catch (caught) {
        setEntries((current) =>
          updateNode(current, path, (item) => ({ ...item, loading: false, expanded: false })),
        );
        reportError(caught);
      }
    },
    [entries, reportError],
  );

  const updateDocumentContent = useCallback((id: string, content: string) => {
    setDocuments((current) =>
      current.map((document) =>
        document.id === id && document.content !== content
          ? { ...document, content, version: document.version + 1 }
          : document,
      ),
    );
  }, []);

  const reorderDocument = useCallback((id: string, insertionIndex: number) => {
    setDocuments((current) => reorderDocumentAt(current, id, insertionIndex));
  }, []);

  const saveDocument = useCallback(
    async (id: string, forceSaveAs = false) => {
      const existingRequest = saveRequests.current.get(id);
      if (existingRequest !== undefined) {
        return existingRequest;
      }
      const document = documentsRef.current.find((item) => item.id === id);
      if (document === undefined) {
        return false;
      }

      const request = (async () => {
        try {
          if (!isDesktopRuntime()) {
            throw new ApplicationError("native_only", "Saving files requires the desktop app.");
          }
          let targetPath = forceSaveAs ? null : document.path;
          if (targetPath === null) {
            targetPath = await save({
              title: "Save file",
              defaultPath: document.name,
            });
          }
          if (typeof targetPath !== "string") {
            return false;
          }

          setSavingIds((current) => new Set(current).add(id));
          const contentSnapshot =
            documentsRef.current.find((item) => item.id === id)?.content ?? document.content;
          const result = await writeTextFile(targetPath, contentSnapshot);
          setDocuments((current) =>
            current.map((item) =>
              item.id === id
                ? {
                    ...item,
                    path: result.path,
                    name: fileName(result.path),
                    savedContent: contentSnapshot,
                    languageId: languageForFile(result.path),
                  }
                : item,
            ),
          );
          return true;
        } catch (caught) {
          reportError(caught);
          return false;
        } finally {
          setSavingIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      })().finally(() => {
        saveRequests.current.delete(id);
      });
      saveRequests.current.set(id, request);
      return request;
    },
    [reportError],
  );

  const saveActiveDocument = useCallback(
    (forceSaveAs = false) => {
      if (activeDocumentId === null) {
        return Promise.resolve(false);
      }
      return saveDocument(activeDocumentId, forceSaveAs);
    },
    [activeDocumentId, saveDocument],
  );

  useEffect(() => {
    const eligibleDocuments =
      autoSave === "afterDelay" ? autoSaveDocuments(documents, pendingCloseId) : [];
    const eligibleById = new Map(eligibleDocuments.map((document) => [document.id, document]));

    for (const [id, timer] of autoSaveTimers.current) {
      const document = eligibleById.get(id);
      if (document === undefined || document.content !== timer.content) {
        window.clearTimeout(timer.timerId);
        autoSaveTimers.current.delete(id);
      }
    }

    for (const document of eligibleDocuments) {
      if (autoSaveTimers.current.has(document.id)) {
        continue;
      }
      const id = document.id;
      const timerId = window.setTimeout(() => {
        autoSaveTimers.current.delete(id);
        void saveDocument(id);
      }, AUTO_SAVE_DELAY_MS);
      autoSaveTimers.current.set(id, { content: document.content, timerId });
    }
  }, [autoSave, documents, pendingCloseId, saveDocument]);

  useEffect(
    () => () => {
      for (const timer of autoSaveTimers.current.values()) {
        window.clearTimeout(timer.timerId);
      }
      autoSaveTimers.current.clear();
    },
    [],
  );

  const requestCloseDocument = useCallback((id: string) => {
    const document = documentsRef.current.find((item) => item.id === id);
    if (document === undefined) {
      return;
    }
    if (isDocumentDirty(document)) {
      setPendingCloseId(id);
      return;
    }
    closeDocument(id, setDocuments, setActiveDocumentId);
  }, []);

  const discardPendingDocument = useCallback(() => {
    if (pendingCloseId !== null) {
      closeDocument(pendingCloseId, setDocuments, setActiveDocumentId);
      setPendingCloseId(null);
    }
  }, [pendingCloseId]);

  const savePendingDocument = useCallback(async () => {
    if (pendingCloseId === null) {
      return;
    }
    const saved = await saveDocument(pendingCloseId);
    if (saved) {
      closeDocument(pendingCloseId, setDocuments, setActiveDocumentId);
      setPendingCloseId(null);
    }
  }, [pendingCloseId, saveDocument]);

  return {
    workspaceRoot,
    entries,
    documents,
    activeDocument,
    activeDocumentId,
    pendingCloseDocument: documents.find((document) => document.id === pendingCloseId) ?? null,
    savingIds,
    cursor,
    error,
    restoringWorkspace,
    createFile,
    createWorkspaceFile,
    openFile,
    openFolder,
    toggleDirectory,
    updateDocumentContent,
    reorderDocument,
    setActiveDocumentId,
    requestCloseDocument,
    discardPendingDocument,
    savePendingDocument,
    cancelPendingClose: () => setPendingCloseId(null),
    saveDocument,
    saveActiveDocument,
    setCursor,
    clearError: () => setError(null),
  };
}

function applyWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  setWorkspaceRoot: React.Dispatch<React.SetStateAction<WorkspaceRoot | null>>,
  setEntries: React.Dispatch<React.SetStateAction<readonly WorkspaceNode[]>>,
): void {
  setWorkspaceRoot({ path: snapshot.root, name: fileName(snapshot.root) });
  setEntries(toWorkspaceNodes(snapshot.entries));
}

async function loadDirectory(
  path: string,
  requests: Map<string, Promise<readonly DirectoryEntry[]>>,
): Promise<readonly DirectoryEntry[]> {
  const current = requests.get(path);
  if (current !== undefined) {
    return current;
  }
  const request = listDirectory(path).finally(() => {
    requests.delete(path);
  });
  requests.set(path, request);
  return request;
}

function toWorkspaceNodes(entries: readonly DirectoryEntry[]): readonly WorkspaceNode[] {
  return entries.map((entry) => ({
    ...entry,
    expanded: false,
    loading: false,
    children: null,
  }));
}

function insertWorkspaceFile(
  nodes: readonly WorkspaceNode[],
  path: string,
  name: string,
): readonly WorkspaceNode[] {
  if (nodes.some((node) => pathKey(node.path) === pathKey(path))) {
    return nodes;
  }

  return [
    ...nodes,
    {
      path,
      name,
      kind: "file" as const,
      expanded: false,
      loading: false,
      children: null,
    },
  ].sort(compareWorkspaceNodes);
}

function compareWorkspaceNodes(left: WorkspaceNode, right: WorkspaceNode): number {
  const rankDifference = workspaceNodeRank(left) - workspaceNodeRank(right);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  const foldedDifference = compareText(left.name.toLowerCase(), right.name.toLowerCase());
  return foldedDifference !== 0 ? foldedDifference : compareText(left.name, right.name);
}

function workspaceNodeRank(node: WorkspaceNode): number {
  switch (node.kind) {
    case "directory":
      return 0;
    case "file":
      return 1;
    case "symbolicLink":
      return 2;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

function findNode(nodes: readonly WorkspaceNode[], path: string): WorkspaceNode | undefined {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    if (node.children !== null) {
      const child = findNode(node.children, path);
      if (child !== undefined) {
        return child;
      }
    }
  }
  return undefined;
}

function updateNode(
  nodes: readonly WorkspaceNode[],
  path: string,
  update: (node: WorkspaceNode) => WorkspaceNode,
): readonly WorkspaceNode[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return update(node);
    }
    if (node.children === null) {
      return node;
    }
    const children = updateNode(node.children, path, update);
    return children === node.children ? node : { ...node, children };
  });
}

function closeDocument(
  id: string,
  setDocuments: React.Dispatch<React.SetStateAction<readonly EditorDocument[]>>,
  setActiveDocumentId: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  setDocuments((current) => {
    const index = current.findIndex((document) => document.id === id);
    if (index < 0) {
      return current;
    }
    const next = current.filter((document) => document.id !== id);
    setActiveDocumentId((activeId) => {
      if (activeId !== id) {
        return activeId;
      }
      return next[Math.min(index, next.length - 1)]?.id ?? null;
    });
    return next;
  });
}

function pathKey(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
