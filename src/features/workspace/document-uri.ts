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

export function fileUriToPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:" || parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    const pathname = decodeURIComponent(parsed.pathname);
    if (parsed.hostname !== "") {
      return `\\\\${parsed.hostname}${pathname.replaceAll("/", "\\")}`;
    }
    if (/^\/[a-z]:\//iu.test(pathname)) {
      return pathname.slice(1).replaceAll("/", "\\");
    }
    return pathname;
  } catch {
    return null;
  }
}

function encodePathSegments(segments: readonly string[]): string {
  return segments
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/iu.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
}
