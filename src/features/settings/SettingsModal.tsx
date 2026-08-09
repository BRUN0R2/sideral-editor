import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import { openLocaleDirectory } from "../../lib/backend";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";
import { useUpdates } from "../updates/UpdateProvider";

export function SettingsModal({
  open,
  onClose,
  onOpenUpdate,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenUpdate: () => void;
}) {
  const { selection, t, setPreference, refreshLocales, changingLanguage, bootstrap } = useI18n();
  const { state: updateState, checkForUpdates } = useUpdates();
  const [operationError, setOperationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    const refresh = () => {
      void refreshLocales().catch((error: unknown) => {
        if (active) {
          setOperationError(toApplicationError(error).message);
        }
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [open, refreshLocales]);

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
    <Modal
      open={open}
      title={t("settings.title")}
      closeLabel={t("action.close")}
      onClose={onClose}
      className="settings-modal"
    >
      <p className="modal-subtitle">{t("settings.subtitle")}</p>
      {operationError !== null ? (
        <div className="inline-alert inline-alert--error" role="alert">
          <Icon name="alert" size={16} />
          <span>{operationError}</span>
        </div>
      ) : null}

      <div className="settings-content">
        <section className="settings-section">
          <div className="settings-section__icon">
            <Icon name="globe" size={19} />
          </div>
          <div className="settings-section__body">
            <h3>{t("settings.languageSection")}</h3>
            <p>{t("settings.languageDescription")}</p>
            <label className="field-label" htmlFor="display-language">
              {t("settings.languageSection")}
            </label>
            <select
              id="display-language"
              className="select-field"
              value={selectedPreference}
              disabled={changingLanguage}
              onChange={(event) => {
                setOperationError(null);
                void setPreference(event.target.value).catch((error: unknown) => {
                  setOperationError(toApplicationError(error).message);
                });
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
          <div className="settings-section__icon">
            <Icon name="folderOpen" size={19} />
          </div>
          <div className="settings-section__body">
            <h3>{t("settings.translationSection")}</h3>
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

        <section className="settings-section">
          <div className="settings-section__icon">
            <Icon name="update" size={19} />
          </div>
          <div className="settings-section__body">
            <h3>{t("settings.updatesSection")}</h3>
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
                  disabled={updateState.phase === "checking" || updateState.phase === "disabled"}
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
    </Modal>
  );
}
