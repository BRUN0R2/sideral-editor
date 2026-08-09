interface OrderedDocument {
  readonly id: string;
}

/**
 * Moves an item to an insertion point in the original list. Insertion points
 * range from zero (before the first item) through list length (after the last).
 */
export function reorderDocumentAt<T extends OrderedDocument>(
  documents: readonly T[],
  documentId: string,
  insertionIndex: number,
): readonly T[] {
  const sourceIndex = documents.findIndex((document) => document.id === documentId);
  if (sourceIndex < 0) {
    return documents;
  }

  const boundedInsertionIndex = Math.max(0, Math.min(documents.length, insertionIndex));
  const destinationIndex =
    sourceIndex < boundedInsertionIndex ? boundedInsertionIndex - 1 : boundedInsertionIndex;
  if (sourceIndex === destinationIndex) {
    return documents;
  }

  const reordered = [...documents];
  const [document] = reordered.splice(sourceIndex, 1);
  if (document === undefined) {
    return documents;
  }
  reordered.splice(destinationIndex, 0, document);
  return reordered;
}
