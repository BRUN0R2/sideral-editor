import type {
  PreviewAttributes,
  PreviewElement,
  PreviewNode,
  PreviewStyle,
  PreviewStyleProperty,
  PreviewTag,
} from "@sideral/extension-sdk";
import {
  arrayOf,
  BoundaryValidationError,
  enumeration,
  optional,
  record,
  required,
  safeInteger,
  stringValue,
} from "../../lib/runtime-validation";

const maxContentBytes: number = 192 * 1024;
const maxNodes: number = 10_000;
const maxDepth: number = 24;
const maxKeyLength: number = 256;
const maxAttributeLength: number = 4 * 1024;
const maxStyleLength: number = 256;
const maxListStart: number = 1_000_000;
const tags: readonly PreviewTag[] = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];
const styleProperties: readonly PreviewStyleProperty[] = [
  "backgroundColor",
  "border",
  "borderBottom",
  "borderInlineStart",
  "borderRadius",
  "borderCollapse",
  "borderSpacing",
  "color",
  "display",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "height",
  "letterSpacing",
  "lineHeight",
  "listStyleType",
  "margin",
  "marginTop",
  "marginBottom",
  "maxWidth",
  "overflow",
  "overflowX",
  "padding",
  "paddingBottom",
  "paddingInlineStart",
  "textAlign",
  "textDecoration",
  "whiteSpace",
  "width",
];
const styleValue: RegExp = /^[a-zA-Z0-9#%,.()\s-]+$/u;
const styleFunctions: ReadonlySet<string> = new Set([
  "calc",
  "clamp",
  "min",
  "max",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "var",
]);

export function decodePreviewContent(
  value: unknown,
  path = "preview content",
): readonly PreviewNode[] {
  let nodeCount = 0;
  const decodeNodes = (
    source: unknown,
    nodePath: string,
    depth: number,
  ): readonly PreviewNode[] => {
    if (depth > maxDepth)
      throw new BoundaryValidationError(nodePath, "exceeds the preview depth limit");
    const keys = new Set<string>();
    return arrayOf(source, nodePath, (node, itemPath) => {
      if (++nodeCount > maxNodes)
        throw new BoundaryValidationError(itemPath, "exceeds the preview node limit");
      if (typeof node === "string") return boundedText(node, itemPath, maxContentBytes);
      const element = record(node, itemPath, ["key", "tag", "children", "attributes", "style"]);
      const key = boundedText(required(element, "key", itemPath), `${itemPath}.key`, maxKeyLength);
      if (key.length === 0 || keys.has(key))
        throw new BoundaryValidationError(
          `${itemPath}.key`,
          "must be nonempty and unique among siblings",
        );
      keys.add(key);
      const tag = enumeration(required(element, "tag", itemPath), tags, `${itemPath}.tag`);
      const children = decodeNodes(
        required(element, "children", itemPath),
        `${itemPath}.children`,
        depth + 1,
      );
      if ((tag === "br" || tag === "hr") && children.length !== 0)
        throw new BoundaryValidationError(itemPath, "cannot give children to a void element");
      const attributes = optional(element, "attributes");
      const style = optional(element, "style");
      return {
        key,
        tag,
        children,
        ...(attributes === undefined
          ? {}
          : { attributes: decodeAttributes(attributes, `${itemPath}.attributes`, tag) }),
        ...(style === undefined ? {} : { style: decodeStyle(style, `${itemPath}.style`) }),
      } satisfies PreviewElement;
    });
  };
  const content = decodeNodes(value, path, 0);
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > maxContentBytes) {
    throw new BoundaryValidationError(path, "exceeds the preview byte limit");
  }
  return content;
}

function decodeAttributes(value: unknown, path: string, tag: PreviewTag): PreviewAttributes {
  const source = record(value, path, ["href", "title", "start", "language"]);
  const attributes: { href?: string; title?: string; start?: number; language?: string } = {};
  for (const name of ["href", "title", "language"] as const) {
    const raw = optional(source, name);
    if (raw !== undefined)
      attributes[name] = boundedText(raw, `${path}.${name}`, maxAttributeLength);
  }
  if (attributes.href !== undefined && (tag !== "a" || !isPreviewLink(attributes.href))) {
    throw new BoundaryValidationError(
      `${path}.href`,
      "must be an anchor with a local or HTTP(S) target",
    );
  }
  if (attributes.language !== undefined && tag !== "code")
    throw new BoundaryValidationError(`${path}.language`, "is supported only on code elements");
  const start = optional(source, "start");
  if (start !== undefined) {
    attributes.start = safeInteger(start, `${path}.start`);
    if (tag !== "ol" || attributes.start > maxListStart)
      throw new BoundaryValidationError(`${path}.start`, "must be a bounded ordered-list start");
  }
  return attributes;
}

function decodeStyle(value: unknown, path: string): PreviewStyle {
  const source = record(value, path, styleProperties);
  const style: Partial<Record<PreviewStyleProperty, string>> = {};
  for (const property of styleProperties) {
    const raw = optional(source, property);
    if (raw === undefined) continue;
    const text = boundedText(raw, `${path}.${property}`, maxStyleLength);
    if (
      !styleValue.test(text) ||
      [...text.matchAll(/([a-zA-Z]+)\s*\(/gu)].some((match) => !styleFunctions.has(match[1] ?? ""))
    ) {
      throw new BoundaryValidationError(`${path}.${property}`, "must be an inert CSS value");
    }
    style[property] = text;
  }
  return style;
}

function boundedText(value: unknown, path: string, maximumLength: number): string {
  const text = stringValue(value, path);
  if (text.length > maximumLength || text.includes("\0"))
    throw new BoundaryValidationError(path, "must be bounded text without NUL bytes");
  return text;
}

export function isPreviewLink(href: string): boolean {
  if (href.startsWith("#")) return true;
  try {
    const url = new URL(href);
    return (
      ["file:", "http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
