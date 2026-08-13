import type {
  ActivationReason,
  CommandContribution,
  JsonObject,
  JsonValue,
  NetworkMethod,
  PermissionSet,
  PreviewAppearance,
  PreviewScrollbarAppearance,
  ProtocolFailure,
  TextDocument,
} from "@sideral/extension-sdk";
import {
  arrayOf,
  booleanValue,
  enumeration,
  jsonObject,
  jsonValue,
  literal,
  nullable,
  optional,
  type RuntimeRecord,
  record,
  required,
  safeInteger,
  stringValue,
} from "../../lib/runtime-validation";
import type {
  BrokerResponse,
  ClientHandshake,
  ExtensionClientInstruction,
  ExtensionCommandView,
  ExtensionKeybindingView,
  ExtensionRuntimeState,
  ExtensionSnapshot,
  HostHandshake,
  InstalledExtensionView,
  KeybindingContribution,
  OutputChannelView,
  PackageInspectionResult,
  PackageInstallView,
  PreviewDocumentView,
  RuntimeDiagnostic,
  SideralExtensionInspection,
} from "./contracts";

const RUNTIME_STATES: readonly ExtensionRuntimeState[] = [
  "dormant",
  "starting",
  "activating",
  "active",
  "stopping",
  "stopped",
  "failed",
];
const NETWORK_METHODS: readonly NetworkMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function decodeSideralExtensionInspection(value: unknown): SideralExtensionInspection {
  const path = "extension manifest inspection response";
  const source = record(value, path, [
    "manifestVersion",
    "apiVersion",
    "id",
    "displayName",
    "version",
    "engineRequirement",
    "runtime",
    "entry",
    "activationEvents",
    "commands",
    "keybindings",
    "permissions",
    "manifestBytes",
    "sizeBudget",
  ]);
  const sizeBudgetPath = `${path}.sizeBudget`;
  const sizeBudget = record(required(source, "sizeBudget", path), sizeBudgetPath, [
    "maxManifestBytes",
    "recommendedWorkerBundleBytes",
    "maxWorkerBundleBytes",
    "maxCompressedPackageBytes",
  ]);
  return {
    manifestVersion: safeInteger(
      required(source, "manifestVersion", path),
      `${path}.manifestVersion`,
    ),
    apiVersion: safeInteger(required(source, "apiVersion", path), `${path}.apiVersion`),
    id: stringValue(required(source, "id", path), `${path}.id`),
    displayName: stringValue(required(source, "displayName", path), `${path}.displayName`),
    version: stringValue(required(source, "version", path), `${path}.version`),
    engineRequirement: stringValue(
      required(source, "engineRequirement", path),
      `${path}.engineRequirement`,
    ),
    runtime: nullable(required(source, "runtime", path), `${path}.runtime`, (item, itemPath) =>
      literal(item, "worker", itemPath),
    ),
    entry: nullable(required(source, "entry", path), `${path}.entry`, stringValue),
    activationEvents: decodeStrings(
      required(source, "activationEvents", path),
      `${path}.activationEvents`,
    ),
    commands: arrayOf(
      required(source, "commands", path),
      `${path}.commands`,
      decodeCommandContribution,
    ),
    keybindings: arrayOf(
      required(source, "keybindings", path),
      `${path}.keybindings`,
      decodeKeybindingContribution,
    ),
    permissions: decodePermissionSet(required(source, "permissions", path), `${path}.permissions`),
    manifestBytes: safeInteger(required(source, "manifestBytes", path), `${path}.manifestBytes`),
    sizeBudget: {
      maxManifestBytes: safeInteger(
        required(sizeBudget, "maxManifestBytes", sizeBudgetPath),
        `${sizeBudgetPath}.maxManifestBytes`,
      ),
      recommendedWorkerBundleBytes: safeInteger(
        required(sizeBudget, "recommendedWorkerBundleBytes", sizeBudgetPath),
        `${sizeBudgetPath}.recommendedWorkerBundleBytes`,
      ),
      maxWorkerBundleBytes: safeInteger(
        required(sizeBudget, "maxWorkerBundleBytes", sizeBudgetPath),
        `${sizeBudgetPath}.maxWorkerBundleBytes`,
      ),
      maxCompressedPackageBytes: safeInteger(
        required(sizeBudget, "maxCompressedPackageBytes", sizeBudgetPath),
        `${sizeBudgetPath}.maxCompressedPackageBytes`,
      ),
    },
  };
}

