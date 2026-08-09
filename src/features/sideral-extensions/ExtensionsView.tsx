import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../i18n/I18nProvider";
import type {
  InstalledExtensionView,
  PackageInspectionResult,
  PackageInstallView,
} from "./contracts";
import type { ExtensionSystem } from "./useExtensionSystem";

interface PendingPackage {
  readonly path: string;
  readonly inspection: PackageInspectionResult;
}

export function ExtensionsView({
  active,
  system,
}: {
  readonly active: boolean;
  readonly system: ExtensionSystem;
}) {
  const { t } = useI18n();
  const [pendingPackage, setPendingPackage] = useState<PendingPackage | null>(null);
  const [installing, setInstalling] = useState(false);
  const [uninstallCandidate, setUninstallCandidate] = useState<InstalledExtensionView | null>(null);
  const [commandResult, setCommandResult] = useState<string | null>(null);

  const selectPackage = async (): Promise<void> => {
    const path = await open({
      title: t("action.installExtension"),
      multiple: false,
      directory: false,
      filters: [{ name: "Sideral Extension", extensions: ["sideralx"] }],
    });
    if (typeof path !== "string") {
      return;
    }
    setPendingPackage({ path, inspection: await system.inspectPackage(path) });
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
    <main className="extensions-workspace" aria-label={t("extensions.title")} hidden={!active}>
      <div className="extensions-workspace__inner">
        <header className="extensions-workspace__header">
          <div>
            <h1>{t("extensions.title")}</h1>
            <p>{t("extensions.subtitle")}</p>
          </div>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void selectPackage().catch(() => undefined)}
            disabled={system.status !== "ready"}
          >
            <Icon name="download" size={16} />
            {t("action.installExtension")}
          </button>
        </header>

        {system.error === null ? null : (
          <div className="extensions-alert extensions-alert--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{system.error}</span>
            <button type="button" onClick={system.clearError} aria-label={t("action.close")}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}

        {system.status === "initializing" ? (
          <div className="extensions-empty">{t("extensions.initializing")}</div>
        ) : null}
        {system.status === "unavailable" ? (
          <div className="extensions-empty">{t("extensions.unavailable")}</div>
        ) : null}
        {system.status === "ready" && system.snapshot.extensions.length === 0 ? (
          <div className="extensions-empty">{t("extensions.empty")}</div>
        ) : null}

        <div className="extensions-list">
          {system.snapshot.extensions.map((extension) => {
            const busy = system.busyExtensionIds.has(extension.id);
            return (
              <article className="extension-card" key={extension.id}>
                <header className="extension-card__header">
                  <div>
                    <div className="extension-card__title-line">
                      <h2>{extension.displayName}</h2>
                      <span className="extension-card__version">v{extension.version}</span>
                      <RuntimeBadge state={extension.runtime.state} />
                    </div>
                    <p className="extension-card__identity">
                      {extension.id} · {extension.publisher}
                    </p>
                  </div>
                  <div className="extension-card__actions">
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void system
                          .setEnabled(extension.id, !extension.enabled)
                          .catch(() => undefined)
                      }
                    >
                      {extension.enabled ? t("action.disable") : t("action.enable")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !extension.enabled}
                      onClick={() => void system.restart(extension.id).catch(() => undefined)}
                    >
                      {t("action.restart")}
                    </button>
                    {extension.rollbackVersion === null ? null : (
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => void system.rollback(extension.id).catch(() => undefined)}
                      >
                        {t("action.rollback")} {extension.rollbackVersion}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => setUninstallCandidate(extension)}
                    >
                      {t("action.uninstall")}
                    </button>
                  </div>
                </header>
                {extension.description === null ? null : <p>{extension.description}</p>}
                <div className="extension-card__metadata">
                  <span>{t("extensions.runtime", { state: extension.runtime.state })}</span>
                  {extension.runtime.lastActivationMilliseconds === null ? null : (
                    <span>
                      {t("extensions.activationTime", {
                        milliseconds: extension.runtime.lastActivationMilliseconds,
                      })}
                    </span>
                  )}
                  {extension.runtime.lastCommandMilliseconds === null ? null : (
                    <span>
                      {t("extensions.commandMetrics", {
                        count: extension.runtime.commandCount,
                        failures: extension.runtime.commandFailureCount,
                        milliseconds: extension.runtime.lastCommandMilliseconds,
                      })}
                    </span>
                  )}
                </div>
                {extension.runtime.lastError === null ? null : (
                  <p className="extension-card__error">
                    {t("extensions.lastError", { message: extension.runtime.lastError.message })}
                  </p>
                )}
                <CapabilityList package_={extension} />
                {extension.commands.length === 0 ? null : (
                  <section className="extension-card__commands">
                    <h3>{t("extensions.commands")}</h3>
                    <div>
                      {extension.commands.map((command) => (
                        <button
                          type="button"
                          className="button"
                          key={command.id}
                          disabled={!extension.enabled || busy}
                          onClick={() => {
                            void system
                              .executeCommand(command.id)
                              .then((result) => {
                                setCommandResult(
                                  t("extensions.commandResult", {
                                    value: result === null ? "null" : JSON.stringify(result),
                                  }),
                                );
                              })
                              .catch(() => undefined);
                          }}
                        >
                          {t("action.run")} {command.category ? `${command.category}: ` : ""}
                          {command.title}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </article>
            );
          })}
        </div>

        {commandResult === null ? null : (
          <div className="extensions-command-result" role="status">
            <span>{commandResult}</span>
            <button type="button" onClick={() => setCommandResult(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}

        {system.outputs.length === 0 ? null : (
          <section className="extensions-output">
            <h2>{t("extensions.output")}</h2>
            {system.outputs.map((output) => (
              <details key={output.resourceId} open={output.visible}>
                <summary>
                  {output.name} · {output.extensionId}
                </summary>
                <pre>{output.content}</pre>
              </details>
            ))}
          </section>
        )}
      </div>

      {pendingPackage === null ? null : (
        <InstallReviewDialog
          pending={pendingPackage}
          installing={installing}
          onCancel={() => setPendingPackage(null)}
          onInstall={() => void installPackage().catch(() => undefined)}
        />
      )}
      {uninstallCandidate === null ? null : (
        <ConfirmationDialog
          title={t("extensions.uninstallTitle")}
          description={t("extensions.uninstallDescription", {
            name: uninstallCandidate.displayName,
          })}
          confirmLabel={t("action.uninstall")}
          onCancel={() => setUninstallCandidate(null)}
          onConfirm={() => {
            const extensionId = uninstallCandidate.id;
            setUninstallCandidate(null);
            void system.uninstall(extensionId).catch(() => undefined);
          }}
        />
      )}
    </main>
  );
}

function CapabilityList({
  package_,
}: {
  readonly package_: Pick<PackageInstallView, "permissions" | "activationEvents">;
}) {
  const { t } = useI18n();
  const capabilities = permissionLabels(package_, t);
  return (
    <section className="extension-capabilities">
      <h3>{t("extensions.permissions")}</h3>
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

function InstallReviewDialog({
  pending,
  installing,
  onCancel,
  onInstall,
}: {
  readonly pending: PendingPackage;
  readonly installing: boolean;
  readonly onCancel: () => void;
  readonly onInstall: () => void;
}) {
  const { t } = useI18n();
  const package_ = pending.inspection.package;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog-card extension-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-install-title"
      >
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
        <CapabilityList package_={package_} />
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
      </section>
    </div>
  );
}

function ConfirmationDialog({
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
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <h2 id="confirm-title">{title}</h2>
        <p>{description}</p>
        <div className="dialog-card__actions">
          <button type="button" className="button" onClick={onCancel}>
            {t("action.cancel")}
          </button>
          <button type="button" className="button button--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function RuntimeBadge({ state }: { readonly state: InstalledExtensionView["runtime"]["state"] }) {
  return <span className={`extension-runtime extension-runtime--${state}`}>{state}</span>;
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
