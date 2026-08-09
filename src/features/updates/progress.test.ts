import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { describe, expect, it } from "vitest";
import { applyDownloadEvent, initialDownloadProgress } from "./progress";

describe("download progress", () => {
  it("calculates percentage and ETA from actual bytes", () => {
    const started = applyDownloadEvent(
      initialDownloadProgress(1_000),
      { event: "Started", data: { contentLength: 1_000 } },
      1_000,
    );
    const event: DownloadEvent = { event: "Progress", data: { chunkLength: 250 } };
    const progress = applyDownloadEvent(started, event, 2_000);

    expect(progress.percent).toBe(25);
    expect(progress.bytesPerSecond).toBe(250);
    expect(progress.etaSeconds).toBe(3);
  });

  it("finishes at 100 percent when the total is known", () => {
    const started = applyDownloadEvent(
      initialDownloadProgress(0),
      { event: "Started", data: { contentLength: 500 } },
      0,
    );
    const finished = applyDownloadEvent(started, { event: "Finished" }, 1_000);

    expect(finished.downloadedBytes).toBe(500);
    expect(finished.percent).toBe(100);
    expect(finished.etaSeconds).toBe(0);
  });
});
