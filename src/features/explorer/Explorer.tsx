import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import type { WorkspaceIssue } from "../../lib/contracts";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";
import { workspaceFolderForPath } from "../workspace/project-settings";
import type { WorkspaceFolder, WorkspaceNode } from "../workspace/types";
import { validateNewFileName } from "./new-file-name";
import { getTreeChildrenAnimationTiming } from "./tree-animation";

interface ExplorerProps {
  readonly folders: readonly WorkspaceFolder[];
  readonly issues: readonly WorkspaceIssue[];
  readonly selectedFolderPath: string | null;
  readonly restoring: boolean;
  readonly onCreateFile: (path: string, name: string) => Promise<void>;
  readonly onOpenFile: () => void;
  readonly onOpenFolder: () => void;
  readonly onOpenWorkspaceFile: (path: string) => void;
  readonly onToggleDirectory: (path: string) => void;
  readonly onToggleFolder: (path: string) => void;
  readonly onSelectFolder: (path: string) => void;
  readonly onRemoveFolder: (path: string) => void;
  readonly onConfigureFolder: (path: string) => void;
}

const TREE_ROOT_INDENT_PIXELS = 16;
const TREE_LEVEL_INDENT_PIXELS = 13;
const TREE_LEADING_COLUMN_WITH_GAP_PIXELS = 21;

interface TreeChildrenAnimationStyle extends CSSProperties {
  readonly "--tree-children-duration": string;
  readonly "--tree-children-fade-duration": string;
}

export function Explorer({
  folders,
  issues,
  selectedFolderPath,
  restoring,
  onCreateFile,
  onOpenFile,
  onOpenFolder,
  onOpenWorkspaceFile,
  onToggleDirectory,
  onToggleFolder,
  onSelectFolder,
  onRemoveFolder,
  onConfigureFolder,
}: ExplorerProps) {
  const { t } = useI18n();
  const [newFileDraft, setNewFileDraft] = useState<string | null>(null);
  const [newFileError, setNewFileError] = useState<string | null>(null);
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileRootPath, setNewFileRootPath] = useState<string | null>(null);
  const newFileInputRef = useRef<HTMLInputElement>(null);
  const submissionInProgress = useRef(false);
  const rootPath = folders.some((folder) => folder.path === newFileRootPath && folder.available)
    ? newFileRootPath
    : null;
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;

  useEffect(() => {
    if (newFileRootPath !== null && rootPath === null) {
      setNewFileDraft(null);
      setNewFileError(null);
    }
  }, [newFileRootPath, rootPath]);

  useEffect(() => {
    if (newFileDraft !== null && !creatingFile) {
      newFileInputRef.current?.focus();
    }
  }, [creatingFile, newFileDraft]);

  const startNewFile = (folder: WorkspaceFolder | undefined) => {
    if (folder === undefined || !folder.available || submissionInProgress.current) return;
    onSelectFolder(folder.path);
    if (!folder.expanded) onToggleFolder(folder.path);
    setNewFileRootPath(folder.path);
    setNewFileError(null);
    if (newFileDraft === null || folder.path !== newFileRootPath) {
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
    if (newFileDraft === null || rootPath === null || submissionInProgress.current) {
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
      await onCreateFile(rootPath, submittedName);
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
        {folders.length > 0 ? (
          <div className="panel-actions">
            <IconButton
              label={t("action.newFile")}
              icon="newFile"
              disabled={!folders.some((folder) => folder.available)}
              onClick={() =>
                startNewFile(
                  folders.find(
                    (folder) => folder.path === selectedFolderPath && folder.available,
                  ) ?? folders.find((folder) => folder.available),
                )
              }
            />
            <IconButton label={t("action.openFile")} icon="file" onClick={onOpenFile} />
            <IconButton label={t("explorer.addFolders")} icon="folderOpen" onClick={onOpenFolder} />
          </div>
        ) : null}
      </header>

      {folders.length === 0 && restoring ? (
        <div className="explorer-empty" role="status">
          <p>{t("explorer.loading")}</p>
        </div>
      ) : folders.length === 0 ? (
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
        <div className="tree">
          {folders.map((folder) => (
            <section key={folder.path} className="workspace-folder" aria-label={folder.name}>
              <div
                className={`workspace-root ${folder.path === selectedFolderPath ? "workspace-root--selected" : ""}`}
              >
                <button
                  type="button"
                  className="workspace-root__toggle"
                  aria-expanded={folder.expanded}
                  aria-current={folder.path === selectedFolderPath ? "true" : undefined}
                  title={folder.path}
                  disabled={!folder.available}
                  onClick={() => onToggleFolder(folder.path)}
                >
                  <Icon className="workspace-root__chevron" name="chevronRight" size={16} />
                  <Icon name="folderOpen" size={17} />
                  <span>{folder.name}</span>
                </button>
                <div className="workspace-root__actions">
                  <IconButton
                    label={t("explorer.configureFolder", { name: folder.name })}
                    icon="settingsGear"
                    disabled={!folder.available}
                    onClick={() => onConfigureFolder(folder.path)}
                  />
                  <IconButton
                    label={t("explorer.removeFolder", { name: folder.name })}
                    icon="close"
                    onClick={() => onRemoveFolder(folder.path)}
                  />
                </div>
              </div>
              {issues
                .filter(
                  (issue) => workspaceFolderForPath(folders, issue.path)?.path === folder.path,
                )
                .map((issue) => (
                  <p
                    key={`${issue.path}:${issue.message}`}
                    className="workspace-folder__issue"
                    role="alert"
                    title={issue.path}
                  >
                    {issue.message}
                  </p>
                ))}
              <div hidden={!folder.expanded}>
                {newFileDraft !== null && folder.path === newFileRootPath ? (
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
                {folder.loading ? (
                  <p className="tree-empty" role="status">
                    {t("explorer.loading")}
                  </p>
                ) : folder.entries?.length === 0 &&
                  (newFileDraft === null || folder.path !== newFileRootPath) ? (
                  <p className="tree-empty">{t("explorer.empty")}</p>
                ) : (
                  folder.entries?.map((node) => (
                    <TreeNode
                      key={node.path}
                      node={node}
                      depth={0}
                      onOpenFile={onOpenWorkspaceFile}
                      onToggleDirectory={onToggleDirectory}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
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
  const childrenVisible = isDirectory && node.expanded && node.children !== null;
  const childrenAnimationStyle = isDirectory
    ? getTreeChildrenAnimationStyle(node.children)
    : undefined;
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
            <Icon className="tree-chevron" name="chevronRight" size={17} />
          ) : (
            <FileTypeIcon name={node.name} />
          )}
        </span>
        <span className="tree-label">{node.name}</span>
      </button>
      {isDirectory ? (
        <div
          className={`tree-children ${childrenVisible ? "tree-children--expanded" : ""}`}
          aria-hidden={!childrenVisible}
          inert={!childrenVisible}
          style={childrenAnimationStyle}
        >
          <div className="tree-children__content">
            {node.children === null ? null : node.children.length === 0 ? (
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
        </div>
      ) : null}
    </div>
  );
}

function getTreeChildrenAnimationStyle(
  children: readonly WorkspaceNode[] | null,
): TreeChildrenAnimationStyle {
  const timing = getTreeChildrenAnimationTiming(children);
  return {
    "--tree-children-duration": `${timing.durationMs}ms`,
    "--tree-children-fade-duration": `${timing.fadeDurationMs}ms`,
  };
}
