import { describe, expect, it } from "vitest";
import { autoSaveDocuments } from "./auto-save";
import type { EditorDocument } from "./types";

function document(
  id: string,
  path: string | null,
  content: string,
  savedContent: string,
): EditorDocument {
  return {
    id,
    path,
    name: path === null ? "Untitled" : `${id}.ts`,
    content,
    savedContent,
    languageId: "typescript",
    version: 1,
  };
}

describe("autoSaveDocuments", () => {
  it("returns only dirty named documents", () => {
    const documents = [
      document("dirty", "C:\\workspace\\dirty.ts", "changed", "saved"),
      document("clean", "C:\\workspace\\clean.ts", "saved", "saved"),
      document("untitled", null, "changed", ""),
    ];

    expect(autoSaveDocuments(documents, null).map(({ id }) => id)).toEqual(["dirty"]);
  });

  it("does not save a document while its close confirmation is open", () => {
    const documents = [document("pending", "C:\\workspace\\pending.ts", "changed", "saved")];

    expect(autoSaveDocuments(documents, "pending")).toEqual([]);
  });
});
