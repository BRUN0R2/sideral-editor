import { Channel, invoke } from "@tauri-apps/api/core";
import { ApplicationError, toApplicationError } from "../../lib/errors";
import { voidValue } from "../../lib/runtime-validation";
import type { FileOpenRequest } from "./contracts";
import { decodeFileOpenInstruction } from "./contractValidation";

export interface FileOpeningOptions {
  openPath(path: string): Promise<void>;
  reportError(error: unknown): void;
}

export interface FileOpeningConnection {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

export function connectFileOpening(options: FileOpeningOptions): FileOpeningConnection {
  const clientId = crypto.randomUUID();
  let disposed = false;
  let connected = false;
  let disposal: Promise<void> | null = null;
  let processing: Promise<void> = Promise.resolve();
  let channel: Channel<unknown> | null = null;
  const receivedIds = new Set<number>();

  const reportError = (error: unknown): void => {
    if (!disposed) {
      options.reportError(error);
    }
  };
  const onInstruction = (value: unknown): void => {
    if (disposed) {
      return;
    }
    try {
      const instruction = decodeFileOpenInstruction(value);
      if (instruction.kind === "failure") {
        reportError(instruction.error);
        return;
      }
      const { request } = instruction;
      if (receivedIds.has(request.id)) {
        return;
      }
      receivedIds.add(request.id);
      processing = processing
        .then(() => processRequest(request))
        .catch(reportError)
        .finally(() => receivedIds.delete(request.id));
    } catch (error: unknown) {
      reportError(error);
    }
  };

  async function processRequest(request: FileOpenRequest): Promise<void> {
    if (disposed) {
      return;
    }
    const errors = request.files.errors.map(toApplicationError);
    for (const path of request.files.paths) {
      if (disposed) {
        return;
      }
      try {
        await options.openPath(path);
      } catch (error: unknown) {
        errors.push(toApplicationError(error));
      }
    }
    if (disposed) {
      return;
    }
    if (errors.length > 0) {
      reportError(
        new ApplicationError("file_opening_error", errors.map((error) => error.message).join("\n")),
      );
    }
    await invokeVoid("acknowledge_file_opening", { clientId, requestId: request.id });
  }

  // StrictMode can dispose an effect before its first microtask. No native
  // subscription is created for that discarded owner.
  const ready = Promise.resolve().then(async () => {
    if (disposed) {
      return;
    }
    channel = new Channel<unknown>(onInstruction);
    await invokeVoid("connect_file_opening", { clientId, channel });
    connected = true;
  });

  return {
    ready,
    dispose() {
      if (disposal !== null) {
        return disposal;
      }
      disposed = true;
      if (channel !== null) {
        channel.onmessage = () => undefined;
      }
      disposal = ready.then(
        async () => {
          if (connected) {
            await invokeVoid("disconnect_file_opening", { clientId });
          }
        },
        () => undefined,
      );
      return disposal;
    },
  };
}

async function invokeVoid(command: string, argumentsValue: Record<string, unknown>): Promise<void> {
  voidValue(await invoke<unknown>(command, argumentsValue), `${command} response`);
}
