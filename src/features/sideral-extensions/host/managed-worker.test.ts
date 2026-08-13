import type { HostToWorkerMessage } from "@sideral/extension-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedWorker } from "./managed-worker";

const STRESS_ITERATIONS: number = 128;

class FakeWorker extends EventTarget {
  static readonly instances: FakeWorker[] = [];

  readonly messages: HostToWorkerMessage[] = [];
  terminationCount = 0;

  constructor(_scriptUrl: URL, _options: WorkerOptions) {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: HostToWorkerMessage): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminationCount += 1;
  }
}

describe("ManagedWorker resource ownership", () => {
  beforeEach(() => {
    FakeWorker.instances.length = 0;
    vi.stubGlobal("Worker", FakeWorker);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deterministically terminates workers and revokes bundle URLs under repetition", async () => {
    for (let index = 0; index < STRESS_ITERATIONS; index += 1) {
      const bundleUrl = `blob:sideral-${index}`;
      const runtime = new ManagedWorker(
        `publisher.extension-${index}`,
        index + 1,
        "a".repeat(64),
        bundleUrl,
        async () => undefined,
        async () => undefined,
      );
      const initialization = runtime.initialize({
        kind: "initialize",
        protocolVersion: 1,
        generation: index + 1,
        extensionId: `publisher.extension-${index}`,
        extensionUri: `file:///extensions/${index}`,
        storageUri: `file:///storage/${index}`,
        bundleUrl,
        commandIds: [],
      });

      runtime.terminate();
      runtime.terminate();

      await expect(initialization).rejects.toThrow("was terminated");
    }

    expect(FakeWorker.instances).toHaveLength(STRESS_ITERATIONS);
    expect(FakeWorker.instances.every((worker) => worker.terminationCount === 1)).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(STRESS_ITERATIONS);
  });
});
