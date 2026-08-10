import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown-renderer";

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

  it("resolves local document links against the preview source", () => {
    const html = staticMarkup("[Architecture](docs/ARCHITECTURE.md)", {
      sourceUri: "file:///D:/workspace/README.md",
      onOpenDocument: () => undefined,
    });

    expect(html).toContain('class="markdown-preview__document-link"');
    expect(html).toContain('href="file:///D:/workspace/docs/ARCHITECTURE.md"');
    expect(html).toContain(">Architecture</a>");
  });

  it("renders powershell fences as a simple labeled code block", () => {
    const html = staticMarkup("```powershell\nnpm install\nnpm run tauri dev\n```");

    expect(html).toContain('class="markdown-preview__code-block"');
    expect(html).toContain(
      '<figcaption class="markdown-preview__code-language">powershell</figcaption>',
    );
    expect(html).toContain('data-language="powershell"');
    expect(html).toContain("npm install");
    expect(html).toContain("npm run tauri dev");
    expect(html).not.toContain("PS&gt;");
    expect(html).not.toContain("```powershell");
  });
});

function staticMarkup(source: string, options?: Parameters<typeof renderMarkdown>[1]): string {
  return renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(source, options)));
}
