// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowedEmbedUrl,
  editorBlockFactories,
  MermaidBlock,
  renderedMath,
  safeBookmarkUrl,
  safePdfUrl,
  unsyncTransclusion,
} from "./editor-blocks";

const renderMermaid = vi.hoisted(() => vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` })));

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMermaid } }));

describe("core editor blocks", () => {
  beforeEach(() => renderMermaid.mockClear());

  it("renders untrusted math without enabling dangerous commands", () => {
    const html = renderedMath(String.raw`\href{javascript:alert(1)}{bad}`, false);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("katex");
  });

  it("embeds only explicit providers and turns ordinary web URLs into bookmarks", () => {
    expect(allowedEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(allowedEmbedUrl("https://example.com/video")).toBeNull();
    expect(safeBookmarkUrl("https://example.com/video")).toBe("https://example.com/video");
    expect(safeBookmarkUrl("javascript:alert(1)")).toBeNull();
  });

  it("accepts only canonical HTTP and HTTPS URLs for PDF frames", () => {
    expect(safePdfUrl(" https://example.com/manual.pdf ")).toBe("https://example.com/manual.pdf");
    expect(safePdfUrl("http://localhost/manual.pdf")).toBe("http://localhost/manual.pdf");
    expect(safePdfUrl("mailto:owner@example.test")).toBeNull();
    expect(safePdfUrl("javascript:alert(1)")).toBeNull();
    expect(safePdfUrl("/api/attachments/file-id")).toBeNull();
  });

  it("uses a fresh Mermaid DOM id for every render invocation", async () => {
    const view = render(createElement(MermaidBlock, { source: "flowchart LR; A-->B" }));
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledOnce());
    view.rerender(createElement(MermaidBlock, { source: "flowchart LR; A-->C" }));

    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
    expect(new Set(renderMermaid.mock.calls.map(([id]) => id))).toHaveProperty("size", 2);
  });

  it("does not offer a synced reference until a source picker can configure it", () => {
    expect(editorBlockFactories.map((item) => item.type)).not.toContain("syncedBlockReference");
  });

  it("parses synced HTML back into structured blocks when unsyncing", () => {
    const parsed = [{ type: "heading", content: [{ type: "text", text: "Styled", styles: { bold: true } }] }];
    const editor = {
      tryParseHTMLToBlocks: vi.fn(() => parsed),
      replaceBlocks: vi.fn(),
    };
    const reference = { id: "reference" };
    const html = "<h2><strong>Styled</strong></h2>";

    unsyncTransclusion(editor, reference, html);

    expect(editor.tryParseHTMLToBlocks).toHaveBeenCalledWith(html);
    expect(editor.replaceBlocks).toHaveBeenCalledWith([reference], parsed);
  });
});
