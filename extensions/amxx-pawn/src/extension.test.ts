import type { ExtensionModule, ProcessRequest } from "@sideral/extension-sdk";
import { createExtensionHarness } from "@sideral/extension-testkit";
import { describe, expect, it } from "vitest";
import { activate } from "./extension";

const extensionModule: ExtensionModule = { activate };

describe("AMXX Pawn compiler extension", () => {
  it("compiles the active SMA document into an adjacent AMXX file", async () => {
    let processRequest: ProcessRequest | undefined;
    const harness = createExtensionHarness(extensionModule, {
      extensionId: "sideral.amxx-pawn",
      activeTextDocument: {
        uri: "file:///D:/server/addons/amxmodx/scripting/example%20plugin.sma",
        languageId: "amxxpawn",
        version: 4,
        content: "public plugin_init() {}",
      },
      executeProcess: async (request) => {
        processRequest = request;
        return {
          exitCode: 0,
          standardOutput: "Pawn compiler 1.10\nDone.\n",
          standardError: "",
        };
      },
      findFiles: async () => [],
    });

    await harness.activate();
    const result = await harness.executeCommand("sideral.amxx-pawn.compile");

    expect(processRequest).toEqual({
      grant: "sideral.amxx-pawn.amxxpc",
      inputs: {
        source: "file:///D:/server/addons/amxmodx/scripting/example%20plugin.sma",
        output: "file:///D:/server/addons/amxmodx/scripting/example%20plugin.amxx",
      },
    });
    expect(result).toEqual({
      ok: true,
      exitCode: 0,
      outputUri: "file:///D:/server/addons/amxmodx/scripting/example%20plugin.amxx",
    });
    expect(harness.outputs[0]?.visible).toBe(true);
    expect(harness.outputs[0]?.content).toContain("Pawn compiler 1.10");
    expect(harness.messages).toEqual([
      { severity: "information", message: "Compiled example plugin.amxx successfully." },
    ]);
  });

  it("adds a validated workspace include directory when the project contributes one", async () => {
    let processRequest: ProcessRequest | undefined;
    const harness = createExtensionHarness(extensionModule, {
      extensionId: "sideral.amxx-pawn",
      activeTextDocument: {
        uri: "file:///D:/server/rezombie/src/class/Human.sma",
        languageId: "amxxpawn",
        version: 1,
        content: "#include <rezombie_main>",
      },
      findFiles: async (pattern) => {
        expect(pattern).toBe("include/*.inc");
        return ["file:///D:/server/rezombie/include/rezombie_main.inc"];
      },
      executeProcess: async (request) => {
        processRequest = request;
        return { exitCode: 0, standardOutput: "Done.\n", standardError: "" };
      },
    });

    await harness.activate();
    await harness.executeCommand("sideral.amxx-pawn.compile");

    expect(processRequest).toEqual({
      grant: "sideral.amxx-pawn.amxxpc-project",
      inputs: {
        source: "file:///D:/server/rezombie/src/class/Human.sma",
        "project-include": "file:///D:/server/rezombie/include/",
        output: "file:///D:/server/rezombie/src/class/Human.amxx",
      },
    });
  });

  it("rejects INC files even though they share the Pawn language", async () => {
    const harness = createExtensionHarness(extensionModule, {
      activeTextDocument: {
        uri: "file:///D:/server/addons/amxmodx/scripting/include/shared.inc",
        languageId: "amxxpawn",
        version: 1,
        content: "native shared();",
      },
      findFiles: async () => [],
    });

    await harness.activate();
    const result = await harness.executeCommand("sideral.amxx-pawn.compile");

    expect(result).toEqual({ ok: false, reason: "unsupportedDocument" });
    expect(harness.messages[0]?.severity).toBe("warning");
  });

  it("reports compiler startup failures without crashing its worker", async () => {
    const harness = createExtensionHarness(extensionModule, {
      activeTextDocument: {
        uri: "file:///D:/server/plugin.sma",
        languageId: "amxxpawn",
        version: 1,
        content: "public plugin_init() {}",
      },
      executeProcess: async () => {
        throw new Error("process grant executable was not found");
      },
      findFiles: async () => [],
    });

    await harness.activate();
    const result = await harness.executeCommand("sideral.amxx-pawn.compile");

    expect(result).toEqual({ ok: false, reason: "compilerUnavailable" });
    expect(harness.outputs[0]?.content).toContain("process grant executable was not found");
    expect(harness.messages[0]?.severity).toBe("error");
  });
});
