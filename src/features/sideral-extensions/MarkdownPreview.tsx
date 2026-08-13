import { useMemo } from "react";
import { IconButton } from "../../components/IconButton";
import { scrollbarCustomProperties } from "../../theme/scrollbar";
import { useI18n } from "../i18n/I18nProvider";
import type { PreviewDocumentView } from "./contracts";
import { renderMarkdown } from "./markdown-renderer";

export function MarkdownPreview({
  preview,
  content,
  onClose,
  onOpenDocument,
}: {
  readonly preview: PreviewDocumentView;
  readonly content: string;
  readonly onClose: () => void;
  readonly onOpenDocument: (path: string) => void;
}) {
  const { t } = useI18n();
  const document = useMemo(
    () =>
      renderMarkdown(content, {
        sourceUri: preview.sourceUri,
        onOpenDocument,
      }),
    [content, onOpenDocument, preview.sourceUri],
  );

  return (
    <aside
      className="markdown-preview"
      aria-label={preview.title}
      style={scrollbarCustomProperties(preview.appearance?.scrollbar)}
    >
      <header className="markdown-preview__header">
        <div>
          <span>{preview.title}</span>
          <small>Markdown</small>
        </div>
        <IconButton label={t("action.close")} icon="close" onClick={onClose} />
      </header>
      <article className="markdown-preview__document">{document}</article>
    </aside>
  );
}
