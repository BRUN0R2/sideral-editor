import { Channel, invoke } from "@tauri-apps/api/core";
import type { HostHandshake, HostInstruction } from "../contracts";
import { ExtensionHostSupervisor } from "./supervisor";

export interface ExtensionHostConnection {
  dispose(): Promise<void>;
}

export async function connectExtensionHost(): Promise<ExtensionHostConnection> {
  const supervisor = new ExtensionHostSupervisor();
  const channel = new Channel<HostInstruction>();
  const pendingInstructions: HostInstruction[] = [];
  let connected = false;

  channel.onmessage = (instruction) => {
    if (connected) {
      supervisor.accept(instruction);
    } else {
      pendingInstructions.push(instruction);
    }
  };

  const handshake = await invoke<HostHandshake>("connect_extension_host", { channel });
  try {
    supervisor.connect(handshake);
  } catch (connectionError: unknown) {
    channel.onmessage = () => undefined;
    pendingInstructions.length = 0;
    try {
      await invoke("disconnect_extension_host", { sessionId: handshake.sessionId });
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
    dispose() {
      disposal ??= disposeConnection(supervisor, channel, handshake, pendingInstructions);
      return disposal;
    },
  };
}

async function disposeConnection(
  supervisor: ExtensionHostSupervisor,
  channel: Channel<HostInstruction>,
  handshake: HostHandshake,
  pendingInstructions: HostInstruction[],
): Promise<void> {
  channel.onmessage = () => undefined;
  pendingInstructions.length = 0;
  try {
    await supervisor.dispose(handshake.shutdownGraceMilliseconds);
  } finally {
    await invoke("disconnect_extension_host", { sessionId: handshake.sessionId });
  }
}
