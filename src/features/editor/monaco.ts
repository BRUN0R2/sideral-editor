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
      "editor.background": "#282c34",
      "editor.foreground": "#c8ccd4",
      "editorLineNumber.foreground": "#5f6672",
      "editorLineNumber.activeForeground": "#b2b7bf",
      "editorCursor.foreground": "#d6d8dc",
      "editor.selectionBackground": "#61677180",
      "editor.inactiveSelectionBackground": "#4b515b66",
      "editor.lineHighlightBackground": "#2c313a",
      "editorIndentGuide.background1": "#373c45",
      "editorIndentGuide.activeBackground1": "#555b65",
      "editorGutter.background": "#282c34",
      "editorWidget.background": "#252a31",
      "editorWidget.border": "#414750",
      "input.background": "#20242a",
      "input.border": "#414750",
      focusBorder: "#9298a1",
    },
  });
  themeDefined = true;
}

export { monaco };
