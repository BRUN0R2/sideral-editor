import type {
  HostToWorkerMessage,
  JsonValue,
  ProtocolFailure,
  WorkerToHostMessage,
} from "@sideral/extension-sdk";
import { invoke } from "@tauri-apps/api/core";
import type {
  BrokerRequest,
  BrokerResponse,
  HostEvent,
  HostHandshake,
  HostInstruction,
} from "../contracts";

const PROTOCOL_VERSION = 1 as const;
const MAX_BROKER_PAYLOAD_BYTES = 256 * 1024;
const MAX_COMMAND_RESULT_BYTES = 1024 * 1024;
const MAX_PROTOCOL_TEXT_BYTES = 4 * 1024;
const BROKER_METHODS = new Set([
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
  "window.showErrorMessage",
  "window.showInformationMessage",
  "window.showWarningMessage",
  "workspace.findFiles",
  "workspace.readTextDocument",
  "workspace.writeTextDocument",
]);

type WorkerReply = Extract<
  WorkerToHostMessage,
  { readonly kind: "activated" | "commandResult" | "deactivated" }
>;
type BrokerWorkerMessage = Extract<
  WorkerToHostMessage,
  { readonly kind: "brokerRequest" | "cancelBrokerRequest" }
>;
type RuntimeInstruction = Extract<
  HostInstruction,
  { readonly kind: "activateExtension" | "executeCommand" }
>;
type BrokerMessageHandler = (message: BrokerWorkerMessage) => Promise<void>;
type WorkerFaultHandler = (failure: ProtocolFailure) => Promise<void>;

interface PendingReply {
  readonly kind: WorkerReply["kind"];
  readonly resolve: (message: WorkerReply) => void;
  readonly reject: (error: Error) => void;
}

interface WorkerBoundaryRecord extends Record<string, unknown> {
  readonly code?: unknown;
  readonly error?: unknown;
  readonly generation?: unknown;
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly method?: unknown;
  readonly payload?: unknown;
  readonly protocolVersion?: unknown;
  readonly requestId?: unknown;
  readonly result?: unknown;
}

export class ExtensionHostSupervisor {
  readonly #workers = new Map<string, ManagedWorker>();
  readonly #lanes = new Map<string, Promise<void>>();
  readonly #invalidatedGenerations = new Map<string, number>();
  readonly #startupCancellations = new Map<
    string,
    { readonly generation: number; readonly controller: AbortController }
  >();
  #handshake: HostHandshake | null = null;
  #disposed = false;

