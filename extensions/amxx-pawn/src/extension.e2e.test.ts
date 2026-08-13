import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionModule, ProcessRequest } from "@sideral/extension-sdk";
import { createExtensionHarness } from "@sideral/extension-testkit";
import { describe, expect, it } from "vitest";
import { activate } from "./extension";

const compiler = environment("SIDERAL_AMXXPC_E2E_COMPILER");
const workspace = environment("SIDERAL_AMXXPC_E2E_WORKSPACE");
const source = environment("SIDERAL_AMXXPC_E2E_SOURCE");
const enabled = compiler !== undefined && workspace !== undefined && source !== undefined;
const extensionModule: ExtensionModule = { activate };

describe.runIf(enabled)("AMXX Pawn real compiler E2E", () => {
  it("compiles a real workspace plugin through the extension command", async () => {
    if (compiler === undefined || workspace === undefined || source === undefined) {
      throw new Error("real compiler E2E environment is incomplete");
    }
    const workspaceRoot = realpathSync(workspace);
    const temporary = mkdtempSync(join(workspaceRoot, ".sideral-amxx-extension-e2e-"));
    const temporarySource = join(temporary, "validation.sma");
    const temporaryOutput = join(temporary, "validation.amxx");
    copyFileSync(source, temporarySource);

    try {
      let processRequest: ProcessRequest | undefined;
      const harness = createExtensionHarness(extensionModule, {
        extensionId: "sideral.amxx-pawn",
        activeTextDocument: {
          uri: pathToFileURL(temporarySource).toString(),
          languageId: "amxxpawn",
          version: 1,
          content: readFileSync(temporarySource, "utf8"),
        },
        findFiles: async () => [
          pathToFileURL(join(workspaceRoot, "include/rezombie_main.inc")).toString(),
        ],
        executeProcess: async (request) => {
          processRequest = request;
          const inputs = request.inputs ?? {};
          const includeUri = processInput(inputs, "project-include");
          const sourceUri = processInput(inputs, "source");
          const outputUri = processInput(inputs, "output");
          if (includeUri === undefined || sourceUri === undefined || outputUri === undefined) {
            throw new Error("extension did not provide the typed compiler inputs");
          }
          const result = spawnSync(
            compiler,
            [
              fileURLToPath(sourceUri),
              `-i${fileURLToPath(includeUri)}`,
              `-o${fileURLToPath(outputUri)}`,
            ],
            { cwd: dirname(compiler), encoding: "utf8" },
          );
          if (result.error !== undefined) {
            throw result.error;
          }
          return {
            exitCode: result.status ?? -1,
            standardOutput: result.stdout,
            standardError: result.stderr,
          };
        },
      });

      await harness.activate();
      const result = await harness.executeCommand("sideral.amxx-pawn.compile");

      expect(processRequest?.grant).toBe("sideral.amxx-pawn.amxxpc-project");
      expect(result).toEqual({
        ok: true,
        exitCode: 0,
        outputUri: pathToFileURL(temporaryOutput).toString(),
      });
      expect(existsSync(temporaryOutput)).toBe(true);
      expect(statSync(temporaryOutput).size).toBeGreaterThan(0);
      expect(harness.outputs[0]?.content).toContain("Done.");
      await harness.dispose();
    } finally {
      removeContainedTemporaryDirectory(workspaceRoot, temporary);
    }
  });
});

function environment(name: string): string | undefined {
  return process.env[name];
}

function processInput(inputs: Readonly<Record<string, string>>, name: string): string | undefined {
  return inputs[name];
}

function removeContainedTemporaryDirectory(workspaceRoot: string, temporary: string): void {
  const resolved = realpathSync(temporary);
  const contained = relative(workspaceRoot, resolved);
  if (contained.length === 0 || contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error(`refusing to remove E2E directory outside the workspace: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}
