import { marked, type Token, type Tokens } from "marked";
import { createElement, Fragment, type ReactNode } from "react";
import { isDesktopRuntime, openExternalUrl } from "../../lib/backend";
import { fileUriToPath } from "../workspace/document-uri";

const CHECKED_SYMBOL = String.fromCodePoint(0x2611);
const UNCHECKED_SYMBOL = String.fromCodePoint(0x2610);

interface MarkdownRenderOptions {
  readonly sourceUri?: string | null;
  readonly onOpenDocument?: (path: string) => void;
}

interface MarkdownRenderContext {
  readonly sourceUri: string | null;
  readonly onOpenDocument: ((path: string) => void) | null;
}

export function renderMarkdown(
  content: string,
  options: MarkdownRenderOptions = {},
): readonly ReactNode[] {
  return renderTokens(marked.lexer(content, { gfm: true }), "root", {
    sourceUri: options.sourceUri ?? null,
    onOpenDocument: options.onOpenDocument ?? null,
  });
}

function renderTokens(
  tokens: readonly Token[],
  path: string,
  context: MarkdownRenderContext,
): readonly ReactNode[] {
  return tokens.map((token, index) => renderToken(token, `${path}-${index}`, context));
}

function renderToken(token: Token, key: string, context: MarkdownRenderContext): ReactNode {
  switch (token.type) {
    case "blockquote":
      return <blockquote key={key}>{renderTokens(tokensOf(token), key, context)}</blockquote>;
    case "br":
      return <br key={key} />;
    case "checkbox":
      return (
        <span className="markdown-preview__checkbox" aria-hidden="true" key={key}>
          {(token as Tokens.Checkbox).checked ? CHECKED_SYMBOL : UNCHECKED_SYMBOL}
        </span>
      );
    case "code": {
      const code = token as Tokens.Code;
      const language = codeLanguage(code.lang);
      if (isPowerShellLanguage(language)) {
        return <PowerShellCodeBlock code={code.text} key={key} />;
      }
      return (
        <pre key={key}>
          <code data-language={language ?? undefined}>{code.text}</code>
        </pre>
      );
    }
    case "codespan":
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;
    case "def":
    case "space":
      return null;
    case "del":
      return <del key={key}>{renderTokens(tokensOf(token), key, context)}</del>;
    case "em":
      return <em key={key}>{renderTokens(tokensOf(token), key, context)}</em>;
    case "escape":
      return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
    case "heading":
      return createElement(
        headingName((token as Tokens.Heading).depth),
        { key },
        renderTokens(tokensOf(token), key, context),
      );
    case "hr":
      return <hr key={key} />;
    case "html":
      return (
        <span className="markdown-preview__raw-html" key={key}>
          {(token as Tokens.HTML).text}
        </span>
      );
    case "image":
      return (
        <span
          className="markdown-preview__image-placeholder"
          key={key}
          title={(token as Tokens.Image).title ?? ""}
        >
          {(token as Tokens.Image).text || "Image"}
        </span>
      );
    case "link":
      return (
        <SafeLink
          context={context}
          href={(token as Tokens.Link).href}
          key={key}
          title={(token as Tokens.Link).title}
        >
          {renderTokens(tokensOf(token), key, context)}
        </SafeLink>
      );
    case "list":
      return renderList(token as Tokens.List, key, context);
    case "list_item":
      return renderListItem(token as Tokens.ListItem, key, context);
    case "paragraph":
      return <p key={key}>{renderTokens(tokensOf(token), key, context)}</p>;
    case "strong":
      return <strong key={key}>{renderTokens(tokensOf(token), key, context)}</strong>;
    case "table":
      return renderTable(token as Tokens.Table, key, context);
    case "text":
      return (
        <Fragment key={key}>
          {tokensOf(token).length === 0
            ? (token as Tokens.Text).text
            : renderTokens(tokensOf(token), key, context)}
        </Fragment>
      );
    default:
      return (
        <Fragment key={key}>
          {tokensOf(token).length === 0 ? token.raw : renderTokens(tokensOf(token), key, context)}
        </Fragment>
      );
  }
}

function tokensOf(token: Token): readonly Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderList(token: Tokens.List, key: string, context: MarkdownRenderContext): ReactNode {
  const children = token.items.map((item, index) =>
    renderListItem(item, `${key}-${index}`, context),
  );
  return token.ordered ? (
    <ol key={key} start={typeof token.start === "number" ? token.start : undefined}>
      {children}
    </ol>
  ) : (
    <ul key={key}>{children}</ul>
  );
}

