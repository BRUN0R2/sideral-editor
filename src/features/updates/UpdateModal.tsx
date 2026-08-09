import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import { useI18n } from "../i18n/I18nProvider";
import { formatBytes, formatDuration } from "./progress";
import { useUpdates } from "./UpdateProvider";

export function UpdateModal({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { state, downloadAndInstall, restart, transferActive, checkForUpdates } = useUpdates();
  const progress = state.progress;
  const progressLabel = (() => {
    if (progress === null) {
      return null;
    }
    if (progress.totalBytes === null || progress.percent === null) {
      return t("updates.progressUnknown", { downloaded: formatBytes(progress.downloadedBytes) });
    }
    return t("updates.progress", {
      percent: Math.round(progress.percent),
      downloaded: formatBytes(progress.downloadedBytes),
      total: formatBytes(progress.totalBytes),
    });
  })();

  return (
    <Modal
      open={open}
      title={t("updates.title")}
      closeLabel={t("action.close")}
      onClose={onClose}
      dismissible={!transferActive}
      className="update-modal"
    >
      <div className="update-hero">
        <div className="update-hero__icon" aria-hidden="true">
          <Icon name="update" size={25} />
        </div>
        <div>
          <span className="eyebrow">{t("updates.badgeLabel")}</span>
          <h3>
            {state.nextVersion === null
              ? t("updates.failed")
              : t("updates.available", { version: state.nextVersion })}
          </h3>
        </div>
      </div>

      <div className="version-comparison">
        <div>
          <span>{t("updates.currentVersion")}</span>
          <strong>{state.currentVersion}</strong>
        </div>
        <Icon name="chevronRight" size={18} />
        <div>
          <span>{t("updates.newVersion")}</span>
          <strong>{state.nextVersion ?? "—"}</strong>
        </div>
      </div>

      {state.phase === "downloading" || state.phase === "installing" ? (
        <section className="update-progress" aria-live="polite">
          <div className="update-progress__heading">
            <strong>
              {state.phase === "installing" ? t("updates.installing") : t("updates.downloading")}
            </strong>
            <span>
              {progress?.percent === null ? "" : `${Math.round(progress?.percent ?? 0)}%`}
            </span>
          </div>
          <div
            className={`progress-track ${state.phase === "installing" ? "progress-track--installing" : ""}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              progress?.percent === null ? undefined : Math.round(progress?.percent ?? 0)
            }
          >
            <span style={{ width: `${progress?.percent ?? 18}%` }} />
          </div>
          <div className="update-progress__details">
            <span>
              {state.phase === "installing" ? t("updates.installingDetail") : progressLabel}
            </span>
            {state.phase === "downloading" && progress?.etaSeconds !== null ? (
              <span>{t("updates.eta", { time: formatDuration(progress?.etaSeconds ?? 0) })}</span>
            ) : null}
          </div>
          <p className="transfer-note">{t("updates.closeDuringTransfer")}</p>
        </section>
      ) : null}

      {state.phase !== "downloading" && state.phase !== "installing" ? (
        <section className="release-notes">
          <h4>{t("updates.releaseNotes")}</h4>
          <div className="release-notes__body">
            {state.releaseNotes?.trim() || t("updates.noReleaseNotes")}
          </div>
        </section>
      ) : null}

      {state.error !== null ? (
        <div className="inline-alert inline-alert--error" role="alert">
          <Icon name="alert" size={17} />
          <span>{state.error}</span>
        </div>
      ) : null}

      <footer className="modal-actions">
        {!transferActive ? (
          <button type="button" className="ghost-button" onClick={onClose}>
            {t("action.close")}
          </button>
        ) : null}
        {state.phase === "available" ? (
          <button
            type="button"
            className="primary-button"
            onClick={() => void downloadAndInstall()}
          >
            <Icon name="download" size={17} />
            {t("updates.download")}
          </button>
        ) : null}
        {state.phase === "ready" ? (
          <button type="button" className="primary-button" onClick={() => void restart()}>
            <Icon name="refresh" size={17} />
            {t("updates.restart")}
          </button>
        ) : null}
        {state.phase === "error" ? (
          <button type="button" className="primary-button" onClick={() => void checkForUpdates()}>
            <Icon name="refresh" size={17} />
            {t("action.retry")}
          </button>
        ) : null}
      </footer>
    </Modal>
  );
}
