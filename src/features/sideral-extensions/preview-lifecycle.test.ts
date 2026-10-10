import { describe, expect, it } from "vitest";
import type { EditorDocument } from "../workspace/types";
import type { PreviewDocumentView } from "./contracts";
import {
  applyPreviewChange,
  closedDocumentPreviews,
  previewForActiveDocument,
  visiblePreviewMap,
} from "./preview-lifecycle";

const readme = document("readme", "D:\\workspace\\README.md");
const changelog = document("changelog", "D:\\workspace\\CHANGELOG.md");
const readmePreview = preview({
  resourceId: "preview:markdown:1",
  sourceUri: "file:///D:/workspace/README.md",
});

describe("preview lifecycle", () => {
  it("shows a document preview only beside its active source", () => {
    expect(previewForActiveDocument([readmePreview], readme)).toBe(readmePreview);
    expect(previewForActiveDocument([readmePreview], changelog)).toBeNull();
    expect(closedDocumentPreviews([readmePreview], [readme, changelog])).toEqual([]);
  });

  it("dismisses a source-bound preview after its editor document closes", () => {
    expect(previewForActiveDocument([readmePreview], null)).toBeNull();
    expect(closedDocumentPreviews([readmePreview], [changelog])).toEqual([readmePreview]);
  });

  it("keeps source-independent previews available", () => {
    const globalPreview = preview({
      resourceId: "preview:global:1",
      sourceUri: null,
    });

    expect(previewForActiveDocument([globalPreview], changelog)).toBe(globalPreview);
    expect(closedDocumentPreviews([globalPreview], [])).toEqual([]);
  });

  it("retains only visible preview payloads in the client cache", () => {
    const hiddenPreview = { ...readmePreview, visible: false };
    const initial = visiblePreviewMap([readmePreview, hiddenPreview]);
    expect([...initial.keys()]).toEqual([readmePreview.resourceId]);

    const hidden = applyPreviewChange(initial, hiddenPreview);
    expect(hidden.size).toBe(0);
    expect(previewForActiveDocument([...hidden.values()], readme)).toBeNull();

    const reopened = applyPreviewChange(hidden, readmePreview);
    expect(reopened.get(readmePreview.resourceId)).toBe(readmePreview);
  });
});

function document(id: string, path: string): EditorDocument {
  return {
    id,
    path,
    name: path.split("\\").at(-1) ?? path,
    content: "# Document",
    savedContent: "# Document",
    languageId: "markdown",
    version: 1,
  };
}

function preview(
  overrides: Pick<PreviewDocumentView, "resourceId" | "sourceUri">,
): PreviewDocumentView {
  return {
    ...overrides,
    extensionId: "sideral.markdown-preview",
    title: "Preview",
    format: "tree",
    content: ["Preview"],
    appearance: null,
    visible: true,
  };
}
