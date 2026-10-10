import type { PreviewElement, PreviewNode } from "@sideral/extension-sdk";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdownRenderer";

describe("Markdown Preview rendering", () => {
  it("renders GFM headings, tables and inline code", () => {
    const elements = flatten(
      renderMarkdown("# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n`code`"),
    );
    expect(elements.map((element) => element.tag)).toEqual(
      expect.arrayContaining(["h1", "table", "code"]),
    );
    expect(elements.find((element) => element.tag === "h1")?.children).toEqual(["Title"]);
  });

  it("keeps HTML inert and never creates remote images or executable links", () => {
    const content = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src="https://tracking.example/pixel" onerror="alert(2)">\n\n[unsafe](javascript:alert(3))\n\n<p style="position:fixed">Safe text</p>',
    );
    const elements = flatten(content);
    expect(elements.some((element) => ["script", "img"].includes(element.tag))).toBe(false);
    expect(elements.some((element) => element.attributes?.href?.startsWith("javascript:"))).toBe(
      false,
    );
    expect(JSON.stringify(content)).toContain("<script>");
    expect(JSON.stringify(content)).toContain("Safe text");
    expect(
      flatten(renderMarkdown("![Tracking](https://tracking.example/pixel)")).every(
        (element) => element.tag !== "a",
      ),
    ).toBe(true);
  });

  it("resolves local document links against the source URI", () => {
    const elements = flatten(
      renderMarkdown("[Architecture](docs/ARCHITECTURE.md)", "file:///D:/workspace/README.md"),
    );
    expect(elements.find((element) => element.tag === "a")?.attributes?.href).toBe(
      "file:///D:/workspace/docs/ARCHITECTURE.md",
    );
  });

  it("renders PowerShell fences as inert labeled code", () => {
    const elements = flatten(renderMarkdown("```powershell\nnpm install\nnpm run tauri dev\n```"));
    expect(elements.find((element) => element.tag === "figcaption")?.children).toEqual([
      "powershell",
    ]);
    expect(elements.find((element) => element.tag === "code")).toMatchObject({
      attributes: { language: "powershell" },
      children: ["npm install\nnpm run tauri dev"],
    });
  });
});

function flatten(nodes: readonly PreviewNode[]): readonly PreviewElement[] {
  return nodes.flatMap((node) =>
    typeof node === "string" ? [] : [node, ...flatten(node.children)],
  );
}
