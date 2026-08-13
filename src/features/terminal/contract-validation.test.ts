import { describe, expect, it } from "vitest";
import {
  decodeTerminalEvent,
  decodeTerminalOutput,
  decodeTerminalSessionSnapshot,
} from "./contract-validation";

describe("integrated terminal boundary", () => {
  it("decodes a canonical session snapshot", () => {
    expect(
      decodeTerminalSessionSnapshot({
        id: "terminal-7",
        processId: 42,
        shellName: "PowerShell",
        workingDirectory: "C:\\workspace",
      }),
    ).toEqual({
      id: "terminal-7",
      processId: 42,
      shellName: "PowerShell",
      workingDirectory: "C:\\workspace",
    });
  });

  it("rejects unknown event fields", () => {
    expect(() =>
      decodeTerminalEvent({ kind: "exited", exitCode: 0, signal: null, hidden: true }),
    ).toThrow(/hidden/);
  });

  it("decodes raw terminal output without text transcoding", () => {
    const output = decodeTerminalOutput(new Uint8Array([0xf0, 0x9f, 0x8c, 0x8c]).buffer);
    expect([...output]).toEqual([0xf0, 0x9f, 0x8c, 0x8c]);
  });

  it("rejects output chunks above the native transport budget", () => {
    expect(() => decodeTerminalOutput(new ArrayBuffer(16 * 1024 + 1))).toThrow(/16384 bytes/);
  });
});
