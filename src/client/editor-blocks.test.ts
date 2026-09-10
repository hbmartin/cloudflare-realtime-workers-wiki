// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowedEmbedUrl,
  editorBlockFactories,
  LinkedDiagramView,
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

  it("renders an empty linked diagram inertly when the editor is read-only", () => {
    render(createElement(LinkedDiagramView, { pageId: "", title: "System map" }));

    expect(screen.getByText(/System map unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not leave an open linked-diagram picker interactive after becoming read-only", () => {
    const view = render(
      createElement(LinkedDiagramView, {
        pageId: "diagram-one",
        title: "System map",
        update: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("textbox", { name: "Find a diagram" })).toBeInTheDocument();

    view.rerender(createElement(LinkedDiagramView, { pageId: "diagram-one", title: "System map" }));

    expect(screen.queryByRole("textbox", { name: "Find a diagram" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
