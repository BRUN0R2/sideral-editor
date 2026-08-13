import type {
  HostToWorkerMessage,
  JsonValue,
  ProtocolFailure,
  TextDocument,
  WorkerToHostMessage,
} from "@sideral/extension-sdk";
import { HostFailure, toFailure, withDeadline } from "./host-errors";
import { decodeWorkerToHostMessage } from "./protocol-validation";
import { EXTENSION_PROTOCOL_VERSION as PROTOCOL_VERSION } from "./protocol-version";

type WorkerReply = Extract<
  WorkerToHostMessage,
  { readonly kind: "activated" | "commandResult" | "deactivated" }
>;
type CommandReply = Extract<WorkerReply, { readonly kind: "commandResult" }>;
export type BrokerWorkerMessage = Extract<
  WorkerToHostMessage,
  { readonly kind: "brokerRequest" | "cancelBrokerRequest" }
>;
type BrokerMessageHandler = (message: BrokerWorkerMessage) => Promise<void>;
type WorkerFaultHandler = (failure: ProtocolFailure) => Promise<void>;

interface PendingReply {
  readonly kind: WorkerReply["kind"];
  readonly resolve: (message: WorkerReply) => void;
  readonly reject: (error: Error) => void;
}

export class ManagedWorker {
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

  async initialize(
    message: Extract<HostToWorkerMessage, { readonly kind: "initialize" }>,
  ): Promise<void> {
    this.#post(message);
    await this.#ready.promise;
  }

  async activate(
    requestId: string,
    reason: Extract<HostToWorkerMessage, { readonly kind: "activate" }>["reason"],
  ): Promise<void> {
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

  execute(
    requestId: string,
    commandId: string,
    arguments_: readonly JsonValue[],
    activeTextDocument: TextDocument | undefined,
  ): Promise<CommandReply> {
    return this.#request("commandResult", requestId, {
      kind: "executeCommand",
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      requestId,
      commandId,
      arguments: arguments_,
      ...(activeTextDocument === undefined ? {} : { activeTextDocument }),
    }).then((reply) => {
      if (reply.kind !== "commandResult") {
        throw new Error(`Worker ${this.extensionId} returned an unexpected reply.`);
      }
      return reply;
    });
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

  #request(
    kind: PendingReply["kind"],
    requestId: string,
    message: HostToWorkerMessage,
  ): Promise<WorkerReply> {
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
    const message = decodeWorkerToHostMessage(value);
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
    void this.#onFault(failure).catch((error: unknown) => {
      console.error("The extension worker failure could not be reported.", error);
    });
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
