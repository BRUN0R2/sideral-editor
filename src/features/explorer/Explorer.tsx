import { useEffect, useRef, useState } from "react";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";
import type { WorkspaceNode, WorkspaceRoot } from "../workspace/types";
import { validateNewFileName } from "./new-file-name";

interface ExplorerProps {
  readonly root: WorkspaceRoot | null;
  readonly entries: readonly WorkspaceNode[];
  readonly restoring: boolean;
  readonly onCreateFile: (name: string) => Promise<void>;
  readonly onOpenFile: () => void;
  readonly onOpenFolder: () => void;
  readonly onOpenWorkspaceFile: (path: string) => void;
  readonly onToggleDirectory: (path: string) => void;
}

const TREE_ROOT_INDENT_PIXELS = 16;
const TREE_LEVEL_INDENT_PIXELS = 13;
const TREE_LEADING_COLUMN_WITH_GAP_PIXELS = 21;

export function Explorer({
  root,
  entries,
  restoring,
  onCreateFile,
  onOpenFile,
  onOpenFolder,
  onOpenWorkspaceFile,
  onToggleDirectory,
}: ExplorerProps) {
  const { t } = useI18n();
  const [newFileDraft, setNewFileDraft] = useState<string | null>(null);
  const [newFileError, setNewFileError] = useState<string | null>(null);
  const [creatingFile, setCreatingFile] = useState(false);
  const newFileInputRef = useRef<HTMLInputElement>(null);
  const submissionInProgress = useRef(false);
  const rootPath = root?.path ?? null;
  const rootPathRef = useRef(rootPath);
  const previousRootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;

  useEffect(() => {
    if (previousRootPathRef.current === rootPath) {
      return;
    }
    previousRootPathRef.current = rootPath;
    setNewFileDraft(null);
    setNewFileError(null);
  }, [rootPath]);

  useEffect(() => {
    if (newFileDraft !== null && !creatingFile) {
      newFileInputRef.current?.focus();
    }
  }, [creatingFile, newFileDraft]);

  const startNewFile = () => {
    setNewFileError(null);
    if (newFileDraft === null) {
      setNewFileDraft("");
    } else {
      newFileInputRef.current?.focus();
    }
  };

  const cancelNewFile = () => {
    if (submissionInProgress.current) {
      return;
    }
    setNewFileDraft(null);
    setNewFileError(null);
  };

  const submitNewFile = async () => {
    if (newFileDraft === null || submissionInProgress.current) {
      return;
    }

    const issue = validateNewFileName(newFileDraft);
    if (issue !== null) {
      setNewFileError(
        t(issue === "required" ? "explorer.fileNameRequired" : "explorer.fileNameInvalid"),
      );
      focusNewFileInput(newFileInputRef);
      return;
    }

    const submittedName = newFileDraft;
    const submittedRoot = rootPath;
    submissionInProgress.current = true;
    setCreatingFile(true);
    setNewFileError(null);
    try {
      await onCreateFile(submittedName);
      if (rootPathRef.current === submittedRoot) {
        setNewFileDraft(null);
      }
    } catch (caught) {
      if (rootPathRef.current === submittedRoot) {
        const error = toApplicationError(caught);
        const message =
          error.code === "file_already_exists"
            ? t("explorer.fileAlreadyExists", { name: submittedName })
            : error.code === "invalid_file_name"
              ? t("explorer.fileNameInvalid")
              : t("explorer.fileCreateFailed", { reason: error.message });
        setNewFileError(message);
        focusNewFileInput(newFileInputRef);
      }
    } finally {
      submissionInProgress.current = false;
      setCreatingFile(false);
    }
  };

  return (
    <aside className="explorer-panel" aria-label={t("explorer.title")}>
      <header className="panel-header">
        <h2>{t("explorer.title")}</h2>
        {root !== null ? (
          <div className="panel-actions">
            <IconButton label={t("action.newFile")} icon="newFile" onClick={startNewFile} />
            <IconButton label={t("action.openFile")} icon="file" onClick={onOpenFile} />
            <IconButton label={t("action.openFolder")} icon="folderOpen" onClick={onOpenFolder} />
          </div>
        ) : null}
      </header>

      {root === null && restoring ? (
        <div className="explorer-empty" role="status">
          <p>{t("explorer.loading")}</p>
        </div>
      ) : root === null ? (
        <div className="explorer-empty">
          <h3>{t("explorer.noFolderTitle")}</h3>
          <p>{t("explorer.noFolderDescription")}</p>
          <button
            type="button"
            className="secondary-button secondary-button--wide"
            onClick={onOpenFolder}
          >
            <Icon name="folderOpen" size={16} />
            {t("action.openFolder")}
          </button>
        </div>
      ) : (
        <section className="tree" aria-label={root.name}>
          <div className="workspace-root">
            <Icon name="folderOpen" size={18} />
            <span title={root.path}>{root.name}</span>
          </div>
          {newFileDraft !== null ? (
            <div className="tree-new-file">
              <div className="tree-new-file__row">
                <span className="tree-leading">
                  <FileTypeIcon name={newFileDraft} />
                </span>
                <input
                  ref={newFileInputRef}
                  className="tree-new-file__input"
                  value={newFileDraft}
                  aria-label={t("explorer.newFileAriaLabel")}
                  aria-invalid={newFileError !== null}
                  aria-describedby={newFileError === null ? undefined : "new-file-name-error"}
                  placeholder={t("explorer.newFilePlaceholder")}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={creatingFile}
                  onChange={(event) => {
                    setNewFileDraft(event.target.value);
                    setNewFileError(null);
                  }}
                  onBlur={() => {
                    if (newFileDraft.trim().length === 0) {
                      cancelNewFile();
                    } else {
                      void submitNewFile();
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      void submitNewFile();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelNewFile();
                    }
                  }}
                />
              </div>
              {newFileError !== null ? (
                <div id="new-file-name-error" className="tree-new-file__error" role="alert">
                  {newFileError}
                </div>
              ) : null}
            </div>
          ) : null}
          {entries.length === 0 && newFileDraft === null ? (
            <p className="tree-empty">{t("explorer.empty")}</p>
          ) : (
            entries.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                onOpenFile={onOpenWorkspaceFile}
                onToggleDirectory={onToggleDirectory}
              />
            ))
          )}
        </section>
      )}
    </aside>
  );
}

