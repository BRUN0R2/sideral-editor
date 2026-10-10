import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationError } from "../../lib/errors";
import { optional, record } from "../../lib/runtime-validation";
import { connectFileOpening } from "./connection";
import { decodeFileOpenInstruction } from "./contractValidation";

beforeEach(() => vi.stubGlobal("window", { crypto }));
afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

function request(id: number, paths: readonly string[]) {
  return { kind: "open", request: { id, files: { paths, errors: [] } } };
}

function ipcArgument(value: unknown, key: string): unknown {
  return optional(record(value, "mock IPC arguments"), key);
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("file-opening connection", () => {
  it("opens batches in order, continues after a failed file and acknowledges after completion", async () => {
    const commands: string[] = [];
    const opened: string[] = [];
    const reports: unknown[] = [];
    const firstFile = deferred();
    const completed = deferred();
    mockIPC((command, argumentsValue) => {
      commands.push(command);
      if (command === "connect_file_opening") {
        const channel = ipcArgument(argumentsValue, "channel");
        if (!(channel instanceof Channel)) {
          throw new Error("A native channel is required.");
        }
        channel.onmessage(request(1, ["first.ts", "missing.rs", "last.ts"]));
        channel.onmessage(request(2, ["next.ts"]));
      }
      if (
        command === "acknowledge_file_opening" &&
        ipcArgument(argumentsValue, "requestId") === 2
      ) {
        completed.resolve();
      }
      return null;
    });
    const connection = connectFileOpening({
      async openPath(path) {
        opened.push(path);
        if (path === "first.ts") {
          await firstFile.promise;
        }
        if (path === "missing.rs") {
          throw new ApplicationError("io_error", "missing.rs cannot be read");
        }
      },
      reportError: (error) => reports.push(error),
    });
    await connection.ready;
    expect(opened).toEqual(["first.ts"]);
    expect(commands).not.toContain("acknowledge_file_opening");
    firstFile.resolve();
    await completed.promise;
    expect(opened).toEqual(["first.ts", "missing.rs", "last.ts", "next.ts"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ message: "missing.rs cannot be read" });
    await connection.dispose();
    expect(commands.at(-1)).toBe("disconnect_file_opening");
  });

  it("does not create a native subscription for a disposed StrictMode owner", async () => {
    const invoke = vi.fn(() => null);
    mockIPC(invoke);
    const connection = connectFileOpening({ openPath: vi.fn(), reportError: vi.fn() });
    await connection.dispose();
    await connection.ready;
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves an interrupted request unacknowledged for the next connection", async () => {
    const commands: string[] = [];
    const pendingFile = deferred();
    const finishedFile = deferred();
    const openPath = vi.fn(async () => {
      await pendingFile.promise;
      finishedFile.resolve();
    });
    mockIPC((command, argumentsValue) => {
      commands.push(command);
      if (command === "connect_file_opening") {
        const channel = ipcArgument(argumentsValue, "channel");
        if (channel instanceof Channel) {
          channel.onmessage(request(1, ["first.ts", "second.ts"]));
        }
      }
      return null;
    });
    const connection = connectFileOpening({ openPath, reportError: vi.fn() });
    await connection.ready;
    await connection.dispose();
    pendingFile.resolve();
    await finishedFile.promise;
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(commands).not.toContain("acknowledge_file_opening");
  });

  it("reports malformed native instructions without opening or acknowledging files", async () => {
    const openPath = vi.fn();
    const reportError = vi.fn();
    mockIPC((command, argumentsValue) => {
      if (command === "connect_file_opening") {
        const channel = ipcArgument(argumentsValue, "channel");
        if (channel instanceof Channel) {
          channel.onmessage({ kind: "open", request: { id: -1 } });
        }
      }
      return null;
    });
    const connection = connectFileOpening({ openPath, reportError });
    await connection.ready;
    expect(openPath).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();
    await connection.dispose();
  });
});

describe("file-opening boundary", () => {
  it.each([
    { kind: "open", request: { id: 2 ** 32, files: { paths: ["main.rs"], errors: [] } } },
    { kind: "open", request: { id: 1, files: { paths: [], errors: [] } } },
    { kind: "open", request: { id: 1, files: { paths: [""], errors: [] } } },
    { kind: "failure", error: { code: "io_error", message: "failed", extra: true } },
  ])("rejects invalid input %#", (value) => {
    expect(() => decodeFileOpenInstruction(value)).toThrow();
  });
});
