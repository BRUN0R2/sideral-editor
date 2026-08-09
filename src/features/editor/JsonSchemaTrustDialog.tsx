import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import type { JsonSchemaTrustScope } from "../../lib/contracts";
import { useI18n } from "../i18n/I18nProvider";
import type { JsonSchemaSupportController } from "./useJsonSchemaSupport";

export function JsonSchemaTrustDialog({
  controller,
}: {
  readonly controller: JsonSchemaSupportController;
}) {
  const { t } = useI18n();
  const prompt = controller.prompt;

  const grant = (scope: JsonSchemaTrustScope): void => {
    void controller.grantTrust(scope);
  };

  return (
    <Modal
      open={prompt !== null}
      title={t("editor.schemaTrustTitle")}
      className="schema-trust-modal"
      closeLabel={t("action.cancel")}
      dismissible={!controller.busy}
      onClose={controller.cancelTrust}
    >
      {prompt !== null ? (
        <>
          <div className="schema-trust-copy">
            <div className="schema-trust-copy__icon" aria-hidden="true">
              <Icon name="alert" size={20} />
            </div>
            <div>
              <p>{t("editor.schemaTrustDescription")}</p>
              <p>{t("editor.schemaTrustSafety")}</p>
            </div>
          </div>
          <dl className="schema-trust-location">
            <div>
              <dt>{t("editor.schemaLocation")}</dt>
              <dd>
                <code>{prompt.uri}</code>
              </dd>
            </div>
            <div>
              <dt>{t("editor.schemaOrigin")}</dt>
              <dd>
                <code>{prompt.origin}</code>
              </dd>
            </div>
          </dl>
          {controller.error !== null ? (
            <div className="inline-alert inline-alert--error" role="alert">
              <Icon name="alert" size={16} />
              <span>{controller.error}</span>
            </div>
          ) : null}
          <div className="modal-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={controller.busy}
              onClick={controller.cancelTrust}
            >
              {t("action.cancel")}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={controller.busy}
              onClick={() => grant("origin")}
            >
              {t("action.trustSchemaOrigin")}
            </button>
            <button
              type="button"
              className={controller.busy ? "primary-button primary-button--busy" : "primary-button"}
              disabled={controller.busy}
              onClick={() => grant("uri")}
            >
              {t("action.trustSchemaUri")}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
