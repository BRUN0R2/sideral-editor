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
  ])("maps %s to %s", (fileName, expectedLanguage) => {
    expect(languageForFile(fileName)).toBe(expectedLanguage);
  });
});
