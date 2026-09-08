import type { HostToWorkerMessage } from "@sideral/extension-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedWorker } from "./managed-worker";
import { EXTENSION_PROTOCOL_VERSION as PROTOCOL_VERSION } from "./protocol-version";

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
        "none",
        async () => undefined,
        async () => undefined,
      );
      const initialization = runtime.initialize({
        kind: "initialize",
        protocolVersion: PROTOCOL_VERSION,
        generation: index + 1,
        extensionId: `publisher.extension-${index}`,
        extensionUri: `file:///extensions/${index}`,
        storageUri: `file:///storage/${index}`,
        bundleUrl,
        commandIds: [],
        workspaceAccess: "none",
        workspaceContext: null,
        windowActivityState: "active",
      });

      runtime.terminate();
      runtime.terminate();

      await expect(initialization).rejects.toThrow("was terminated");
    }

    expect(FakeWorker.instances).toHaveLength(STRESS_ITERATIONS);
    expect(FakeWorker.instances.every((worker) => worker.terminationCount === 1)).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(STRESS_ITERATIONS);
  });

  it("forwards workspace metadata only to a worker with manifest authority", async () => {
    const context = {
      workspaceName: "sideral-editor",
      activeDocument: { name: "main.rs", languageId: "rust" },
    } as const;
    const createRuntime = (workspaceAccess: "none" | "metadata", suffix: string) => {
      const runtime = new ManagedWorker(
        `publisher.${suffix}`,
        1,
        "a".repeat(64),
        `blob:${suffix}`,
        workspaceAccess,
        async () => undefined,
        async () => undefined,
      );
      const initialization = runtime.initialize({
        kind: "initialize",
        protocolVersion: PROTOCOL_VERSION,
        generation: 1,
        extensionId: `publisher.${suffix}`,
        extensionUri: `file:///extensions/${suffix}`,
        storageUri: `file:///storage/${suffix}`,
        bundleUrl: `blob:${suffix}`,
        commandIds: [],
        workspaceAccess,
        workspaceContext:
          workspaceAccess === "none" ? null : { workspaceName: null, activeDocument: null },
        windowActivityState: "active",
      });
      void initialization.catch(() => undefined);
      return { initialization, runtime };
    };
    const deniedOwner = createRuntime("none", "denied");
    const denied = deniedOwner.runtime;
    denied.updateWorkspaceContext(context);
    expect(
      FakeWorker.instances[0]?.messages.filter(
        (message) => message.kind === "workspaceContextChanged",
      ),
    ).toEqual([]);

    const permittedOwner = createRuntime("metadata", "permitted");
    const permitted = permittedOwner.runtime;
    permitted.updateWorkspaceContext(context);
    expect(
      FakeWorker.instances[1]?.messages.filter(
        (message) => message.kind === "workspaceContextChanged",
      ),
    ).toEqual([
      {
        kind: "workspaceContextChanged",
        protocolVersion: PROTOCOL_VERSION,
        generation: 1,
        context,
      },
    ]);

    denied.terminate();
    permitted.terminate();
    await expect(deniedOwner.initialization).rejects.toThrow("was terminated");
    await expect(permittedOwner.initialization).rejects.toThrow("was terminated");
  });

  it("forwards window activity transitions without a manifest permission", async () => {
    const runtime = new ManagedWorker(
      "publisher.activity",
      1,
      "a".repeat(64),
      "blob:activity",
      "none",
      async () => undefined,
      async () => undefined,
    );
    const initialization = runtime.initialize({
      kind: "initialize",
      protocolVersion: PROTOCOL_VERSION,
      generation: 1,
      extensionId: "publisher.activity",
      extensionUri: "file:///extensions/activity",
      storageUri: "file:///storage/activity",
      bundleUrl: "blob:activity",
      commandIds: [],
      workspaceAccess: "none",
      workspaceContext: null,
      windowActivityState: "active",
    });
    void initialization.catch(() => undefined);

    runtime.updateWindowActivityState("idle");

    expect(
      FakeWorker.instances[0]?.messages.filter(
        (message) => message.kind === "windowActivityStateChanged",
      ),
    ).toEqual([
      {
        kind: "windowActivityStateChanged",
        protocolVersion: PROTOCOL_VERSION,
        generation: 1,
        state: "idle",
      },
    ]);
    runtime.terminate();
    await expect(initialization).rejects.toThrow("was terminated");
  });
});
