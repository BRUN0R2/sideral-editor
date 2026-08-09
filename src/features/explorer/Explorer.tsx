import { FileTypeIcon } from "../../components/FileTypeIcon";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useI18n } from "../i18n/I18nProvider";
import type { WorkspaceNode, WorkspaceRoot } from "../workspace/types";

interface ExplorerProps {
  readonly root: WorkspaceRoot | null;
  readonly entries: readonly WorkspaceNode[];
  readonly onNewFile: () => void;
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
  onNewFile,
  onOpenFile,
  onOpenFolder,
  onOpenWorkspaceFile,
  onToggleDirectory,
}: ExplorerProps) {
  const { t } = useI18n();

  return (
    <aside className="explorer-panel" aria-label={t("explorer.title")}>
      <header className="panel-header">
        <h2>{t("explorer.title")}</h2>
        <div className="panel-actions">
          <IconButton label={t("action.newFile")} icon="newFile" onClick={onNewFile} />
          <IconButton label={t("action.openFile")} icon="file" onClick={onOpenFile} />
          <IconButton label={t("action.openFolder")} icon="folderOpen" onClick={onOpenFolder} />
        </div>
      </header>

      {root === null ? (
        <div className="explorer-empty">
          <div className="empty-icon" aria-hidden="true">
            <Icon name="folderOpen" size={22} />
          </div>
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
          {entries.length === 0 ? (
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
