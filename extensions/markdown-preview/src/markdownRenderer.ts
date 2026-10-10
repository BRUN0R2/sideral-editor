import type {
  PreviewAttributes,
  PreviewElement,
  PreviewNode,
  PreviewStyle,
  PreviewTag,
} from "@sideral/extension-sdk";
import { marked, type Token, type Tokens } from "marked";
import {
  checkboxStyle,
  codeBlockStyle,
  codeLabelStyle,
  documentStyle,
  elementStyles,
  imageStyle,
  rawHtmlStyle,
} from "./previewStyles";

const checkedSymbol: string = "\u2611";
const uncheckedSymbol: string = "\u2610";
const headingTags: readonly PreviewTag[] = ["h1", "h2", "h3", "h4", "h5", "h6"];
const powerShellLanguages: ReadonlySet<string> = new Set(["powershell", "ps1", "pwsh"]);

export function renderMarkdown(
  content: string,
  sourceUri: string | null = null,
): readonly PreviewNode[] {
  return [
    element(
      "div",
      "document",
      renderTokens(marked.lexer(content, { gfm: true }), "root", sourceUri),
      { style: documentStyle },
    ),
  ];
}

function renderTokens(
  tokens: readonly Token[],
  parent: string,
  sourceUri: string | null,
): readonly PreviewNode[] {
  return tokens.flatMap((token, index) => renderToken(token, `${parent}-${index}`, sourceUri));
}

function renderToken(token: Token, key: string, sourceUri: string | null): readonly PreviewNode[] {
  const children = () => renderTokens(tokensOf(token), key, sourceUri);
  switch (token.type) {
    case "space":
    case "def":
      return [];
    case "blockquote":
      return [element("blockquote", key, children())];
    case "br":
      return [element("br", key, [])];
    case "hr":
      return [element("hr", key, [])];
    case "codespan":
      return [element("code", key, [(token as Tokens.Codespan).text])];
    case "code":
      return [renderCode(token as Tokens.Code, key)];
    case "del":
      return [element("del", key, children())];
    case "em":
      return [element("em", key, children())];
    case "strong":
      return [element("strong", key, children())];
    case "paragraph":
      return [element("p", key, children())];
    case "heading":
      return [element(headingTags[(token as Tokens.Heading).depth - 1] ?? "h6", key, children())];
    case "escape":
      return [(token as Tokens.Escape).text];
    case "html":
      return [element("span", key, [token.raw], { style: rawHtmlStyle })];
    case "image":
      return [
        element("span", key, [(token as Tokens.Image).text || "Image"], {
          style: imageStyle,
          attributes: { title: (token as Tokens.Image).title ?? "" },
        }),
      ];
    case "link": {
      const link = token as Tokens.Link;
      const href = resolveLink(link.href, sourceUri);
      return [
        href === null
          ? element("span", key, children(), { style: { color: "#aeb4bd" } })
          : element("a", key, children(), {
              attributes: { href, ...(link.title == null ? {} : { title: link.title }) },
            }),
      ];
    }
    case "list": {
      const list = token as Tokens.List;
      return [
        element(
          list.ordered ? "ol" : "ul",
          key,
          list.items.map((item, index) => renderListItem(item, `${key}-${index}`, sourceUri)),
          {
            ...(typeof list.start === "number" ? { attributes: { start: list.start } } : {}),
          },
        ),
      ];
    }
    case "list_item":
      return [renderListItem(token as Tokens.ListItem, key, sourceUri)];
    case "table":
      return [renderTable(token as Tokens.Table, key, sourceUri)];
    case "text":
      return tokensOf(token).length === 0 ? [(token as Tokens.Text).text] : children();
    default:
      return tokensOf(token).length === 0 ? [token.raw] : children();
  }
}

function renderListItem(
  token: Tokens.ListItem,
  key: string,
  sourceUri: string | null,
): PreviewElement {
  const children = renderTokens(token.tokens, key, sourceUri);
  return element(
    "li",
    key,
    token.task
      ? [
          element("span", `${key}-checkbox`, [token.checked ? checkedSymbol : uncheckedSymbol], {
            style: checkboxStyle,
          }),
          ...children,
        ]
      : children,
    {
      ...(token.task ? { style: { listStyleType: "none" } } : {}),
    },
  );
}

function renderTable(token: Tokens.Table, key: string, sourceUri: string | null): PreviewElement {
  const cells = (values: readonly Tokens.TableCell[], parent: string, tag: "td" | "th") =>
    values.map((cell, index) =>
      element(
        tag,
        `${parent}-${index}`,
        renderTokens(cell.tokens, `${parent}-${index}`, sourceUri),
        {
          ...(cell.align === null ? {} : { style: { textAlign: cell.align } }),
        },
      ),
    );
  return element("table", key, [
    element("thead", `${key}-head`, [
      element("tr", `${key}-header`, cells(token.header, `${key}-header`, "th")),
    ]),
    element(
      "tbody",
      `${key}-body`,
      token.rows.map((row, index) =>
        element("tr", `${key}-row-${index}`, cells(row, `${key}-row-${index}`, "td")),
      ),
    ),
  ]);
}

function renderCode(token: Tokens.Code, key: string): PreviewElement {
  const language = token.lang?.trim().split(/\s+/u)[0]?.toLowerCase();
  const code = element("code", `${key}-code`, [token.text], {
    style: { padding: "0", backgroundColor: "transparent", color: "#cdd1d7", whiteSpace: "pre" },
    ...(language === undefined || language === "" ? {} : { attributes: { language } }),
  });
  if (language !== undefined && powerShellLanguages.has(language)) {
    return element(
      "figure",
      key,
      [
        element("figcaption", `${key}-label`, ["powershell"], { style: codeLabelStyle }),
        element("pre", `${key}-pre`, [code], {
          style: {
            border: "0",
            borderRadius: "0",
            margin: "0",
            padding: "11px 10px 12px",
            backgroundColor: "transparent",
          },
        }),
      ],
      { style: codeBlockStyle },
    );
  }
  return element("pre", key, [code]);
}

function element(
  tag: PreviewTag,
  key: string,
  children: readonly PreviewNode[],
  options: { readonly attributes?: PreviewAttributes; readonly style?: PreviewStyle } = {},
): PreviewElement {
  const style = { ...elementStyles[tag], ...options.style };
  return {
    key,
    tag,
    children,
    ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
    ...(Object.keys(style).length === 0 ? {} : { style }),
  };
}

function tokensOf(token: Token): readonly Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function resolveLink(href: string, sourceUri: string | null): string | null {
  if (href.startsWith("#")) return href;
  try {
    const url = sourceUri === null ? new URL(href) : new URL(href, sourceUri);
    if (
      !["file:", "http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== ""
    )
      return null;
    if (url.protocol === "file:") {
      url.search = "";
      url.hash = "";
    }
    return url.toString();
  } catch {
    return null;
  }
}
