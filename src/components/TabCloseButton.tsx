import { useI18n } from "../features/i18n/I18nProvider";
import { Icon } from "./Icon";

interface TabCloseButtonProps {
  readonly label: string;
  readonly onClose: () => void;
}

export function TabCloseButton({ label, onClose }: TabCloseButtonProps) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="workbench-tab__close"
      aria-label={`${t("action.close")} ${label}`}
      onClick={onClose}
    >
      <Icon name="close" size={18} />
    </button>
  );
}
