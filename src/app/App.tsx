import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { DiscardChangesDialog } from "../components/DiscardChangesDialog";
import { ErrorToast } from "../components/ErrorToast";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { EditorTabs } from "../features/editor/EditorTabs";
import { StatusBar } from "../features/editor/StatusBar";
import { Explorer } from "../features/explorer/Explorer";
import { useI18n } from "../features/i18n/I18nProvider";
import { SettingsView } from "../features/settings/SettingsView";
import { useDesktopPreferences } from "../features/settings/useDesktopPreferences";
import { ExtensionCommandPalette } from "../features/sideral-extensions/ExtensionCommandPalette";
import { ExtensionNotices } from "../features/sideral-extensions/ExtensionNotices";
import { ExtensionsView } from "../features/sideral-extensions/ExtensionsView";
import type { ExtensionHostConnection } from "../features/sideral-extensions/host/connection";
import { matchingExtensionCommand } from "../features/sideral-extensions/keybindings";
import { useExtensionSystem } from "../features/sideral-extensions/useExtensionSystem";
import { UpdateModal } from "../features/updates/UpdateModal";
import { UpdateProvider, useUpdates } from "../features/updates/UpdateProvider";
import { editorDocumentUri } from "../features/workspace/document-uri";
import { useWorkspace } from "../features/workspace/useWorkspace";
import { installWebViewShortcutGuard } from "./webview-shortcuts";

const loadEditorPane = async () => {
  const editorModule = await import("../features/editor/EditorPane");
  return { default: editorModule.EditorPane };
};
const EditorPane = lazy(loadEditorPane);
const MarkdownPreview = lazy(async () => {
  const module = await import("../features/sideral-extensions/MarkdownPreview");
  return { default: module.MarkdownPreview };
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
  const [activeView, setActiveView] = useState<"editor" | "extensions" | "settings">("editor");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [jsonSchemaTrustRevision, setJsonSchemaTrustRevision] = useState(0);
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
      const key = event.key.toLowerCase();
      if (key === "p" && event.shiftKey) {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        setActiveView("editor");
        workspace.createFile();
      } else if (key === "o" && event.shiftKey) {
        event.preventDefault();
        setActiveView("editor");
        void workspace.openFolder();
      } else if (key === "o") {
        event.preventDefault();
        setActiveView("editor");
        void workspace.openFile();
      } else if (key === "s") {
        event.preventDefault();
        void workspace.saveActiveDocument(event.shiftKey);
      } else if (event.key === ",") {
        event.preventDefault();
        setActiveView("settings");
      } else if (key === "x" && event.shiftKey) {
        event.preventDefault();
        setActiveView("extensions");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    workspace.createFile,
    workspace.openFile,
    workspace.openFolder,
    workspace.saveActiveDocument,
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
        setActiveView("editor");
      }
      void extensions.executeCommand(commandId).catch(() => undefined);
    };
    window.addEventListener("keydown", handleExtensionShortcut);
    return () => window.removeEventListener("keydown", handleExtensionShortcut);
  }, [extensions, workspace.activeDocument?.languageId]);

  const visiblePreview = extensions.previews.find((preview) => preview.visible) ?? null;
  const previewSource =
    visiblePreview?.sourceUri === null || visiblePreview === null
      ? null
      : (workspace.documents.find(
          (document) => editorDocumentUri(document) === visiblePreview.sourceUri,
        ) ?? null);
  const openPreviewDocument = useCallback(
    (path: string) => {
      setActiveView("editor");
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
            selected={activeView === "editor"}
            onClick={() => setActiveView("editor")}
          />
          <IconButton
            label={t("activity.extensions")}
            icon="extensions"
            selected={activeView === "extensions"}
            onClick={() => setActiveView("extensions")}
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
            selected={activeView === "settings"}
            onClick={() => setActiveView("settings")}
          />
        </nav>

        <Explorer
          root={workspace.workspaceRoot}
          entries={workspace.entries}
          onCreateFile={async (name) => {
            await workspace.createWorkspaceFile(name);
            setActiveView("editor");
          }}
          onOpenFile={() => {
            setActiveView("editor");
            void workspace.openFile();
          }}
          onOpenFolder={() => {
            setActiveView("editor");
            void workspace.openFolder();
          }}
          onOpenWorkspaceFile={(path) => {
            setActiveView("editor");
            void workspace.openFile(path);
          }}
          onToggleDirectory={(path) => void workspace.toggleDirectory(path)}
        />

        <div className="workspace-content">
          <main className="editor-area" hidden={activeView !== "editor"}>
            {workspace.activeDocument !== null ? (
              <>
                <EditorTabs
                  documents={workspace.documents}
                  activeDocumentId={workspace.activeDocument.id}
                  savingIds={workspace.savingIds}
                  onActivate={workspace.setActiveDocumentId}
                  onClose={workspace.requestCloseDocument}
                  onReorder={workspace.reorderDocument}
                />
                <Suspense fallback={<div className="editor-pane" aria-busy="true" />}>
                  <div
                    className="editor-surface"
                    data-preview={visiblePreview !== null || undefined}
                  >
                    <div className="editor-surface__editor">
                      <EditorPane
                        documents={workspace.documents}
                        activeDocumentId={workspace.activeDocument.id}
                        active={activeView === "editor"}
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
                              .dismissPreview(visiblePreview.resourceId)
                              .catch(() => undefined);
                          }}
                        />
                      </Suspense>
                    )}
                  </div>
                </Suspense>
              </>
            ) : null}
          </main>
          <SettingsView
            active={activeView === "settings"}
            desktopPreferences={desktopPreferences}
            extensions={extensions}
            onJsonSchemaTrustChange={notifyJsonSchemaTrustChange}
            onOpenUpdate={() => setUpdateOpen(true)}
          />
          <ExtensionsView active={activeView === "extensions"} system={extensions} />
        </div>
      </div>

      <StatusBar document={workspace.activeDocument} cursor={workspace.cursor} />

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
