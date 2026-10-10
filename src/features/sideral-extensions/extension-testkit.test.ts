import type { ExtensionModule } from "@sideral/extension-sdk";
import { describe, expect, it } from "vitest";
import { createExtensionHarness } from "../../../packages/sideral-extension-testkit/src/index";

describe("Sideral extension test kit", () => {
  it("activates, executes and disposes a command deterministically", async () => {
    const extension: ExtensionModule = {
      async activate(context, api) {
        const output = api.window.createOutputChannel("Test");
        context.subscriptions.add(
          output,
          api.commands.registerCommand("test.extension.run", async () => {
            const current = await api.storage.get("runs");
            const runs = typeof current === "number" ? current + 1 : 1;
            await api.storage.update("runs", runs);
            output.appendLine(`Run ${runs}`);
            output.show();
            await api.window.showInformationMessage("Command completed.");
            return { runs };
          }),
        );
      },
    };
    const harness = createExtensionHarness(extension);

    await harness.activate();
    await expect(harness.executeCommand("test.extension.run")).resolves.toEqual({ runs: 1 });
    expect(harness.storage.get("runs")).toBe(1);
    expect(harness.messages).toEqual([{ severity: "information", message: "Command completed." }]);
    expect(harness.outputs[0]).toMatchObject({
      name: "Test",
      content: "Run 1\n",
      visible: true,
      disposed: false,
    });

    await harness.dispose();
    expect(harness.outputs[0]?.disposed).toBe(true);
  });

  it("serializes concurrent command executions", async () => {
    let concurrentExecutions = 0;
    let maximumConcurrency = 0;
    const extension: ExtensionModule = {
      activate(context, api) {
        context.subscriptions.add(
          api.commands.registerCommand("test.extension.serial", async () => {
            concurrentExecutions += 1;
            maximumConcurrency = Math.max(maximumConcurrency, concurrentExecutions);
            await Promise.resolve();
            concurrentExecutions -= 1;
          }),
        );
      },
    };
    const harness = createExtensionHarness(extension);

    await harness.activate();
    await Promise.all([
      harness.executeCommand("test.extension.serial"),
      harness.executeCommand("test.extension.serial"),
      harness.executeCommand("test.extension.serial"),
    ]);

    expect(maximumConcurrency).toBe(1);
    await harness.dispose();
  });

  it("serializes commands and workspace callbacks on the same extension lane", async () => {
    const executionOrder: string[] = [];
    let releaseCommand: (() => void) | undefined;
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const extension: ExtensionModule = {
      activate(context, api) {
        context.subscriptions.add(
          api.commands.registerCommand("test.extension.wait", async () => {
            executionOrder.push("command:start");
            await commandGate;
            executionOrder.push("command:end");
          }),
          api.workspace.onDidChangeContext(() => {
            executionOrder.push("workspace");
          }),
        );
      },
    };
    const harness = createExtensionHarness(extension);

    await harness.activate();
    const command = harness.executeCommand("test.extension.wait");
    await Promise.resolve();
    const workspaceUpdate = harness.updateWorkspaceContext({
      workspaceName: "next-workspace",
      activeDocument: null,
    });
    expect(executionOrder).toEqual(["command:start"]);

    releaseCommand?.();
    await Promise.all([command, workspaceUpdate]);
    expect(executionOrder).toEqual(["command:start", "command:end", "workspace"]);
    await harness.dispose();
  });

  it("keeps preview scrollbar overrides scoped and cloned", async () => {
    const appearance = {
      scrollbar: {
        trackSize: 16,
        thumbSize: 10,
        trackColor: "transparent",
        thumbColor: "#8b5cf6",
        thumbHoverColor: "#a78bfa",
        thumbActiveColor: "#c4b5fd",
        showButtons: true,
        buttonSize: 18,
        arrowSize: 10,
        arrowHeight: 5,
        arrowColor: "#ddd6fe",
        arrowHoverColor: "#ede9fe",
        arrowActiveColor: "#ffffff",
        cornerRadius: 12,
      },
    };
    const extension: ExtensionModule = {
      async activate(context, api) {
        const preview = api.window.createPreviewPanel({
          title: "Custom preview",
          format: "tree",
          content: ["Preview"],
          appearance,
        });
        context.subscriptions.add(preview);
        await preview.show();
      },
    };
    const harness = createExtensionHarness(extension);

    await harness.activate();
    appearance.scrollbar.thumbColor = "#000000";

    expect(harness.previews[0]).toMatchObject({
      title: "Custom preview",
      visible: true,
      appearance: {
        scrollbar: {
          trackSize: 16,
          thumbSize: 10,
          thumbColor: "#8b5cf6",
          showButtons: true,
          buttonSize: 18,
          arrowSize: 10,
          arrowHeight: 5,
          arrowColor: "#ddd6fe",
          cornerRadius: 12,
        },
      },
    });
    await harness.dispose();
    expect(harness.previews[0]?.disposed).toBe(true);
  });

  it("executes nested local commands without deadlocking the serial queue", async () => {
    const extension: ExtensionModule = {
      activate(context, api) {
        context.subscriptions.add(
          api.commands.registerCommand("test.extension.inner", () => 42),
          api.commands.registerCommand("test.extension.outer", () =>
            api.commands.executeCommand("test.extension.inner"),
          ),
        );
      },
    };
    const harness = createExtensionHarness(extension);

    await harness.activate();
    await expect(harness.executeCommand("test.extension.outer")).resolves.toBe(42);
    await harness.dispose();
  });

  it("provides declared configuration as read-only runtime input", async () => {
    const extension: ExtensionModule = {
      activate(context, api) {
        context.subscriptions.add(
          api.commands.registerCommand("test.extension.configuration", () =>
            api.configuration.get("compiler-path"),
          ),
        );
      },
    };
    const harness = createExtensionHarness(extension, {
      configuration: { "compiler-path": "D:\\Tools\\compiler.exe" },
    });

    await harness.activate();

    await expect(harness.executeCommand("test.extension.configuration")).resolves.toBe(
      "D:\\Tools\\compiler.exe",
    );
    await harness.dispose();
  });

  it("disposes every resource in reverse order when cleanup fails", async () => {
    const cleanupOrder: string[] = [];
    const extension: ExtensionModule = {
      activate(context) {
        context.subscriptions.add(
          {
            dispose() {
              cleanupOrder.push("first");
            },
          },
          {
            dispose() {
              cleanupOrder.push("second");
              throw new Error("second failed");
            },
          },
        );
      },
      deactivate() {
        cleanupOrder.push("deactivate");
      },
    };
    const harness = createExtensionHarness(extension);

    await harness.activate();
    await expect(harness.dispose()).rejects.toThrow("cleanup operations failed");

    expect(cleanupOrder).toEqual(["deactivate", "second", "first"]);
  });
});