function focusNewFileInput(input: React.RefObject<HTMLInputElement | null>): void {
  window.requestAnimationFrame(() => input.current?.focus());
}

function TreeNode({
  node,
  depth,
  onOpenFile,
  onToggleDirectory,
}: {
  readonly node: WorkspaceNode;
  readonly depth: number;
  readonly onOpenFile: (path: string) => void;
  readonly onToggleDirectory: (path: string) => void;
}) {
  const { t } = useI18n();
  const isDirectory = node.kind === "directory";
  const isSymbolicLink = node.kind === "symbolicLink";
  const activate = () => {
    if (isDirectory) {
      onToggleDirectory(node.path);
    } else if (!isSymbolicLink) {
      onOpenFile(node.path);
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`tree-row ${isSymbolicLink ? "tree-row--disabled" : ""}`}
        aria-expanded={isDirectory ? node.expanded : undefined}
        style={{
          paddingInlineStart: `${TREE_ROOT_INDENT_PIXELS + depth * TREE_LEVEL_INDENT_PIXELS}px`,
        }}
        onClick={activate}
        disabled={isSymbolicLink}
        title={isSymbolicLink ? t("explorer.symlink") : node.path}
      >
        <span
          className={`tree-leading ${isDirectory && node.loading ? "tree-leading--loading" : ""}`}
        >
          {isDirectory ? (
            <Icon name={node.expanded ? "chevronDown" : "chevronRight"} size={17} />
          ) : (
            <FileTypeIcon name={node.name} />
          )}
        </span>
        <span className="tree-label">{node.name}</span>
      </button>
      {isDirectory && node.expanded && node.children !== null ? (
        <div>
          {node.children.length === 0 ? (
            <div
              className="tree-empty tree-empty--nested"
              style={{
                paddingInlineStart: `${TREE_ROOT_INDENT_PIXELS + TREE_LEADING_COLUMN_WITH_GAP_PIXELS + depth * TREE_LEVEL_INDENT_PIXELS}px`,
              }}
            >
              {t("explorer.empty")}
            </div>
          ) : (
            node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                onToggleDirectory={onToggleDirectory}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
