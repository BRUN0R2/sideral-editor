import { describe, expect, it } from "vitest";
import type { OutputChannelView } from "./contracts";
import { observeOutputChannel } from "./output-lifecycle";

const OUTPUT: OutputChannelView = {
  resourceId: "acme.compiler:1",
  extensionId: "acme.compiler",
  name: "Compiler",
  content: "Compiling...\n",
  revealSequence: 0,
};

describe("extension output lifecycle", () => {
  it("updates flushed content without requesting focus", () => {
    const observation = observeOutputChannel(new Map(), OUTPUT);
    expect(observation.kind).toBe("update");
    if (observation.kind === "update") {
      expect(observation.revealRequested).toBe(false);
    }
  });

  it("requests one reveal for each new show sequence", () => {
    const shown = observeOutputChannel(new Map(), { ...OUTPUT, revealSequence: 1 });
    expect(shown.kind).toBe("update");
    if (shown.kind !== "update") {
      return;
    }
    expect(shown.revealRequested).toBe(true);

    const flushed = observeOutputChannel(shown.sequences, {
      ...OUTPUT,
      content: "Done.\n",
      revealSequence: 1,
    });
    expect(flushed).toMatchObject({ kind: "update", revealRequested: false });

    expect(observeOutputChannel(flushed.sequences, { ...OUTPUT, revealSequence: 2 })).toMatchObject(
      { kind: "update", revealRequested: true },
    );
  });

  it("rejects out-of-order output snapshots", () => {
    const observation = observeOutputChannel(new Map([[OUTPUT.resourceId, 2]]), {
      ...OUTPUT,
      revealSequence: 1,
    });
    expect(observation.kind).toBe("stale");
  });
});
