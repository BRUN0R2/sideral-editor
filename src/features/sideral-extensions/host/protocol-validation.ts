import type {
  BrokerMethod,
  HostToWorkerMessage,
  JsonValue,
  ProtocolFailure,
  WorkerToHostMessage,
} from "@sideral/extension-sdk";
import {
  arrayOf,
  enumeration,
  jsonObject,
  jsonValue,
  literal,
  nullable,
  type RuntimeRecord,
  record,
  required,
  safeInteger,
  stringValue,
} from "../../../lib/runtime-validation";
import { decodeActivationReason, decodeTextDocument } from "../contract-validation";
import type { HostInstruction } from "../contracts";

const BROKER_METHODS: readonly BrokerMethod[] = [
  "commands.execute",
  "configuration.get",
  "configuration.update",
  "network.request",
  "processes.execute",
  "storage.delete",
  "storage.get",
  "storage.keys",
  "storage.update",
  "window.output.append",
  "window.output.clear",
  "window.output.create",
  "window.output.dispose",
  "window.output.flush",
  "window.output.show",
  "window.preview.create",
  "window.preview.dispose",
  "window.preview.hide",
  "window.preview.show",
  "window.preview.toggle",
  "window.preview.update",
  "window.showErrorMessage",
  "window.showInformationMessage",
  "window.showWarningMessage",
  "workspace.findFiles",
  "workspace.readTextDocument",
  "workspace.writeTextDocument",
] as const;

const MAX_BROKER_PAYLOAD_BYTES: number = 256 * 1024;
const MAX_COMMAND_RESULT_BYTES: number = 1024 * 1024;
const MAX_PROTOCOL_TEXT_BYTES: number = 4 * 1024;
const REQUEST_ID_PATTERN: RegExp = /^[a-zA-Z0-9_.:-]+$/u;

export function decodeHostInstruction(value: unknown): HostInstruction {
  const path = "extension host instruction";
  const envelope = record(value, path);
  const kind = enumeration(
    required(envelope, "kind", path),
    ["activateExtension", "executeCommand", "cancelRequest", "deactivateExtension", "disposeAll"],
    `${path}.kind`,
  );
  const protocolVersion = safeInteger(
    required(envelope, "protocolVersion", path),
    `${path}.protocolVersion`,
    1,
  );
  if (kind === "disposeAll") {
    const source = record(value, path, ["kind", "protocolVersion", "reason", "graceMilliseconds"]);
    return {
      kind,
      protocolVersion,
      reason: decodeDeactivationReason(required(source, "reason", path), `${path}.reason`),
      graceMilliseconds: safeInteger(
        required(source, "graceMilliseconds", path),
        `${path}.graceMilliseconds`,
        1,
      ),
    };
  }

  const requestId = decodeRequestId(required(envelope, "requestId", path), `${path}.requestId`);
  const extensionId = boundedString(
    required(envelope, "extensionId", path),
    `${path}.extensionId`,
    128,
  );
  const generation = safeInteger(required(envelope, "generation", path), `${path}.generation`);
  if (kind === "cancelRequest") {
    record(value, path, ["kind", "protocolVersion", "requestId", "extensionId", "generation"]);
    return { kind, protocolVersion, requestId, extensionId, generation };
  }
  if (kind === "deactivateExtension") {
    const source = record(value, path, [
      "kind",
      "protocolVersion",
      "requestId",
      "extensionId",
      "generation",
      "reason",
      "graceMilliseconds",
    ]);
    return {
      kind,
      protocolVersion,
      requestId,
      extensionId,
      generation,
      reason: decodeDeactivationReason(required(source, "reason", path), `${path}.reason`),
      graceMilliseconds: safeInteger(
        required(source, "graceMilliseconds", path),
        `${path}.graceMilliseconds`,
        1,
      ),
    };
  }

  const commonKeys = [
    "kind",
    "protocolVersion",
    "requestId",
    "extensionId",
    "generation",
    "apiVersion",
    "bundleSha256",
    "extensionUri",
    "storageUri",
    "commandIds",
    "activationReason",
    "startDeadlineMilliseconds",
    "activationDeadlineMilliseconds",
  ] as const;
  const source = record(
    value,
    path,
    kind === "executeCommand"
      ? [
          ...commonKeys,
          "commandId",
          "arguments",
          "activeTextDocument",
          "executionDeadlineMilliseconds",
        ]
      : commonKeys,
  );
  const common = {
    protocolVersion,
    requestId,
    extensionId,
    generation,
    apiVersion: safeInteger(required(source, "apiVersion", path), `${path}.apiVersion`, 1),
    bundleSha256: sha256(required(source, "bundleSha256", path), `${path}.bundleSha256`),
    extensionUri: boundedString(
      required(source, "extensionUri", path),
      `${path}.extensionUri`,
      4 * 1024,
    ),
    storageUri: boundedString(required(source, "storageUri", path), `${path}.storageUri`, 4 * 1024),
    commandIds: arrayOf(
      required(source, "commandIds", path),
      `${path}.commandIds`,
      (item, itemPath) => boundedString(item, itemPath, 128),
    ),
    activationReason: decodeActivationReason(
      required(source, "activationReason", path),
      `${path}.activationReason`,
    ),
    startDeadlineMilliseconds: safeInteger(
      required(source, "startDeadlineMilliseconds", path),
      `${path}.startDeadlineMilliseconds`,
      1,
    ),
    activationDeadlineMilliseconds: safeInteger(
      required(source, "activationDeadlineMilliseconds", path),
      `${path}.activationDeadlineMilliseconds`,
      1,
    ),
  };
  if (kind === "activateExtension") {
    return { kind, ...common };
  }
  return {
    kind,
    ...common,
    commandId: boundedString(required(source, "commandId", path), `${path}.commandId`, 128),
    arguments: arrayOf(required(source, "arguments", path), `${path}.arguments`, jsonValue),
    activeTextDocument: nullable(
      required(source, "activeTextDocument", path),
      `${path}.activeTextDocument`,
      decodeTextDocument,
    ),
    executionDeadlineMilliseconds: safeInteger(
      required(source, "executionDeadlineMilliseconds", path),
      `${path}.executionDeadlineMilliseconds`,
      1,
    ),
  };
}

