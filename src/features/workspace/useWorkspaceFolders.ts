import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addWorkspaceFolders,
  initializeWorkspaceFolder,
  isDesktopRuntime,
  listDirectory,
  refreshWorkspace,
  removeWorkspaceFolder,
  restoreWorkspace,
} from "../../lib/backend";
import type { DirectoryEntry, WorkspaceIssue, WorkspaceSnapshot } from "../../lib/contracts";
import { ApplicationError } from "../../lib/errors";
import { workspaceFolderForPath } from "./project-settings";
import type { WorkspaceFolder, WorkspaceNode } from "./types";
import {
  findWorkspaceNode,
  insertWorkspaceFile,
  toWorkspaceNodes,
  updateWorkspaceNode,
  workspacePathKey,
} from "./workspace-tree";

export function useWorkspaceFolders(reportError: (value: unknown) => void) {
  const [folders, setFolders] = useState<readonly WorkspaceFolder[]>([]);
  const [issues, setIssues] = useState<readonly WorkspaceIssue[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [restoringWorkspace, setRestoringWorkspace] = useState(isDesktopRuntime);
  const foldersRef = useRef(folders);
  const selectedFolderPathRef = useRef(selectedFolderPath);
  const folderGeneration = useRef(0);
  const directoryRequests = useRef(new Map<string, Promise<readonly DirectoryEntry[]>>());
  const workspaceRequestSequence = useRef(0);
  const workspaceOperationQueue = useRef<Promise<void>>(Promise.resolve());
  const openFolderRequest = useRef<Promise<void> | null>(null);
  const refreshRequest = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const pending = directoryRequests.current;
    return () => {
      mounted.current = false;
      pending.clear();
    };
  }, []);
  const selectedFolder = folders.find((folder) => folder.path === selectedFolderPath) ?? null;
  const getFolders = useCallback(() => foldersRef.current, []);
  const updateFolders = useCallback(
    (update: (current: readonly WorkspaceFolder[]) => readonly WorkspaceFolder[]) => {
      if (!mounted.current) return;
      const next = update(foldersRef.current);
      foldersRef.current = next;
      setFolders(next);
    },
    [],
  );

  const selectFolder = useCallback((path: string | null) => {
    if (
      !mounted.current ||
      (path !== null &&
        !foldersRef.current.some((folder) => folder.path === path && folder.available))
    )
      return;
    selectedFolderPathRef.current = path;
    setSelectedFolderPath(path);
  }, []);

  const applySnapshot = useCallback(
    (snapshot: WorkspaceSnapshot) => {
      if (!mounted.current) return;
      const firstAvailablePath = snapshot.folders.find((folder) => folder.available)?.path;
      updateFolders((current) =>
        snapshot.folders.map((folder) => {
          const previous = current.find(
            (item) => workspacePathKey(item.path) === workspacePathKey(folder.path),
          );
          if (previous !== undefined && previous.available === folder.available) {
            return { ...previous, ...folder };
          }
          return {
            ...folder,
            generation: ++folderGeneration.current,
            expanded: folder.path === firstAvailablePath,
            loading: false,
            entries: null,
          };
        }),
      );
      setIssues(snapshot.issues);
      const selection =
        foldersRef.current.find(
          (folder) => folder.path === selectedFolderPathRef.current && folder.available,
        ) ?? foldersRef.current.find((folder) => folder.available);
      selectFolder(selection?.path ?? null);
    },
    [selectFolder, updateFolders],
  );

  const runWorkspaceOperation = useCallback(
    <Value>(operation: () => Promise<Value>): Promise<Value> => {
      ++workspaceRequestSequence.current;
      setRestoringWorkspace(false);
      const request = workspaceOperationQueue.current.then(operation);
      workspaceOperationQueue.current = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    },
    [],
  );

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
        applySnapshot(snapshot);
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
  }, [applySnapshot, reportError]);

  const refreshFolders = useCallback(
    (reason: "focus" | "savedConfiguration"): Promise<void> => {
      if (!isDesktopRuntime()) return Promise.resolve();
      if (reason === "focus" && refreshRequest.current !== null) return refreshRequest.current;
      const request = runWorkspaceOperation(async () => {
        applySnapshot(await refreshWorkspace());
      })
        .catch(reportError)
        .finally(() => {
          if (refreshRequest.current === request) refreshRequest.current = null;
        });
      refreshRequest.current = request;
      return request;
    },
    [applySnapshot, reportError, runWorkspaceOperation],
  );

  useEffect(() => {
    const refresh = () => {
      if (foldersRef.current.length > 0) void refreshFolders("focus");
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshFolders]);

  const addFolders = useCallback(
    (paths: readonly string[]): Promise<void> =>
      runWorkspaceOperation(async () => {
        const snapshot = await addWorkspaceFolders(paths);
        applySnapshot(snapshot);
        const keys = new Set(paths.map(workspacePathKey));
        updateFolders((current) =>
          current.map((folder) =>
            keys.has(workspacePathKey(folder.path)) ? { ...folder, expanded: true } : folder,
          ),
        );
        const selected = snapshot.folders.find(
          (folder) => folder.available && keys.has(workspacePathKey(folder.path)),
        );
        if (selected !== undefined) selectFolder(selected.path);
      }),
    [applySnapshot, runWorkspaceOperation, selectFolder, updateFolders],
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
        const selectedPaths = await open({
          multiple: true,
          directory: true,
          title: "Add folders to workspace",
        });
        if (selectedPaths === null) return;
        if (!mounted.current) return;
        const paths = typeof selectedPaths === "string" ? [selectedPaths] : selectedPaths;
        await addFolders(paths);
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
  }, [addFolders, reportError]);

  const removeFolder = useCallback(
    async (path: string) => {
      try {
        await runWorkspaceOperation(async () => applySnapshot(await removeWorkspaceFolder(path)));
      } catch (caught) {
        reportError(caught);
      }
    },
    [applySnapshot, reportError, runWorkspaceOperation],
  );

  const initializeFolder = useCallback(
    (path: string) =>
      runWorkspaceOperation(async () => {
        const initialized = await initializeWorkspaceFolder(path);
        applySnapshot(initialized.snapshot);
        updateFolders((current) =>
          current.map((folder) =>
            folder.path === path
              ? {
                  ...folder,
                  generation: ++folderGeneration.current,
                  expanded: true,
                  loading: false,
                  entries: null,
                }
              : folder,
          ),
        );
        return initialized.settingsPath;
      }),
    [applySnapshot, runWorkspaceOperation, updateFolders],
  );

  const loadFolderEntries = useCallback(
    async (folder: WorkspaceFolder) => {
      const key = `${folder.generation}:${workspacePathKey(folder.path)}`;
      updateFolders((current) =>
        current.map((item) =>
          item.generation === folder.generation ? { ...item, loading: true } : item,
        ),
      );
      try {
        const children = await loadDirectory(folder.path, key, directoryRequests.current);
        updateFolders((current) =>
          current.map((item) =>
            item.generation === folder.generation
              ? { ...item, loading: false, entries: toWorkspaceNodes(children) }
              : item,
          ),
        );
      } catch (caught) {
        if (foldersRef.current.some((item) => item.generation === folder.generation)) {
          updateFolders((current) =>
            current.map((item) =>
              item.generation === folder.generation
                ? { ...item, loading: false, expanded: false }
                : item,
            ),
          );
          reportError(caught);
        }
      }
    },
    [reportError, updateFolders],
  );

  useEffect(() => {
    for (const folder of folders) {
      if (folder.available && folder.expanded && folder.entries === null && !folder.loading)
        void loadFolderEntries(folder);
    }
  }, [folders, loadFolderEntries]);

  const toggleFolder = useCallback(
    (path: string) => {
      selectFolder(path);
      updateFolders((current) =>
        current.map((folder) =>
          folder.path === path && folder.available
            ? { ...folder, expanded: !folder.expanded }
            : folder,
        ),
      );
    },
    [selectFolder, updateFolders],
  );

  const toggleDirectory = useCallback(
    async (path: string) => {
      const folder = workspaceFolderForPath(foldersRef.current, path);
      if (folder === undefined || folder.entries === null) return;
      selectFolder(folder.path);
      const node = findWorkspaceNode(folder.entries, path);
      if (node === undefined || node.kind !== "directory") {
        return;
      }
      const updateNode = (update: (node: WorkspaceNode) => WorkspaceNode) =>
        updateFolders((current) =>
          current.map((item) =>
            item.generation === folder.generation && item.entries !== null
              ? { ...item, entries: updateWorkspaceNode(item.entries, path, update) }
              : item,
          ),
        );
      if (node.children !== null || node.loading) {
        updateNode((item) => ({ ...item, expanded: !item.expanded }));
        return;
      }
      const key = `${folder.generation}:${workspacePathKey(path)}`;
      updateNode((item) => ({ ...item, expanded: true, loading: true }));
      try {
        const children = await loadDirectory(path, key, directoryRequests.current);
        updateNode((item) => ({ ...item, loading: false, children: toWorkspaceNodes(children) }));
      } catch (caught) {
        updateNode((item) => ({ ...item, loading: false, expanded: false }));
        if (foldersRef.current.some((item) => item.generation === folder.generation))
          reportError(caught);
      }
    },
    [reportError, selectFolder, updateFolders],
  );

  const insertFile = useCallback(
    (root: WorkspaceFolder, path: string, name: string) => {
      updateFolders((current) =>
        current.map((folder) =>
          folder.generation === root.generation
            ? {
                ...folder,
                expanded: true,
                entries:
                  folder.entries === null ? null : insertWorkspaceFile(folder.entries, path, name),
              }
            : folder,
        ),
      );
    },
    [updateFolders],
  );
  return {
    folders,
    issues,
    getFolders,
    selectedFolder,
    selectFolder,
    restoringWorkspace,
    refreshFolders,
    addFolders,
    openFolder,
    removeFolder,
    initializeFolder,
    toggleFolder,
    toggleDirectory,
    insertFile,
  };
}

async function loadDirectory(
  path: string,
  key: string,
  requests: Map<string, Promise<readonly DirectoryEntry[]>>,
): Promise<readonly DirectoryEntry[]> {
  const current = requests.get(key);
  if (current !== undefined) {
    return current;
  }
  const request = listDirectory(path).finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  requests.set(key, request);
  return request;
}
