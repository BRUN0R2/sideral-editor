import { editorDocumentUri } from "../workspace/document-uri";
import type { EditorDocument } from "../workspace/types";
import type { PreviewDocumentView } from "./contracts";

export function visiblePreviewMap(
  previews: readonly PreviewDocumentView[],
): ReadonlyMap<string, PreviewDocumentView> {
  return new Map(
    previews
      .filter((preview) => preview.visible)
      .map((preview) => [preview.resourceId, preview] as const),
  );
}

export function applyPreviewChange(
  current: ReadonlyMap<string, PreviewDocumentView>,
  preview: PreviewDocumentView,
): ReadonlyMap<string, PreviewDocumentView> {
  const next = new Map(current);
  if (preview.visible) {
    next.set(preview.resourceId, preview);
  } else {
    next.delete(preview.resourceId);
  }
  return next;
}

export function previewForActiveDocument(
  previews: readonly PreviewDocumentView[],
  activeDocument: EditorDocument | null,
): PreviewDocumentView | null {
  return (
    previews.find(
      (preview) => preview.visible && previewMatchesActiveDocument(preview, activeDocument),
    ) ?? null
  );
}

export function closedDocumentPreviews(
  previews: readonly PreviewDocumentView[],
  openDocuments: readonly EditorDocument[],
): readonly PreviewDocumentView[] {
  const openDocumentUris = new Set(openDocuments.map(editorDocumentUri));
  return previews.filter(
    (preview) =>
      preview.visible && preview.sourceUri !== null && !openDocumentUris.has(preview.sourceUri),
  );
}

function previewMatchesActiveDocument(
  preview: PreviewDocumentView,
  activeDocument: EditorDocument | null,
): boolean {
  if (preview.sourceUri === null) {
    return true;
  }
  return activeDocument !== null && preview.sourceUri === editorDocumentUri(activeDocument);
}
