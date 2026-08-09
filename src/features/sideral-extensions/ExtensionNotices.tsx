import { Icon } from "../../components/Icon";
import { useI18n } from "../i18n/I18nProvider";
import type { ExtensionSystem } from "./useExtensionSystem";

export function ExtensionNotices({ system }: { readonly system: ExtensionSystem }) {
  const { t } = useI18n();
  if (system.notices.length === 0) {
    return null;
  }
  return (
    <div className="extension-notices" aria-live="polite">
      {system.notices.map((notice) => (
        <div
          className={`extension-notice extension-notice--${notice.severity}`}
          key={notice.id}
          role={notice.severity === "error" ? "alert" : "status"}
        >
          <Icon name={notice.severity === "information" ? "spark" : "alert"} size={16} />
          <div>
            {notice.extensionId === null ? null : <strong>{notice.extensionId}</strong>}
            <span>{notice.message}</span>
          </div>
          <button
            type="button"
            onClick={() => system.dismissNotice(notice.id)}
            aria-label={t("action.close")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
