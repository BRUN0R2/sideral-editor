import {
  arrayBuffer,
  BoundaryValidationError,
  enumeration,
  nonEmptyString,
  nullable,
  record,
  required,
  safeInteger,
} from "../../lib/runtime-validation";
import type { TerminalEvent, TerminalSessionId, TerminalSessionSnapshot } from "./contracts";

const TERMINAL_SESSION_ID_PATTERN = /^terminal-[1-9]\d*$/;
const MAX_TERMINAL_OUTPUT_BYTES = 16 * 1024;

export function decodeTerminalSessionSnapshot(value: unknown): TerminalSessionSnapshot {
  const path = "integrated terminal session response";
  const source = record(value, path, ["id", "processId", "shellName", "workingDirectory"]);
  return {
    id: decodeTerminalSessionId(required(source, "id", path), `${path}.id`),
    processId: nullable(
      required(source, "processId", path),
      `${path}.processId`,
      (item, itemPath) => safeInteger(item, itemPath, 1),
    ),
    shellName: nonEmptyString(required(source, "shellName", path), `${path}.shellName`),
    workingDirectory: nonEmptyString(
      required(source, "workingDirectory", path),
      `${path}.workingDirectory`,
    ),
  };
}

export function decodeTerminalEvent(value: unknown): TerminalEvent {
  const path = "integrated terminal event";
  const source = record(value, path, ["kind", "exitCode", "signal", "operation", "message"]);
  const kind = enumeration(required(source, "kind", path), ["exited", "failure"], `${path}.kind`);
  if (kind === "exited") {
    const exact = record(value, path, ["kind", "exitCode", "signal"]);
    return {
      kind,
      exitCode: safeInteger(required(exact, "exitCode", path), `${path}.exitCode`),
      signal: nullable(required(exact, "signal", path), `${path}.signal`, nonEmptyString),
    };
  }
  const exact = record(value, path, ["kind", "operation", "message"]);
  return {
    kind,
    operation: enumeration(
      required(exact, "operation", path),
      ["output", "wait"],
      `${path}.operation`,
    ),
    message: nonEmptyString(required(exact, "message", path), `${path}.message`),
  };
}

export function decodeTerminalOutput(value: unknown): Uint8Array<ArrayBuffer> {
  const path = "integrated terminal output";
  const output = arrayBuffer(value, path);
  if (output.byteLength > MAX_TERMINAL_OUTPUT_BYTES) {
    throw new BoundaryValidationError(path, `must not exceed ${MAX_TERMINAL_OUTPUT_BYTES} bytes`);
  }
  return new Uint8Array(output);
}

function decodeTerminalSessionId(value: unknown, path: string): TerminalSessionId {
  const identifier = nonEmptyString(value, path);
  if (!TERMINAL_SESSION_ID_PATTERN.test(identifier)) {
    throw new BoundaryValidationError(path, "must be a canonical terminal session identifier");
  }
  return identifier as TerminalSessionId;
}
