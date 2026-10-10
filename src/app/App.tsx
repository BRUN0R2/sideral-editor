import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { DiscardChangesDialog } from "../components/DiscardChangesDialog";
import { ErrorToast } from "../components/ErrorToast";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { SideralLogo } from "../components/SideralLogo";
import { StatusBar } from "../features/editor/StatusBar";
import { Explorer } from "../features/explorer/Explorer";
import { useFileOpening } from "../features/file-opening/useFileOpening";
import { useI18n } from "../features/i18n/I18nProvider";
import { SettingsView } from "../features/settings/SettingsView";
import { useDesktopPreferences } from "../features/settings/useDesktopPreferences";
import { ExtensionCommandPalette } from "../features/sideral-extensions/ExtensionCommandPalette";
import { ExtensionDetailsView } from "../features/sideral-extensions/ExtensionDetailsView";
import { ExtensionNotices } from "../features/sideral-extensions/ExtensionNotices";
import { ExtensionsSidebar } from "../features/sideral-extensions/ExtensionsSidebar";
import type { ExtensionHostConnection } from "../features/sideral-extensions/host/connection";
import { matchingExtensionCommand } from "../features/sideral-extensions/keybindings";
import {
  closedDocumentPreviews,
  previewForActiveDocument,
} from "../features/sideral-extensions/preview-lifecycle";
import { useExtensionSystem } from "../features/sideral-extensions/useExtensionSystem";
import { UpdateModal } from "../features/updates/UpdateModal";
import { UpdateProvider, useUpdates } from "../features/updates/UpdateProvider";
import { type WorkbenchResourceTab, WorkbenchTabs } from "../features/workbench/WorkbenchTabs";
import { editorDocumentUri } from "../features/workspace/document-uri";
import { useWorkspace } from "../features/workspace/useWorkspace";
import { installWebViewShortcutGuard } from "./webview-shortcuts";
import {
  INITIAL_WORKBENCH_NAVIGATION,
  type PrimarySidebarView,
  reduceWorkbenchNavigation,
  workbenchResourceId,
} from "./workbench-navigation";

const loadEditorPane = async () => {
  const editorModule = await import("../features/editor/EditorPane");
  return { default: editorModule.EditorPane };
};
const EditorPane = lazy(loadEditorPane);
const MarkdownPreview = lazy(async () => {
  const module = await import("../features/sideral-extensions/MarkdownPreview");
  return { default: module.MarkdownPreview };
});
const IntegratedTerminal = lazy(async () => {
  const module = await import("../features/terminal/IntegratedTerminal");
  return { default: module.IntegratedTerminal };
});

interface AppProps {
  readonly extensionHostConnection: Promise<ExtensionHostConnection> | null;
}

export function App({ extensionHostConnection }: AppProps) {
  const { bootstrap } = useI18n();

  useEffect(() => installWebViewShortcutGuard(), []);

  return (
    <UpdateProvider enabled={bootstrap.updaterEnabled} currentVersion={bootstrap.version}>
      <Workbench extensionHostConnection={extensionHostConnection} />
    </UpdateProvider>
  );
}

