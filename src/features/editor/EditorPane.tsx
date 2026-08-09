import { useEffect, useRef } from "react";
import { isDesktopRuntime, openExternalUrl } from "../../lib/backend";
import type { CursorPosition, EditorDocument } from "../workspace/types";
import { JsonSchemaTrustDialog } from "./JsonSchemaTrustDialog";
import { ensureSideralTheme, monaco } from "./monaco";
import { useJsonSchemaSupport } from "./useJsonSchemaSupport";

interface EditorPaneProps {
  readonly documents: readonly EditorDocument[];
  readonly activeDocumentId: string;
  readonly active: boolean;
  readonly workspaceRootPath: string | null;
  readonly jsonSchemaTrustRevision: number;
  readonly onContentChange: (id: string, content: string) => void;
  readonly onCursorChange: (position: CursorPosition) => void;
  readonly onJsonSchemaTrustChange: () => void;
}

export function EditorPane({
  documents,
  activeDocumentId,
  active,
  workspaceRootPath,
  jsonSchemaTrustRevision,
  onContentChange,
  onCursorChange,
  onJsonSchemaTrustChange,
}: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const contentListenerRef = useRef<monaco.IDisposable | null>(null);
  const cursorCallbackRef = useRef(onCursorChange);
  cursorCallbackRef.current = onCursorChange;
  const activeDocument = documents.find((document) => document.id === activeDocumentId);
  const activeModelUri = activeDocument === undefined ? null : modelUri(activeDocument).toString();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    ensureSideralTheme();
    const editor = monaco.editor.create(container, {
      theme: "sideral-dark",
      automaticLayout: false,
      model: null,
      fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
      fontSize: 14,
      lineHeight: 22,
      fontLigatures: true,
      minimap: { enabled: false },
      padding: { top: 18, bottom: 18 },
      renderLineHighlight: "line",
      renderWhitespace: "selection",
      smoothScrolling: true,
      scrollBeyondLastLine: false,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      stickyScroll: { enabled: true },
      overviewRulerBorder: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;

    const linkOpener = monaco.editor.registerLinkOpener({
      async open(resource) {
        if (!isDesktopRuntime() || !isExternalWebScheme(resource.scheme)) {
          return false;
        }
        await openExternalUrl(resource.toString(true));
        return true;
      },
    });

    const cursorListener = editor.onDidChangeCursorPosition((event) => {
      cursorCallbackRef.current({ line: event.position.lineNumber, column: event.position.column });
    });
    const resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      linkOpener.dispose();
      cursorListener.dispose();
      contentListenerRef.current?.dispose();
      contentListenerRef.current = null;
      editor.dispose();
      editorRef.current = null;
      for (const model of modelsRef.current.values()) {
        model.dispose();
      }
      modelsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const documentIds = new Set(documents.map((document) => document.id));
    for (const [id, model] of modelsRef.current) {
      if (!documentIds.has(id)) {
        if (editorRef.current?.getModel() === model) {
          editorRef.current.setModel(null);
        }
        model.dispose();
        modelsRef.current.delete(id);
      }
    }

    for (const document of documents) {
      let model = modelsRef.current.get(document.id);
      const uri = modelUri(document);
      if (model !== undefined && model.uri.toString() !== uri.toString()) {
        if (editorRef.current?.getModel() === model) {
          editorRef.current.setModel(null);
        }
        model.dispose();
        modelsRef.current.delete(document.id);
        model = undefined;
      }
      if (model === undefined) {
        model = monaco.editor.createModel(document.content, document.languageId, uri);
        modelsRef.current.set(document.id, model);
      } else {
        if (model.getLanguageId() !== document.languageId) {
          monaco.editor.setModelLanguage(model, document.languageId);
        }
        if (model.getValue() !== document.content) {
          model.setValue(document.content);
        }
      }
    }
  }, [documents]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelsRef.current.get(activeDocumentId);
    if (editor === null || model === undefined || model.uri.toString() !== activeModelUri) {
      return;
    }
    contentListenerRef.current?.dispose();
    editor.setModel(model);
    contentListenerRef.current = model.onDidChangeContent(() => {
      onContentChange(activeDocumentId, model.getValue());
    });
    editor.focus();
    return () => {
      contentListenerRef.current?.dispose();
      contentListenerRef.current = null;
    };
  }, [activeDocumentId, activeModelUri, onContentChange]);

  const jsonSchemaSupport = useJsonSchemaSupport({
    active,
    documents,
    workspaceRootPath,
    trustRevision: jsonSchemaTrustRevision,
    models: modelsRef,
    onTrustChange: onJsonSchemaTrustChange,
  });

  return (
    <>
      <div ref={containerRef} className="editor-pane" />
      <JsonSchemaTrustDialog controller={jsonSchemaSupport} />
    </>
  );
}

function modelUri(document: EditorDocument): monaco.Uri {
  return document.path === null
    ? monaco.Uri.from({ scheme: "untitled", path: `/${document.id}` })
    : monaco.Uri.file(document.path);
}

function isExternalWebScheme(scheme: string): boolean {
  return scheme === "http" || scheme === "https";
}
