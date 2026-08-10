import type { ExtensionModule, PreviewDocument, PreviewPanel } from "@sideral/extension-sdk";

const TOGGLE_PREVIEW_COMMAND = "sideral.markdown-preview.toggle";

export const activate: ExtensionModule["activate"] = (context, api) => {
  let panel: PreviewPanel | null = null;
  let sourceUri: string | null = null;

  const command = api.commands.registerTextEditorCommand(
    TOGGLE_PREVIEW_COMMAND,
    async (document) => {
      if (document.languageId !== "markdown") {
        await api.window.showWarningMessage("Open a Markdown document to use Markdown Preview.");
        return { visible: false, reason: "unsupportedLanguage" };
      }

      const nextPreview: PreviewDocument = {
        title: `Preview: ${documentName(document.uri)}`,
        format: "markdown",
        content: document.content,
        sourceUri: document.uri,
      };
      if (panel === null) {
        panel = api.window.createPreviewPanel(nextPreview);
        sourceUri = document.uri;
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
    },
  );

  context.subscriptions.add(command, {
    async dispose() {
      const current = panel;
      panel = null;
      sourceUri = null;
      await current?.dispose();
    },
  });
};

function documentName(uri: string): string {
  try {
    const path = new URL(uri).pathname;
    const name = path.split("/").filter(Boolean).at(-1);
    return name === undefined ? "Markdown" : decodeURIComponent(name);
  } catch {
    return "Markdown";
  }
}
