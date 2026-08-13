const PRODUCT_ICONS = {
  explorer: "files",
  extensions: "extensions",
  account: "account",
  clearAll: "clear-all",
  settingsGear: "settings-gear",
  terminal: "terminal",
  trash: "trash",
} as const;

export type ProductIconName = keyof typeof PRODUCT_ICONS;

export function isProductIconName(name: string): name is ProductIconName {
  return Object.hasOwn(PRODUCT_ICONS, name);
}

export function ProductIcon({ name }: { readonly name: ProductIconName }) {
  const codicon = PRODUCT_ICONS[name];
  return <span className={`product-icon codicon codicon-${codicon}`} aria-hidden="true" />;
}
