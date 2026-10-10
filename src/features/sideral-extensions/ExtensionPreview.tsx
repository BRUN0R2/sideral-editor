import type { PreviewElement, PreviewNode } from "@sideral/extension-sdk";
import { createElement, type ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { isDesktopRuntime, openExternalUrl } from "../../lib/backend";
import { scrollbarCustomProperties } from "../../theme/scrollbar";
import { useI18n } from "../i18n/I18nProvider";
import { fileUriToPath } from "../workspace/document-uri";
import type { PreviewDocumentView } from "./contracts";

export function ExtensionPreview({
  preview,
  onClose,
  onOpenDocument,
  onError,
}: {
  readonly preview: PreviewDocumentView;
  readonly onClose: () => void;
  readonly onOpenDocument: (path: string) => void;
  readonly onError: (reason: unknown) => void;
}) {
  const { t } = useI18n();
  return (
    <aside
      className="extension-preview"
      aria-label={preview.title}
      style={scrollbarCustomProperties(preview.appearance?.scrollbar)}
    >
      <header className="extension-preview__header">
        <span>{preview.title}</span>
        <IconButton label={t("action.close")} icon="close" onClick={onClose} />
      </header>
      <div className="extension-preview__content">
        {renderPreviewNodes(preview.content, { onOpenDocument, onError })}
      </div>
    </aside>
  );
}

interface PreviewActions {
  readonly onOpenDocument: (path: string) => void;
  readonly onError: (reason: unknown) => void;
}

export function renderPreviewNodes(
  nodes: readonly PreviewNode[],
  actions: PreviewActions,
): readonly ReactNode[] {
  return nodes.map((node) => (typeof node === "string" ? node : renderElement(node, actions)));
}

function renderElement(node: PreviewElement, actions: PreviewActions): ReactNode {
  const { href, title, start, language } = node.attributes ?? {};
  return createElement(
    node.tag,
    {
      key: node.key,
      style: node.style,
      title,
      ...(start === undefined ? {} : { start }),
      ...(language === undefined ? {} : { "data-language": language }),
      ...(href === undefined
        ? {}
        : {
            href,
            rel: "noreferrer",
            onClick(event: { preventDefault(): void }) {
              if (href.startsWith("#")) return;
              event.preventDefault();
              const path = fileUriToPath(href);
              if (path !== null) actions.onOpenDocument(path);
              else if (isDesktopRuntime()) void openExternalUrl(href).catch(actions.onError);
            },
          }),
    },
    ...(node.children.length === 0 ? [] : renderPreviewNodes(node.children, actions)),
  );
}
