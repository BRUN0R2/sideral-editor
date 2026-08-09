import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { getJsonSchemaTrustSettings, revokeJsonSchemaTrust } from "../../lib/backend";
import type { JsonSchemaTrustScope, JsonSchemaTrustSettings } from "../../lib/contracts";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";

export function JsonSchemaSettings({
  active,
  onTrustChange,
}: {
  readonly active: boolean;
  readonly onTrustChange: () => void;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<JsonSchemaTrustSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const customTrust = [
    ...(settings?.origins.map((value) => ({ scope: "origin" as const, value })) ?? []),
    ...(settings?.uris.map((value) => ({ scope: "uri" as const, value })) ?? []),
  ];

  useEffect(() => {
    if (!active) {
      return;
    }
    let requestActive = true;
    setLoading(true);
    setError(null);
    void getJsonSchemaTrustSettings()
      .then((result) => {
        if (requestActive) {
          setSettings(result);
        }
      })
      .catch((caught: unknown) => {
        if (requestActive) {
          setError(toApplicationError(caught).message);
        }
      })
      .finally(() => {
        if (requestActive) {
          setLoading(false);
        }
      });
    return () => {
      requestActive = false;
    };
  }, [active]);

  const revoke = (value: string, scope: JsonSchemaTrustScope): void => {
    const operation = `${scope}:${value}`;
    setError(null);
    setRevoking(operation);
    void revokeJsonSchemaTrust(value, scope)
      .then((result) => {
        setSettings(result);
        onTrustChange();
      })
      .catch((caught: unknown) => setError(toApplicationError(caught).message))
      .finally(() => setRevoking(null));
  };

  return (
    <section className="settings-section">
      <div className="settings-section__body">
        <h2>{t("settings.jsonSchemasSection")}</h2>
        <p>{t("settings.jsonSchemasDescription")}</p>
        {error !== null ? (
          <div className="inline-alert inline-alert--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="schema-trust-settings" aria-busy={loading}>
          <details className="schema-trust-settings__built-in">
            <summary>{t("settings.builtInSchemaOrigins")}</summary>
            <ul>
              {(settings?.builtInOrigins ?? []).map((origin) => (
                <li key={origin}>
                  <code>{origin}</code>
                </li>
              ))}
            </ul>
          </details>
          <h3>{t("settings.additionalSchemaTrust")}</h3>
          {loading && settings === null ? (
            <span className="schema-trust-settings__empty">{t("settings.loadingSchemaTrust")}</span>
          ) : customTrust.length === 0 ? (
            <span className="schema-trust-settings__empty">
              {t("settings.noAdditionalSchemaTrust")}
            </span>
          ) : (
            <ul className="schema-trust-settings__list">
              {customTrust.map(({ scope, value }) => {
                const operation = `${scope}:${value}`;
                return (
                  <li key={operation}>
                    <div>
                      <span>
                        {scope === "origin" ? t("settings.schemaOrigin") : t("settings.schemaUri")}
                      </span>
                      <code>{value}</code>
                    </div>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={revoking !== null}
                      aria-busy={revoking === operation}
                      onClick={() => revoke(value, scope)}
                    >
                      {t("action.removeSchemaTrust")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
