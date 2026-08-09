import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { PreferenceCheckbox } from "../../components/PreferenceCheckbox";
import { openLocaleDirectory } from "../../lib/backend";
import type { DesktopPreferences } from "../../lib/contracts";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";
import { useUpdates } from "../updates/UpdateProvider";
import { JsonSchemaSettings } from "./JsonSchemaSettings";
import type { DesktopPreferencesController } from "./useDesktopPreferences";

export function SettingsView({
  active,
  desktopPreferences,
  onJsonSchemaTrustChange,
  onOpenUpdate,
}: {
  readonly active: boolean;
  readonly desktopPreferences: DesktopPreferencesController;
  readonly onJsonSchemaTrustChange: () => void;
  readonly onOpenUpdate: () => void;
}) {
  const { selection, t, setPreference, refreshLocales, bootstrap } = useI18n();
  const { state: updateState, checkForUpdates } = useUpdates();
  const [operationError, setOperationError] = useState<string | null>(null);
  const [changingLanguage, setChangingLanguage] = useState(false);
  const desktopPreferencesEnabled = bootstrap.runtime === "desktop";

  const updateDesktopPreferences = (preferences: DesktopPreferences): void => {
    setOperationError(null);
    void desktopPreferences.save(preferences).catch((error: unknown) => {
      setOperationError(toApplicationError(error).message);
    });
  };

  useEffect(() => {
    if (!active) {
      return;
    }
    let listenerActive = true;
    const refresh = () => {
      void refreshLocales().catch((error: unknown) => {
        if (listenerActive) {
          setOperationError(toApplicationError(error).message);
        }
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      listenerActive = false;
      window.removeEventListener("focus", refresh);
    };
  }, [active, refreshLocales]);

  const selectedPreference = useMemo(() => {
    if (selection.preference === "system") {
      return "system";
    }
    return selection.catalog.locales.some(
      (locale) => locale.locale.toLowerCase() === selection.preference.toLowerCase(),
    )
      ? selection.preference
      : "system";
  }, [selection]);

  const updateStatus = (() => {
    switch (updateState.phase) {
      case "checking":
        return t("updates.checking");
      case "upToDate":
        return t("updates.checked");
      case "available":
      case "downloading":
      case "installing":
      case "ready":
        return t("updates.available", { version: updateState.nextVersion ?? "" });
      case "error":
        return updateState.error ?? t("updates.failed");
      case "disabled":
        return t("settings.updaterNotConfigured");
      case "idle":
        return `Sideral Editor ${bootstrap.version}`;
    }
  })();

  return (
    <main className="settings-workspace" aria-label={t("settings.title")} hidden={!active}>
      <div className="settings-workspace__inner">
        <header className="settings-workspace__header">
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.subtitle")}</p>
        </header>

        {operationError !== null ? (
          <div className="inline-alert inline-alert--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{operationError}</span>
          </div>
        ) : null}

        <div className="settings-content">
          <section className="settings-section">
            <div className="settings-section__body">
              <h2>{t("settings.applicationSection")}</h2>
              <p>{t("settings.applicationDescription")}</p>
              <div className="desktop-preferences" aria-busy={desktopPreferences.saving}>
                <PreferenceCheckbox
                  checked={desktopPreferences.preferences.startWithWindows}
                  description={t("settings.startWithWindowsDescription")}
                  disabled={!desktopPreferencesEnabled}
                  label={t("settings.startWithWindows")}
                  onChange={(startWithWindows) =>
                    updateDesktopPreferences({
                      ...desktopPreferences.preferences,
                      startWithWindows,
                      startMinimized: startWithWindows
                        ? desktopPreferences.preferences.startMinimized
                        : false,
                    })
                  }
                />
                <PreferenceCheckbox
                  checked={desktopPreferences.preferences.startMinimized}
                  description={t("settings.startMinimizedDescription")}
                  disabled={
                    !desktopPreferencesEnabled || !desktopPreferences.preferences.startWithWindows
                  }
                  label={t("settings.startMinimized")}
                  onChange={(startMinimized) =>
                    updateDesktopPreferences({
                      ...desktopPreferences.preferences,
                      startMinimized,
                    })
                  }
                />
                <PreferenceCheckbox
                  checked={desktopPreferences.preferences.closeToTray}
                  description={t("settings.closeToTrayDescription")}
                  disabled={!desktopPreferencesEnabled}
                  label={t("settings.closeToTray")}
                  onChange={(closeToTray) =>
                    updateDesktopPreferences({
                      ...desktopPreferences.preferences,
                      closeToTray,
                    })
                  }
                />
                <PreferenceCheckbox
                  checked={desktopPreferences.preferences.autoSave === "afterDelay"}
                  description={t("settings.autoSaveDescription")}
                  disabled={!desktopPreferencesEnabled}
                  label={t("settings.autoSave")}
                  onChange={(enabled) =>
                    updateDesktopPreferences({
                      ...desktopPreferences.preferences,
                      autoSave: enabled ? "afterDelay" : "off",
                    })
                  }
                />
              </div>
              <span className="desktop-preferences__status" aria-live="polite">
                {desktopPreferences.saving ? t("settings.savingDesktopPreferences") : ""}
              </span>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__body">
              <h2>{t("settings.languageSection")}</h2>
              <p>{t("settings.languageDescription")}</p>
              <label className="field-label" htmlFor="display-language">
                {t("settings.languageSection")}
              </label>
              <select
                id="display-language"
                className="select-field"
                value={selectedPreference}
                disabled={changingLanguage}
                aria-busy={changingLanguage}
                onChange={(event) => {
                  setOperationError(null);
                  setChangingLanguage(true);
                  void setPreference(event.target.value)
                    .catch((error: unknown) => {
                      setOperationError(toApplicationError(error).message);
                    })
                    .finally(() => setChangingLanguage(false));
                }}
              >
                <option value="system">{t("settings.systemLanguage")}</option>
                {selection.catalog.locales.map((locale) => (
                  <option key={locale.locale} value={locale.locale}>
                    {locale.name} — {locale.locale}
                  </option>
                ))}
              </select>
              <div className="field-help">
                {t("settings.activeLanguage", { language: selection.active.name })}
              </div>
              {selection.unavailablePreference !== null ? (
                <div className="inline-alert" role="status">
                  <Icon name="alert" size={16} />
                  <span>{t("settings.localeFallback", { language: selection.active.name })}</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__body">
              <h2>{t("settings.translationSection")}</h2>
              <p>{t("settings.translationDescription")}</p>
              <span className="field-label">{t("settings.translationPath")}</span>
              <code className="path-field">{selection.catalog.directory}</code>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setOperationError(null);
                  void openLocaleDirectory().catch((error: unknown) => {
                    setOperationError(toApplicationError(error).message);
                  });
                }}
              >
                <Icon name="folderOpen" size={16} />
                {t("action.openTranslationsFolder")}
              </button>
              {selection.catalog.issues.length === 0 ? (
                <div className="locale-valid">{t("settings.noLocaleIssues")}</div>
              ) : (
                <details className="locale-issues" open>
                  <summary>{t("settings.invalidLocales")}</summary>
                  <ul>
                    {selection.catalog.issues.map((issue) => (
                      <li key={`${issue.file}:${issue.reason}`}>
                        {t("settings.invalidLocaleFile", {
                          file: issue.file,
                          reason: issue.reason,
                        })}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </section>

          {desktopPreferencesEnabled ? (
            <JsonSchemaSettings active={active} onTrustChange={onJsonSchemaTrustChange} />
          ) : null}

          <section className="settings-section">
            <div className="settings-section__body">
              <h2>{t("settings.updatesSection")}</h2>
              <p>{t("settings.updatesDescription")}</p>
              <div className="update-setting-row">
                <span>{updateStatus}</span>
                {updateState.phase === "available" ||
                updateState.phase === "downloading" ||
                updateState.phase === "installing" ||
                updateState.phase === "ready" ? (
                  <button type="button" className="secondary-button" onClick={onOpenUpdate}>
                    <Icon name="update" size={16} />
                    {t("updates.badgeLabel")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={updateState.phase === "disabled"}
                    onClick={() => void checkForUpdates()}
                  >
                    <Icon name="refresh" size={16} />
                    {t("action.checkUpdates")}
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