export function decodeExtensionSnapshot(value: unknown): ExtensionSnapshot {
  return decodeSnapshot(value, "extension snapshot response");
}

export function decodeClientHandshake(value: unknown): ClientHandshake {
  const path = "extension client handshake";
  const source = record(value, path, ["connectionId", "snapshot", "outputs", "previews"]);
  return {
    connectionId: safeInteger(required(source, "connectionId", path), `${path}.connectionId`, 1),
    snapshot: decodeSnapshot(required(source, "snapshot", path), `${path}.snapshot`),
    outputs: arrayOf(required(source, "outputs", path), `${path}.outputs`, decodeOutputChannel),
    previews: arrayOf(
      required(source, "previews", path),
      `${path}.previews`,
      decodePreviewDocument,
    ),
  };
}

export function decodeHostHandshake(value: unknown): HostHandshake {
  const path = "extension host handshake";
  const source = record(value, path, [
    "protocolVersion",
    "supportedApiVersions",
    "sessionId",
    "sessionToken",
    "shutdownGraceMilliseconds",
  ]);
  return {
    protocolVersion: safeInteger(
      required(source, "protocolVersion", path),
      `${path}.protocolVersion`,
      1,
    ),
    supportedApiVersions: arrayOf(
      required(source, "supportedApiVersions", path),
      `${path}.supportedApiVersions`,
      (item, itemPath) => safeInteger(item, itemPath, 1),
    ),
    sessionId: safeInteger(required(source, "sessionId", path), `${path}.sessionId`, 1),
    sessionToken: stringValue(required(source, "sessionToken", path), `${path}.sessionToken`),
    shutdownGraceMilliseconds: safeInteger(
      required(source, "shutdownGraceMilliseconds", path),
      `${path}.shutdownGraceMilliseconds`,
      1,
    ),
  };
}

export function decodeExtensionClientInstruction(value: unknown): ExtensionClientInstruction {
  const envelopePath = "extension client instruction";
  const envelope = record(value, envelopePath);
  const kind = enumeration(
    required(envelope, "kind", envelopePath),
    [
      "snapshot",
      "showMessage",
      "outputChanged",
      "outputDisposed",
      "previewChanged",
      "previewDisposed",
    ],
    `${envelopePath}.kind`,
  );
  switch (kind) {
    case "snapshot": {
      const source = record(value, envelopePath, ["kind", "snapshot"]);
      return {
        kind,
        snapshot: decodeSnapshot(
          required(source, "snapshot", envelopePath),
          `${envelopePath}.snapshot`,
        ),
      };
    }
    case "showMessage": {
      const source = record(value, envelopePath, ["kind", "extensionId", "severity", "message"]);
      return {
        kind,
        extensionId: stringValue(
          required(source, "extensionId", envelopePath),
          `${envelopePath}.extensionId`,
        ),
        severity: enumeration(
          required(source, "severity", envelopePath),
          ["information", "warning", "error"],
          `${envelopePath}.severity`,
        ),
        message: stringValue(required(source, "message", envelopePath), `${envelopePath}.message`),
      };
    }
    case "outputChanged": {
      const source = record(value, envelopePath, ["kind", "channel"]);
      return {
        kind,
        channel: decodeOutputChannel(
          required(source, "channel", envelopePath),
          `${envelopePath}.channel`,
        ),
      };
    }
    case "outputDisposed":
    case "previewDisposed": {
      const source = record(value, envelopePath, ["kind", "resourceId"]);
      return {
        kind,
        resourceId: stringValue(
          required(source, "resourceId", envelopePath),
          `${envelopePath}.resourceId`,
        ),
      };
    }
    case "previewChanged": {
      const source = record(value, envelopePath, ["kind", "preview"]);
      return {
        kind,
        preview: decodePreviewDocument(
          required(source, "preview", envelopePath),
          `${envelopePath}.preview`,
        ),
      };
    }
  }
}

export function decodePackageInspection(value: unknown): PackageInspectionResult {
  const path = "extension package inspection response";
  const envelope = record(value, path, ["status", "package"]);
  const status = enumeration(
    required(envelope, "status", path),
    ["ready", "publisherTrustRequired"],
    `${path}.status`,
  );
  return { status, package: decodePackage(required(envelope, "package", path), `${path}.package`) };
}

