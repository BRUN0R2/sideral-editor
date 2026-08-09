import { describe, expect, it } from "vitest";
import { type FileIconKind, fileIconKindForFile } from "./file-icon";

describe("fileIconKindForFile", () => {
  it.each<[string, FileIconKind]>([
    ["App.tsx", "typescript"],
    ["vite.config.ts", "vite"],
    ["tsconfig.json", "typescript"],
    ["package-lock.json", "package"],
    ["biome.json", "json"],
    ["index.html", "html"],
    ["README.md", "readme"],
    ["notes.md", "markdown"],
    [".gitignore", "git"],
    ["main.rs", "rust"],
    ["unknown.custom", "generic"],
  ])("maps %s to the %s icon", (fileName, expectedKind) => {
    expect(fileIconKindForFile(fileName)).toBe(expectedKind);
  });
});
