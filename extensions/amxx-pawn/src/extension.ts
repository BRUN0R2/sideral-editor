import type { ExtensionModule, OutputChannel, ProcessResult } from "@sideral/extension-sdk";

const COMPILE_COMMAND = "sideral.amxx-pawn.compile";
const COMPILER_GRANT = "sideral.amxx-pawn.amxxpc";
const PROJECT_COMPILER_GRANT = "sideral.amxx-pawn.amxxpc-project";

export const activate: ExtensionModule["activate"] = (context, api) => {
  const output = api.window.createOutputChannel("AMXX Pawn Compiler");
  const command = api.commands.registerTextEditorCommand(COMPILE_COMMAND, async (document) => {
    output.clear();
    output.show();

    if (document.languageId !== "amxxpawn" || !isSmaFile(document.uri)) {
      const message = "Open a saved .sma file to compile an AMXX plugin.";
      output.appendLine(message);
      await output.flush();
      await api.window.showWarningMessage(message);
      return { ok: false, reason: "unsupportedDocument" };
    }

    const outputUri = replaceFileExtension(document.uri, ".amxx");
    const projectIncludeUri = await findProjectInclude(api.workspace.findFiles);
    output.appendLine(`Compiling ${documentName(document.uri)}...`);
    if (projectIncludeUri !== null) {
      output.appendLine(`Project includes: ${uriPath(projectIncludeUri)}`);
    }
    await output.flush();

    let result: ProcessResult;
    try {
      result = await api.processes.execute({
        grant: projectIncludeUri === null ? COMPILER_GRANT : PROJECT_COMPILER_GRANT,
        inputs:
          projectIncludeUri === null
            ? { source: document.uri, output: outputUri }
            : {
                source: document.uri,
                "project-include": projectIncludeUri,
                output: outputUri,
              },
      });
    } catch (error: unknown) {
      const detail = errorMessage(error);
      const message =
        "Could not start the configured AMXX compiler. Select a valid executable in Settings.";
      output.appendLine(`${message}\n${detail}`);
      await output.flush();
      await api.window.showErrorMessage(message);
      return { ok: false, reason: "compilerUnavailable" };
    }

    appendCompilerOutput(output, result);
    if (result.exitCode === 0) {
      const message = `Compiled ${documentName(outputUri)} successfully.`;
      output.appendLine(message);
      await output.flush();
      await api.window.showInformationMessage(message);
      return { ok: true, exitCode: result.exitCode, outputUri };
    }

    const message = `amxxpc failed with exit code ${result.exitCode}.`;
    output.appendLine(message);
    await output.flush();
    await api.window.showErrorMessage(message);
    return { ok: false, exitCode: result.exitCode, outputUri };
  });

  context.subscriptions.add(output, command);
};

async function findProjectInclude(
  findFiles: (
    pattern: string,
    options?: { readonly limit?: number; readonly signal?: AbortSignal },
  ) => Promise<readonly string[]>,
): Promise<string | null> {
  const matches = await findFiles("include/*.inc", { limit: 1 });
  return matches[0] === undefined ? null : new URL("./", matches[0]).toString();
}

function appendCompilerOutput(output: OutputChannel, result: ProcessResult): void {
  appendBlock(output, result.standardOutput);
  if (result.standardError.length > 0) {
    output.appendLine("stderr:");
    appendBlock(output, result.standardError);
  }
}

function appendBlock(output: OutputChannel, value: string): void {
  const normalized = value.replaceAll("\r\n", "\n").trimEnd();
  if (normalized.length > 0) {
    output.appendLine(normalized);
  }
}

function isSmaFile(uri: string): boolean {
  return uri.startsWith("file:") && /\.sma$/iu.test(uri);
}

function replaceFileExtension(uri: string, extension: string): string {
  return uri.replace(/\.sma$/iu, extension);
}

function documentName(uri: string): string {
  const encodedName = uri.split("/").at(-1) ?? uri;
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

function uriPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The compiler process failed.";
}