export function decodeExtensionCommandResult(value: unknown): JsonValue | null {
  return jsonValue(value, "extension command response");
}

export function decodeBrokerResponse(value: unknown): BrokerResponse {
  const path = "extension broker response";
  const source = record(value, path, ["requestId", "result", "error"]);
  return {
    requestId: stringValue(required(source, "requestId", path), `${path}.requestId`),
    result: nullable(required(source, "result", path), `${path}.result`, jsonValue),
    error: nullable(required(source, "error", path), `${path}.error`, decodeProtocolFailure),
  };
}

export function decodeProtocolFailure(value: unknown, path: string): ProtocolFailure {
  const source = record(value, path, ["code", "message"]);
  return {
    code: stringValue(required(source, "code", path), `${path}.code`),
    message: stringValue(required(source, "message", path), `${path}.message`),
  };
}

export function decodeActivationReason(value: unknown, path: string): ActivationReason {
  const envelope = record(value, path);
  const kind = enumeration(
    required(envelope, "kind", path),
    ["command", "language", "workbenchReady"],
    `${path}.kind`,
  );
  if (kind === "workbenchReady") {
    record(value, path, ["kind"]);
    return { kind };
  }
  if (kind === "command") {
    const source = record(value, path, ["kind", "commandId"]);
    return {
      kind,
      commandId: stringValue(required(source, "commandId", path), `${path}.commandId`),
    };
  }
  const source = record(value, path, ["kind", "languageId"]);
  return {
    kind,
    languageId: stringValue(required(source, "languageId", path), `${path}.languageId`),
  };
}

export function decodeTextDocument(value: unknown, path: string): TextDocument {
  const source = record(value, path, ["uri", "languageId", "version", "content"]);
  return {
    uri: stringValue(required(source, "uri", path), `${path}.uri`),
    languageId: stringValue(required(source, "languageId", path), `${path}.languageId`),
    version: safeInteger(required(source, "version", path), `${path}.version`),
    content: stringValue(required(source, "content", path), `${path}.content`),
  };
}

function decodeSnapshot(value: unknown, path: string): ExtensionSnapshot {
  const source = record(value, path, [
    "sequence",
    "revision",
    "extensions",
    "commands",
    "keybindings",
  ]);
  return {
    sequence: safeInteger(required(source, "sequence", path), `${path}.sequence`),
    revision: safeInteger(required(source, "revision", path), `${path}.revision`),
    extensions: arrayOf(
      required(source, "extensions", path),
      `${path}.extensions`,
      decodeInstalledExtension,
    ),
    commands: arrayOf(
      required(source, "commands", path),
      `${path}.commands`,
      decodeExtensionCommand,
    ),
    keybindings: arrayOf(
      required(source, "keybindings", path),
      `${path}.keybindings`,
      decodeExtensionKeybinding,
    ),
  };
}

function decodeInstalledExtension(value: unknown, path: string): InstalledExtensionView {
  const source = record(value, path, [
    "id",
    "displayName",
    "version",
    "description",
    "enabled",
    "development",
    "publisher",
    "permissions",
    "activationEvents",
    "commands",
    "keybindings",
    "runtime",
    "rollbackVersion",
  ]);
  return {
    id: stringValue(required(source, "id", path), `${path}.id`),
    displayName: stringValue(required(source, "displayName", path), `${path}.displayName`),
    version: stringValue(required(source, "version", path), `${path}.version`),
    description: nullable(
      required(source, "description", path),
      `${path}.description`,
      stringValue,
    ),
    enabled: booleanValue(required(source, "enabled", path), `${path}.enabled`),
    development: booleanValue(required(source, "development", path), `${path}.development`),
    publisher: stringValue(required(source, "publisher", path), `${path}.publisher`),
    permissions: decodePermissionSet(required(source, "permissions", path), `${path}.permissions`),
    activationEvents: decodeStrings(
      required(source, "activationEvents", path),
      `${path}.activationEvents`,
    ),
    commands: arrayOf(
      required(source, "commands", path),
      `${path}.commands`,
      decodeExtensionCommand,
    ),
    keybindings: arrayOf(
      required(source, "keybindings", path),
      `${path}.keybindings`,
      decodeExtensionKeybinding,
    ),
    runtime: decodeRuntimeDiagnostic(required(source, "runtime", path), `${path}.runtime`),
    rollbackVersion: nullable(
      required(source, "rollbackVersion", path),
      `${path}.rollbackVersion`,
      stringValue,
    ),
  };
}

