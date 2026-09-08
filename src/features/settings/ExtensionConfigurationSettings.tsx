import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";
import {
  getExtensionConfigurations,
  updateExtensionConfiguration,
} from "../sideral-extensions/backend";
import type {
  ConfigurationUpdate,
  ExtensionConfigurationPropertyView,
  ExtensionConfigurationView,
  InstalledExtensionView,
} from "../sideral-extensions/contracts";

interface ExtensionConfigurationSettingsProps {
  readonly active: boolean;
  readonly extensions: readonly InstalledExtensionView[];
}

export function ExtensionConfigurationSettings({
  active,
  extensions,
}: ExtensionConfigurationSettingsProps) {
  const { t } = useI18n();
  const hasConfigurations = useMemo(
    () => extensions.some((extension) => extension.configuration !== null),
    [extensions],
  );
  const [configurations, setConfigurations] = useState<
    readonly ExtensionConfigurationView[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !hasConfigurations) {
      return;
    }
    let requestActive = true;
    setLoading(true);
    setError(null);
    void getExtensionConfigurations()
      .then((result) => {
        if (requestActive) {
          setConfigurations(result);
        }
      })
      .catch((reason: unknown) => {
        if (requestActive) {
          setError(toApplicationError(reason).message);
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
  }, [active, hasConfigurations]);

  if (!hasConfigurations) {
    return null;
  }

  const persist = async (
    extensionId: string,
    key: string,
    update: ConfigurationUpdate,
  ): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const next = await updateExtensionConfiguration(extensionId, key, update);
      setConfigurations((current) => {
        const existing = current ?? [];
        return existing.map((configuration) =>
          configuration.extensionId === extensionId ? next : configuration,
        );
      });
    } catch (reason: unknown) {
      setError(toApplicationError(reason).message);
    } finally {
      setSaving(false);
    }
  };

  const selectExecutable = async (
    extensionId: string,
    configurationTitle: string,
    key: string,
    propertyTitle: string,
  ): Promise<void> => {
    setError(null);
    try {
      const selected = await open({
        title: `${configurationTitle} › ${propertyTitle}`,
        multiple: false,
        directory: false,
      });
      if (typeof selected === "string") {
        await persist(extensionId, key, { kind: "value", value: selected });
      }
    } catch (reason: unknown) {
      setError(toApplicationError(reason).message);
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section__body">
        <h2>{t("settings.extensionConfigurationSection")}</h2>
        <p>{t("settings.extensionConfigurationDescription")}</p>
        {error === null ? null : (
          <div className="inline-alert inline-alert--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        )}
        {loading && configurations === null ? (
          <span className="extension-configurations__empty">
            {t("settings.loadingExtensionConfiguration")}
          </span>
        ) : (
          <div className="extension-configurations" aria-busy={loading}>
            {(configurations ?? []).flatMap((configuration) =>
              configuration.properties.map((property) => (
                <ConfigurationPropertyEditor
                  key={`${configuration.extensionId}:${property.key}`}
                  configurationTitle={configuration.title}
                  extensionId={configuration.extensionId}
                  property={property}
                  saving={saving}
                  onPersist={persist}
                  onSelectExecutable={selectExecutable}
                />
              )),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface ConfigurationPropertyEditorProps {
  readonly configurationTitle: string;
  readonly extensionId: string;
  readonly property: ExtensionConfigurationPropertyView;
  readonly saving: boolean;
  readonly onPersist: (
    extensionId: string,
    key: string,
    update: ConfigurationUpdate,
  ) => Promise<void>;
  readonly onSelectExecutable: (
    extensionId: string,
    configurationTitle: string,
    key: string,
    propertyTitle: string,
  ) => Promise<void>;
}

function ConfigurationPropertyEditor({
  configurationTitle,
  extensionId,
  property,
  saving,
  onPersist,
  onSelectExecutable,
}: ConfigurationPropertyEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(property.value);
  const inputId = `extension-configuration-${extensionId}-${property.key}`;

  useEffect(() => {
    setDraft(property.value);
  }, [property.value]);

  return (
    <div className="extension-configuration">
      <div className="extension-configuration__identity">
        <label htmlFor={inputId}>
          {configurationTitle} <span aria-hidden="true">›</span> {property.title}
        </label>
        {property.description === null ? null : <small>{property.description}</small>}
      </div>
      <form
        className="extension-configuration__control"
        onSubmit={(event) => {
          event.preventDefault();
          if (property.kind === "text" && draft !== property.value) {
            void onPersist(extensionId, property.key, { kind: "value", value: draft });
          }
        }}
      >
        <input
          id={inputId}
          className="extension-configuration__input"
          readOnly={property.kind === "executable"}
          value={property.kind === "executable" ? property.value : draft}
          placeholder={property.kind === "text" ? (property.placeholder ?? undefined) : undefined}
          onChange={(event) => setDraft(event.target.value)}
        />
        {property.kind === "executable" ? (
          <button
            type="button"
            className="secondary-button"
            disabled={saving}
            onClick={() =>
              void onSelectExecutable(extensionId, configurationTitle, property.key, property.title)
            }
          >
            <Icon name="folderOpen" size={16} />
            {t("action.selectExecutable")}
          </button>
        ) : (
          <button
            type="submit"
            className="secondary-button"
            disabled={saving || draft === property.value}
          >
            {t("action.save")}
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={saving || !property.userDefined}
          onClick={() => void onPersist(extensionId, property.key, { kind: "default" })}
        >
          {t("action.reset")}
        </button>
      </form>
      <small className="extension-configuration__default">
        {t("settings.defaultConfigurationValue", {
          value: property.defaultValue || t("settings.emptyConfigurationValue"),
        })}
      </small>
    </div>
  );
}
