import type {
  ProtocolFailure,
  WindowActivityState,
  WorkspaceContext,
} from "@sideral/extension-sdk";
import { invoke } from "@tauri-apps/api/core";
import { arrayBuffer, voidValue } from "../../../lib/runtime-validation";
import { decodeBrokerResponse } from "../contract-validation";
import type { BrokerRequest, HostEvent, HostHandshake, HostInstruction } from "../contracts";
import { HostFailure, throwIfAborted, toFailure, withDeadline } from "./host-errors";
import { type BrokerWorkerMessage, ManagedWorker } from "./managed-worker";
import { EXTENSION_PROTOCOL_VERSION as PROTOCOL_VERSION } from "./protocol-version";

type RuntimeInstruction = Extract<
  HostInstruction,
  { readonly kind: "activateExtension" | "executeCommand" }
>;

export class ExtensionHostSupervisor {
  readonly #workers = new Map<string, ManagedWorker>();
  readonly #lanes = new Map<string, Promise<void>>();
  readonly #invalidatedGenerations = new Map<string, number>();
  readonly #startupCancellations = new Map<
    string,
    { readonly generation: number; readonly controller: AbortController }
  >();
  #handshake: HostHandshake | null = null;
  #workspaceContext: WorkspaceContext = { workspaceName: null, activeDocument: null };
  #windowActivityState: WindowActivityState = "active";
  #disposed = false;

  updateWorkspaceContext(context: WorkspaceContext): void {
    if (this.#disposed || sameWorkspaceContext(this.#workspaceContext, context)) {
      return;
    }
    this.#workspaceContext = context;
    for (const worker of this.#workers.values()) {
      worker.updateWorkspaceContext(context);
    }
  }

  updateWindowActivityState(state: WindowActivityState): void {
    if (this.#disposed || state === this.#windowActivityState) {
      return;
    }
    this.#windowActivityState = state;
    for (const worker of this.#workers.values()) {
      worker.updateWindowActivityState(state);
    }
  }

  connect(handshake: HostHandshake): void {
    if (this.#handshake !== null) {
      throw new Error("The extension host already has a native session.");
    }
    if (handshake.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported native extension protocol ${handshake.protocolVersion}.`);
    }
    if (!Number.isSafeInteger(handshake.sessionId) || handshake.sessionId <= 0) {
      throw new Error("The native extension host returned an invalid session id.");
    }
    if (handshake.sessionToken.length === 0 || handshake.sessionToken.length > 128) {
      throw new Error("The native extension host returned an invalid session token.");
    }
    if (
      !Number.isSafeInteger(handshake.shutdownGraceMilliseconds) ||
      handshake.shutdownGraceMilliseconds <= 0
    ) {
      throw new Error("The native extension host returned an invalid shutdown deadline.");
    }
    this.#handshake = handshake;
  }

  accept(instruction: HostInstruction): void {
    if (this.#disposed) {
      return;
    }
    if (instruction.protocolVersion !== PROTOCOL_VERSION) {
      void this.reportFatal(
        new HostFailure(
          "extension_protocol_mismatch",
          `Unsupported native extension protocol ${instruction.protocolVersion}.`,
        ),
      );
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
    const workers = this.#takeWorkers();
    const outcomes = await Promise.allSettled(
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
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more extension workers failed to deactivate.");
    }
  }

  async reportFatal(error: unknown): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const workers = this.#takeWorkers();
    for (const worker of workers) {
      worker.terminate();
    }
    try {
      await this.#emitHostFault(toFailure(error, "extension_host_fault"));
    } catch (transportError: unknown) {
      console.error(
        "The extension host fault could not be delivered to the native service.",
        new AggregateError(
          [error, transportError],
          "Extension host failure and transport failure.",
        ),
      );
    }
  }

  #takeWorkers(): ManagedWorker[] {
    this.#disposed = true;
    this.#lanes.clear();
    for (const startup of this.#startupCancellations.values()) {
      startup.controller.abort();
    }
    this.#startupCancellations.clear();
    const workers = [...this.#workers.values()];
    this.#workers.clear();
    return workers;
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
        runtime.execute(
          instruction.requestId,
          instruction.commandId,
          instruction.arguments,
          instruction.activeTextDocument ?? undefined,
        ),
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
    const bytes = arrayBuffer(
      await invoke<unknown>("extension_host_bundle", {
        sessionToken: this.#requireHandshake().sessionToken,
        extensionId: instruction.extensionId,
        generation: instruction.generation,
      }),
      "extension_host_bundle response",
    );
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
      instruction.workspaceAccess,
      (message) => this.#handleWorkerMessage(instruction.extensionId, message),
      (failure) => this.#handleWorkerFault(instruction, failure),
    );
    const abortStartup = () => runtime.terminate();
    cancellationSignal.addEventListener("abort", abortStartup, { once: true });
    const initialWorkspaceContext =
      instruction.workspaceAccess === "none" ? null : this.#workspaceContext;
    const initialWindowActivityState = this.#windowActivityState;
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
        workspaceAccess: instruction.workspaceAccess,
        workspaceContext: initialWorkspaceContext,
        windowActivityState: initialWindowActivityState,
      });
      throwIfAborted(cancellationSignal);
      if (
        initialWorkspaceContext !== null &&
        !sameWorkspaceContext(initialWorkspaceContext, this.#workspaceContext)
      ) {
        runtime.updateWorkspaceContext(this.#workspaceContext);
      }
      if (initialWindowActivityState !== this.#windowActivityState) {
        runtime.updateWindowActivityState(this.#windowActivityState);
      }
      return runtime;
    } catch (error: unknown) {
      runtime.terminate();
      throw error;
    } finally {
      cancellationSignal.removeEventListener("abort", abortStartup);
    }
  }

  async #handleWorkerMessage(extensionId: string, message: BrokerWorkerMessage): Promise<void> {
    const runtime = this.#workers.get(extensionId);
    if (runtime === undefined || runtime.generation !== message.generation) {
      return;
    }
    if (message.kind === "cancelBrokerRequest") {
      voidValue(
        await invoke<unknown>("cancel_extension_broker_request", {
          sessionToken: this.#requireHandshake().sessionToken,
          protocolVersion: PROTOCOL_VERSION,
          extensionId,
          generation: message.generation,
          requestId: message.requestId,
        }),
        "cancel_extension_broker_request response",
      );
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
      const response = decodeBrokerResponse(
        await invoke<unknown>("extension_broker_request", {
          sessionToken: this.#requireHandshake().sessionToken,
          request,
        }),
      );
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
    voidValue(
      await invoke<unknown>("extension_host_event", {
        sessionToken: this.#requireHandshake().sessionToken,
        event,
      }),
      "extension_host_event response",
    );
  }

  #requireHandshake(): HostHandshake {
    if (this.#handshake === null) {
      throw new Error("The extension host has not connected to the native broker.");
    }
    return this.#handshake;
  }
}

function sameWorkspaceContext(left: WorkspaceContext, right: WorkspaceContext): boolean {
  return (
    left.workspaceName === right.workspaceName &&
    left.activeDocument?.name === right.activeDocument?.name &&
    left.activeDocument?.languageId === right.activeDocument?.languageId
  );
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
