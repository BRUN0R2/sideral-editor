import { describe, expect, it } from "vitest";
import { decodeExtensionConfiguration, decodeExtensionConfigurations } from "./contract-validation";

const CONFIGURATION = {
  extensionId: "acme.compiler",
  title: "Acme Compiler",
  properties: [
    {
      kind: "executable",
      key: "compiler-path",
      title: "Compiler Path",
      description: "Compiler executable.",
      defaultValue: "compiler",
      value: "D:\\Tools\\compiler.exe",
      userDefined: true,
    },
  ],
};

describe("extension configuration contracts", () => {
  it("decodes executable settings without weakening their discriminated type", () => {
    expect(decodeExtensionConfiguration(CONFIGURATION)).toEqual(CONFIGURATION);
    expect(decodeExtensionConfigurations([CONFIGURATION])).toEqual([CONFIGURATION]);
  });

  it("rejects malformed executable values at the frontend boundary", () => {
    expect(() =>
      decodeExtensionConfiguration({
        ...CONFIGURATION,
        properties: [{ ...CONFIGURATION.properties[0], value: false }],
      }),
    ).toThrow(/properties\[0\]\.value/u);
  });
});
