import type { TextDocument } from "@sideral/extension-sdk";
import type { EditorDocument } from "./types";

export function editorDocumentUri(document: EditorDocument): string {
  if (document.path === null) {
    return `untitled:/${encodeURIComponent(document.id)}`;
  }

  const normalized = document.path.replaceAll("\\", "/");
  if (normalized.startsWith("//")) {
    const [host = "", ...segments] = normalized.slice(2).split("/");
    return `file://${host}/${encodePathSegments(segments)}`;
  }
  const segments = normalized.replace(/^\/+/, "").split("/");
  return `file:///${encodePathSegments(segments)}`;
}

export function toExtensionTextDocument(document: EditorDocument): TextDocument {
  return {
    uri: editorDocumentUri(document),
    languageId: document.languageId,
    version: document.version,
    content: document.content,
  };
}

function encodePathSegments(segments: readonly string[]): string {
  return segments
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/iu.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
}
