import { marked, type Token, type Tokens } from "marked";
import { createElement, Fragment, type ReactNode, useMemo } from "react";
import { IconButton } from "../../components/IconButton";
import { isDesktopRuntime, openExternalUrl } from "../../lib/backend";
import { useI18n } from "../i18n/I18nProvider";
import type { PreviewDocumentView } from "./contracts";

const CHECKED_SYMBOL = String.fromCodePoint(0x2611);
const UNCHECKED_SYMBOL = String.fromCodePoint(0x2610);

export function MarkdownPreview({
  preview,
  content,
  onClose,
}: {
  readonly preview: PreviewDocumentView;
  readonly content: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const document = useMemo(() => renderMarkdown(content), [content]);

  return (
    <aside className="markdown-preview" aria-label={preview.title}>
      <header className="markdown-preview__header">
        <div>
          <span>{preview.title}</span>
          <small>Markdown</small>
        </div>
        <IconButton label={t("action.close")} icon="close" onClick={onClose} />
      </header>
      <article className="markdown-preview__document">{document}</article>
    </aside>
  );
}

export function renderMarkdown(content: string): readonly ReactNode[] {
  return renderTokens(marked.lexer(content, { gfm: true }), "root");
}

function renderTokens(tokens: readonly Token[], path: string): readonly ReactNode[] {
  return tokens.map((token, index) => renderToken(token, `${path}-${index}`));
}

function renderToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "blockquote":
      return <blockquote key={key}>{renderTokens(tokensOf(token), key)}</blockquote>;
    case "br":
      return <br key={key} />;
    case "checkbox":
      return (
        <span className="markdown-preview__checkbox" aria-hidden="true" key={key}>
          {(token as Tokens.Checkbox).checked ? CHECKED_SYMBOL : UNCHECKED_SYMBOL}
        </span>
      );
    case "code":
      return (
        <pre key={key}>
          <code data-language={(token as Tokens.Code).lang}>{(token as Tokens.Code).text}</code>
        </pre>
      );
    case "codespan":
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;
    case "def":
    case "space":
      return null;
    case "del":
      return <del key={key}>{renderTokens(tokensOf(token), key)}</del>;
    case "em":
      return <em key={key}>{renderTokens(tokensOf(token), key)}</em>;
    case "escape":
      return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
    case "heading":
      return createElement(
        headingName((token as Tokens.Heading).depth),
        { key },
        renderTokens(tokensOf(token), key),
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
        <SafeLink href={(token as Tokens.Link).href} key={key} title={(token as Tokens.Link).title}>
          {renderTokens(tokensOf(token), key)}
        </SafeLink>
      );
    case "list":
      return renderList(token as Tokens.List, key);
    case "list_item":
      return renderListItem(token as Tokens.ListItem, key);
    case "paragraph":
      return <p key={key}>{renderTokens(tokensOf(token), key)}</p>;
    case "strong":
      return <strong key={key}>{renderTokens(tokensOf(token), key)}</strong>;
    case "table":
      return renderTable(token as Tokens.Table, key);
    case "text":
      return (
        <Fragment key={key}>
          {tokensOf(token).length === 0
            ? (token as Tokens.Text).text
            : renderTokens(tokensOf(token), key)}
        </Fragment>
      );
    default:
      return (
        <Fragment key={key}>
          {tokensOf(token).length === 0 ? token.raw : renderTokens(tokensOf(token), key)}
        </Fragment>
      );
  }
}

function tokensOf(token: Token): readonly Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderList(token: Tokens.List, key: string): ReactNode {
  const children = token.items.map((item, index) => renderListItem(item, `${key}-${index}`));
  return token.ordered ? (
    <ol key={key} start={typeof token.start === "number" ? token.start : undefined}>
      {children}
    </ol>
  ) : (
    <ul key={key}>{children}</ul>
  );
}

function renderListItem(token: Tokens.ListItem, key: string): ReactNode {
  return (
    <li key={key} className={token.task ? "markdown-preview__task" : undefined}>
      {token.task ? (
        <span className="markdown-preview__checkbox" aria-hidden="true">
          {token.checked ? CHECKED_SYMBOL : UNCHECKED_SYMBOL}
        </span>
      ) : null}
      {renderTokens(token.tokens, key)}
    </li>
  );
}

function renderTable(token: Tokens.Table, key: string): ReactNode {
  return (
    <table key={key}>
      <thead>
        <tr>
          {withStableKeys(token.header, tableCellIdentity).map(({ value: cell, key: cellKey }) => (
            <th className={alignmentClass(cell.align)} key={`${key}-header-${cellKey}`}>
              {renderTokens(cell.tokens, `${key}-header-${cellKey}`)}
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
                  {renderTokens(cell.tokens, `${key}-cell-${rowKey}-${cellKey}`)}
                </td>
              ))}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function SafeLink({
  href,
  title,
  children,
}: {
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
  if (!isExternalUrl(href)) {
    return <span className="markdown-preview__unsafe-link">{children}</span>;
  }
  return (
    <a
      href={href}
      rel="noreferrer"
      title={title ?? undefined}
      onClick={(event) => {
        event.preventDefault();
        if (isDesktopRuntime()) {
          void openExternalUrl(href);
        }
      }}
    >
      {children}
    </a>
  );
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
