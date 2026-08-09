import { useEffect, useRef } from "react";
import type { CursorPosition, EditorDocument } from "../workspace/types";
import { ensureSideralTheme, monaco } from "./monaco";

interface EditorPaneProps {
  readonly documents: readonly EditorDocument[];
  readonly activeDocumentId: string;
  readonly onContentChange: (id: string, content: string) => void;
  readonly onCursorChange: (position: CursorPosition) => void;
}

export function EditorPane({
  documents,
  activeDocumentId,
  onContentChange,
  onCursorChange,
}: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const contentListenerRef = useRef<monaco.IDisposable | null>(null);
  const cursorCallbackRef = useRef(onCursorChange);
  cursorCallbackRef.current = onCursorChange;

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

    const cursorListener = editor.onDidChangeCursorPosition((event) => {
      cursorCallbackRef.current({ line: event.position.lineNumber, column: event.position.column });
    });
    const resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
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
      if (model === undefined) {
        const uri = monaco.Uri.from({ scheme: "sideral", path: `/documents/${document.id}` });
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
    if (editor === null || model === undefined) {
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
  }, [activeDocumentId, onContentChange]);

  return <div ref={containerRef} className="editor-pane" />;
}
