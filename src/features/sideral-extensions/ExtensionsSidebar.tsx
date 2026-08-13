import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProductIcon } from "../../components/ProductIcon";
import { useI18n } from "../i18n/I18nProvider";
import type { InstalledExtensionView } from "./contracts";
import { ExtensionInstallReviewDialog, type PendingExtensionPackage } from "./ExtensionManagement";
import type { ExtensionSystem } from "./useExtensionSystem";

interface ExtensionsSidebarProps {
  readonly active: boolean;
  readonly selectedExtensionId: string | null;
  readonly system: ExtensionSystem;
  readonly onSelectExtension: (extensionId: string) => void;
}

export function ExtensionsSidebar({
  active,
  selectedExtensionId,
  system,
  onSelectExtension,
}: ExtensionsSidebarProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [pendingPackage, setPendingPackage] = useState<PendingExtensionPackage | null>(null);
  const [installing, setInstalling] = useState(false);
  const visibleExtensions = useMemo(
    () => filterExtensions(system.snapshot.extensions, query),
    [query, system.snapshot.extensions],
  );

  const selectPackage = async (): Promise<void> => {
    const path = await open({
      title: t("action.installExtension"),
      multiple: false,
      directory: false,
      filters: [{ name: "Sideral Extension", extensions: ["sideralx"] }],
    });
    if (typeof path === "string") {
      setPendingPackage({ path, inspection: await system.inspectPackage(path) });
    }
  };

  const installPackage = async (): Promise<void> => {
    if (pendingPackage === null) {
      return;
    }
    setInstalling(true);
    try {
      await system.installPackage(
        pendingPackage.path,
        pendingPackage.inspection.package.packageSha256,
        pendingPackage.inspection.status === "publisherTrustRequired",
      );
      setPendingPackage(null);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <aside
      id="primary-sidebar-extensions"
      className="extensions-sidebar"
      aria-label={t("extensions.title")}
      hidden={!active}
    >
      <header className="panel-header">
        <h2>{t("extensions.title")}</h2>
        <div className="panel-actions">
          <IconButton
            label={t("action.installExtension")}
            icon="download"
            disabled={system.status !== "ready"}
            onClick={() => void selectPackage().catch(system.reportError)}
          />
        </div>
      </header>

      <div className="extensions-sidebar__search">
        <input
          type="search"
          value={query}
          placeholder={t("extensions.searchPlaceholder")}
          aria-label={t("extensions.searchPlaceholder")}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {system.error === null ? null : (
        <div className="extensions-alert extensions-alert--error" role="alert">
          <Icon name="alert" size={15} />
          <span>{system.error}</span>
          <button type="button" onClick={system.clearError} aria-label={t("action.close")}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="extensions-sidebar__group">
        <div className="extensions-sidebar__group-heading">
          <h3>{t("extensions.installed")}</h3>
          <span>{system.snapshot.extensions.length}</span>
        </div>
        <div className="extensions-sidebar__list">
          <ExtensionListState system={system} visibleCount={visibleExtensions.length} />
          {visibleExtensions.map((extension) => (
            <ExtensionSidebarItem
              key={extension.id}
              extension={extension}
              selected={selectedExtensionId === extension.id}
              onSelect={() => onSelectExtension(extension.id)}
            />
          ))}
        </div>
      </div>

      {pendingPackage === null ? null : (
        <ExtensionInstallReviewDialog
          pending={pendingPackage}
          installing={installing}
          onCancel={() => setPendingPackage(null)}
          onInstall={() => void installPackage().catch(system.reportError)}
        />
      )}
    </aside>
  );
}

function ExtensionListState({
  system,
  visibleCount,
}: {
  readonly system: ExtensionSystem;
  readonly visibleCount: number;
}) {
  const { t } = useI18n();
  if (system.status === "initializing") {
    return <p className="extensions-sidebar__empty">{t("extensions.initializing")}</p>;
  }
  if (system.status === "unavailable") {
    return <p className="extensions-sidebar__empty">{t("extensions.unavailable")}</p>;
  }
  if (system.status === "ready" && system.snapshot.extensions.length === 0) {
    return <p className="extensions-sidebar__empty">{t("extensions.empty")}</p>;
  }
  if (system.snapshot.extensions.length > 0 && visibleCount === 0) {
    return <p className="extensions-sidebar__empty">{t("extensions.noMatches")}</p>;
  }
  return null;
}

function ExtensionSidebarItem({
  extension,
  selected,
  onSelect,
}: {
  readonly extension: InstalledExtensionView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();
  const activationMilliseconds = extension.runtime.lastActivationMilliseconds;
  const activationLabel =
    activationMilliseconds === null
      ? t("extensions.activationPending")
      : t("extensions.activationTime", { milliseconds: activationMilliseconds });
  return (
    <button
      type="button"
      className={`extension-sidebar-item ${selected ? "extension-sidebar-item--selected" : ""}`}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
    >
      <span className="extension-sidebar-item__icon">
        <ProductIcon name="extensions" />
      </span>
      <span className="extension-sidebar-item__content">
        <span className="extension-sidebar-item__title">
          <strong>{extension.displayName}</strong>
          <span className="extension-sidebar-item__diagnostic" title={activationLabel}>
            <span
              className={`extension-runtime-dot extension-runtime-dot--${extension.runtime.state}`}
            />
            {activationMilliseconds === null ? "—" : `${activationMilliseconds} ms`}
          </span>
        </span>
        <span className="extension-sidebar-item__description">
          {extension.description ?? extension.id}
        </span>
        <span className="extension-sidebar-item__meta">
          <span>{extension.publisher}</span>
          <span>v{extension.version}</span>
        </span>
      </span>
    </button>
  );
}

function filterExtensions(
  extensions: readonly InstalledExtensionView[],
  query: string,
): readonly InstalledExtensionView[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return extensions;
  }
  return extensions.filter((extension) =>
    [extension.displayName, extension.id, extension.publisher, extension.description ?? ""].some(
      (value) => value.toLowerCase().includes(normalizedQuery),
    ),
  );
}
