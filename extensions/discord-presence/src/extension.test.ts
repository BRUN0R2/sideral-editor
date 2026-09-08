import { createExtensionHarness } from "@sideral/extension-testkit";
import { describe, expect, it } from "vitest";
import { activate } from "./extension";

describe("Discord Work Presence", () => {
  it("publishes metadata changes once and clears the activity on disposal", async () => {
    const initialContext = {
      workspaceName: "sideral-editor",
      activeDocument: { name: "main.rs", languageId: "rust" },
    } as const;
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
        workspaceContext: initialContext,
      },
    );

    await harness.activate();
    await harness.updateWorkspaceContext(initialContext);
    expect(harness.discordActivityUpdates).toHaveLength(1);
    expect(harness.discordActivityUpdates[0]).toMatchObject({
      type: "playing",
      details: "🧑‍💻 main.rs",
      state: "📁 sideral-editor",
      buttons: [
        {
          label: "Download",
          url: "https://github.com/BRUN0R2/sideral-editor/releases/latest",
        },
      ],
    });

    const nextContext = {
      workspaceName: "sideral-editor",
      activeDocument: { name: "worker-entry.ts", languageId: "typescript" },
    } as const;
    await harness.updateWorkspaceContext(nextContext);
    await harness.updateWorkspaceContext(nextContext);
    expect(harness.discordActivityUpdates).toHaveLength(2);
    expect(harness.discordActivityUpdates[1]).toMatchObject({
      details: "🧑‍💻 worker-entry.ts",
    });

    await harness.dispose();
    expect(harness.discordActivityUpdates.at(-1)).toBeNull();
  });

  it("shows a coffee stop while the Sideral window is idle", async () => {
    const context = {
      workspaceName: "sideral-editor",
      activeDocument: { name: "main.rs", languageId: "rust" },
    } as const;
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
        workspaceContext: context,
      },
    );

    await harness.activate();
    await harness.updateWorkspaceContext(context);
    await harness.updateWindowActivityState("idle");
    expect(harness.discordActivityUpdates.at(-1)).toMatchObject({
      details: "Stopped for a coffee ☕",
      state: "📁 sideral-editor",
    });

    await harness.updateWindowActivityState("active");
    expect(harness.discordActivityUpdates.at(-1)).toMatchObject({
      details: "🧑‍💻 main.rs",
      state: "📁 sideral-editor",
    });
    await harness.dispose();
  });

  it("publishes immediately without user configuration", async () => {
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
      },
    );

    await harness.activate();
    await harness.updateWorkspaceContext({ workspaceName: null, activeDocument: null });

    expect(harness.discordActivityUpdates).toHaveLength(1);
    expect(harness.messages).toHaveLength(0);
    await harness.dispose();
  });

  it("does not block activation on Discord I/O", async () => {
    const activityStarted = Promise.withResolvers<void>();
    const activityRelease = Promise.withResolvers<void>();
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
        setDiscordActivity: async () => {
          activityStarted.resolve();
          await activityRelease.promise;
        },
      },
    );

    await harness.activate();
    await activityStarted.promise;
    expect(harness.discordActivityUpdates).toHaveLength(0);

    activityRelease.resolve();
    await harness.updateWorkspaceContext({ workspaceName: null, activeDocument: null });
    expect(harness.discordActivityUpdates).toHaveLength(1);
    await harness.dispose();
  });

  it("disposes deterministically while background initialization is pending", async () => {
    const activityStarted = Promise.withResolvers<void>();
    const activityRelease = Promise.withResolvers<void>();
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
        setDiscordActivity: async () => {
          activityStarted.resolve();
          await activityRelease.promise;
        },
      },
    );

    await harness.activate();
    await activityStarted.promise;
    let disposed = false;
    const disposal = harness.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    activityRelease.resolve();
    await disposal;
    expect(disposed).toBe(true);
    expect(harness.discordActivityUpdates.at(-1)).toBeNull();
  });

  it("retries failures and persists the explicit toggle state", async () => {
    let attempts = 0;
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
        workspaceContext: { workspaceName: "workspace", activeDocument: null },
        setDiscordActivity: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("Discord is not running");
          }
        },
      },
    );

    await harness.activate();
    await harness.executeCommand("sideral.discord-presence.refresh");
    expect(harness.outputs[0]?.content).toContain("Discord is not running");
    expect(harness.discordActivityUpdates).toHaveLength(1);

    await expect(harness.executeCommand("sideral.discord-presence.toggle")).resolves.toBe(false);
    expect(harness.storage.get("presence-enabled")).toBe(false);
    expect(harness.discordActivityUpdates.at(-1)).toBeNull();
    await harness.dispose();
  });
});