function decodeRuntimeDiagnostic(value: unknown, path: string): RuntimeDiagnostic {
  const source = record(value, path, [
    "state",
    "generation",
    "activationReason",
    "lastActivationMilliseconds",
    "activationCount",
    "commandCount",
    "commandFailureCount",
    "lastCommandMilliseconds",
    "lastError",
  ]);
  return {
    state: enumeration(required(source, "state", path), RUNTIME_STATES, `${path}.state`),
    generation: safeInteger(required(source, "generation", path), `${path}.generation`),
    activationReason: nullable(
      required(source, "activationReason", path),
      `${path}.activationReason`,
      decodeActivationReason,
    ),
    lastActivationMilliseconds: nullable(
      required(source, "lastActivationMilliseconds", path),
      `${path}.lastActivationMilliseconds`,
      safeInteger,
    ),
    activationCount: safeInteger(
      required(source, "activationCount", path),
      `${path}.activationCount`,
    ),
    commandCount: safeInteger(required(source, "commandCount", path), `${path}.commandCount`),
    commandFailureCount: safeInteger(
      required(source, "commandFailureCount", path),
      `${path}.commandFailureCount`,
    ),
    lastCommandMilliseconds: nullable(
      required(source, "lastCommandMilliseconds", path),
      `${path}.lastCommandMilliseconds`,
      safeInteger,
    ),
    lastError: nullable(
      required(source, "lastError", path),
      `${path}.lastError`,
      decodeProtocolFailure,
    ),
  };
}

function decodeExtensionCommand(value: unknown, path: string): ExtensionCommandView {
  const source = record(value, path, ["id", "title", "category", "invocation", "extensionId"]);
  return {
    id: stringValue(required(source, "id", path), `${path}.id`),
    title: stringValue(required(source, "title", path), `${path}.title`),
    category: nullable(required(source, "category", path), `${path}.category`, stringValue),
    invocation: enumeration(
      required(source, "invocation", path),
      ["workbench", "activeTextDocument"],
      `${path}.invocation`,
    ),
    extensionId: stringValue(required(source, "extensionId", path), `${path}.extensionId`),
  };
}

function decodeExtensionKeybinding(value: unknown, path: string): ExtensionKeybindingView {
  const source = record(value, path, [
    "extensionId",
    "commandId",
    "commandTitle",
    "defaultKey",
    "key",
    "languages",
    "userDefined",
    "conflict",
  ]);
  return {
    extensionId: stringValue(required(source, "extensionId", path), `${path}.extensionId`),
    commandId: stringValue(required(source, "commandId", path), `${path}.commandId`),
    commandTitle: stringValue(required(source, "commandTitle", path), `${path}.commandTitle`),
    defaultKey: stringValue(required(source, "defaultKey", path), `${path}.defaultKey`),
    key: nullable(required(source, "key", path), `${path}.key`, stringValue),
    languages: decodeStrings(required(source, "languages", path), `${path}.languages`),
    userDefined: booleanValue(required(source, "userDefined", path), `${path}.userDefined`),
    conflict: booleanValue(required(source, "conflict", path), `${path}.conflict`),
  };
}

function decodePermissionSet(value: unknown, path: string): PermissionSet {
  const source = record(value, path, ["workspace", "network", "processes"]);
  return {
    workspace: enumeration(
      required(source, "workspace", path),
      ["none", "read", "readWrite"],
      `${path}.workspace`,
    ),
    network: arrayOf(required(source, "network", path), `${path}.network`, (item, itemPath) => {
      const permission = record(item, itemPath, ["origin", "methods"]);
      return {
        origin: stringValue(required(permission, "origin", itemPath), `${itemPath}.origin`),
        methods: arrayOf(
          required(permission, "methods", itemPath),
          `${itemPath}.methods`,
          (method, methodPath) => enumeration(method, NETWORK_METHODS, methodPath),
        ),
      };
    }),
    processes: arrayOf(
      required(source, "processes", path),
      `${path}.processes`,
      (item, itemPath) => {
        const permission = record(item, itemPath, [
          "id",
          "executable",
          "workingDirectory",
          "arguments",
        ]);
        return {
          id: stringValue(required(permission, "id", itemPath), `${itemPath}.id`),
          executable: stringValue(
            required(permission, "executable", itemPath),
            `${itemPath}.executable`,
          ),
          workingDirectory: enumeration(
            required(permission, "workingDirectory", itemPath),
            ["workspace", "extensionData"],
            `${itemPath}.workingDirectory`,
          ),
          arguments: decodeStrings(
            required(permission, "arguments", itemPath),
            `${itemPath}.arguments`,
          ),
        };
      },
    ),
  };
}

