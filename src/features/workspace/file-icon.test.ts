import { describe, expect, it } from "vitest";
import { fileIconForFile } from "./file-icon";

describe("fileIconForFile", () => {
  it.each([
    ["App.tsx", "_react"],
    ["component.test.tsx", "_react_1"],
    ["vite.config.ts", "_vite"],
    ["tsconfig.json", "_tsconfig"],
    ["package-lock.json", "_json"],
    ["biome.json", "_json"],
    ["index.html", "_html_3"],
    ["README.md", "_info"],
    ["notes.md", "_markdown"],
    [".editorconfig", "_config"],
    [".gitattributes", "_git"],
    [".gitignore", "_git"],
    [".npmrc", "_npm_1"],
    ["main.rs", "_rust"],
    ["unknown.custom", "_default"],
  ])("maps %s to the official Seti definition %s", (fileName, expectedId) => {
    expect(fileIconForFile(fileName).id).toBe(expectedId);
  });

  it("decodes the official font character and color", () => {
    expect(fileIconForFile("main.ts")).toEqual({
      character: String.fromCodePoint(0xe099),
      color: "#519aba",
      id: "_typescript",
    });
  });

  it("handles paths and filenames without case sensitivity", () => {
    expect(fileIconForFile("C:\\workspace\\README.MD").id).toBe("_info");
  });
});
