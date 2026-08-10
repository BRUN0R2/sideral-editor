import type { TextDocument } from "@sideral/extension-sdk";
import { createExtensionHarness } from "@sideral/extension-testkit";
import { describe, expect, it } from "vitest";
import * as markdownPreview from "../../../examples/markdown-preview/src/extension";

const markdownDocument: TextDocument = {
  uri: "file:///D:/workspace/README.md",
  languageId: "markdown",
  version: 3,
  content: "# Sideral\n\nA modern preview.",
};

describe("Markdown preview reference extension", () => {
  it("creates, updates and toggles one host-owned preview", async () => {
    const harness = createExtensionHarness(markdownPreview, {
      extensionId: "sideral.markdown-preview",
      activeTextDocument: markdownDocument,
    });
    await harness.activate();

    await expect(harness.executeCommand("sideral.markdown-preview.toggle")).resolves.toEqual({
      visible: true,
      uri: markdownDocument.uri,
    });
    expect(harness.previews).toHaveLength(1);
    expect(harness.previews[0]).toMatchObject({
      title: "Preview: README.md",
      format: "markdown",
      content: markdownDocument.content,
      sourceUri: markdownDocument.uri,
      visible: true,
    });

    await expect(harness.executeCommand("sideral.markdown-preview.toggle")).resolves.toEqual({
      visible: false,
      uri: markdownDocument.uri,
    });
    expect(harness.previews[0]?.visible).toBe(false);
    await harness.dispose();
    expect(harness.previews[0]?.disposed).toBe(true);
  });

  it("does not create a preview for another language", async () => {
    const harness = createExtensionHarness(markdownPreview, {
      extensionId: "sideral.markdown-preview",
      activeTextDocument: { ...markdownDocument, languageId: "plaintext" },
    });
    await harness.activate();
    await harness.executeCommand("sideral.markdown-preview.toggle");

    expect(harness.previews).toHaveLength(0);
    expect(harness.messages).toEqual([
      {
        severity: "warning",
        message: "Open a Markdown document to use Markdown Preview.",
      },
    ]);
    await harness.dispose();
  });
});
