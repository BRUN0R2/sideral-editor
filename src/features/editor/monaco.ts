import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

window.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === "json") {
      return new JsonWorker();
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new CssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new HtmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new TypeScriptWorker();
    }
    return new EditorWorker();
  },
};

let themeDefined = false;

export function ensureSideralTheme(): void {
  if (themeDefined) {
    return;
  }
  monaco.editor.defineTheme("sideral-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "697386", fontStyle: "italic" },
      { token: "keyword", foreground: "c6a6ff" },
      { token: "string", foreground: "a7dba0" },
      { token: "number", foreground: "f4b67a" },
      { token: "type", foreground: "82d2ce" },
    ],
    colors: {
      "editor.background": "#11151b",
      "editor.foreground": "#d7dce5",
      "editorLineNumber.foreground": "#4e5869",
      "editorLineNumber.activeForeground": "#aeb7c5",
      "editorCursor.foreground": "#8ea7ff",
      "editor.selectionBackground": "#344a7a80",
      "editor.inactiveSelectionBackground": "#27365366",
      "editor.lineHighlightBackground": "#171c24",
      "editorIndentGuide.background1": "#242b36",
      "editorIndentGuide.activeBackground1": "#465064",
      "editorGutter.background": "#11151b",
      "editorWidget.background": "#171c24",
      "editorWidget.border": "#2d3542",
      "input.background": "#0e1116",
      "input.border": "#313a48",
      focusBorder: "#7088d8",
    },
  });
  themeDefined = true;
}

export { monaco };
