import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTextFile, isDesktopRuntime, readTextFile, writeTextFile } from "../../lib/backend";
import type { AutoSaveMode } from "../../lib/contracts";
import { ApplicationError, toApplicationError } from "../../lib/errors";
import { AUTO_SAVE_DELAY_MS, autoSaveDocuments } from "./auto-save";
import { type LanguageAssociation, languageForFile } from "./language";
import {
  documentAutoSave,
  isWorkspaceConfiguration,
  workspaceFolderForPath,
} from "./project-settings";
import { type CursorPosition, type EditorDocument, isDocumentDirty } from "./types";
import { useWorkspaceFolders } from "./useWorkspaceFolders";
import { workspaceFileName, workspacePathKey } from "./workspace-tree";

const INITIAL_CURSOR: CursorPosition = { line: 1, column: 1 };

interface AutoSaveTimer {
  readonly content: string;
  readonly timerId: number;
}

export function useWorkspace(autoSave: AutoSaveMode) {
  const [documents, setDocuments] = useState<readonly EditorDocument[]>([]);
  const [activeDocumentId, updateActiveDocumentId] = useState<string | null>(null);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<CursorPosition>(INITIAL_CURSOR);
  const [error, setError] = useState<ApplicationError | null>(null);
  const untitledSequence = useRef(0);
  const fileRequests = useRef(new Map<string, Promise<void>>());
  const saveRequests = useRef(new Map<string, Promise<boolean>>());
  const autoSaveTimers = useRef(new Map<string, AutoSaveTimer>());
  const mounted = useRef(false);
  const documentsRef = useRef(documents);
  const extensionLanguagesRef = useRef<readonly LanguageAssociation[]>([]);
  documentsRef.current = documents;

  useEffect(() => {
    mounted.current = true;
    const files = fileRequests.current;
    return () => {
      mounted.current = false;
      files.clear();
    };
  }, []);

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documents],
  );

  const reportError = useCallback((value: unknown) => {
    if (mounted.current) setError(toApplicationError(value));
  }, []);

  const {
    folders,
    issues,
    getFolders,
    selectedFolder,
    selectFolder,
    restoringWorkspace,
    refreshFolders,
    openFolder,
    removeFolder,
    initializeFolder,
    toggleFolder,
    toggleDirectory,
    insertFile,
  } = useWorkspaceFolders(reportError);

  const setActiveDocumentId = useCallback(
    (id: string) => {
      const document = documentsRef.current.find((item) => item.id === id);
      const owner = workspaceFolderForPath(getFolders(), document?.path ?? null);
      if (owner !== undefined) selectFolder(owner.path);
      updateActiveDocumentId(id);
    },
    [getFolders, selectFolder],
  );

  useEffect(() => {
    const owner = workspaceFolderForPath(getFolders(), activeDocument?.path ?? null);
    if (owner !== undefined) selectFolder(owner.path);
  }, [activeDocument?.path, getFolders, selectFolder]);

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
    updateActiveDocumentId(document.id);
    setCursor(INITIAL_CURSOR);
  }, []);

  const createWorkspaceFile = useCallback(
    async (rootPath: string, name: string) => {
      const root = getFolders().find((folder) => folder.path === rootPath && folder.available);
      if (root === undefined) {
        throw new ApplicationError("workspace_required", "Open a folder before creating a file.");
      }
      if (!isDesktopRuntime()) {
        throw new ApplicationError("native_only", "Creating files requires the desktop app.");
      }

      const payload = await createTextFile(root.path, name);
      if (!mounted.current) return;
      const document: EditorDocument = {
        id: `file:${workspacePathKey(payload.path)}`,
        path: payload.path,
        name: payload.name,
        content: payload.content,
        savedContent: payload.content,
        languageId: languageForFile(payload.name, extensionLanguagesRef.current),
        version: 1,
      };

      setDocuments((current) =>
        current.some((item) => item.id === document.id) ? current : [...current, document],
      );
      updateActiveDocumentId(document.id);
      selectFolder(root.path);
      setCursor(INITIAL_CURSOR);

      insertFile(root, payload.path, payload.name);
    },
    [getFolders, insertFile, selectFolder],
  );

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

        const key = workspacePathKey(selectedPath);
        const existing = documentsRef.current.find(
          (document) => document.path !== null && workspacePathKey(document.path) === key,
        );
        if (existing !== undefined) {
          setActiveDocumentId(existing.id);
          return;
        }
        const pending = fileRequests.current.get(key);
        if (pending !== undefined) {
          return await pending;
        }

        const request = readTextFile(selectedPath)
          .then((payload) => {
            if (!mounted.current) return;
            const document: EditorDocument = {
              id: `file:${workspacePathKey(payload.path)}`,
              path: payload.path,
              name: payload.name,
              content: payload.content,
              savedContent: payload.content,
              languageId: languageForFile(payload.name, extensionLanguagesRef.current),
              version: 1,
            };
            setDocuments((current) => {
              const alreadyOpen = current.some((item) => item.id === document.id);
              return alreadyOpen ? current : [...current, document];
            });
            updateActiveDocumentId(document.id);
            const owner = workspaceFolderForPath(getFolders(), payload.path);
            if (owner !== undefined) selectFolder(owner.path);
            setCursor(INITIAL_CURSOR);
          })
          .finally(() => {
            fileRequests.current.delete(key);
          });
        fileRequests.current.set(key, request);
        return await request;
      } catch (caught) {
        reportError(caught);
      }
    },
    [getFolders, reportError, selectFolder, setActiveDocumentId],
  );

  const configureFolder = useCallback(
    async (path: string) => {
      try {
        await openFile(await initializeFolder(path));
      } catch (caught) {
        reportError(caught);
      }
    },
    [initializeFolder, openFile, reportError],
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
          if (!mounted.current) return true;
          setDocuments((current) =>
            current.map((item) =>
              item.id === id
                ? {
                    ...item,
                    path: result.path,
                    name: workspaceFileName(result.path),
                    savedContent: contentSnapshot,
                    languageId: languageForFile(result.path, extensionLanguagesRef.current),
                  }
                : item,
            ),
          );
          if (isWorkspaceConfiguration(getFolders(), result.path))
            await refreshFolders("savedConfiguration");
          return true;
        } catch (caught) {
          reportError(caught);
          return false;
        } finally {
          if (mounted.current) {
            setSavingIds((current) => {
              const next = new Set(current);
              next.delete(id);
              return next;
            });
          }
        }
      })().finally(() => {
        saveRequests.current.delete(id);
      });
      saveRequests.current.set(id, request);
      return request;
    },
    [getFolders, refreshFolders, reportError],
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
    const eligibleDocuments = autoSaveDocuments(documents, pendingCloseId).filter(
      (document) => documentAutoSave(folders, document.path, autoSave) === "afterDelay",
    );
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
  }, [autoSave, documents, folders, pendingCloseId, saveDocument]);

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
    closeDocument(id, setDocuments, updateActiveDocumentId);
  }, []);

  const discardPendingDocument = useCallback(() => {
    if (pendingCloseId !== null) {
      closeDocument(pendingCloseId, setDocuments, updateActiveDocumentId);
      setPendingCloseId(null);
    }
  }, [pendingCloseId]);

  const savePendingDocument = useCallback(async () => {
    if (pendingCloseId === null) {
      return;
    }
    const saved = await saveDocument(pendingCloseId);
    if (saved) {
      closeDocument(pendingCloseId, setDocuments, updateActiveDocumentId);
      setPendingCloseId(null);
    }
  }, [pendingCloseId, saveDocument]);

  const setExtensionLanguages = useCallback((languages: readonly LanguageAssociation[]) => {
    extensionLanguagesRef.current = languages;
    setDocuments((current) =>
      current.map((document) => {
        if (document.path === null) {
          return document;
        }
        const languageId = languageForFile(document.name, languages);
        return languageId === document.languageId ? document : { ...document, languageId };
      }),
    );
  }, []);

  return {
    folders,
    issues,
    selectedFolder,
    selectFolder,
    toggleFolder,
    removeFolder,
    configureFolder,
    documents,
    activeDocument,
    activeDocumentId,
    pendingCloseDocument: documents.find((document) => document.id === pendingCloseId) ?? null,
    savingIds,
    cursor,
    error,
    reportError,
    restoringWorkspace,
    createFile,
    createWorkspaceFile,
    openFile,
    openFolder,
    toggleDirectory,
    updateDocumentContent,
    setActiveDocumentId,
    requestCloseDocument,
    discardPendingDocument,
    savePendingDocument,
    cancelPendingClose: () => setPendingCloseId(null),
    saveDocument,
    saveActiveDocument,
    setExtensionLanguages,
    setCursor,
    clearError: () => setError(null),
  };
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
