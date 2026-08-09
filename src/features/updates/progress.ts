import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export interface DownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly percent: number | null;
  readonly bytesPerSecond: number | null;
  readonly etaSeconds: number | null;
  readonly startedAtMilliseconds: number;
}

export function initialDownloadProgress(nowMilliseconds: number): DownloadProgress {
  return {
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    bytesPerSecond: null,
    etaSeconds: null,
    startedAtMilliseconds: nowMilliseconds,
  };
}

export function applyDownloadEvent(
  current: DownloadProgress,
  event: DownloadEvent,
  nowMilliseconds: number,
): DownloadProgress {
  if (event.event === "Started") {
    const totalBytes = event.data.contentLength ?? null;
    return {
      ...initialDownloadProgress(nowMilliseconds),
      totalBytes,
      percent: totalBytes === 0 ? 100 : null,
    };
  }
  if (event.event === "Finished") {
    const downloadedBytes = current.totalBytes ?? current.downloadedBytes;
    return {
      ...current,
      downloadedBytes,
      percent: current.totalBytes === null ? null : 100,
      etaSeconds: 0,
    };
  }

  const downloadedBytes = current.downloadedBytes + event.data.chunkLength;
  const elapsedSeconds = Math.max((nowMilliseconds - current.startedAtMilliseconds) / 1000, 0.001);
  const bytesPerSecond = downloadedBytes / elapsedSeconds;
  const remainingBytes =
    current.totalBytes === null ? null : Math.max(current.totalBytes - downloadedBytes, 0);
  const percent =
    current.totalBytes === null || current.totalBytes === 0
      ? null
      : Math.min((downloadedBytes / current.totalBytes) * 100, 100);

  return {
    ...current,
    downloadedBytes,
    percent,
    bytesPerSecond,
    etaSeconds:
      remainingBytes === null || bytesPerSecond <= 0 ? null : remainingBytes / bytesPerSecond,
  };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = Math.max(bytes, 0);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(Math.ceil(seconds), 0);
  if (rounded < 60) {
    return `${rounded}s`;
  }
  const minutes = Math.ceil(rounded / 60);
  return `${minutes}m`;
}
