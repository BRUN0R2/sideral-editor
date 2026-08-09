import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

export function ErrorToast({
  title,
  message,
  closeLabel,
  onClose,
}: {
  readonly title: string;
  readonly message: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
}) {
  return (
    <div className="error-toast" role="alert">
      <span className="error-toast__icon">
        <Icon name="alert" size={18} />
      </span>
      <span className="error-toast__copy">
        <strong>{title}</strong>
        <span>{message}</span>
      </span>
      <IconButton label={closeLabel} icon="close" onClick={onClose} />
    </div>
  );
}
