import { createExtensionHarness } from "@sideral/extension-testkit";
import { describe, expect, it } from "vitest";
import { activate } from "./extension";

describe("Discord Work Presence", () => {
  it("publishes metadata changes once and clears the activity on disposal", async () => {
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
        workspaceContext: {
          workspaceName: "sideral-editor",
          activeDocument: { name: "main.rs", languageId: "rust" },
        },
      },
    );

    await harness.activate();
    expect(harness.discordActivityUpdates).toHaveLength(1);
    expect(harness.discordActivityUpdates[0]).toMatchObject({
      type: "playing",
      details: "Editing main.rs",
      state: "Workspace: sideral-editor",
    });

    const nextContext = {
      workspaceName: "sideral-editor",
      activeDocument: { name: "worker-entry.ts", languageId: "typescript" },
    } as const;
    await harness.updateWorkspaceContext(nextContext);
    await harness.updateWorkspaceContext(nextContext);
    expect(harness.discordActivityUpdates).toHaveLength(2);
    expect(harness.discordActivityUpdates[1]).toMatchObject({
      details: "Editing worker-entry.ts",
    });

    await harness.dispose();
    expect(harness.discordActivityUpdates.at(-1)).toBeNull();
  });

  it("publishes immediately without user configuration", async () => {
    const harness = createExtensionHarness(
      { activate },
      {
        extensionId: "sideral.discord-presence",
      },
    );

    await harness.activate();

    expect(harness.discordActivityUpdates).toHaveLength(1);
    expect(harness.messages).toHaveLength(0);
    await harness.dispose();
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
    expect(harness.outputs[0]?.content).toContain("Discord is not running");
    await harness.executeCommand("sideral.discord-presence.refresh");
    expect(harness.discordActivityUpdates).toHaveLength(1);

    await expect(harness.executeCommand("sideral.discord-presence.toggle")).resolves.toBe(false);
    expect(harness.storage.get("presence-enabled")).toBe(false);
    expect(harness.discordActivityUpdates.at(-1)).toBeNull();
    await harness.dispose();
  });
});
