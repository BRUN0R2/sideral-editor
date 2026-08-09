import { Icon, type IconName } from "../../components/Icon";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";

export function WelcomeView({
  onNewFile,
  onOpenFile,
  onOpenFolder,
}: {
  readonly onNewFile: () => void;
  readonly onOpenFile: () => void;
  readonly onOpenFolder: () => void;
}) {
  const { t } = useI18n();
  const actions: readonly WelcomeAction[] = [
    {
      label: "action.newFile",
      hint: "welcome.newFileHint",
      icon: "newFile",
      shortcut: "Ctrl N",
      action: onNewFile,
    },
    {
      label: "action.openFile",
      hint: "welcome.openFileHint",
      icon: "file",
      shortcut: "Ctrl O",
      action: onOpenFile,
    },
    {
      label: "action.openFolder",
      hint: "welcome.openFolderHint",
      icon: "folderOpen",
      shortcut: "Ctrl Shift O",
      action: onOpenFolder,
    },
  ];

  return (
    <section className="welcome-view">
      <div className="welcome-orbit" aria-hidden="true">
        <span className="welcome-orbit__core">S</span>
        <span className="welcome-orbit__plane">
          <span className="welcome-orbit__ring" />
          <span className="welcome-orbit__star" />
        </span>
      </div>
      <div className="welcome-copy">
        <div className="eyebrow">
          <Icon name="spark" size={14} />
          {t("welcome.eyebrow")}
        </div>
        <h1>{t("welcome.title")}</h1>
        <p>{t("welcome.description")}</p>
      </div>
      <div className="welcome-actions">
        {actions.map((item) => (
          <button key={item.label} type="button" className="welcome-action" onClick={item.action}>
            <span className="welcome-action__icon">
              <Icon name={item.icon} size={18} />
            </span>
            <span className="welcome-action__copy">
              <strong>{t(item.label)}</strong>
              <small>{t(item.hint)}</small>
            </span>
            <kbd>{item.shortcut}</kbd>
          </button>
        ))}
      </div>
    </section>
  );
}

interface WelcomeAction {
  readonly label: MessageKey;
  readonly hint: MessageKey;
  readonly icon: IconName;
  readonly shortcut: string;
  readonly action: () => void;
}
