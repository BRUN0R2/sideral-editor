import { useState } from "react";
import { ProductIcon } from "../../components/ProductIcon";
import { useI18n } from "../i18n/I18nProvider";
import type { InstalledExtensionView } from "./contracts";
import {
  ExtensionCapabilityList,
  ExtensionConfirmationDialog,
  ExtensionRuntimeBadge,
} from "./ExtensionManagement";
import type { ExtensionSystem } from "./useExtensionSystem";

interface ExtensionDetailsViewProps {
  readonly active: boolean;
  readonly extensionId: string | null;
  readonly system: ExtensionSystem;
  readonly onUninstalled: () => void;
}

export function ExtensionDetailsView({
  active,
  extensionId,
  system,
  onUninstalled,
}: ExtensionDetailsViewProps) {
  const { t } = useI18n();
  const [uninstallCandidate, setUninstallCandidate] = useState<InstalledExtensionView | null>(null);
  const extension =
    extensionId === null
      ? null
      : (system.snapshot.extensions.find((candidate) => candidate.id === extensionId) ?? null);

  return (
    <main className="extension-details" aria-label={t("extensions.detailsTitle")} hidden={!active}>
      {extension === null ? (
        <div className="extension-details__empty">
          <ProductIcon name="extensions" />
          <p>{t("extensions.selectPrompt")}</p>
        </div>
      ) : (
        <div className="extension-details__inner">
          <header className="extension-details__header">
            <div className="extension-details__icon">
              <ProductIcon name="extensions" />
            </div>
            <div className="extension-details__identity">
              <div className="extension-details__title-line">
                <h1>{extension.displayName}</h1>
                <span className="extension-version">v{extension.version}</span>
                <ExtensionRuntimeBadge state={extension.runtime.state} />
              </div>
              <p className="extension-details__publisher">
                {extension.publisher} · {extension.id}
              </p>
              {extension.description === null ? null : <p>{extension.description}</p>}
            </div>
          </header>

          <ExtensionActions
            extension={extension}
            system={system}
            onRequestUninstall={() => setUninstallCandidate(extension)}
          />

          <RuntimeDiagnostics extension={extension} />
          <ExtensionCapabilityList package_={extension} />
        </div>
      )}

      {uninstallCandidate === null ? null : (
        <ExtensionConfirmationDialog
          title={t("extensions.uninstallTitle")}
          description={t("extensions.uninstallDescription", {
            name: uninstallCandidate.displayName,
          })}
          confirmLabel={t("action.uninstall")}
          onCancel={() => setUninstallCandidate(null)}
          onConfirm={() => {
            const candidateId = uninstallCandidate.id;
            setUninstallCandidate(null);
            void system.uninstall(candidateId).then(onUninstalled).catch(system.reportError);
          }}
        />
      )}
    </main>
  );
}

function ExtensionActions({
  extension,
  system,
  onRequestUninstall,
}: {
  readonly extension: InstalledExtensionView;
  readonly system: ExtensionSystem;
  readonly onRequestUninstall: () => void;
}) {
  const { t } = useI18n();
  const busy = system.busyExtensionIds.has(extension.id);
  return (
    <div className="extension-details__actions">
      <button
        type="button"
        className="button button--primary"
        disabled={busy}
        onClick={() =>
          void system.setEnabled(extension.id, !extension.enabled).catch(system.reportError)
        }
      >
        {extension.enabled ? t("action.disable") : t("action.enable")}
      </button>
      <button
        type="button"
        className="button"
        disabled={busy || !extension.enabled}
        onClick={() => void system.restart(extension.id).catch(system.reportError)}
      >
        {t("action.restart")}
      </button>
      {extension.rollbackVersion === null ? null : (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void system.rollback(extension.id).catch(system.reportError)}
        >
          {t("action.rollback")} {extension.rollbackVersion}
        </button>
      )}
      <button
        type="button"
        className="button button--danger"
        disabled={busy}
        onClick={onRequestUninstall}
      >
        {t("action.uninstall")}
      </button>
    </div>
  );
}

function RuntimeDiagnostics({ extension }: { readonly extension: InstalledExtensionView }) {
  const { t } = useI18n();
  const runtime = extension.runtime;
  return (
    <section className="extension-details__section extension-diagnostics">
      <h2>{t("extensions.performance")}</h2>
      <dl>
        <div className="extension-diagnostics__metric">
          <dt>{t("extensions.runtimeState")}</dt>
          <dd>{runtime.state}</dd>
        </div>
        <div className="extension-diagnostics__metric">
          <dt>{t("extensions.activationDuration")}</dt>
          <dd>
            {runtime.lastActivationMilliseconds === null
              ? t("extensions.activationPending")
              : `${runtime.lastActivationMilliseconds} ms`}
          </dd>
        </div>
        <div className="extension-diagnostics__metric">
          <dt>{t("extensions.activations")}</dt>
          <dd>{runtime.activationCount}</dd>
        </div>
        <div className="extension-diagnostics__metric">
          <dt>{t("extensions.commandsExecuted")}</dt>
          <dd>{runtime.commandCount}</dd>
        </div>
      </dl>
      {runtime.lastCommandMilliseconds === null ? null : (
        <p>
          {t("extensions.commandMetrics", {
            count: runtime.commandCount,
            failures: runtime.commandFailureCount,
            milliseconds: runtime.lastCommandMilliseconds,
          })}
        </p>
      )}
      {runtime.lastError === null ? null : (
        <p className="extension-details__error">
          {t("extensions.lastError", { message: runtime.lastError.message })}
        </p>
      )}
    </section>
  );
}
