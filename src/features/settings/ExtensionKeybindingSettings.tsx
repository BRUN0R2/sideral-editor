import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../i18n/I18nProvider";
import { shortcutFromKeyboardEvent } from "../sideral-extensions/keybindings";
import type { ExtensionSystem } from "../sideral-extensions/useExtensionSystem";

export function ExtensionKeybindingSettings({ system }: { readonly system: ExtensionSystem }) {
  const { t } = useI18n();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bindings = useMemo(
    () =>
      system.snapshot.extensions
        .flatMap((extension) => extension.keybindings)
        .toSorted((left, right) => left.commandTitle.localeCompare(right.commandTitle)),
    [system.snapshot.extensions],
  );

  if (bindings.length === 0) {
    return null;
  }

  const update = (
    commandId: string,
    value:
      | { readonly kind: "default" }
      | { readonly kind: "disabled" }
      | { readonly kind: "custom"; readonly key: string },
  ): void => {
    setError(null);
    void system.updateKeybinding(commandId, value).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <section className="settings-section">
      <div className="settings-section__body">
        <h2>{t("settings.extensionKeybindingsSection")}</h2>
        <p>{t("settings.extensionKeybindingsDescription")}</p>
        {error === null ? null : (
          <div className="inline-alert inline-alert--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        )}
        <div className="extension-keybindings">
          {bindings.map((binding) => {
            const busy = system.busyExtensionIds.has(binding.extensionId);
            return (
              <div className="extension-keybinding" key={binding.commandId}>
                <div className="extension-keybinding__identity">
                  <strong>{binding.commandTitle}</strong>
                  <small>{binding.commandId}</small>
                  {binding.conflict ? (
                    <span className="extension-keybinding__conflict" role="status">
                      {t("settings.keybindingConflict")}
                    </span>
                  ) : null}
                </div>
                <input
                  className="keybinding-capture"
                  aria-label={t("settings.keybindingCapture", { command: binding.commandTitle })}
                  readOnly
                  value={
                    capturing === binding.commandId
                      ? t("settings.keybindingRecording")
                      : (binding.key ?? t("settings.keybindingDisabled"))
                  }
                  disabled={busy}
                  onFocus={() => setCapturing(binding.commandId)}
                  onBlur={() => setCapturing(null)}
                  onKeyDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === "Escape") {
                      event.currentTarget.blur();
                      return;
                    }
                    const shortcut = shortcutFromKeyboardEvent(event);
                    if (shortcut !== null) {
                      update(binding.commandId, { kind: "custom", key: shortcut });
                      event.currentTarget.blur();
                    }
                  }}
                />
                <div className="extension-keybinding__actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || binding.key === null}
                    onClick={() => update(binding.commandId, { kind: "disabled" })}
                  >
                    {t("action.disable")}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || !binding.userDefined}
                    onClick={() => update(binding.commandId, { kind: "default" })}
                  >
                    {t("settings.keybindingReset")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
