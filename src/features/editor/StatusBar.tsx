import { ProductIcon } from "../../components/ProductIcon";
import { useI18n } from "../i18n/I18nProvider";
import type { CursorPosition, EditorDocument } from "../workspace/types";

export function StatusBar({
  document,
  cursor,
  terminalAvailable,
  terminalOpen,
  onToggleTerminal,
}: {
  readonly document: EditorDocument | null;
  readonly cursor: CursorPosition;
  readonly terminalAvailable: boolean;
  readonly terminalOpen: boolean;
  readonly onToggleTerminal: () => void;
}) {
  const { t } = useI18n();
  return (
    <footer className="status-bar">
      {terminalAvailable ? (
        <button
          type="button"
          className="status-bar__terminal"
          aria-label={t("terminal.toggle")}
          aria-pressed={terminalOpen}
          title={`${t("terminal.toggle")} (Ctrl+\u0060)`}
          onClick={onToggleTerminal}
        >
          <ProductIcon name="terminal" />
          <span>{t("terminal.title")}</span>
        </button>
      ) : (
        <span />
      )}
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
