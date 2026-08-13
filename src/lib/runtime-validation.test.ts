import { describe, expect, it } from "vitest";
import { BoundaryValidationError, jsonValue, record } from "./runtime-validation";

describe("runtime boundary validation", () => {
  it("rejects non-plain transport objects", () => {
    expect(() => record(new Date(), "payload")).toThrow(BoundaryValidationError);
  });

  it("rejects circular JSON values", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(() => jsonValue(value, "payload")).toThrow(/must not contain cycles/u);
  });

  it("rejects prototype mutation keys", () => {
    const value: unknown = JSON.parse('{"__proto__":{"polluted":true}}');

    expect(() => jsonValue(value, "payload")).toThrow(/safe transport property/u);
  });

  it("rebuilds bounded JSON without sharing mutable containers", () => {
    const source = { nested: [1, { enabled: true }] };
    const decoded = jsonValue(source, "payload");

    expect(decoded).toEqual(source);
    expect(decoded).not.toBe(source);
  });
});
