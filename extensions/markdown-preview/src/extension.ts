import type {
  ExtensionModule,
  PreviewDocument,
  PreviewPanel,
  TextDocument,
} from "@sideral/extension-sdk";
import { renderMarkdown } from "./markdownRenderer";

const togglePreviewCommand: string = "sideral.markdown-preview.toggle";

export const activate: ExtensionModule["activate"] = (context, api) => {
  let panel: PreviewPanel | null = null;
  let sourceUri: string | null = null;

  const command = api.commands.registerTextEditorCommand(togglePreviewCommand, async (document) => {
    if (document.languageId !== "markdown") {
      await api.window.showWarningMessage("Open a Markdown document to use Markdown Preview.");
      return { visible: false, reason: "unsupportedLanguage" };
    }

    const nextPreview = previewDocument(document);
    if (panel === null) {
      panel = api.window.createPreviewPanel(nextPreview);
      sourceUri = document.uri;
      context.subscriptions.add(
        panel.onDidChangeSourceDocument(async (source) => {
          if (source.uri === sourceUri) await panel?.update(previewDocument(source));
        }),
      );
      await panel.show();
      return { visible: true, uri: document.uri };
    }

    await panel.update(nextPreview);
    if (sourceUri !== document.uri) {
      sourceUri = document.uri;
      await panel.show();
      return { visible: true, uri: document.uri };
    }

    const visible = await panel.toggle();
    return { visible, uri: document.uri };
  });

  context.subscriptions.add(command, {
    async dispose() {
      const current = panel;
      panel = null;
      sourceUri = null;
      await current?.dispose();
    },
  });
};

function previewDocument(document: TextDocument): PreviewDocument {
  return {
    title: `Preview: ${documentName(document.uri)}`,
    format: "tree",
    content: renderMarkdown(document.content, document.uri),
    sourceUri: document.uri,
  };
}

function documentName(uri: string): string {
  try {
    const path = new URL(uri).pathname;
    const name = path.split("/").filter(Boolean).at(-1);
    return name === undefined ? "Markdown" : decodeURIComponent(name);
  } catch {
    return "Markdown";
  }
}
