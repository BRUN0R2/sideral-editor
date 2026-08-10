import type { ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type {
  InstalledExtensionView,
  PackageInspectionResult,
  PackageInstallView,
} from "./contracts";

export interface PendingExtensionPackage {
  readonly path: string;
  readonly inspection: PackageInspectionResult;
}

export function ExtensionCapabilityList({
  package_,
}: {
  readonly package_: Pick<PackageInstallView, "permissions" | "activationEvents">;
}) {
  const { t } = useI18n();
  const capabilities = permissionLabels(package_, t);
  return (
    <section className="extension-capabilities">
      <h2>{t("extensions.permissions")}</h2>
      {capabilities.length === 0 ? (
        <p>{t("extensions.permissionNone")}</p>
      ) : (
        <ul>
          {capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ExtensionRuntimeBadge({
  state,
}: {
  readonly state: InstalledExtensionView["runtime"]["state"];
}) {
  return <span className={`extension-runtime extension-runtime--${state}`}>{state}</span>;
}

export function ExtensionInstallReviewDialog({
  pending,
  installing,
  onCancel,
  onInstall,
}: {
  readonly pending: PendingExtensionPackage;
  readonly installing: boolean;
  readonly onCancel: () => void;
  readonly onInstall: () => void;
}) {
  const { t } = useI18n();
  const package_ = pending.inspection.package;
  return (
    <DialogFrame labelledBy="extension-install-title" className="extension-install-dialog">
      <h2 id="extension-install-title">{t("extensions.installReviewTitle")}</h2>
      <p>{t("extensions.installReviewDescription")}</p>
      <div className="extension-install-dialog__identity">
        <strong>
          {package_.displayName} {package_.version}
        </strong>
        <span>{package_.id}</span>
      </div>
      {package_.description === null ? null : <p>{package_.description}</p>}
      <dl>
        <dt>{t("extensions.publisher")}</dt>
        <dd>{package_.publisher}</dd>
        <dt>{t("extensions.signingKey")}</dt>
        <dd className="extension-hash">{package_.keyId}</dd>
        <dt>{t("extensions.packageHash")}</dt>
        <dd className="extension-hash">{package_.packageSha256}</dd>
      </dl>
      <ExtensionCapabilityList package_={package_} />
      {package_.replacesVersion === null ? null : (
        <p>{t("extensions.replaces", { version: package_.replacesVersion })}</p>
      )}
      <p className="extension-install-dialog__trust">
        {pending.inspection.status === "publisherTrustRequired"
          ? t("extensions.trustRequired")
          : t("extensions.trustKnown")}
      </p>
      <div className="dialog-card__actions">
        <button type="button" className="button" disabled={installing} onClick={onCancel}>
          {t("action.cancel")}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={installing}
          onClick={onInstall}
        >
          {pending.inspection.status === "publisherTrustRequired"
            ? t("action.trustAndInstall")
            : t("action.installExtension")}
        </button>
      </div>
    </DialogFrame>
  );
}

export function ExtensionConfirmationDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <DialogFrame labelledBy="extension-confirm-title">
      <h2 id="extension-confirm-title">{title}</h2>
      <p>{description}</p>
      <div className="dialog-card__actions">
        <button type="button" className="button" onClick={onCancel}>
          {t("action.cancel")}
        </button>
        <button type="button" className="button button--danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </DialogFrame>
  );
}

function DialogFrame({
  labelledBy,
  className = "",
  children,
}: {
  readonly labelledBy: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className={`dialog-card ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </section>
    </div>
  );
}

function permissionLabels(
  package_: Pick<PackageInstallView, "permissions" | "activationEvents">,
  t: ReturnType<typeof useI18n>["t"],
): string[] {
  const labels: string[] = [];
  const workspace = package_.permissions.workspace ?? "none";
  if (workspace === "read") {
    labels.push(t("extensions.workspaceRead"));
  } else if (workspace === "readWrite") {
    labels.push(t("extensions.workspaceReadWrite"));
  }
  const network = package_.permissions.network ?? [];
  if (network.length > 0) {
    labels.push(
      t("extensions.network", {
        value: network
          .map(
            (permission) => `${permission.origin} [${(permission.methods ?? ["GET"]).join(", ")}]`,
          )
          .join(" · "),
      }),
    );
  }
  const processes = package_.permissions.processes ?? [];
  if (processes.length > 0) {
    labels.push(
      t("extensions.processes", {
        value: processes.map((permission) => permission.id).join(", "),
      }),
    );
  }
  if (package_.activationEvents.length > 0) {
    labels.push(t("extensions.activation", { value: package_.activationEvents.join(", ") }));
  }
  return labels;
}
