import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { Icon } from "../../components/Icon";
import { ProductIcon, type ProductIconName } from "../../components/ProductIcon";
import { TabCloseButton } from "../../components/TabCloseButton";
import { useI18n } from "../i18n/I18nProvider";
import { type EditorDocument, isDocumentDirty } from "../workspace/types";
import { reorderTabAt, synchronizeTabOrder } from "./tab-order";
import { useTabDrag } from "./useTabDrag";

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
}

type WorkbenchTab =
  | { readonly kind: "document"; readonly document: EditorDocument }
  | { readonly kind: "resource"; readonly resource: WorkbenchResourceTab };

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
}: WorkbenchTabsProps) {
  const { t } = useI18n();
  const blockedNoticeId = useId();
  const [tabOrder, setTabOrder] = useState<readonly string[]>([]);
  const tabsById = new Map<string, WorkbenchTab>();
  for (const document of documents) {
    tabsById.set(`document:${document.id}`, { kind: "document", document });
  }
  for (const resource of resourceTabs) {
    tabsById.set(`resource:${resource.id}`, { kind: "resource", resource });
  }
  const orderedTabIds = synchronizeTabOrder(tabOrder, [...tabsById.keys()]);
  if (orderedTabIds !== tabOrder) {
    setTabOrder(orderedTabIds);
  }

  const drag = useTabDrag({
    tabIds: orderedTabIds,
    onReorder: (tabId, insertionIndex) => {
      setTabOrder((current) => reorderTabAt(current, tabId, insertionIndex));
    },
  });
  const dropIndex = drag.feedback?.dropIndex ?? null;

  return (
    <>
      <div
        {...drag.stripProps}
        className="editor-tabs"
        role="tablist"
        data-drop-blocked={drag.feedback?.blocked || undefined}
      >
        {orderedTabIds.map((tabId, index) => {
          const tab = tabsById.get(tabId);
          if (tab === undefined) {
            return null;
          }
          const document = tab.kind === "document" ? tab.document : null;
          const label = tab.kind === "document" ? tab.document.name : tab.resource.label;
          const active =
            tab.kind === "document"
              ? tab.document.id === activeDocumentId
              : tab.resource.id === activeResourceTabId;
          const dirty = document !== null && isDocumentDirty(document);
          const held = drag.feedback?.tabId === tabId;
          const classNames = [
            "workbench-tab",
            tab.kind === "resource" ? "workbench-tab--resource" : "",
            active ? "workbench-tab--active" : "",
            held ? "workbench-tab--held" : "",
            held && drag.feedback?.dragging ? "workbench-tab--dragging" : "",
            dropIndex === index ? "workbench-tab--drop-before" : "",
            dropIndex === orderedTabIds.length && index === orderedTabIds.length - 1
              ? "workbench-tab--drop-after"
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={tabId} className={classNames} data-workbench-tab="">
              <button
                type="button"
                className="workbench-tab__main"
                role="tab"
                aria-selected={active}
                aria-label={`${label}${dirty ? ` — ${t("editor.dirty")}` : ""}`}
                aria-describedby={held && drag.feedback?.blocked ? blockedNoticeId : undefined}
                style={
                  held ? { cursor: drag.feedback?.blocked ? "not-allowed" : "grabbing" } : undefined
                }
                draggable={false}
                onPointerDown={(event) => drag.beginDrag(event, tabId)}
                onClick={() => {
                  if (tab.kind === "document") {
                    onActivateDocument(tab.document.id);
                  } else {
                    onActivateResource(tab.resource.id);
                  }
                }}
                title={held ? undefined : (document?.path ?? label)}
              >
                {tab.kind === "document" ? (
                  <FileTypeIcon name={tab.document.name} />
                ) : (
                  <ProductIcon name={tab.resource.icon} />
                )}
                <span>{label}</span>
                {document !== null && savingIds.has(document.id) ? (
                  <span className="tab-saving" aria-hidden="true" />
                ) : dirty ? (
                  <span className="tab-dirty" aria-hidden="true" />
                ) : null}
              </button>
              <TabCloseButton
                label={label}
                onClose={() => {
                  if (tab.kind === "document") {
                    onCloseDocument(tab.document.id);
                  } else {
                    onCloseResource(tab.resource.id);
                  }
                }}
              />
            </div>
          );
        })}
      </div>
      {drag.feedback !== null
        ? createPortal(
            <>
              <div
                className="workbench-tab-drag-surface"
                aria-hidden="true"
                data-drop-blocked={drag.feedback.blocked || undefined}
              />
              {drag.feedback.blocked ? (
                <div
                  id={blockedNoticeId}
                  className="workbench-tab-drop-notice"
                  role="status"
                  style={{ left: drag.feedback.noticeLeft, top: drag.feedback.noticeTop }}
                >
                  <Icon name="blocked" size={16} />
                  <span>{t("editor.tabDropBlocked")}</span>
                </div>
              ) : null}
            </>,
            document.body,
          )
        : null}
    </>
  );
}
