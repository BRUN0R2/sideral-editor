import { useI18n } from "../features/i18n/I18nProvider";
import type { EditorDocument } from "../features/workspace/types";
import { Modal } from "./Modal";

export function DiscardChangesDialog({
  document,
  onCancel,
  onDiscard,
  onSave,
  saving,
}: {
  readonly document: EditorDocument | null;
  readonly onCancel: () => void;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
  readonly saving: boolean;
}) {
  const { t } = useI18n();
  return (
    <Modal
      open={document !== null}
      title={t("editor.dirty")}
      closeLabel={t("action.close")}
      onClose={onCancel}
      className="confirmation-modal"
    >
      <p className="confirmation-copy">
        <strong>{document?.name}</strong>
        <span>{t("editor.closeDirty")}</span>
      </p>
      <footer className="modal-actions">
        <button type="button" className="ghost-button" onClick={onCancel}>
          {t("action.cancel")}
        </button>
        <button
          type="button"
          className={`primary-button ${saving ? "primary-button--busy" : ""}`}
          disabled={saving}
          aria-busy={saving}
          onClick={onSave}
        >
          {saving ? t("status.saving") : t("action.save")}
        </button>
        <button type="button" className="danger-button" onClick={onDiscard}>
          {t("action.discard")}
        </button>
      </footer>
    </Modal>
  );
}
