import { useI18n } from "../i18n/I18nProvider";
import type { CursorPosition, EditorDocument } from "../workspace/types";

export function StatusBar({
  document,
  cursor,
}: {
  readonly document: EditorDocument | null;
  readonly cursor: CursorPosition;
}) {
  const { t } = useI18n();
  return (
    <footer className="status-bar">
      {document !== null ? (
        <div className="status-bar__right">
          <span>{t("status.lineColumn", { line: cursor.line, column: cursor.column })}</span>
          <span>{t("status.encoding")}</span>
          <span>{document.languageId}</span>
        </div>
      ) : null}
    </footer>
  );
}
