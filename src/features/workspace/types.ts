import type { DirectoryEntryKind } from "../../lib/contracts";

export interface WorkspaceNode {
  readonly path: string;
  readonly name: string;
  readonly kind: DirectoryEntryKind;
  readonly expanded: boolean;
  readonly loading: boolean;
  readonly children: readonly WorkspaceNode[] | null;
}

export interface WorkspaceRoot {
  readonly path: string;
  readonly name: string;
}

export interface EditorDocument {
  readonly id: string;
  readonly path: string | null;
  readonly name: string;
  readonly content: string;
  readonly savedContent: string;
  readonly languageId: string;
  readonly version: number;
}

export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

export function isDocumentDirty(document: EditorDocument): boolean {
  return document.content !== document.savedContent;
}
