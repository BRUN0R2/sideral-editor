import type {
  ActivationReason,
  BrokerMethod,
  CommandHandler,
  DeactivationReason,
  Disposable,
  ExtensionApi,
  ExtensionContext,
  ExtensionModule,
  HostToWorkerMessage,
  JsonObject,
  JsonValue,
  NetworkRequest,
  NetworkResponse,
  OutputChannel,
  ProcessRequest,
  ProcessResult,
  ProtocolFailure,
  TextDocument,
  WorkerToHostMessage,
} from "@sideral/extension-sdk";

const PROTOCOL_VERSION = 1 as const;
const OUTPUT_CHUNK_CODE_UNITS = 20 * 1024;
const MAX_PENDING_OUTPUT_CODE_UNITS = 256 * 1024;
const MAX_BROKER_PAYLOAD_BYTES = 240 * 1024;
const MAX_COMMAND_RESULT_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;

interface WorkerScope {
  postMessage(message: WorkerToHostMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  close(): void;
}

interface PendingBrokerRequest {
  readonly resolve: (value: JsonValue | undefined) => void;
  readonly reject: (reason: Error) => void;
  readonly disposeAbortListener: () => void;
}

interface StoredValueResult {
  readonly found: boolean;
  readonly value: JsonValue;
}

interface BoundaryRecord extends Record<string, unknown> {
  readonly activate?: unknown;
  readonly body?: unknown;
  readonly content?: unknown;
  readonly deactivate?: unknown;
  readonly exitCode?: unknown;
  readonly found?: unknown;
  readonly generation?: unknown;
  readonly headers?: unknown;
  readonly kind?: unknown;
  readonly languageId?: unknown;
  readonly protocolVersion?: unknown;
  readonly standardError?: unknown;
  readonly standardOutput?: unknown;
  readonly status?: unknown;
  readonly uri?: unknown;
  readonly value?: unknown;
  readonly version?: unknown;
}

const scope = globalThis as unknown as WorkerScope;
const handlers = new Map<string, CommandHandler>();
const pendingBrokerRequests = new Map<string, PendingBrokerRequest>();
const commandCancellations = new Map<string, AbortController>();
const subscriptions: Disposable[] = [];
const localCommandStack: string[] = [];
const extensionCancellation = new AbortController();
const cleanupCancellation = new AbortController();

let extensionId = "";
let extensionUri = "";
let storageUri = "";
let activationReason: ActivationReason = { kind: "workbenchReady" };
let generation = 0;
let brokerSequence = 1;
let extensionModule: ExtensionModule | null = null;
let allowedCommands = new Set<string>();
let initialized = false;
let activated = false;
let deactivating = false;
let currentOperationSignal: AbortSignal | null = null;
let commandQueue = Promise.resolve();
let deactivationOperation: Promise<ProtocolFailure | undefined> | null = null;

scope.addEventListener("message", (event) => {
  void handleMessage(event.data).catch((error: unknown) => {
    postFault(toFailure(error, "worker_protocol_error"));
  });
});

async function handleMessage(value: unknown): Promise<void> {
  const message = parseMessage(value);
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported extension protocol ${message.protocolVersion}.`);
  }
  if (message.kind === "initialize") {
    await initialize(message);
    return;
  }
  if (!initialized || message.generation !== generation) {
    return;
  }
  switch (message.kind) {
    case "activate":
      await activate(message.requestId, message.reason);
      return;
    case "executeCommand": {
      const cancellation = new AbortController();
      commandCancellations.set(message.requestId, cancellation);
      const operation = commandQueue.then(() =>
        executeCommand(
          message.requestId,
          message.commandId,
          message.arguments,
          cancellation.signal,
        ),
      );
      commandQueue = operation.catch(() => undefined);
      await operation;
      return;
    }
    case "brokerResponse":
      settleBrokerRequest(message.requestId, message.result, message.error);
      return;
    case "cancel":
      commandCancellations.get(message.requestId)?.abort();
      return;
    case "deactivate":
      await deactivate(message.requestId, message.reason);
      return;
  }
}

async function initialize(
  message: Extract<HostToWorkerMessage, { readonly kind: "initialize" }>,
): Promise<void> {
  if (initialized) {
    throw new Error("The extension worker was initialized more than once.");
  }
  extensionId = message.extensionId;
  extensionUri = message.extensionUri;
  storageUri = message.storageUri;
  generation = message.generation;
  allowedCommands = new Set(message.commandIds);
  const imported: unknown = await import(/* @vite-ignore */ message.bundleUrl);
  extensionModule = validateExtensionModule(imported);
  initialized = true;
  post({ kind: "ready", protocolVersion: PROTOCOL_VERSION, generation });
}

async function activate(requestId: string, reason: ActivationReason): Promise<void> {
  if (activated) {
    post({ kind: "activated", protocolVersion: PROTOCOL_VERSION, generation, requestId });
    return;
  }
  if (extensionModule === null || deactivating) {
    throw new Error("The extension cannot be activated in its current state.");
  }
  currentOperationSignal = extensionCancellation.signal;
  activationReason = reason;
  try {
    await extensionModule.activate(createContext(), createApi());
    if (extensionCancellation.signal.aborted) {
      throw abortError();
    }
    activated = true;
    post({ kind: "activated", protocolVersion: PROTOCOL_VERSION, generation, requestId });
  } catch (error: unknown) {
    postFault(toFailure(error, "extension_activation_failed"));
  } finally {
    currentOperationSignal = null;
  }
}

async function executeCommand(
  requestId: string,
  commandId: string,
  arguments_: readonly JsonValue[],
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!activated || deactivating) {
      throw new Error("The extension is not active.");
    }
    if (signal.aborted) {
      throw abortError();
    }
    currentOperationSignal = signal;
    const result = await invokeRegisteredCommand(commandId, arguments_);
    if (signal.aborted) {
      throw abortError();
    }
    if (result !== undefined) {
      assertJsonValue(result, "command result", MAX_COMMAND_RESULT_BYTES);
    }
    post({
      kind: "commandResult",
      protocolVersion: PROTOCOL_VERSION,
      generation,
      requestId,
      ...(result === undefined ? {} : { result }),
    });
  } catch (error: unknown) {
    post({
      kind: "commandResult",
      protocolVersion: PROTOCOL_VERSION,
      generation,
      requestId,
      error: toFailure(error, signal.aborted ? "extension_cancelled" : "command_failed"),
    });
  } finally {
    currentOperationSignal = null;
    commandCancellations.delete(requestId);
  }
}

async function deactivate(requestId: string, reason: DeactivationReason): Promise<void> {
  deactivationOperation ??= performDeactivation(reason);
  const failure = await deactivationOperation;
  post({
    kind: "deactivated",
    protocolVersion: PROTOCOL_VERSION,
    generation,
    requestId,
    ...(failure === undefined ? {} : { error: failure }),
  });
}

async function performDeactivation(
  reason: DeactivationReason,
): Promise<ProtocolFailure | undefined> {
  deactivating = true;
  extensionCancellation.abort();
  for (const cancellation of commandCancellations.values()) {
    cancellation.abort();
  }
  let failure: ProtocolFailure | undefined;
  const cleanupFailures: unknown[] = [];
  try {
    await commandQueue;
    currentOperationSignal = cleanupCancellation.signal;
    try {
      await extensionModule?.deactivate?.(reason);
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    for (const subscription of subscriptions.splice(0).reverse()) {
      try {
        await subscription.dispose();
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
    }
    handlers.clear();
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "One or more extension cleanup operations failed.");
    }
  } catch (error: unknown) {
    failure = toFailure(error, "extension_deactivation_failed");
  } finally {
    handlers.clear();
    currentOperationSignal = null;
  }
  return failure;
}

function createContext(): ExtensionContext {
  let acceptingSubscriptions = true;
  subscriptions.push({
    dispose() {
      acceptingSubscriptions = false;
    },
  });
  return {
    extensionId,
    extensionUri,
    storageUri,
    activationReason,
    cancellationSignal: extensionCancellation.signal,
    subscriptions: {
      add(...disposables) {
        if (!acceptingSubscriptions || deactivating) {
          throw new Error("Cannot add subscriptions while the extension is deactivating.");
        }
        subscriptions.push(...disposables);
      },
    },
  };
}

function createApi(): ExtensionApi {
  return {
    commands: {
      registerCommand(id, handler) {
        if (!allowedCommands.has(id)) {
          throw new Error(`Command ${id} is not declared in the extension manifest.`);
        }
        if (handlers.has(id)) {
          throw new Error(`Command ${id} is already registered.`);
        }
        handlers.set(id, handler);
        let disposed = false;
        return {
          dispose() {
            if (!disposed) {
              disposed = true;
              handlers.delete(id);
            }
          },
        };
      },
      executeCommand(id, ...arguments_) {
        if (allowedCommands.has(id)) {
          return invokeRegisteredCommand(id, arguments_);
        }
        return brokerRequest("commands.execute", { commandId: id, arguments: arguments_ });
      },
    },
    configuration: {
      async get(section) {
        const result = asStoredValue(await brokerRequest("configuration.get", { key: section }));
        return result.found ? result.value : undefined;
      },
      async update(section, value) {
        await brokerRequest("configuration.update", { key: section, value });
      },
    },
    network: {
      request: requestNetwork,
    },
    processes: {
      execute: executeProcess,
    },
    storage: {
      async get(key) {
        const result = asStoredValue(await brokerRequest("storage.get", { key }));
        return result.found ? result.value : undefined;
      },
      async update(key, value) {
        await brokerRequest("storage.update", { key, value });
      },
      async delete(key) {
        await brokerRequest("storage.delete", { key });
      },
      async keys() {
        return asStringArray(await brokerRequest("storage.keys", {}));
      },
    },
    window: {
      createOutputChannel: createOutputChannel,
      async showInformationMessage(message) {
        await brokerRequest("window.showInformationMessage", { message });
      },
      async showWarningMessage(message) {
        await brokerRequest("window.showWarningMessage", { message });
      },
      async showErrorMessage(message) {
        await brokerRequest("window.showErrorMessage", { message });
      },
    },
    workspace: {
      async readTextDocument(uri, signal) {
        return asTextDocument(await brokerRequest("workspace.readTextDocument", { uri }, signal));
      },
      async writeTextDocument(uri, content, expectedVersion, signal) {
        return asTextDocument(
          await brokerRequest(
            "workspace.writeTextDocument",
            { uri, content, expectedVersion },
            signal,
          ),
        );
      },
      async findFiles(pattern, options) {
        return asStringArray(
          await brokerRequest(
            "workspace.findFiles",
            {
              pattern,
              ...(options?.limit === undefined ? {} : { limit: options.limit }),
            },
            options?.signal,
          ),
        );
      },
    },
  };
}

async function invokeRegisteredCommand(
  commandId: string,
  arguments_: readonly JsonValue[],
): Promise<JsonValue | undefined> {
  assertJsonValue(arguments_, "command arguments", MAX_BROKER_PAYLOAD_BYTES);
  if (!activated || deactivating) {
    throw new Error("The extension is not active.");
  }
  const handler = handlers.get(commandId);
  if (handler === undefined) {
    throw new Error(`The extension did not register command ${commandId}.`);
  }
  if (localCommandStack.includes(commandId)) {
    throw new Error(`Cyclic local command execution was rejected for ${commandId}.`);
  }
  if (localCommandStack.length >= 32) {
    throw new Error("The local command execution depth limit was exceeded.");
  }
  localCommandStack.push(commandId);
  try {
    return await handler(...arguments_);
  } finally {
    localCommandStack.pop();
  }
}

async function requestNetwork(request: NetworkRequest): Promise<NetworkResponse> {
  const result = await brokerRequest(
    "network.request",
    {
      url: request.url,
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.maximumResponseBytes === undefined
        ? {}
        : { maximumResponseBytes: request.maximumResponseBytes }),
    },
    request.signal,
  );
  if (!isRecord(result) || typeof result.status !== "number" || typeof result.body !== "string") {
    throw new Error("The network broker returned an invalid response.");
  }
  return {
    status: result.status,
    headers: asStringRecord(result.headers),
    body: result.body,
  };
}

async function executeProcess(request: ProcessRequest): Promise<ProcessResult> {
  const result = await brokerRequest("processes.execute", { grant: request.grant }, request.signal);
  if (
    !isRecord(result) ||
    typeof result.exitCode !== "number" ||
    typeof result.standardOutput !== "string" ||
    typeof result.standardError !== "string"
  ) {
    throw new Error("The process broker returned an invalid response.");
  }
  return {
    exitCode: result.exitCode,
    standardOutput: result.standardOutput,
    standardError: result.standardError,
  };
}

function createOutputChannel(name: string): OutputChannel {
  const resource = brokerRequest("window.output.create", { name }).then((value) => {
    if (typeof value !== "string") {
      throw new Error("The output broker returned an invalid resource id.");
    }
    return value;
  });
  void resource.catch(() => undefined);
  let pending = "";
  let disposed = false;
  let queue = Promise.resolve();
  let queueFailure: unknown;

  const enqueue = (operation: (resourceId: string) => Promise<unknown>): void => {
    queue = queue
      .then(async () => {
        if (disposed) {
          return;
        }
        await operation(await resource);
      })
      .catch((error: unknown) => {
        queueFailure ??= error;
      });
  };
  const flushPending = async (): Promise<void> => {
    const resourceId = await resource;
    while (pending.length > 0) {
      const chunk = pending.slice(0, OUTPUT_CHUNK_CODE_UNITS);
      pending = pending.slice(chunk.length);
      await brokerRequest("window.output.append", { resourceId, value: chunk });
    }
    await brokerRequest("window.output.flush", { resourceId });
  };
  const appendPending = (value: string): void => {
    if (pending.length + value.length > MAX_PENDING_OUTPUT_CODE_UNITS) {
      throw new Error("The pending output buffer limit was exceeded. Flush the channel sooner.");
    }
    pending += value;
  };
  const throwQueueFailure = (): void => {
    if (queueFailure !== undefined) {
      throw queueFailure;
    }
  };

  return {
    append(value) {
      if (!disposed) {
        appendPending(value);
      }
    },
    appendLine(value) {
      if (!disposed) {
        appendPending(`${value}\n`);
      }
    },
    clear() {
      pending = "";
      enqueue((resourceId) => brokerRequest("window.output.clear", { resourceId }));
    },
    show() {
      enqueue(async (resourceId) => {
        await flushPending();
        await brokerRequest("window.output.show", { resourceId });
      });
    },
    async flush() {
      queue = queue.then(flushPending);
      await queue;
      throwQueueFailure();
    },
    async dispose() {
      if (disposed) {
        return;
      }
      if (extensionCancellation.signal.aborted) {
        disposed = true;
        pending = "";
        return;
      }
      await queue;
      throwQueueFailure();
      await flushPending();
      disposed = true;
      await brokerRequest("window.output.dispose", { resourceId: await resource });
    },
  };
}

function brokerRequest(
  method: BrokerMethod,
  payload: JsonObject,
  signal: AbortSignal | undefined = currentOperationSignal ?? extensionCancellation.signal,
): Promise<JsonValue | undefined> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  assertJsonValue(payload, "broker payload", MAX_BROKER_PAYLOAD_BYTES);
  const requestId = `broker-${generation}-${brokerSequence++}`;
  return new Promise((resolve, reject) => {
    const abort = () => {
      pendingBrokerRequests.delete(requestId);
      post({
        kind: "cancelBrokerRequest",
        protocolVersion: PROTOCOL_VERSION,
        generation,
        requestId,
      });
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    pendingBrokerRequests.set(requestId, {
      resolve,
      reject,
      disposeAbortListener: () => signal.removeEventListener("abort", abort),
    });
    try {
      post({
        kind: "brokerRequest",
        protocolVersion: PROTOCOL_VERSION,
        generation,
        requestId,
        method,
        payload,
      });
    } catch (error: unknown) {
      pendingBrokerRequests.delete(requestId);
      signal.removeEventListener("abort", abort);
      reject(error instanceof Error ? error : new Error("Could not send a broker request."));
    }
  });
}

function settleBrokerRequest(
  requestId: string,
  result: JsonValue | undefined,
  error: ProtocolFailure | undefined,
): void {
  const pending = pendingBrokerRequests.get(requestId);
  if (pending === undefined) {
    return;
  }
  pendingBrokerRequests.delete(requestId);
  pending.disposeAbortListener();
  if (error === undefined) {
    pending.resolve(result);
  } else {
    pending.reject(new Error(`${error.code}: ${error.message}`));
  }
}

function validateExtensionModule(value: unknown): ExtensionModule {
  if (!isRecord(value) || typeof value.activate !== "function") {
    throw new Error("The extension bundle must export an activate function.");
  }
  if (value.deactivate !== undefined && typeof value.deactivate !== "function") {
    throw new Error("The extension deactivate export must be a function.");
  }
  return value as unknown as ExtensionModule;
}

function parseMessage(value: unknown): HostToWorkerMessage {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.protocolVersion !== "number" ||
    typeof value.generation !== "number"
  ) {
    throw new Error("The extension host sent an invalid message.");
  }
  return value as unknown as HostToWorkerMessage;
}

function asStoredValue(value: JsonValue | undefined): StoredValueResult {
  if (!isRecord(value) || typeof value.found !== "boolean" || !("value" in value)) {
    throw new Error("The storage broker returned an invalid response.");
  }
  return { found: value.found, value: value.value as JsonValue };
}

function asTextDocument(value: JsonValue | undefined): TextDocument {
  if (
    !isRecord(value) ||
    typeof value.uri !== "string" ||
    typeof value.languageId !== "string" ||
    typeof value.version !== "number" ||
    typeof value.content !== "string"
  ) {
    throw new Error("The workspace broker returned an invalid document.");
  }
  return {
    uri: value.uri,
    languageId: value.languageId,
    version: value.version,
    content: value.content,
  };
}

function asStringArray(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("The broker returned an invalid string array.");
  }
  return value;
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) {
    throw new Error("The broker returned invalid headers.");
  }
  return value as Record<string, string>;
}

function assertJsonValue(value: unknown, label: string, maximumBytes: number): void {
  validateJsonNode(value, label, 0, new Set<object>());
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error: unknown) {
    throw new Error(`${label} cannot be serialized: ${errorMessage(error)}`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} is not a JSON value.`);
  }
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  }
}

function validateJsonNode(
  value: unknown,
  label: string,
  depth: number,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || depth >= MAX_JSON_DEPTH) {
    throw new Error(`${label} is not a bounded JSON value.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} cannot contain circular references.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonNode(item, label, depth + 1, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} can contain only plain JSON objects.`);
    }
    for (const item of Object.values(value)) {
      validateJsonNode(item, label, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown serialization error";
}

function isRecord(value: unknown): value is BoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function post(message: WorkerToHostMessage): void {
  scope.postMessage(message);
}

function postFault(error: ProtocolFailure): void {
  post({ kind: "fault", protocolVersion: PROTOCOL_VERSION, generation, error });
}

function abortError(): Error {
  return new DOMException("The extension operation was cancelled.", "AbortError");
}

function toFailure(error: unknown, fallbackCode: string): ProtocolFailure {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "extension_cancelled", message: error.message };
  }
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message || "Extension operation failed." };
  }
  return { code: fallbackCode, message: "Extension operation failed." };
}
