// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "../shared/types";
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
const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMermaid } }));
vi.mock("./api", () => ({
  api: mocks.api,
  apiErrorMessage: (_cause: unknown, fallback: string) => fallback,
  json: (value: unknown) => JSON.stringify(value),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("core editor blocks", () => {
  beforeEach(() => {
    renderMermaid.mockClear();
    mocks.api.mockReset();
  });

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

  it("does not link a newly created diagram after the block becomes read-only", async () => {
    const request = deferred<{ page: Page }>();
    const update = vi.fn();
    mocks.api.mockImplementation((_path: string, init?: RequestInit) =>
      init?.method === "POST" ? request.promise : Promise.resolve({}),
    );
    const view = render(createElement(LinkedDiagramView, { pageId: "", title: "", update }));

    fireEvent.click(screen.getByRole("button", { name: /Create child diagram/ }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    view.rerender(createElement(LinkedDiagramView, { pageId: "", title: "" }));
    await act(async () => {
      request.resolve({ page: { id: "diagram-one", title: "System map" } as Page });
      await request.promise;
    });

    expect(update).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenLastCalledWith("/api/pages/diagram-one", { method: "DELETE" });
    expect(await screen.findByRole("alert")).toHaveTextContent("discarded because this block became read-only");
  });

  it("does not archive a newly created diagram merely because the block unmounted", async () => {
    const request = deferred<{ page: Page }>();
    const update = vi.fn();
    mocks.api.mockImplementation(() => request.promise);
    const view = render(createElement(LinkedDiagramView, { pageId: "", title: "", update }));

    fireEvent.click(screen.getByRole("button", { name: /Create child diagram/ }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => {
      request.resolve({ page: { id: "diagram-one", title: "System map" } as Page });
      await request.promise;
    });

    expect(update).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledOnce();
  });
});