export function decodeWorkerToHostMessage(value: unknown): WorkerToHostMessage {
  const path = "extension worker message";
  const envelope = record(value, path);
  const kind = enumeration(
    required(envelope, "kind", path),
    [
      "ready",
      "activated",
      "commandResult",
      "brokerRequest",
      "cancelBrokerRequest",
      "deactivated",
      "fault",
    ],
    `${path}.kind`,
  );
  const protocolVersion = literal(
    required(envelope, "protocolVersion", path),
    1,
    `${path}.protocolVersion`,
  );
  const generation = safeInteger(required(envelope, "generation", path), `${path}.generation`);
  if (kind === "ready") {
    record(value, path, ["kind", "protocolVersion", "generation"]);
    return { kind, protocolVersion, generation };
  }
  if (kind === "fault") {
    const source = record(value, path, ["kind", "protocolVersion", "generation", "error"]);
    return {
      kind,
      protocolVersion,
      generation,
      error: decodeFailure(required(source, "error", path), `${path}.error`),
    };
  }
  const requestId = decodeRequestId(required(envelope, "requestId", path), `${path}.requestId`);
  if (kind === "activated" || kind === "cancelBrokerRequest") {
    record(value, path, ["kind", "protocolVersion", "generation", "requestId"]);
    return { kind, protocolVersion, generation, requestId };
  }
  if (kind === "brokerRequest") {
    const source = record(value, path, [
      "kind",
      "protocolVersion",
      "generation",
      "requestId",
      "method",
      "payload",
    ]);
    const payload = jsonObject(required(source, "payload", path), `${path}.payload`);
    assertTransportSize(payload, "worker broker payload", MAX_BROKER_PAYLOAD_BYTES);
    return {
      kind,
      protocolVersion,
      generation,
      requestId,
      method: enumeration(required(source, "method", path), BROKER_METHODS, `${path}.method`),
      payload,
    };
  }
  if (kind === "deactivated") {
    const source = record(value, path, [
      "kind",
      "protocolVersion",
      "generation",
      "requestId",
      "error",
    ]);
    const error = decodeOptionalFailure(source, path);
    return {
      kind,
      protocolVersion,
      generation,
      requestId,
      ...(error === undefined ? {} : { error }),
    };
  }
  const source = record(value, path, [
    "kind",
    "protocolVersion",
    "generation",
    "requestId",
    "result",
    "error",
  ]);
  const result = decodeOptionalJson(source, "result", path);
  const error = decodeOptionalFailure(source, path);
  if (result !== undefined && error !== undefined) {
    throw new Error("A worker command response cannot contain both a result and an error.");
  }
  if (result !== undefined) {
    assertTransportSize(result, "worker command result", MAX_COMMAND_RESULT_BYTES);
  }
  return {
    kind,
    protocolVersion,
    generation,
    requestId,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

export function decodeHostToWorkerMessage(value: unknown): HostToWorkerMessage {
  const path = "extension host-to-worker message";
  const envelope = record(value, path);
  const kind = enumeration(
    required(envelope, "kind", path),
    ["initialize", "activate", "executeCommand", "brokerResponse", "cancel", "deactivate"],
    `${path}.kind`,
  );
  const protocolVersion = literal(
    required(envelope, "protocolVersion", path),
    1,
    `${path}.protocolVersion`,
  );
  const generation = safeInteger(required(envelope, "generation", path), `${path}.generation`);
  if (kind === "initialize") {
    const source = record(value, path, [
      "kind",
      "protocolVersion",
      "generation",
      "extensionId",
      "extensionUri",
      "storageUri",
      "bundleUrl",
      "commandIds",
    ]);
    return {
      kind,
      protocolVersion,
      generation,
      extensionId: boundedString(required(source, "extensionId", path), `${path}.extensionId`, 128),
      extensionUri: boundedString(
        required(source, "extensionUri", path),
        `${path}.extensionUri`,
        4 * 1024,
      ),
      storageUri: boundedString(
        required(source, "storageUri", path),
        `${path}.storageUri`,
        4 * 1024,
      ),
      bundleUrl: boundedString(required(source, "bundleUrl", path), `${path}.bundleUrl`, 4 * 1024),
      commandIds: arrayOf(
        required(source, "commandIds", path),
        `${path}.commandIds`,
        (item, itemPath) => boundedString(item, itemPath, 128),
      ),
    };
  }
  const requestId = decodeRequestId(required(envelope, "requestId", path), `${path}.requestId`);
  if (kind === "activate") {
    const source = record(value, path, [
      "kind",
      "protocolVersion",
      "generation",
      "requestId",
      "reason",
    ]);
    return {
      kind,
      protocolVersion,
      generation,
      requestId,
      reason: decodeActivationReason(required(source, "reason", path), `${path}.reason`),
    };
  }
  if (kind === "cancel") {
    record(value, path, ["kind", "protocolVersion", "generation", "requestId"]);
    return { kind, protocolVersion, generation, requestId };
  }
  if (kind === "deactivate") {
    const source = record(value, path, [
      "kind",
      "protocolVersion",
      "generation",
      "requestId",
      "reason",
    ]);
    return {
      kind,
      protocolVersion,
      generation,
      requestId,
      reason: decodeDeactivationReason(required(source, "reason", path), `${path}.reason`),
    };
  }
  if (kind === "executeCommand") {
    const source = record(value, path, [
      "kind",
      "protocolVersion",
      "generation",
      "requestId",
      "commandId",
      "arguments",
      "activeTextDocument",
    ]);
    const hasActiveTextDocument = Object.hasOwn(source, "activeTextDocument");
    return {
      kind,
      protocolVersion,
      generation,
      requestId,
      commandId: boundedString(required(source, "commandId", path), `${path}.commandId`, 128),
      arguments: arrayOf(required(source, "arguments", path), `${path}.arguments`, jsonValue),
      ...(!hasActiveTextDocument
        ? {}
        : {
            activeTextDocument: decodeTextDocument(
              required(source, "activeTextDocument", path),
              `${path}.activeTextDocument`,
            ),
          }),
    };
  }
  const source = record(value, path, [
    "kind",
    "protocolVersion",
    "generation",
    "requestId",
    "result",
    "error",
  ]);
  const result = decodeOptionalJson(source, "result", path);
  const error = decodeOptionalFailure(source, path);
  if (result !== undefined && error !== undefined) {
    throw new Error("A broker response cannot contain both a result and an error.");
  }
  return {
    kind,
    protocolVersion,
    generation,
    requestId,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

function decodeDeactivationReason(value: unknown, path: string) {
  return enumeration(value, ["applicationShutdown", "disabled", "reload"], path);
}

function decodeOptionalFailure(source: RuntimeRecord, path: string): ProtocolFailure | undefined {
  return Object.hasOwn(source, "error")
    ? decodeFailure(required(source, "error", path), `${path}.error`)
    : undefined;
}

function decodeOptionalJson(
  source: RuntimeRecord,
  key: string,
  path: string,
): JsonValue | undefined {
  return Object.hasOwn(source, key)
    ? jsonValue(required(source, key, path), `${path}.${key}`)
    : undefined;
}

function decodeFailure(value: unknown, path: string): ProtocolFailure {
  const source = record(value, path, ["code", "message"]);
  return {
    code: boundedString(required(source, "code", path), `${path}.code`, 128),
    message: boundedString(
      required(source, "message", path),
      `${path}.message`,
      MAX_PROTOCOL_TEXT_BYTES,
    ),
  };
}

function decodeRequestId(value: unknown, path: string): string {
  const requestId = boundedString(value, path, 128);
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`${path} contains unsupported characters.`);
  }
  return requestId;
}

function sha256(value: unknown, path: string): string {
  const digest = boundedString(value, path, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function boundedString(value: unknown, path: string, maximumBytes: number): string {
  const decoded = stringValue(value, path);
  const byteLength = new TextEncoder().encode(decoded).byteLength;
  if (decoded.length === 0 || byteLength > maximumBytes) {
    throw new Error(`${path} must contain between 1 and ${maximumBytes} UTF-8 bytes.`);
  }
  return decoded;
}

function assertTransportSize(value: JsonValue, label: string, maximumBytes: number): void {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  }
}
