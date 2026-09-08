import type { WindowActivityState, WorkspaceContext } from "@sideral/extension-sdk";
import { Channel, invoke } from "@tauri-apps/api/core";
import { voidValue } from "../../../lib/runtime-validation";
import { decodeHostHandshake } from "../contract-validation";
import type { HostHandshake, HostInstruction } from "../contracts";
import { decodeHostInstruction } from "./protocol-validation";
import { ExtensionHostSupervisor } from "./supervisor";

export interface ExtensionHostConnection {
  updateWorkspaceContext(context: WorkspaceContext): void;
  updateWindowActivityState(state: WindowActivityState): void;
  dispose(): Promise<void>;
}

export async function connectExtensionHost(): Promise<ExtensionHostConnection> {
  const supervisor = new ExtensionHostSupervisor();
  const channel = new Channel<unknown>();
  const pendingInstructions: HostInstruction[] = [];
  let connected = false;
  let boundaryFailure: unknown | null = null;

  channel.onmessage = (value) => {
    let instruction: HostInstruction;
    try {
      instruction = decodeHostInstruction(value);
    } catch (error: unknown) {
      if (connected) {
        void supervisor.reportFatal(error);
      } else {
        boundaryFailure ??= error;
        pendingInstructions.length = 0;
      }
      return;
    }
    if (connected) {
      supervisor.accept(instruction);
    } else {
      pendingInstructions.push(instruction);
    }
  };

  const handshake = decodeHostHandshake(
    await invoke<unknown>("connect_extension_host", { channel }),
  );
  try {
    if (boundaryFailure !== null) {
      throw boundaryFailure;
    }
    supervisor.connect(handshake);
  } catch (connectionError: unknown) {
    channel.onmessage = () => undefined;
    pendingInstructions.length = 0;
    try {
      await invokeVoid("disconnect_extension_host", { sessionId: handshake.sessionId });
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [connectionError, cleanupError],
        "The invalid extension host session could not be released.",
      );
    }
    throw connectionError;
  }

  connected = true;
  for (const instruction of pendingInstructions.splice(0)) {
    supervisor.accept(instruction);
  }

  let disposal: Promise<void> | null = null;
  return {
    updateWorkspaceContext(context) {
      supervisor.updateWorkspaceContext(context);
    },
    updateWindowActivityState(state) {
      supervisor.updateWindowActivityState(state);
    },
    dispose() {
      disposal ??= disposeConnection(supervisor, channel, handshake, pendingInstructions);
      return disposal;
    },
  };
}

async function disposeConnection(
  supervisor: ExtensionHostSupervisor,
  channel: Channel<unknown>,
  handshake: HostHandshake,
  pendingInstructions: HostInstruction[],
): Promise<void> {
  channel.onmessage = () => undefined;
  pendingInstructions.length = 0;
  try {
    await supervisor.dispose(handshake.shutdownGraceMilliseconds);
  } finally {
    await invokeVoid("disconnect_extension_host", { sessionId: handshake.sessionId });
  }
}

async function invokeVoid(command: string, arguments_: Record<string, unknown>): Promise<void> {
  voidValue(await invoke<unknown>(command, arguments_), `${command} response`);
}
