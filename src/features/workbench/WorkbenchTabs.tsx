import { type DragEvent, useState } from "react";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { ProductIcon, type ProductIconName } from "../../components/ProductIcon";
import { TabCloseButton } from "../../components/TabCloseButton";
import { useI18n } from "../i18n/I18nProvider";
import { type EditorDocument, isDocumentDirty } from "../workspace/types";

export interface WorkbenchResourceTab {
  readonly id: string;
  readonly label: string;
  readonly icon: ProductIconName;
}

interface WorkbenchTabsProps {
  readonly documents: readonly EditorDocument[];
  readonly resourceTabs: readonly WorkbenchResourceTab[];
  readonly activeDocumentId: string | null;
  readonly activeResourceTabId: string | null;
  readonly savingIds: ReadonlySet<string>;
  readonly onActivateDocument: (id: string) => void;
  readonly onActivateResource: (id: string) => void;
  readonly onCloseDocument: (id: string) => void;
  readonly onCloseResource: (id: string) => void;
  readonly onReorderDocument: (id: string, insertionIndex: number) => void;
}

const TAB_DRAG_TYPE = "application/x-sideral-editor-tab";
const DRAG_SCROLL_EDGE = 48;
const DRAG_SCROLL_STEP = 14;

export function WorkbenchTabs({
  documents,
  resourceTabs,
  activeDocumentId,
  activeResourceTabId,
  savingIds,
  onActivateDocument,
  onActivateResource,
  onCloseDocument,
  onCloseResource,
  onReorderDocument,
}: WorkbenchTabsProps) {
  const { t } = useI18n();
  const [draggedDocumentId, setDraggedDocumentId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const clearDragState = () => {
    setDraggedDocumentId(null);
    setDropIndex(null);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (draggedDocumentId === null) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const container = event.currentTarget;
    const tabs = [...container.querySelectorAll<HTMLElement>("[data-document-tab]")];
    const insertionIndex = tabs.findIndex((tab) => {
      const bounds = tab.getBoundingClientRect();
      return event.clientX < bounds.left + bounds.width / 2;
    });
    setDropIndex(insertionIndex < 0 ? tabs.length : insertionIndex);
    scrollDuringDrag(container, event.clientX);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (draggedDocumentId === null || dropIndex === null) {
      return;
    }
    event.preventDefault();
    const transferredId = event.dataTransfer.getData(TAB_DRAG_TYPE);
    const documentId = transferredId.length > 0 ? transferredId : draggedDocumentId;
    if (documents.some((document) => document.id === documentId)) {
      onReorderDocument(documentId, dropIndex);
    }
    clearDragState();
  };

  return (
    <div className="editor-tabs" role="tablist" onDragOver={handleDragOver} onDrop={handleDrop}>
      {documents.map((document, index) => {
        const active = document.id === activeDocumentId;
        const dirty = isDocumentDirty(document);
        const classNames = [
          "workbench-tab",
          active ? "workbench-tab--active" : "",
          draggedDocumentId === document.id ? "workbench-tab--dragging" : "",
          dropIndex === index ? "workbench-tab--drop-before" : "",
          dropIndex === documents.length && index === documents.length - 1
            ? "workbench-tab--drop-after"
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={document.id} className={classNames} data-document-tab="">
            <button
              type="button"
              className="workbench-tab__main"
              role="tab"
              aria-selected={active}
              aria-label={`${document.name}${dirty ? ` — ${t("editor.dirty")}` : ""}`}
              draggable
              onClick={() => onActivateDocument(document.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(TAB_DRAG_TYPE, document.id);
                setDraggedDocumentId(document.id);
                setDropIndex(index);
              }}
              onDragEnd={clearDragState}
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
            <TabCloseButton label={document.name} onClose={() => onCloseDocument(document.id)} />
          </div>
        );
      })}
      {resourceTabs.map((tab) => {
        const active = tab.id === activeResourceTabId;
        return (
          <div
            key={tab.id}
            className={`workbench-tab workbench-tab--resource ${active ? "workbench-tab--active" : ""}`}
          >
            <button
              type="button"
              className="workbench-tab__main"
              role="tab"
              aria-selected={active}
              onClick={() => onActivateResource(tab.id)}
              title={tab.label}
            >
              <ProductIcon name={tab.icon} />
              <span>{tab.label}</span>
            </button>
            <TabCloseButton label={tab.label} onClose={() => onCloseResource(tab.id)} />
          </div>
        );
      })}
    </div>
  );
}

function scrollDuringDrag(container: HTMLDivElement, pointerX: number): void {
  const bounds = container.getBoundingClientRect();
  if (pointerX < bounds.left + DRAG_SCROLL_EDGE) {
    container.scrollLeft -= DRAG_SCROLL_STEP;
  } else if (pointerX > bounds.right - DRAG_SCROLL_EDGE) {
    container.scrollLeft += DRAG_SCROLL_STEP;
  }
}