  connect(handshake: HostHandshake): void {
    if (this.#handshake !== null) {
      throw new Error("The extension host already has a native session.");
    }
    if (handshake.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported native extension protocol ${handshake.protocolVersion}.`);
    }
    this.#handshake = handshake;
  }

  accept(instruction: HostInstruction): void {
    if (this.#disposed) {
      return;
    }
    if (instruction.protocolVersion !== PROTOCOL_VERSION) {
      void this.#emitHostFault({
        code: "extension_protocol_mismatch",
        message: `Unsupported native extension protocol ${instruction.protocolVersion}.`,
      });
      return;
    }
    switch (instruction.kind) {
      case "activateExtension":
        this.#enqueue(instruction.extensionId, () => this.#activateOnly(instruction));
        return;
      case "executeCommand":
        this.#enqueue(instruction.extensionId, () => this.#execute(instruction));
        return;
      case "cancelRequest":
        this.#workers.get(instruction.extensionId)?.cancel(instruction.requestId);
        return;
      case "deactivateExtension": {
        const invalidatedGeneration = this.#invalidatedGenerations.get(instruction.extensionId);
        if (invalidatedGeneration === undefined || instruction.generation > invalidatedGeneration) {
          this.#invalidatedGenerations.set(instruction.extensionId, instruction.generation);
        }
        const startup = this.#startupCancellations.get(instruction.extensionId);
        if (startup?.generation === instruction.generation) {
          startup.controller.abort();
        }
        void this.#deactivate(instruction).catch((error: unknown) => this.reportFatal(error));
        return;
      }
      case "disposeAll":
        void this.dispose(instruction.graceMilliseconds).catch((error: unknown) =>
          this.reportFatal(error),
        );
        return;
    }
  }

  async dispose(graceMilliseconds: number): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#lanes.clear();
    for (const startup of this.#startupCancellations.values()) {
      startup.controller.abort();
    }
    this.#startupCancellations.clear();
    const workers = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.allSettled(
      workers.map((worker) =>
        worker.deactivate(
          `shutdown-${worker.generation}`,
          "applicationShutdown",
          graceMilliseconds,
        ),
      ),
    );
    for (const worker of workers) {
      worker.terminate();
    }
  }

  async reportFatal(error: unknown): Promise<void> {
    try {
      await this.#emitHostFault(toFailure(error, "extension_host_fault"));
    } catch {
      // The native transport is already unavailable, so there is no remaining
      // recovery channel for a host-level failure.
    }
  }

  #enqueue(extensionId: string, operation: () => Promise<void>): void {
    const previous = this.#lanes.get(extensionId) ?? Promise.resolve();
    const next = previous.then(operation).catch((error: unknown) => this.reportFatal(error));
    this.#lanes.set(extensionId, next);
    void next.then(() => {
      if (this.#lanes.get(extensionId) === next) {
        this.#lanes.delete(extensionId);
      }
    });
  }

  async #execute(
    instruction: Extract<HostInstruction, { readonly kind: "executeCommand" }>,
  ): Promise<void> {
    let runtime = this.#workers.get(instruction.extensionId);
    try {
      runtime = await this.#ensureActive(instruction);
      const reply = await withDeadline(
        runtime.execute(instruction.requestId, instruction.commandId, instruction.arguments),
        instruction.executionDeadlineMilliseconds,
        "extension_command_deadline",
        `Command ${instruction.commandId} did not finish in time.`,
      );
      await this.#emit({
        kind: "commandResult",
        protocolVersion: PROTOCOL_VERSION,
        requestId: instruction.requestId,
        extensionId: instruction.extensionId,
        generation: instruction.generation,
        result: reply.result ?? null,
        error: reply.error ?? null,
      });
    } catch (error: unknown) {
      const failure = toFailure(error, "extension_runtime_error");
      runtime?.terminate();
      if (this.#workers.get(instruction.extensionId) === runtime) {
        this.#workers.delete(instruction.extensionId);
      }
      await this.#emitState(instruction, "failed", null, failure);
      await this.#emit({
        kind: "commandResult",
        protocolVersion: PROTOCOL_VERSION,
        requestId: instruction.requestId,
        extensionId: instruction.extensionId,
        generation: instruction.generation,
        result: null,
        error: failure,
      });
    }
  }

  async #activateOnly(
    instruction: Extract<HostInstruction, { readonly kind: "activateExtension" }>,
  ): Promise<void> {
    let runtime = this.#workers.get(instruction.extensionId);
    let failure: ProtocolFailure | null = null;
    try {
      runtime = await this.#ensureActive(instruction);
    } catch (error: unknown) {
      failure = toFailure(error, "extension_runtime_error");
      runtime?.terminate();
      if (this.#workers.get(instruction.extensionId) === runtime) {
        this.#workers.delete(instruction.extensionId);
      }
      await this.#emitState(instruction, "failed", null, failure);
    }
    await this.#emit({
      kind: "activated",
      protocolVersion: PROTOCOL_VERSION,
      requestId: instruction.requestId,
      extensionId: instruction.extensionId,
      generation: instruction.generation,
      error: failure,
    });
  }

  async #ensureActive(instruction: RuntimeInstruction): Promise<ManagedWorker> {
    if (this.#disposed) {
      throw new HostFailure("extension_host_disposed", "The extension host is shutting down.");
    }
    const invalidatedGeneration = this.#invalidatedGenerations.get(instruction.extensionId);
    if (invalidatedGeneration !== undefined && invalidatedGeneration >= instruction.generation) {
      throw new HostFailure(
        "extension_runtime_cancelled",
        `Extension generation ${instruction.generation} was deactivated.`,
      );
    }
    if (invalidatedGeneration !== undefined && invalidatedGeneration < instruction.generation) {
      this.#invalidatedGenerations.delete(instruction.extensionId);
    }
    if (!this.#requireHandshake().supportedApiVersions.includes(instruction.apiVersion)) {
      throw new HostFailure(
        "extension_api_mismatch",
        `Extension API ${instruction.apiVersion} is unsupported by this host.`,
      );
    }
    let runtime = this.#workers.get(instruction.extensionId);
    if (
      runtime === undefined ||
      runtime.generation !== instruction.generation ||
      runtime.bundleSha256 !== instruction.bundleSha256
    ) {
      runtime?.terminate();
      await this.#emitState(instruction, "starting", null, null);
      const startupController = new AbortController();
      const startup = {
        generation: instruction.generation,
        controller: startupController,
      };
      this.#startupCancellations.set(instruction.extensionId, startup);
      try {
        runtime = await withDeadline(
          this.#createRuntime(instruction, startupController.signal),
          instruction.startDeadlineMilliseconds,
          "extension_start_deadline",
          `Extension ${instruction.extensionId} did not become ready in time.`,
          () => startupController.abort(),
        );
      } finally {
        if (this.#startupCancellations.get(instruction.extensionId) === startup) {
          this.#startupCancellations.delete(instruction.extensionId);
        }
      }
      throwIfAborted(startupController.signal);
      this.#workers.set(instruction.extensionId, runtime);
    }
    if (!runtime.active) {
      await this.#emitState(instruction, "activating", null, null);
      const startedAt = performance.now();
      try {
        await withDeadline(
          runtime.activate(instruction.requestId, instruction.activationReason),
          instruction.activationDeadlineMilliseconds,
          "extension_activation_deadline",
          `Extension ${instruction.extensionId} did not activate in time.`,
        );
      } catch (error: unknown) {
        runtime.terminate();
        if (this.#workers.get(instruction.extensionId) === runtime) {
          this.#workers.delete(instruction.extensionId);
        }
        throw error;
      }
      const activationMilliseconds = Math.max(0, Math.round(performance.now() - startedAt));
      await this.#emitState(instruction, "active", activationMilliseconds, null);
    }
    return runtime;
  }

  async #createRuntime(
    instruction: RuntimeInstruction,
    cancellationSignal: AbortSignal,
  ): Promise<ManagedWorker> {
    throwIfAborted(cancellationSignal);
    const bytes = await invoke<ArrayBuffer>("extension_host_bundle", {
      sessionToken: this.#requireHandshake().sessionToken,
      extensionId: instruction.extensionId,
      generation: instruction.generation,
    });
    throwIfAborted(cancellationSignal);
    const actualSha256 = await sha256Hex(bytes);
    throwIfAborted(cancellationSignal);
    if (actualSha256 !== instruction.bundleSha256) {
      throw new HostFailure(
        "extension_bundle_integrity",
        `Bundle integrity check failed for ${instruction.extensionId}.`,
      );
    }
    const bundleUrl = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    const runtime = new ManagedWorker(
      instruction.extensionId,
      instruction.generation,
      instruction.bundleSha256,
      bundleUrl,
      (message) => this.#handleWorkerMessage(instruction.extensionId, message),
      (failure) => this.#handleWorkerFault(instruction, failure),
    );
    const abortStartup = () => runtime.terminate();
    cancellationSignal.addEventListener("abort", abortStartup, { once: true });
    try {
      await runtime.initialize({
        kind: "initialize",
        protocolVersion: PROTOCOL_VERSION,
        generation: instruction.generation,
        extensionId: instruction.extensionId,
        extensionUri: instruction.extensionUri,
        storageUri: instruction.storageUri,
        bundleUrl,
        commandIds: instruction.commandIds,
      });
      throwIfAborted(cancellationSignal);
      return runtime;
    } catch (error: unknown) {
      runtime.terminate();
      throw error;
    } finally {
      cancellationSignal.removeEventListener("abort", abortStartup);
    }
  }

  async #handleWorkerMessage(
    extensionId: string,
    message: Extract<
      WorkerToHostMessage,
      { readonly kind: "brokerRequest" | "cancelBrokerRequest" }
    >,
  ): Promise<void> {
    const runtime = this.#workers.get(extensionId);
    if (runtime === undefined || runtime.generation !== message.generation) {
      return;
    }
    if (message.kind === "cancelBrokerRequest") {
      await invoke("cancel_extension_broker_request", {
        sessionToken: this.#requireHandshake().sessionToken,
        protocolVersion: PROTOCOL_VERSION,
        extensionId,
        generation: message.generation,
        requestId: message.requestId,
      });
      return;
    }
    const request: BrokerRequest = {
      protocolVersion: PROTOCOL_VERSION,
      extensionId,
      generation: message.generation,
      requestId: message.requestId,
      method: message.method,
      payload: message.payload,
    };
    try {
      const response = await invoke<BrokerResponse>("extension_broker_request", {
        sessionToken: this.#requireHandshake().sessionToken,
        request,
      });
      runtime.respondToBroker(
        response.requestId,
        response.result === null ? undefined : response.result,
        response.error === null ? undefined : response.error,
      );
    } catch (error: unknown) {
      runtime.respondToBroker(
        message.requestId,
        undefined,
        toFailure(error, "extension_broker_transport"),
      );
    }
  }

  async #handleWorkerFault(
    instruction: RuntimeInstruction,
    failure: ProtocolFailure,
  ): Promise<void> {
    const runtime = this.#workers.get(instruction.extensionId);
    if (runtime?.generation === instruction.generation) {
      runtime.terminate();
      this.#workers.delete(instruction.extensionId);
    }
    await this.#emitState(instruction, "failed", null, failure);
  }

  async #deactivate(
    instruction: Extract<HostInstruction, { readonly kind: "deactivateExtension" }>,
  ): Promise<void> {
    const runtime = this.#workers.get(instruction.extensionId);
    if (runtime === undefined || runtime.generation !== instruction.generation) {
      await this.#emit({
        kind: "deactivated",
        protocolVersion: PROTOCOL_VERSION,
        requestId: instruction.requestId,
        extensionId: instruction.extensionId,
        generation: instruction.generation,
        error: null,
      });
      return;
    }
    let failure: ProtocolFailure | null = null;
    try {
      await runtime.deactivate(
        instruction.requestId,
        instruction.reason,
        instruction.graceMilliseconds,
      );
    } catch (error: unknown) {
      failure = toFailure(error, "extension_deactivation_failed");
    } finally {
      runtime.terminate();
      this.#workers.delete(instruction.extensionId);
    }
    await this.#emit({
      kind: "deactivated",
      protocolVersion: PROTOCOL_VERSION,
      requestId: instruction.requestId,
      extensionId: instruction.extensionId,
      generation: instruction.generation,
      error: failure,
    });
  }

  async #emitState(
    instruction: RuntimeInstruction,
    state: "starting" | "activating" | "active" | "failed",
    activationMilliseconds: number | null,
    error: ProtocolFailure | null,
  ): Promise<void> {
    await this.#emit({
      kind: "stateChanged",
      protocolVersion: PROTOCOL_VERSION,
      extensionId: instruction.extensionId,
      generation: instruction.generation,
      state,
      activationReason: instruction.activationReason,
      activationMilliseconds,
      error,
    });
  }

  async #emitHostFault(error: ProtocolFailure): Promise<void> {
    if (this.#handshake === null) {
      return;
    }
    await this.#emit({ kind: "hostFault", protocolVersion: PROTOCOL_VERSION, error });
  }

  async #emit(event: HostEvent): Promise<void> {
    await invoke("extension_host_event", {
      sessionToken: this.#requireHandshake().sessionToken,
      event,
    });
  }

  #requireHandshake(): HostHandshake {
    if (this.#handshake === null) {
      throw new Error("The extension host has not connected to the native broker.");
    }
    return this.#handshake;
  }
}

class ManagedWorker {
  readonly extensionId: string;
  readonly generation: number;
  readonly bundleSha256: string;
  readonly #bundleUrl: string;
  readonly #worker: Worker;
  readonly #ready = new Deferred<void>();
  readonly #pending = new Map<string, PendingReply>();
  readonly #onBrokerMessage: BrokerMessageHandler;
  readonly #onFault: WorkerFaultHandler;
  #terminated = false;
  #failed = false;
  active = false;

  constructor(
    extensionId: string,
    generation: number,
    bundleSha256: string,
    bundleUrl: string,
    onBrokerMessage: BrokerMessageHandler,
    onFault: WorkerFaultHandler,
  ) {
    this.extensionId = extensionId;
    this.generation = generation;
    this.bundleSha256 = bundleSha256;
    this.#bundleUrl = bundleUrl;
    this.#onBrokerMessage = onBrokerMessage;
    this.#onFault = onFault;
    this.#worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
      type: "module",
      name: `sideral:${extensionId}`,
    });
    this.#worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      try {
        this.#acceptWorkerMessage(event.data);
      } catch (error: unknown) {
        this.#fail(toFailure(error, "extension_worker_protocol"));
      }
    });
    this.#worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.#fail({
        code: "extension_worker_error",
        message: event.message || `Extension worker ${extensionId} failed.`,
      });
    });
    this.#worker.addEventListener("messageerror", () => {
      this.#fail({
        code: "extension_worker_message_error",
        message: `Extension worker ${extensionId} sent an invalid message.`,
      });
    });
  }

  async initialize(message: Extract<HostToWorkerMessage, { readonly kind: "initialize" }>) {
    this.#post(message);
    await this.#ready.promise;
  }

  async activate(
    requestId: string,
    reason: Extract<HostToWorkerMessage, { kind: "activate" }>["reason"],
  ) {
    const reply = this.#request("activated", requestId, {
      kind: "activate",
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      requestId,
      reason,
    });
    await reply;
    this.active = true;
  }

  execute(requestId: string, commandId: string, arguments_: readonly JsonValue[]) {
    return this.#request("commandResult", requestId, {
      kind: "executeCommand",
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      requestId,
      commandId,
      arguments: arguments_,
    }) as Promise<Extract<WorkerReply, { kind: "commandResult" }>>;
  }

  async deactivate(
    requestId: string,
    reason: "applicationShutdown" | "disabled" | "reload",
    graceMilliseconds: number,
  ): Promise<void> {
    if (this.#terminated) {
      return;
    }
    const operation = this.#request("deactivated", requestId, {
      kind: "deactivate",
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      requestId,
      reason,
    });
    await withDeadline(
      operation,
      graceMilliseconds,
      "extension_deactivation_deadline",
      `Extension ${this.extensionId} did not deactivate in time.`,
    );
  }

  cancel(requestId: string): void {
    if (!this.#terminated) {
      this.#post({
        kind: "cancel",
        protocolVersion: PROTOCOL_VERSION,
        generation: this.generation,
        requestId,
      });
    }
  }

  respondToBroker(
    requestId: string,
    result: JsonValue | undefined,
    error: ProtocolFailure | undefined,
  ): void {
    if (this.#terminated) {
      return;
    }
    this.#post({
      kind: "brokerResponse",
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      requestId,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    });
  }

  terminate(): void {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    this.#worker.terminate();
    URL.revokeObjectURL(this.#bundleUrl);
    const error = new Error(`Extension worker ${this.extensionId} was terminated.`);
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #request(kind: PendingReply["kind"], requestId: string, message: HostToWorkerMessage) {
    if (this.#pending.has(requestId)) {
      return Promise.reject(new Error(`Duplicate worker request ${requestId}.`));
    }
    const promise = new Promise<WorkerReply>((resolve, reject) => {
      this.#pending.set(requestId, { kind, resolve, reject });
    });
    this.#post(message);
    return promise;
  }

  #acceptWorkerMessage(value: unknown): void {
    const message = parseWorkerMessage(value);
    if (message.protocolVersion !== PROTOCOL_VERSION || message.generation !== this.generation) {
      return;
    }
    switch (message.kind) {
      case "ready":
        this.#ready.resolve(undefined);
        return;
      case "activated":
      case "commandResult":
      case "deactivated": {
        const pending = this.#pending.get(message.requestId);
        if (pending === undefined || pending.kind !== message.kind) {
          this.#fail({
            code: "extension_worker_protocol",
            message: `Unexpected ${message.kind} response for ${message.requestId}.`,
          });
          return;
        }
        this.#pending.delete(message.requestId);
        pending.resolve(message);
        return;
      }
      case "brokerRequest":
      case "cancelBrokerRequest":
        void this.#onBrokerMessage(message).catch((error: unknown) => {
          this.#fail(toFailure(error, "extension_broker_transport"));
        });
        return;
      case "fault":
        this.#fail(message.error);
        return;
    }
  }

  #fail(failure: ProtocolFailure): void {
    if (this.#failed || this.#terminated) {
      return;
    }
    this.#failed = true;
    const error = new HostFailure(failure.code, failure.message);
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    void this.#onFault(failure).catch(() => undefined);
  }

  #post(message: HostToWorkerMessage): void {
    if (this.#terminated) {
      throw new Error(`Extension worker ${this.extensionId} is terminated.`);
    }
    this.#worker.postMessage(message);
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (error: Error) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value: T): void {
    if (!this.#settled) {
      this.#settled = true;
      this.#resolve(value);
    }
  }

  reject(error: Error): void {
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(error);
    }
  }
}

class HostFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostFailure";
    this.code = code;
  }
}

function parseWorkerMessage(value: unknown): WorkerToHostMessage {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.protocolVersion !== "number" ||
    !Number.isSafeInteger(value.protocolVersion) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) {
    throw new Error("The extension worker sent an invalid message.");
  }
  switch (value.kind) {
    case "ready":
      break;
    case "activated":
    case "cancelBrokerRequest":
      assertRequestId(value.requestId);
      break;
    case "commandResult":
    case "deactivated":
      assertRequestId(value.requestId);
      assertOptionalFailure(value.error);
      if (value.result !== undefined) {
        assertJsonTransport(value.result, "worker command result", MAX_COMMAND_RESULT_BYTES);
      }
      if (value.error !== undefined && value.result !== undefined) {
        throw new Error("A worker response cannot contain both a result and an error.");
      }
      break;
    case "brokerRequest":
      assertRequestId(value.requestId);
      if (typeof value.method !== "string" || !BROKER_METHODS.has(value.method)) {
        throw new Error("The extension worker requested an unknown broker method.");
      }
      if (!isRecord(value.payload)) {
        throw new Error("The extension worker sent an invalid broker payload.");
      }
      assertJsonTransport(value.payload, "worker broker payload", MAX_BROKER_PAYLOAD_BYTES);
      break;
    case "fault":
      assertFailure(value.error);
      break;
    default:
      throw new Error(`The extension worker sent an unknown message kind: ${value.kind}.`);
  }
  return value as WorkerToHostMessage;
}

function assertRequestId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[a-zA-Z0-9_.:-]+$/u.test(value)
  ) {
    throw new Error("The extension worker sent an invalid request id.");
  }
}

function assertOptionalFailure(value: unknown): void {
  if (value !== undefined) {
    assertFailure(value);
  }
}

function assertFailure(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    value.code.length > 128 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    new TextEncoder().encode(value.message).byteLength > MAX_PROTOCOL_TEXT_BYTES
  ) {
    throw new Error("The extension worker sent an invalid failure description.");
  }
}

function assertJsonTransport(value: unknown, label: string, maximumBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error: unknown) {
    throw new Error(`${label} is not JSON: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new Error(`${label} exceeds its transport boundary.`);
  }
}

function isRecord(value: unknown): value is WorkerBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  code: string,
  message: string,
  onDeadline?: () => void,
): Promise<T> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return Promise.reject(
      new HostFailure("invalid_extension_deadline", "Invalid native deadline."),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      onDeadline?.();
      reject(new HostFailure(code, message));
    }, milliseconds);
    void operation.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new HostFailure("extension_runtime_cancelled", "Extension startup was cancelled.");
  }
}

function toFailure(error: unknown, fallbackCode: string): ProtocolFailure {
  if (error instanceof HostFailure) {
    return { code: error.code, message: error.message };
  }
  if (isCommandError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message || "Extension host operation failed." };
  }
  return { code: fallbackCode, message: "Extension host operation failed." };
}

function isCommandError(
  value: unknown,
): value is { readonly code: string; readonly message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
