import { FileTypeIcon } from "../../components/FileTypeIcon";
import { Icon } from "../../components/Icon";
import { useI18n } from "../i18n/I18nProvider";
import { type EditorDocument, isDocumentDirty } from "../workspace/types";

interface EditorTabsProps {
  readonly documents: readonly EditorDocument[];
  readonly activeDocumentId: string;
  readonly savingIds: ReadonlySet<string>;
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
}

export function EditorTabs({
  documents,
  activeDocumentId,
  savingIds,
  onActivate,
  onClose,
}: EditorTabsProps) {
  const { t } = useI18n();

  return (
    <div className="editor-tabs" role="tablist">
      {documents.map((document) => {
        const active = document.id === activeDocumentId;
        const dirty = isDocumentDirty(document);
        return (
          <div key={document.id} className={`editor-tab ${active ? "editor-tab--active" : ""}`}>
            <button
              type="button"
              className="editor-tab-main"
              role="tab"
              aria-selected={active}
              aria-label={`${document.name}${dirty ? ` — ${t("editor.dirty")}` : ""}`}
              onClick={() => onActivate(document.id)}
              title={document.path ?? document.name}
            >
              <FileTypeIcon name={document.name} />
              <span>{document.name}</span>
              {savingIds.has(document.id) ? (
                <span className="tab-saving" aria-hidden="true" />
              ) : dirty ? (
                <span className="tab-dirty" aria-hidden="true" />
              ) : null}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`${t("action.close")} ${document.name}`}
              onClick={() => onClose(document.id)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
