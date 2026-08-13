import { describe, expect, it } from "vitest";
import {
  decodeHostInstruction,
  decodeHostToWorkerMessage,
  decodeWorkerToHostMessage,
} from "./protocol-validation";

describe("extension protocol boundary", () => {
  it("decodes an exact native activation instruction", () => {
    const instruction = {
      kind: "activateExtension",
      protocolVersion: 1,
      requestId: "activate-1",
      extensionId: "acme.sample",
      generation: 2,
      apiVersion: 1,
      bundleSha256: "a".repeat(64),
      extensionUri: "sideral-extension://acme.sample/",
      storageUri: "sideral-storage://acme.sample/",
      commandIds: ["acme.sample.run"],
      activationReason: { kind: "workbenchReady" },
      startDeadlineMilliseconds: 5_000,
      activationDeadlineMilliseconds: 10_000,
    };

    expect(decodeHostInstruction(instruction)).toEqual(instruction);
  });

  it("rejects native instructions with undeclared fields", () => {
    expect(() =>
      decodeHostInstruction({
        kind: "cancelRequest",
        protocolVersion: 1,
        requestId: "request-1",
        extensionId: "acme.sample",
        generation: 1,
        unexpected: true,
      }),
    ).toThrow(/unexpected is not supported/u);
  });

  it("rejects worker responses containing both result and error", () => {
    expect(() =>
      decodeWorkerToHostMessage({
        kind: "commandResult",
        protocolVersion: 1,
        generation: 1,
        requestId: "command-1",
        result: null,
        error: { code: "failed", message: "failed" },
      }),
    ).toThrow(/both a result and an error/u);
  });

  it("rejects undefined properties instead of treating them as absent", () => {
    expect(() =>
      decodeHostToWorkerMessage({
        kind: "brokerResponse",
        protocolVersion: 1,
        generation: 1,
        requestId: "broker-1",
        result: undefined,
      }),
    ).toThrow(/JSON values/u);
  });

  it("rejects non-JSON broker payloads", () => {
    expect(() =>
      decodeWorkerToHostMessage({
        kind: "brokerRequest",
        protocolVersion: 1,
        generation: 1,
        requestId: "broker-1",
        method: "storage.get",
        payload: { invalid: Number.NaN },
      }),
    ).toThrow(/finite number/u);
  });
});