function decodeCommandContribution(value: unknown, path: string): CommandContribution {
  const source = record(value, path, ["id", "title", "category", "invocation"]);
  return {
    id: stringValue(required(source, "id", path), `${path}.id`),
    title: stringValue(required(source, "title", path), `${path}.title`),
    category: nullable(required(source, "category", path), `${path}.category`, stringValue),
    invocation: enumeration(
      required(source, "invocation", path),
      ["workbench", "activeTextDocument"],
      `${path}.invocation`,
    ),
  };
}

function decodeKeybindingContribution(value: unknown, path: string): KeybindingContribution {
  const source = record(value, path, ["command", "key", "mac", "languages"]);
  return {
    command: stringValue(required(source, "command", path), `${path}.command`),
    key: stringValue(required(source, "key", path), `${path}.key`),
    mac: nullable(required(source, "mac", path), `${path}.mac`, stringValue),
    languages: decodeStrings(required(source, "languages", path), `${path}.languages`),
  };
}

function decodeOutputChannel(value: unknown, path: string): OutputChannelView {
  const source = record(value, path, ["resourceId", "extensionId", "name", "content", "visible"]);
  return {
    resourceId: stringValue(required(source, "resourceId", path), `${path}.resourceId`),
    extensionId: stringValue(required(source, "extensionId", path), `${path}.extensionId`),
    name: stringValue(required(source, "name", path), `${path}.name`),
    content: stringValue(required(source, "content", path), `${path}.content`),
    visible: booleanValue(required(source, "visible", path), `${path}.visible`),
  };
}

function decodePreviewDocument(value: unknown, path: string): PreviewDocumentView {
  const source = record(value, path, [
    "resourceId",
    "extensionId",
    "title",
    "format",
    "content",
    "sourceUri",
    "appearance",
    "visible",
  ]);
  return {
    resourceId: stringValue(required(source, "resourceId", path), `${path}.resourceId`),
    extensionId: stringValue(required(source, "extensionId", path), `${path}.extensionId`),
    title: stringValue(required(source, "title", path), `${path}.title`),
    format: literal(required(source, "format", path), "markdown", `${path}.format`),
    content: stringValue(required(source, "content", path), `${path}.content`),
    sourceUri: nullable(required(source, "sourceUri", path), `${path}.sourceUri`, stringValue),
    appearance: nullable(
      required(source, "appearance", path),
      `${path}.appearance`,
      decodePreviewAppearance,
    ),
    visible: booleanValue(required(source, "visible", path), `${path}.visible`),
  };
}

function decodePreviewAppearance(value: unknown, path: string): PreviewAppearance {
  const source = record(value, path, ["scrollbar"]);
  const scrollbar = decodeOptional(source, "scrollbar", path, decodePreviewScrollbar);
  return scrollbar === undefined ? {} : { scrollbar };
}

