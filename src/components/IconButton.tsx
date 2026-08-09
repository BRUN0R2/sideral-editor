import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly icon: IconName;
  readonly selected?: boolean;
}

export function IconButton({
  label,
  icon,
  selected = false,
  className = "",
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${selected ? "icon-button--selected" : ""} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={selected || undefined}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}
