import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";
import { isProductIconName, ProductIcon, type ProductIconName } from "./ProductIcon";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly icon: IconName | ProductIconName;
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
      {isProductIconName(icon) ? <ProductIcon name={icon} /> : <Icon name={icon} />}
    </button>
  );
}
