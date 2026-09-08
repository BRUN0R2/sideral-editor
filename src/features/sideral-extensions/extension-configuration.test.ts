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
    {
      kind: "text",
      key: "application-id",
      title: "Application ID",
      description: null,
      placeholder: "123456789012345678",
      defaultValue: "",
      value: "123456789012345678",
      userDefined: true,
    },
  ],
};

describe("extension configuration contracts", () => {
  it("decodes typed settings without weakening their discriminated union", () => {
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