function decodePreviewScrollbar(value: unknown, path: string): PreviewScrollbarAppearance {
  const source = record(value, path, [
    "trackSize",
    "thumbSize",
    "trackColor",
    "thumbColor",
    "thumbHoverColor",
    "thumbActiveColor",
    "showButtons",
    "buttonSize",
    "arrowSize",
    "arrowHeight",
    "arrowColor",
    "arrowHoverColor",
    "arrowActiveColor",
    "cornerRadius",
  ]);
  const trackSize = decodeOptional(source, "trackSize", path, safeInteger);
  const thumbSize = decodeOptional(source, "thumbSize", path, safeInteger);
  const trackColor = decodeOptional(source, "trackColor", path, stringValue);
  const thumbColor = decodeOptional(source, "thumbColor", path, stringValue);
  const thumbHoverColor = decodeOptional(source, "thumbHoverColor", path, stringValue);
  const thumbActiveColor = decodeOptional(source, "thumbActiveColor", path, stringValue);
  const showButtons = decodeOptional(source, "showButtons", path, booleanValue);
  const buttonSize = decodeOptional(source, "buttonSize", path, safeInteger);
  const arrowSize = decodeOptional(source, "arrowSize", path, safeInteger);
  const arrowHeight = decodeOptional(source, "arrowHeight", path, safeInteger);
  const arrowColor = decodeOptional(source, "arrowColor", path, stringValue);
  const arrowHoverColor = decodeOptional(source, "arrowHoverColor", path, stringValue);
  const arrowActiveColor = decodeOptional(source, "arrowActiveColor", path, stringValue);
  const cornerRadius = decodeOptional(source, "cornerRadius", path, safeInteger);
  return {
    ...(trackSize === undefined ? {} : { trackSize }),
    ...(thumbSize === undefined ? {} : { thumbSize }),
    ...(trackColor === undefined ? {} : { trackColor }),
    ...(thumbColor === undefined ? {} : { thumbColor }),
    ...(thumbHoverColor === undefined ? {} : { thumbHoverColor }),
    ...(thumbActiveColor === undefined ? {} : { thumbActiveColor }),
    ...(showButtons === undefined ? {} : { showButtons }),
    ...(buttonSize === undefined ? {} : { buttonSize }),
    ...(arrowSize === undefined ? {} : { arrowSize }),
    ...(arrowHeight === undefined ? {} : { arrowHeight }),
    ...(arrowColor === undefined ? {} : { arrowColor }),
    ...(arrowHoverColor === undefined ? {} : { arrowHoverColor }),
    ...(arrowActiveColor === undefined ? {} : { arrowActiveColor }),
    ...(cornerRadius === undefined ? {} : { cornerRadius }),
  };
}

function decodePackage(value: unknown, path: string): PackageInstallView {
  const source = record(value, path, [
    "id",
    "displayName",
    "version",
    "description",
    "publisher",
    "keyId",
    "publicKey",
    "packageSha256",
    "bundleSha256",
    "permissions",
    "activationEvents",
    "commands",
    "keybindings",
    "replacesVersion",
  ]);
  return {
    id: stringValue(required(source, "id", path), `${path}.id`),
    displayName: stringValue(required(source, "displayName", path), `${path}.displayName`),
    version: stringValue(required(source, "version", path), `${path}.version`),
    description: nullable(
      required(source, "description", path),
      `${path}.description`,
      stringValue,
    ),
    publisher: stringValue(required(source, "publisher", path), `${path}.publisher`),
    keyId: stringValue(required(source, "keyId", path), `${path}.keyId`),
    publicKey: stringValue(required(source, "publicKey", path), `${path}.publicKey`),
    packageSha256: stringValue(required(source, "packageSha256", path), `${path}.packageSha256`),
    bundleSha256: stringValue(required(source, "bundleSha256", path), `${path}.bundleSha256`),
    permissions: decodePermissionSet(required(source, "permissions", path), `${path}.permissions`),
    activationEvents: decodeStrings(
      required(source, "activationEvents", path),
      `${path}.activationEvents`,
    ),
    commands: arrayOf(
      required(source, "commands", path),
      `${path}.commands`,
      decodeCommandContribution,
    ),
    keybindings: arrayOf(
      required(source, "keybindings", path),
      `${path}.keybindings`,
      decodeKeybindingContribution,
    ),
    replacesVersion: nullable(
      required(source, "replacesVersion", path),
      `${path}.replacesVersion`,
      stringValue,
    ),
  };
}

function decodeStrings(value: unknown, path: string): readonly string[] {
  return arrayOf(value, path, stringValue);
}

function decodeOptional<Value>(
  source: RuntimeRecord,
  key: string,
  path: string,
  decode: (value: unknown, valuePath: string) => Value,
): Value | undefined {
  const value = optional(source, key);
  return value === undefined ? undefined : decode(value, `${path}.${key}`);
}

export function decodeBrokerPayload(value: unknown, path: string): JsonObject {
  return jsonObject(value, path);
}
