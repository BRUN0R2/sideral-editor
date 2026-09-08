import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostHandshake, HostInstruction } from "../contracts";
import { EXTENSION_PROTOCOL_VERSION as PROTOCOL_VERSION } from "./protocol-version";

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: (message: unknown) => void }>,
  connectError: null as Error | null,
  events: [] as string[],
  invoke: vi.fn(),
  supervisors: [] as Array<{
    accept: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage: (message: T) => void;

    constructor(onmessage: (message: T) => void = () => undefined) {
      this.onmessage = onmessage;
      mocks.channels.push(this as { onmessage: (message: unknown) => void });
    }
  },
  invoke: mocks.invoke,
}));

vi.mock("./supervisor", () => ({
  ExtensionHostSupervisor: class {
    readonly accept = vi.fn(() => {
      mocks.events.push("accept");
    });
    readonly connect = vi.fn(() => {
      mocks.events.push("connect");
      if (mocks.connectError !== null) {
        throw mocks.connectError;
      }
    });
    readonly dispose = vi.fn(async () => {
      mocks.events.push("dispose");
    });

    constructor() {
      mocks.supervisors.push(this);
    }
  },
}));

import { connectExtensionHost } from "./connection";

const HANDSHAKE: HostHandshake = {
  protocolVersion: PROTOCOL_VERSION,
  supportedApiVersions: [1],
  sessionId: 7,
  sessionToken: "native-session-token",
  shutdownGraceMilliseconds: 2_000,
};
const PENDING_INSTRUCTION: HostInstruction = {
  kind: "disposeAll",
  protocolVersion: PROTOCOL_VERSION,
  reason: "applicationShutdown",
  graceMilliseconds: 2_000,
};

describe("extension host connection", () => {
  beforeEach(() => {
    mocks.channels.length = 0;
    mocks.connectError = null;
    mocks.events.length = 0;
    mocks.invoke.mockReset();
    mocks.supervisors.length = 0;
  });

  it("establishes the session before forwarding queued instructions", async () => {
    mocks.invoke.mockImplementation(async (command: string, arguments_: unknown) => {
      if (command === "connect_extension_host") {
        const { channel } = arguments_ as {
          readonly channel: { onmessage: (instruction: HostInstruction) => void };
        };
        channel.onmessage(PENDING_INSTRUCTION);
        return HANDSHAKE;
      }
      if (command === "disconnect_extension_host") {
        mocks.events.push("disconnect");
        return undefined;
      }
      throw new Error(`Unexpected native command: ${command}`);
    });

    const connection = await connectExtensionHost();
    const supervisor = mocks.supervisors[0];
    expect(supervisor).toBeDefined();
    expect(supervisor?.connect).toHaveBeenCalledWith(HANDSHAKE);
    expect(supervisor?.accept).toHaveBeenCalledWith(PENDING_INSTRUCTION);
    expect(mocks.events.slice(0, 2)).toEqual(["connect", "accept"]);

    await Promise.all([connection.dispose(), connection.dispose()]);

    expect(supervisor?.dispose).toHaveBeenCalledTimes(1);
    expect(supervisor?.dispose).toHaveBeenCalledWith(HANDSHAKE.shutdownGraceMilliseconds);
    expect(mocks.invoke).toHaveBeenCalledWith("disconnect_extension_host", {
      sessionId: HANDSHAKE.sessionId,
    });
    expect(mocks.events.slice(-2)).toEqual(["dispose", "disconnect"]);
  });

  it("releases a native session when protocol negotiation fails", async () => {
    const connectionError = new Error("invalid handshake");
    mocks.connectError = connectionError;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "connect_extension_host") {
        return HANDSHAKE;
      }
      if (command === "disconnect_extension_host") {
        return undefined;
      }
      throw new Error(`Unexpected native command: ${command}`);
    });

    await expect(connectExtensionHost()).rejects.toBe(connectionError);
    expect(mocks.invoke).toHaveBeenCalledWith("disconnect_extension_host", {
      sessionId: HANDSHAKE.sessionId,
    });
  });
});
