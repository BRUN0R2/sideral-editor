import { type EditorDocument, isDocumentDirty } from "./types";

export const AUTO_SAVE_DELAY_MS: number = 1_000;

export function autoSaveDocuments(
  documents: readonly EditorDocument[],
  pendingCloseId: string | null,
): readonly EditorDocument[] {
  return documents.filter(
    (document) =>
      document.path !== null && document.id !== pendingCloseId && isDocumentDirty(document),
  );
}
