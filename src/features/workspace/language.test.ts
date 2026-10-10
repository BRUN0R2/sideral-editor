import { describe, expect, it } from "vitest";
import { languageForFile } from "./language";

describe("languageForFile", () => {
  it.each([
    ["main.rs", "rust"],
    ["App.tsx", "typescript"],
    ["settings.json", "json"],
    ["Dockerfile", "dockerfile"],
    ["README.md", "markdown"],
    ["unknown.custom", "plaintext"],
    ["notes.txt", "plaintext"],
    ["APP.TSX", "typescript"],
    ["constructor", "plaintext"],
    ["file.constructor", "plaintext"],
  ])("maps %s to %s", (fileName, expectedLanguage) => {
    expect(languageForFile(fileName)).toBe(expectedLanguage);
  });

  it("uses declarative extension languages without hardcoding them in the editor", () => {
    const languages = [{ id: "amxxpawn", extensions: [".sma", ".inc"] }];

    expect(languageForFile("plugin.SMA", languages)).toBe("amxxpawn");
    expect(languageForFile("shared.inc", languages)).toBe("amxxpawn");
  });
});
