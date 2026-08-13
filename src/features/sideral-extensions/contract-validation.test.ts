import { describe, expect, it } from "vitest";
import { decodeExtensionClientInstruction } from "./contract-validation";

describe("extension client contracts", () => {
  const outputChanged = {
    kind: "outputChanged",
    channel: {
      resourceId: "acme.compiler:1",
      extensionId: "acme.compiler",
      name: "Compiler",
      content: "Compiling...\n",
      revealSequence: 1,
    },
  } as const;

  it("decodes an exact output update with its reveal sequence", () => {
    expect(decodeExtensionClientInstruction(outputChanged)).toEqual(outputChanged);
  });

  it("rejects the removed output visibility flag", () => {
    expect(() =>
      decodeExtensionClientInstruction({
        ...outputChanged,
        channel: { ...outputChanged.channel, visible: true },
      }),
    ).toThrow(/visible is not supported/u);
  });

  it("rejects unsafe output reveal sequences", () => {
    expect(() =>
      decodeExtensionClientInstruction({
        ...outputChanged,
        channel: { ...outputChanged.channel, revealSequence: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow(/safe integer/u);
  });
});
