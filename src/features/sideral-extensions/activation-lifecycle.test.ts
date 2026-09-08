import type { ActivationReason } from "@sideral/extension-sdk";
import { describe, expect, it } from "vitest";
import { replayCurrentActivationEvents } from "./activation-lifecycle";

describe("extension activation lifecycle", () => {
  it("replays the current workbench and language events", async () => {
    const events: ActivationReason[] = [];

    await replayCurrentActivationEvents(async (reason) => {
      events.push(reason);
    }, "typescript");

    expect(events).toEqual([
      { kind: "workbenchReady" },
      { kind: "language", languageId: "typescript" },
    ]);
  });

  it("continues replaying context after one activation event fails", async () => {
    const events: ActivationReason[] = [];
    const workbenchFailure = new Error("workbench activation failed");

    await expect(
      replayCurrentActivationEvents(async (reason) => {
        events.push(reason);
        if (reason.kind === "workbenchReady") {
          throw workbenchFailure;
        }
      }, "rust"),
    ).rejects.toBe(workbenchFailure);
    expect(events).toEqual([{ kind: "workbenchReady" }, { kind: "language", languageId: "rust" }]);
  });
});
