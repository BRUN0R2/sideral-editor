import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./MarkdownPreview";

describe("renderMarkdown", () => {
  it("renders modern GFM structures", () => {
    const html = staticMarkup("# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n`code`");

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>code</code>");
  });

  it("removes executable HTML, remote images and unsafe URLs", () => {
    const html = staticMarkup(`
<script>alert(1)</script>
<img src="https://tracking.example/pixel" onerror="alert(2)">
[unsafe](javascript:alert(3))
<p style="position:fixed">Safe text</p>
`);

    expect(html).not.toMatch(/<script|<img|href="javascript:/iu);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Safe text");
  });
});

function staticMarkup(source: string): string {
  return renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(source)));
}
