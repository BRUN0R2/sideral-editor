import { describe, expect, it } from "vitest";
import { editorDocumentUri } from "./document-uri";
import type { EditorDocument } from "./types";

function document(path: string | null, id = "document-1"): EditorDocument {
  return {
    id,
    path,
    name: "README.md",
    content: "",
    savedContent: "",
    languageId: "markdown",
    version: 1,
  };
}

describe("editorDocumentUri", () => {
  it("creates stable encoded Windows file URIs", () => {
    expect(editorDocumentUri(document("D:\\Project files\\README #1.md"))).toBe(
      "file:///D:/Project%20files/README%20%231.md",
    );
  });

  it("creates stable untitled URIs", () => {
    expect(editorDocumentUri(document(null, "untitled 1"))).toBe("untitled:/untitled%201");
  });
});
