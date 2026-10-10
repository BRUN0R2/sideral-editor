import type { PreviewStyle, PreviewTag } from "@sideral/extension-sdk";

const codeFont: string = "Cascadia Code, JetBrains Mono, Consolas, monospace";
const paragraph: PreviewStyle = { margin: "0 0 1.15em" };
const heading: PreviewStyle = {
  margin: "1.65em 0 0.65em",
  color: "#f0f1f3",
  fontWeight: "680",
  lineHeight: "1.28",
  letterSpacing: "-0.018em",
};
const cell: PreviewStyle = { border: "1px solid #3b424c", padding: "7px 10px", textAlign: "start" };

export const documentStyle: PreviewStyle = {
  padding: "34px clamp(24px, 6vw, 72px) 72px",
  fontFamily: "Inter, Segoe UI, sans-serif",
  fontSize: "14px",
  lineHeight: "1.72",
  color: "#d8dbe0",
  backgroundColor: "#22262d",
};
export const rawHtmlStyle: PreviewStyle = {
  color: "#aeb4bd",
  fontFamily: codeFont,
  fontSize: "0.88em",
  whiteSpace: "pre-wrap",
};
export const imageStyle: PreviewStyle = {
  display: "inline-block",
  border: "1px dashed #515a67",
  borderRadius: "5px",
  padding: "2px 7px",
  fontSize: "0.88em",
  color: "#aeb4bd",
};
export const checkboxStyle: PreviewStyle = {
  display: "inline-block",
  width: "1.35em",
  color: "#91b7e8",
};
export const codeBlockStyle: PreviewStyle = {
  overflow: "hidden",
  border: "1px solid #41454b",
  borderRadius: "8px",
  margin: "0 0 1.15em",
  backgroundColor: "#2d3034",
};
export const codeLabelStyle: PreviewStyle = {
  padding: "10px 11px",
  color: "#f0f2f5",
  backgroundColor: "#34373b",
  fontWeight: "650",
  lineHeight: "1",
};

export const elementStyles: Readonly<Partial<Record<PreviewTag, PreviewStyle>>> = {
  h1: { ...heading, borderBottom: "1px solid #3a4049", paddingBottom: "0.38em", fontSize: "2em" },
  h2: { ...heading, borderBottom: "1px solid #353b44", paddingBottom: "0.34em", fontSize: "1.5em" },
  h3: { ...heading, fontSize: "1.24em" },
  h4: heading,
  h5: heading,
  h6: heading,
  p: paragraph,
  ol: { ...paragraph, paddingInlineStart: "1.7em" },
  ul: { ...paragraph, paddingInlineStart: "1.7em" },
  a: { color: "#6cb6ff", textDecoration: "underline" },
  blockquote: {
    ...paragraph,
    borderInlineStart: "3px solid #667383",
    padding: "0.15em 1em",
    color: "#aeb4bd",
    backgroundColor: "#232830",
  },
  code: {
    borderRadius: "4px",
    padding: "0.16em 0.38em",
    color: "#d7c5ec",
    backgroundColor: "#191d23",
    fontFamily: codeFont,
    fontSize: "0.88em",
  },
  pre: {
    ...paragraph,
    overflow: "auto",
    border: "1px solid #343a43",
    borderRadius: "8px",
    padding: "15px 17px",
    backgroundColor: "#191d23",
  },
  table: { ...paragraph, width: "100%", borderSpacing: "0", borderCollapse: "collapse" },
  td: cell,
  th: { ...cell, backgroundColor: "#292e36", fontWeight: "650" },
  hr: { height: "1px", border: "0", margin: "2em 0", backgroundColor: "#3a4049" },
};
