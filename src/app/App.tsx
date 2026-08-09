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
import { SettingsView } from "../features/settings/SettingsView";
import { UpdateModal } from "../features/updates/UpdateModal";
import { UpdateProvider, useUpdates } from "../features/updates/UpdateProvider";
import { useWorkspace } from "../features/workspace/useWorkspace";

const loadEditorPane = async () => {
  const editorModule = await import("../features/editor/EditorPane");
  return { default: editorModule.EditorPane };
};
const EditorPane = lazy(loadEditorPane);

export function App() {
  const { bootstrap } = useI18n();
  return (
    <UpdateProvider enabled={bootstrap.updaterEnabled} currentVersion={bootstrap.version}>
      <Workbench />
    </UpdateProvider>
  );
}

function Workbench() {
  const { bootstrap, t } = useI18n();
  const workspace = useWorkspace();
  const [activeView, setActiveView] = useState<"editor" | "settings">("editor");
  const [updateOpen, setUpdateOpen] = useState(false);

  useEffect(() => {
    void loadEditorPane();
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "n" && !event.shiftKey) {
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
            icon="folderOpen"
            selected={activeView === "editor"}
            onClick={() => setActiveView("editor")}
          />
          {workspace.activeDocument !== null ? (
            <IconButton
              label={t("action.save")}
              icon="save"
              onClick={() => void workspace.saveActiveDocument()}
            />
          ) : null}
          <div className="activity-bar__spacer" />
          <UpdateActivityButton
            label={t("updates.badgeLabel")}
            onOpen={() => setUpdateOpen(true)}
          />
          <IconButton
            label={t("activity.settings")}
            icon="settings"
            selected={activeView === "settings"}
            onClick={() => setActiveView("settings")}
          />
        </nav>

        <Explorer
          root={workspace.workspaceRoot}
          entries={workspace.entries}
          onNewFile={() => {
            setActiveView("editor");
            workspace.createFile();
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
          <SettingsView
            active={activeView === "settings"}
            onOpenUpdate={() => setUpdateOpen(true)}
          />
        </div>
      </div>

      <StatusBar
        document={workspace.activeDocument}
        cursor={workspace.cursor}
        saving={activeSaving}
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
