import { lazy, Suspense, useEffect, useState } from "react";
import { DiscardChangesDialog } from "../components/DiscardChangesDialog";
import { ErrorToast } from "../components/ErrorToast";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { EditorTabs } from "../features/editor/EditorTabs";
import { StatusBar } from "../features/editor/StatusBar";
import { WelcomeView } from "../features/editor/WelcomeView";
import { Explorer } from "../features/explorer/Explorer";
import { useI18n } from "../features/i18n/I18nProvider";
import { SettingsModal } from "../features/settings/SettingsModal";
import { UpdateModal } from "../features/updates/UpdateModal";
import { UpdateProvider, useUpdates } from "../features/updates/UpdateProvider";
import { useWorkspace } from "../features/workspace/useWorkspace";

const EditorPane = lazy(async () => {
  const editorModule = await import("../features/editor/EditorPane");
  return { default: editorModule.EditorPane };
});

export function App() {
  const { bootstrap } = useI18n();
  return (
    <UpdateProvider enabled={bootstrap.updaterEnabled} currentVersion={bootstrap.version}>
      <Workbench />
    </UpdateProvider>
  );
}

function Workbench() {
  const { bootstrap, selection, t } = useI18n();
  const updates = useUpdates();
  const workspace = useWorkspace();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        workspace.createFile();
      } else if (key === "o" && event.shiftKey) {
        event.preventDefault();
        void workspace.openFolder();
      } else if (key === "o") {
        event.preventDefault();
        void workspace.openFile();
      } else if (key === "s") {
        event.preventDefault();
        void workspace.saveActiveDocument(event.shiftKey);
      } else if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
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

  const activeSaving =
    workspace.activeDocument !== null && workspace.savingIds.has(workspace.activeDocument.id);
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
      <header className="top-bar">
        <div className="workspace-breadcrumb" title={workspace.workspaceRoot?.path}>
          <span>{t("topbar.workspace")}</span>
          <Icon name="chevronRight" size={13} />
          <strong>{workspace.workspaceRoot?.name ?? t("topbar.untitledWorkspace")}</strong>
        </div>
        <div className="top-actions">
          {workspace.activeDocument !== null ? (
            <IconButton
              label={t("action.save")}
              icon="save"
              disabled={activeSaving}
              onClick={() => void workspace.saveActiveDocument()}
            />
          ) : null}
          {updates.indicatorVisible ? (
            <button
              type="button"
              className={`update-indicator ${updates.transferActive ? "update-indicator--active" : ""}`}
              onClick={() => setUpdateOpen(true)}
              aria-label={t("updates.badgeLabel")}
              title={t("updates.badgeLabel")}
            >
              <Icon name="update" size={17} />
              <span />
            </button>
          ) : null}
        </div>
      </header>

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
          <IconButton label={t("activity.explorer")} icon="folderOpen" selected />
          <div className="activity-bar__spacer" />
          <span className="locale-chip" title={selection.active.name}>
            {selection.active.locale.split("-")[0]?.toUpperCase()}
          </span>
          <IconButton
            label={t("activity.settings")}
            icon="settings"
            selected={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          />
        </nav>

        <Explorer
          root={workspace.workspaceRoot}
          entries={workspace.entries}
          onNewFile={workspace.createFile}
          onOpenFile={() => void workspace.openFile()}
          onOpenFolder={() => void workspace.openFolder()}
          onOpenWorkspaceFile={(path) => void workspace.openFile(path)}
          onToggleDirectory={(path) => void workspace.toggleDirectory(path)}
        />

        <main className="editor-area">
          {workspace.activeDocument === null ? (
            <WelcomeView
              onNewFile={workspace.createFile}
              onOpenFile={() => void workspace.openFile()}
              onOpenFolder={() => void workspace.openFolder()}
            />
          ) : (
            <>
              <EditorTabs
                documents={workspace.documents}
                activeDocumentId={workspace.activeDocument.id}
                savingIds={workspace.savingIds}
                onActivate={workspace.setActiveDocumentId}
                onClose={workspace.requestCloseDocument}
              />
              <Suspense fallback={<div className="editor-pane" aria-busy="true" />}>
                <EditorPane
                  documents={workspace.documents}
                  activeDocumentId={workspace.activeDocument.id}
                  onContentChange={workspace.updateDocumentContent}
                  onCursorChange={workspace.setCursor}
                />
              </Suspense>
            </>
          )}
        </main>
      </div>

      <StatusBar
        document={workspace.activeDocument}
        cursor={workspace.cursor}
        saving={activeSaving}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenUpdate={() => {
          setSettingsOpen(false);
          setUpdateOpen(true);
        }}
      />
      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
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
