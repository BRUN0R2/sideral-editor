import { Channel, invoke } from "@tauri-apps/api/core";
import { ApplicationError } from "../../lib/errors";
import { voidValue } from "../../lib/runtime-validation";
import {
  decodeTerminalEvent,
  decodeTerminalOutput,
  decodeTerminalSessionSnapshot,
} from "./contract-validation";
import type { TerminalEvent, TerminalSessionId, TerminalSessionSnapshot } from "./contracts";

const MAX_TERMINAL_COLUMNS = 500;
const MAX_TERMINAL_INPUT_BYTES = 1024 * 1024;
const MAX_TERMINAL_ROWS = 500;
const MIN_TERMINAL_COLUMNS = 2;
const MIN_TERMINAL_ROWS = 1;
const TERMINAL_INPUT_ENCODER = new TextEncoder();

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export interface ConnectIntegratedTerminalOptions extends TerminalDimensions {
  readonly workspaceRoot: string | null;
}

export interface IntegratedTerminalConnection {
  readonly snapshot: TerminalSessionSnapshot;
  dispose(): Promise<void>;
  resize(dimensions: TerminalDimensions): Promise<void>;
  write(data: string): Promise<void>;
}

export async function connectIntegratedTerminal(
  options: ConnectIntegratedTerminalOptions,
  onOutput: (output: Uint8Array<ArrayBuffer>) => void,
  onEvent: (event: TerminalEvent) => void,
  onBoundaryFailure: (error: unknown) => void,
): Promise<IntegratedTerminalConnection> {
  validateDimensions(options);
  let disposed = false;
  const output = new Channel<unknown>((value) => {
    if (disposed) {
      return;
    }
    try {
      onOutput(decodeTerminalOutput(value));
    } catch (error: unknown) {
      onBoundaryFailure(error);
    }
  });
  const events = new Channel<unknown>((value) => {
    if (disposed) {
      return;
    }
    try {
      onEvent(decodeTerminalEvent(value));
    } catch (error: unknown) {
      onBoundaryFailure(error);
    }
  });

  let snapshot: TerminalSessionSnapshot;
  try {
    snapshot = await invokeDecoded(
      "create_integrated_terminal",
      {
        request: {
          workspaceRoot: options.workspaceRoot,
          columns: options.columns,
          rows: options.rows,
        },
        output,
        events,
      },
      decodeTerminalSessionSnapshot,
    );
  } catch (error: unknown) {
    output.onmessage = () => undefined;
    events.onmessage = () => undefined;
    throw error;
  }

  let inputQueue: Promise<void> = Promise.resolve();
  let pendingInputBytes = 0;
  let pendingDimensions: TerminalDimensions | null = null;
  let resizeQueue: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;

  const connection: IntegratedTerminalConnection = {
    snapshot,
    write(data) {
      if (disposed) {
        return Promise.reject(closedTerminalError());
      }
      const inputBytes = TERMINAL_INPUT_ENCODER.encode(data).byteLength;
      if (inputBytes > MAX_TERMINAL_INPUT_BYTES) {
        return Promise.reject(oversizedTerminalInputError());
      }
      if (pendingInputBytes + inputBytes > MAX_TERMINAL_INPUT_BYTES) {
        return Promise.reject(fullTerminalInputQueueError());
      }
      pendingInputBytes += inputBytes;
      const operation = inputQueue.then(async () => {
        if (!disposed) {
          await invokeVoid("write_integrated_terminal", { sessionId: snapshot.id, data });
        }
      });
      const trackedOperation = operation.finally(() => {
        pendingInputBytes -= inputBytes;
      });
      inputQueue = trackedOperation.catch(() => undefined);
      return trackedOperation;
    },
    resize(dimensions) {
      if (disposed) {
        return Promise.reject(closedTerminalError());
      }
      try {
        validateDimensions(dimensions);
      } catch (error: unknown) {
        return Promise.reject(error);
      }
      pendingDimensions = dimensions;
      resizeQueue ??= drainResizes(
        snapshot.id,
        () => pendingDimensions,
        (value) => {
          pendingDimensions = value;
        },
      ).finally(() => {
        resizeQueue = null;
      });
      return resizeQueue;
    },
    dispose() {
      if (disposal !== null) {
        return disposal;
      }
      disposed = true;
      pendingDimensions = null;
      output.onmessage = () => undefined;
      events.onmessage = () => undefined;
      disposal = invokeVoid("close_integrated_terminal", { sessionId: snapshot.id });
      return disposal;
    },
  };
  return connection;
}

async function drainResizes(
  sessionId: TerminalSessionId,
  current: () => TerminalDimensions | null,
  update: (value: TerminalDimensions | null) => void,
): Promise<void> {
  let dimensions = current();
  while (dimensions !== null) {
    update(null);
    await invokeVoid("resize_integrated_terminal", {
      sessionId,
      columns: dimensions.columns,
      rows: dimensions.rows,
    });
    dimensions = current();
  }
}

function validateDimensions(dimensions: TerminalDimensions): void {
  const { columns, rows } = dimensions;
  if (
    !Number.isInteger(columns) ||
    columns < MIN_TERMINAL_COLUMNS ||
    columns > MAX_TERMINAL_COLUMNS
  ) {
    throw new ApplicationError(
      "invalid_terminal_size",
      `Terminal columns must be between ${MIN_TERMINAL_COLUMNS} and ${MAX_TERMINAL_COLUMNS}.`,
    );
  }
  if (!Number.isInteger(rows) || rows < MIN_TERMINAL_ROWS || rows > MAX_TERMINAL_ROWS) {
    throw new ApplicationError(
      "invalid_terminal_size",
      `Terminal rows must be between ${MIN_TERMINAL_ROWS} and ${MAX_TERMINAL_ROWS}.`,
    );
  }
}

function closedTerminalError(): ApplicationError {
  return new ApplicationError("terminal_closed", "The integrated terminal is closed.");
}

function oversizedTerminalInputError(): ApplicationError {
  return new ApplicationError(
    "terminal_input_too_large",
    `Terminal input cannot exceed ${MAX_TERMINAL_INPUT_BYTES} bytes.`,
  );
}

function fullTerminalInputQueueError(): ApplicationError {
  return new ApplicationError(
    "terminal_input_queue_full",
    `Pending terminal input cannot exceed ${MAX_TERMINAL_INPUT_BYTES} bytes.`,
  );
}

async function invokeDecoded<Value>(
  command: string,
  arguments_: Record<string, unknown>,
  decode: (value: unknown) => Value,
): Promise<Value> {
  return decode(await invoke<unknown>(command, arguments_));
}

async function invokeVoid(command: string, arguments_: Record<string, unknown>): Promise<void> {
  voidValue(await invoke<unknown>(command, arguments_), `${command} response`);
}
