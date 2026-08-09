import { describe, expect, it } from "vitest";
import { reorderDocumentAt } from "./document-order";

const documents = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }, { id: "delta" }];

describe("reorderDocumentAt", () => {
  it("moves documents in both directions", () => {
    expect(reorderDocumentAt(documents, "alpha", 3).map(({ id }) => id)).toEqual([
      "beta",
      "gamma",
      "alpha",
      "delta",
    ]);
    expect(reorderDocumentAt(documents, "delta", 1).map(({ id }) => id)).toEqual([
      "alpha",
      "delta",
      "beta",
      "gamma",
    ]);
  });

  it("moves documents to the beginning and end", () => {
    expect(reorderDocumentAt(documents, "gamma", 0).map(({ id }) => id)).toEqual([
      "gamma",
      "alpha",
      "beta",
      "delta",
    ]);
    expect(reorderDocumentAt(documents, "beta", documents.length).map(({ id }) => id)).toEqual([
      "alpha",
      "gamma",
      "delta",
      "beta",
    ]);
  });

  it("preserves the collection for no-op and unknown moves", () => {
    expect(reorderDocumentAt(documents, "beta", 2)).toBe(documents);
    expect(reorderDocumentAt(documents, "missing", 0)).toBe(documents);
  });
});