function renderListItem(
  token: Tokens.ListItem,
  key: string,
  context: MarkdownRenderContext,
): ReactNode {
  return (
    <li key={key} className={token.task ? "markdown-preview__task" : undefined}>
      {token.task ? (
        <span className="markdown-preview__checkbox" aria-hidden="true">
          {token.checked ? CHECKED_SYMBOL : UNCHECKED_SYMBOL}
        </span>
      ) : null}
      {renderTokens(token.tokens, key, context)}
    </li>
  );
}

function renderTable(token: Tokens.Table, key: string, context: MarkdownRenderContext): ReactNode {
  return (
    <table key={key}>
      <thead>
        <tr>
          {withStableKeys(token.header, tableCellIdentity).map(({ value: cell, key: cellKey }) => (
            <th className={alignmentClass(cell.align)} key={`${key}-header-${cellKey}`}>
              {renderTokens(cell.tokens, `${key}-header-${cellKey}`, context)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {withStableKeys(token.rows, (row) => row.map(tableCellIdentity).join("|")).map(
          ({ value: row, key: rowKey }) => (
            <tr key={`${key}-row-${rowKey}`}>
              {withStableKeys(row, tableCellIdentity).map(({ value: cell, key: cellKey }) => (
                <td className={alignmentClass(cell.align)} key={`${key}-cell-${rowKey}-${cellKey}`}>
                  {renderTokens(cell.tokens, `${key}-cell-${rowKey}-${cellKey}`, context)}
                </td>
              ))}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function PowerShellCodeBlock({ code }: { readonly code: string }) {
  return (
    <figure className="markdown-preview__code-block">
      <figcaption className="markdown-preview__code-language">powershell</figcaption>
      <pre>
        <code data-language="powershell">{code}</code>
      </pre>
    </figure>
  );
}

function codeLanguage(value: string | undefined): string | null {
  const language = value?.trim().split(/\s+/u)[0]?.toLowerCase();
  return language === undefined || language === "" ? null : language;
}

function isPowerShellLanguage(language: string | null): boolean {
  return language !== null && ["powershell", "ps1", "pwsh"].includes(language);
}

function SafeLink({
  context,
  href,
  title,
  children,
}: {
  readonly context: MarkdownRenderContext;
  readonly href: string;
  readonly title: string | null | undefined;
  readonly children: ReactNode;
}) {
  if (href.startsWith("#")) {
    return (
      <a href={href} title={title ?? undefined}>
        {children}
      </a>
    );
  }
  if (isExternalUrl(href)) {
    return (
      <a
        className="markdown-preview__external-link"
        href={href}
        rel="noreferrer"
        title={title ?? undefined}
        onClick={(event) => {
          event.preventDefault();
          if (isDesktopRuntime()) {
            void openExternalUrl(href).catch((error: unknown) => {
              console.error("The external link could not be opened.", error);
            });
          }
        }}
      >
        {children}
      </a>
    );
  }
  const documentLink = resolveDocumentLink(href, context.sourceUri);
  if (documentLink !== null && context.onOpenDocument !== null) {
    return (
      <a
        className="markdown-preview__document-link"
        href={documentLink.uri}
        title={title ?? undefined}
        onClick={(event) => {
          event.preventDefault();
          context.onOpenDocument?.(documentLink.path);
        }}
      >
        {children}
      </a>
    );
  }
  return <span className="markdown-preview__unsafe-link">{children}</span>;
}

function resolveDocumentLink(href: string, sourceUri: string | null): DocumentLink | null {
  if (sourceUri === null) {
    return null;
  }
  try {
    const resolved = new URL(href, sourceUri);
    if (resolved.protocol !== "file:") {
      return null;
    }
    resolved.hash = "";
    resolved.search = "";
    const path = fileUriToPath(resolved.toString());
    return path === null ? null : { uri: resolved.toString(), path };
  } catch {
    return null;
  }
}

interface DocumentLink {
  readonly uri: string;
  readonly path: string;
}

function isExternalUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function headingName(depth: number): "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  switch (depth) {
    case 1:
      return "h1";
    case 2:
      return "h2";
    case 3:
      return "h3";
    case 4:
      return "h4";
    case 5:
      return "h5";
    default:
      return "h6";
  }
}

function alignmentClass(alignment: Tokens.TableCell["align"]): string | undefined {
  return alignment === null ? undefined : `markdown-preview__align-${alignment}`;
}

function tableCellIdentity(cell: Tokens.TableCell): string {
  return `${cell.align ?? "default"}:${cell.text}`;
}

function withStableKeys<Value>(
  values: readonly Value[],
  identity: (value: Value) => string,
): readonly { readonly value: Value; readonly key: string }[] {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const base = hash(identity(value));
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { value, key: `${base}-${occurrence}` };
  });
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}