function Workbench({ extensionHostConnection }: AppProps) {
  const { bootstrap, t } = useI18n();
  const desktopPreferences = useDesktopPreferences(
    bootstrap.desktopPreferences,
    bootstrap.runtime === "desktop",
  );
  const workspace = useWorkspace(desktopPreferences.preferences.autoSave);
  const extensions = useExtensionSystem(
    workspace.workspaceRoot?.path ?? null,
    workspace.activeDocument,
    extensionHostConnection,
  );
  const [primarySidebar, setPrimarySidebar] = useState<PrimarySidebarView>("explorer");
  const [navigation, navigate] = useReducer(
    reduceWorkbenchNavigation,
    INITIAL_WORKBENCH_NAVIGATION,
  );
  const [updateOpen, setUpdateOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [jsonSchemaTrustRevision, setJsonSchemaTrustRevision] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(false);
  const openExternalFile = useCallback(
    async (path: string) => {
      navigate({ kind: "showEditor" });
      await workspace.openFile(path);
    },
    [workspace.openFile],
  );
  useFileOpening(bootstrap.runtime === "desktop" && !workspace.restoringWorkspace, {
    openFile: openExternalFile,
    reportError: workspace.reportError,
  });
  const terminalAvailable = bootstrap.runtime === "desktop";
  const toggleTerminal = useCallback(() => {
    if (!terminalAvailable) {
      return;
    }
    setTerminalStarted(true);
    setTerminalOpen((current) => !current);
  }, [terminalAvailable]);
  const notifyJsonSchemaTrustChange = useCallback(
    () => setJsonSchemaTrustRevision((current) => current + 1),
    [],
  );

  useEffect(() => {
    void loadEditorPane();
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "F1") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      if (event.code === "Backquote" && !event.shiftKey) {
        if (event.repeat || event.isComposing) {
          return;
        }
        event.preventDefault();
        toggleTerminal();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "p" && event.shiftKey) {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        navigate({ kind: "showEditor" });
        workspace.createFile();
      } else if (key === "o" && event.shiftKey) {
        event.preventDefault();
        setPrimarySidebar("explorer");
        navigate({ kind: "showEditor" });
        void workspace.openFolder();
      } else if (key === "o") {
        event.preventDefault();
        navigate({ kind: "showEditor" });
        void workspace.openFile();
      } else if (key === "s") {
        event.preventDefault();
        void workspace.saveActiveDocument(event.shiftKey);
      } else if (event.key === ",") {
        event.preventDefault();
        navigate({ kind: "openSettings" });
      } else if (key === "x" && event.shiftKey) {
        event.preventDefault();
        setPrimarySidebar("extensions");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    workspace.createFile,
    workspace.openFile,
    workspace.openFolder,
    workspace.saveActiveDocument,
    toggleTerminal,
  ]);

  useEffect(() => {
    const handleExtensionShortcut = (event: KeyboardEvent): void => {
      if (event.repeat || event.isComposing || extensions.status !== "ready") {
        return;
      }
      const commandId = matchingExtensionCommand(
        extensions.snapshot.keybindings,
        event,
        workspace.activeDocument?.languageId ?? null,
      );
      if (commandId === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const command = extensions.snapshot.commands.find((candidate) => candidate.id === commandId);
      if (command?.invocation === "activeTextDocument") {
        navigate({ kind: "showEditor" });
      }
      void extensions.executeCommand(commandId).catch(extensions.reportError);
    };
    window.addEventListener("keydown", handleExtensionShortcut);
    return () => window.removeEventListener("keydown", handleExtensionShortcut);
  }, [extensions, workspace.activeDocument?.languageId]);

  const visiblePreview = previewForActiveDocument(extensions.previews, workspace.activeDocument);
  const previewsWithClosedSources = useMemo(
    () => closedDocumentPreviews(extensions.previews, workspace.documents),
    [extensions.previews, workspace.documents],
  );
  const dismissingPreviewIds = useRef(new Set<string>());
  useEffect(() => {
    for (const preview of previewsWithClosedSources) {
      const { resourceId } = preview;
      if (dismissingPreviewIds.current.has(resourceId)) {
        continue;
      }
      dismissingPreviewIds.current.add(resourceId);
      void extensions
        .dismissPreview(resourceId, preview.sourceUri)
        .catch(extensions.reportError)
        .finally(() => dismissingPreviewIds.current.delete(resourceId));
    }
  }, [extensions.dismissPreview, extensions.reportError, previewsWithClosedSources]);
  const previewSource =
    visiblePreview?.sourceUri === null || visiblePreview === null
      ? null
      : (workspace.documents.find(
          (document) => editorDocumentUri(document) === visiblePreview.sourceUri,
        ) ?? null);
  const openPreviewDocument = useCallback(
    (path: string) => {
      navigate({ kind: "showEditor" });
      void workspace.openFile(path);
    },
    [workspace.openFile],
  );

  const errorMessage = (() => {
    if (workspace.error === null) {
      return null;
    }
    if (workspace.error.code === "file_too_large") {
      return t("error.fileTooLarge");
    }
    if (workspace.error.code === "binary_file") {
      return t("error.binaryFile");
    }
    if (workspace.error.code === "native_only") {
      return t("error.nativeOnly");
    }
    return workspace.error.message || t("error.unknown");
  })();
  const resourceTabs: readonly WorkbenchResourceTab[] = navigation.resources.map((resource) => {
    if (resource.kind === "settings") {
      return {
        id: workbenchResourceId(resource),
        label: t("settings.title"),
        icon: "settingsGear",
      };
    }
    const extension = extensions.snapshot.extensions.find(
      (candidate) => candidate.id === resource.extensionId,
    );
    return {
      id: workbenchResourceId(resource),
      label: t("extensions.tabTitle", {
        name: extension?.displayName ?? resource.extensionId,
      }),
      icon: "extensions",
    };
  });
  const activeResourceTabId =
    navigation.surface.kind === "editor" ? null : workbenchResourceId(navigation.surface);

  return (
    <div className="app-shell">
      {bootstrap.runtime === "browser-preview" ? (
        <div className="preview-banner">
          <Icon name="alert" size={14} />
          {t("app.browserPreview")}
        </div>
      ) : null}

      <div
        className="workbench"
        data-preview={bootstrap.runtime === "browser-preview" || undefined}
      >
        <nav className="activity-bar" aria-label="Primary navigation">
          <IconButton
            label={t("activity.explorer")}
            icon="explorer"
            selected={primarySidebar === "explorer"}
            aria-controls="primary-sidebar-explorer"
            onClick={() => setPrimarySidebar("explorer")}
          />
          <IconButton
            label={t("activity.extensions")}
            icon="extensions"
            selected={primarySidebar === "extensions"}
            aria-controls="primary-sidebar-extensions"
            onClick={() => setPrimarySidebar("extensions")}
          />
          <div className="activity-bar__spacer" />
          <UpdateActivityButton
            label={t("updates.badgeLabel")}
            onOpen={() => setUpdateOpen(true)}
          />
          <IconButton label={t("activity.profileComingSoon")} icon="account" disabled />
          <IconButton
            label={t("activity.settings")}
            icon="settingsGear"
            onClick={() => navigate({ kind: "openSettings" })}
          />
        </nav>

        <div className="primary-sidebar">
          <div
            id="primary-sidebar-explorer"
            className="primary-sidebar__view"
            hidden={primarySidebar !== "explorer"}
          >
            <Explorer
              root={workspace.workspaceRoot}
              entries={workspace.entries}
              restoring={workspace.restoringWorkspace}
              onCreateFile={async (name) => {
                await workspace.createWorkspaceFile(name);
                navigate({ kind: "showEditor" });
              }}
              onOpenFile={() => {
                navigate({ kind: "showEditor" });
                void workspace.openFile();
              }}
              onOpenFolder={() => {
                navigate({ kind: "showEditor" });
                void workspace.openFolder();
              }}
              onOpenWorkspaceFile={(path) => {
                navigate({ kind: "showEditor" });
                void workspace.openFile(path);
              }}
              onToggleDirectory={(path) => void workspace.toggleDirectory(path)}
            />
          </div>
          <ExtensionsSidebar
            active={primarySidebar === "extensions"}
            selectedExtensionId={
              navigation.surface.kind === "extensionDetails" ? navigation.surface.extensionId : null
            }
            system={extensions}
            onSelectExtension={(extensionId) => navigate({ kind: "openExtension", extensionId })}
          />
        </div>

        <div className="workspace-content" data-terminal-open={terminalOpen || undefined}>
          <WorkbenchTabs
            documents={workspace.documents}
            resourceTabs={resourceTabs}
            activeDocumentId={
              navigation.surface.kind === "editor" ? (workspace.activeDocument?.id ?? null) : null
            }
            activeResourceTabId={activeResourceTabId}
            savingIds={workspace.savingIds}
            onActivateDocument={(documentId) => {
              workspace.setActiveDocumentId(documentId);
              navigate({ kind: "showEditor" });
            }}
            onActivateResource={(resourceId) => navigate({ kind: "activateResource", resourceId })}
            onCloseDocument={workspace.requestCloseDocument}
            onCloseResource={(resourceId) => navigate({ kind: "closeResource", resourceId })}
            onReorderDocument={workspace.reorderDocument}
          />
          <div className="workspace-surfaces">
            <main className="editor-area" hidden={navigation.surface.kind !== "editor"}>
              {workspace.activeDocument !== null ? (
                <Suspense fallback={<div className="editor-pane" aria-busy="true" />}>
                  <div
                    className="editor-surface"
                    data-preview={visiblePreview !== null || undefined}
                  >
                    <div className="editor-surface__editor">
                      <EditorPane
                        documents={workspace.documents}
                        activeDocumentId={workspace.activeDocument.id}
                        active={navigation.surface.kind === "editor"}
                        workspaceRootPath={workspace.workspaceRoot?.path ?? null}
                        jsonSchemaTrustRevision={jsonSchemaTrustRevision}
                        onContentChange={workspace.updateDocumentContent}
                        onCursorChange={workspace.setCursor}
                        onJsonSchemaTrustChange={notifyJsonSchemaTrustChange}
                      />
                    </div>
                    {visiblePreview === null ? null : (
                      <Suspense fallback={<aside className="markdown-preview" aria-busy="true" />}>
                        <MarkdownPreview
                          preview={visiblePreview}
                          content={previewSource?.content ?? visiblePreview.content}
                          onOpenDocument={openPreviewDocument}
                          onClose={() => {
                            void extensions
                              .dismissPreview(visiblePreview.resourceId, visiblePreview.sourceUri)
                              .catch(extensions.reportError);
                          }}
                        />
                      </Suspense>
                    )}
                  </div>
                </Suspense>
              ) : (
                <div className="editor-empty-state" aria-hidden="true">
                  <SideralLogo className="editor-empty-state__logo" />
                </div>
              )}
            </main>
            <SettingsView
              active={navigation.surface.kind === "settings"}
              desktopPreferences={desktopPreferences}
              extensions={extensions}
              onJsonSchemaTrustChange={notifyJsonSchemaTrustChange}
              onOpenUpdate={() => setUpdateOpen(true)}
            />
            <ExtensionDetailsView
              active={navigation.surface.kind === "extensionDetails"}
              extensionId={
                navigation.surface.kind === "extensionDetails"
                  ? navigation.surface.extensionId
                  : null
              }
              system={extensions}
              onUninstalled={() => {
                if (navigation.surface.kind === "extensionDetails") {
                  navigate({
                    kind: "closeResource",
                    resourceId: workbenchResourceId(navigation.surface),
                  });
                }
              }}
            />
          </div>
          {terminalStarted ? (
            <Suspense fallback={<section className="terminal-panel" aria-busy="true" />}>
              <IntegratedTerminal
                active={terminalOpen}
                workspaceRoot={workspace.workspaceRoot?.path ?? null}
                onClose={() => setTerminalOpen(false)}
              />
            </Suspense>
          ) : null}
        </div>
      </div>

      <StatusBar
        document={workspace.activeDocument}
        cursor={workspace.cursor}
        terminalAvailable={terminalAvailable}
        terminalOpen={terminalOpen}
        onToggleTerminal={toggleTerminal}
      />

      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
      <ExtensionNotices system={extensions} />
      <ExtensionCommandPalette
        open={commandPaletteOpen}
        system={extensions}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <DiscardChangesDialog
        document={workspace.pendingCloseDocument}
        onCancel={workspace.cancelPendingClose}
        onDiscard={workspace.discardPendingDocument}
        onSave={() => void workspace.savePendingDocument()}
        saving={
          workspace.pendingCloseDocument !== null &&
          workspace.savingIds.has(workspace.pendingCloseDocument.id)
        }
      />
      {errorMessage !== null ? (
        <ErrorToast
          title={t("error.title")}
          message={errorMessage}
          closeLabel={t("action.close")}
          onClose={workspace.clearError}
        />
      ) : null}
    </div>
  );
}

function UpdateActivityButton({
  label,
  onOpen,
}: {
  readonly label: string;
  readonly onOpen: () => void;
}) {
  const updates = useUpdates();
  if (!updates.indicatorVisible) {
    return null;
  }
  return (
    <button
      type="button"
      className={`update-indicator ${updates.transferActive ? "update-indicator--active" : ""}`}
      onClick={onOpen}
      aria-label={label}
      title={label}
    >
      <Icon name="update" size={21} />
      <span />
    </button>
  );
}
