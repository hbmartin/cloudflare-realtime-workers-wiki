// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RenderBoundary } from "./RenderBoundary";
import { PageInfoPopover } from "./PageInfoPopover";
import { subscribeCardPreview } from "./card-preview-pool";
import { useNearViewport } from "./near-viewport";
import { LinkedTableView } from "./LinkedTableView";
import { EditorFeatureContext } from "./editor-feature-context";

const mocks = vi.hoisted(() => ({ api: vi.fn(), report: vi.fn() }));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: mocks.api }));
vi.mock("./telemetry", () => ({ reportClientError: mocks.report }));
vi.mock("./CollaborativeTablePage", () => ({
  CollaborativeTablePage: ({ onViewChanged }: { onViewChanged: (id: string) => void }) => (
    <button type="button" onClick={() => onViewChanged("different-view")}>
      Switch saved view
    </button>
  ),
}));
function Bomb({ fail }: { fail: boolean }) {
  if (fail) throw new Error("broken renderer");
  return <p>Loaded document</p>;
}
function ViewportHarness() {
  const { ref, ready } = useNearViewport();
  return (
    <div ref={ref}>
      <input aria-label="Editable source" />
      <output>{ready ? "active" : "deferred"}</output>
    </div>
  );
}

describe("editor containment and disposable previews", () => {
  it("keeps viewer saved-view changes local and persists an editor's host pointer", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const update = vi.fn();
    const context = { hostId: "host", member: { role: "viewer" } as never, onSelectPage: vi.fn() };
    const content = (editable: boolean) => (
      <EditorFeatureContext.Provider value={context}>
        <LinkedTableView
          tablePageId="source"
          viewId="original-view"
          title="Source"
          editable={editable}
          update={update}
        />
      </EditorFeatureContext.Provider>
    );
    try {
      const view = render(content(false));
      fireEvent.click(screen.getByRole("button", { name: "Switch saved view" }));
      expect(update).not.toHaveBeenCalled();
      view.rerender(content(true));
      fireEvent.click(screen.getByRole("button", { name: "Switch saved view" }));
      expect(update).toHaveBeenCalledWith({ tablePageId: "source", viewId: "different-view", title: "Source" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("retains explicit recovery actions and resets failed renderers on page change", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const history = vi.fn(),
      recovery = vi.fn();
    try {
      const view = render(
        <RenderBoundary resetKey="first" onHistory={history} onExport={recovery}>
          <Bomb fail />
        </RenderBoundary>,
      );
      expect(screen.getByRole("alert")).toContainElement(
        screen.getByRole("button", { name: "Download recovery copy" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Open version history" }));
      fireEvent.click(screen.getByRole("button", { name: "Download recovery copy" }));
      expect(history).toHaveBeenCalledOnce();
      expect(recovery).toHaveBeenCalledOnce();
      expect(mocks.report).toHaveBeenCalledWith("client.render_failed", expect.any(Error));
      view.rerender(
        <RenderBoundary resetKey="second">
          <Bomb fail={false} />
        </RenderBoundary>,
      );
      expect(screen.getByText("Loaded document")).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });
  it("loads contributor pages without duplicate members and states partial attribution", async () => {
    const info = {
      id: "page",
      createdAt: 1,
      updatedAt: 2,
      createdBy: { id: "a", name: "Alice" },
      lastEditedBy: null,
      contributors: [{ id: "a", name: "Alice", firstEditedAt: 1, lastEditedAt: 2 }],
      nextCursor: "more",
      contributorHistorySince: 1,
      wordCount: 42,
      wordCountComplete: true,
      contributorHistoryComplete: false,
      contributorAttribution: "authenticated_uploaders",
    };
    mocks.api.mockReset();
    mocks.api.mockResolvedValueOnce(info).mockResolvedValueOnce({
      ...info,
      nextCursor: null,
      contributors: [...info.contributors, { id: "b", name: "Bob", firstEditedAt: 2, lastEditedAt: 3 }],
    });
    render(<PageInfoPopover pageId="page" />);
    fireEvent.click(screen.getByRole("button", { name: "Page info" }));
    await screen.findByText("42 words");
    expect(screen.getByText(/Partial contributor history/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More contributors" }));
    await screen.findByText(/Bob ·/);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(mocks.api.mock.calls[1]![0]).toBe("/api/pages/page/info?cursor=more");
    expect(screen.getByText(/member who synced/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close page info" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("pools source reads and drops cached metadata on a revoked source", async () => {
    mocks.api.mockReset();
    mocks.api
      .mockResolvedValueOnce({ page: { id: "target", title: "Secret title", kind: "document" }, text: "Preview" })
      .mockRejectedValueOnce(new Error("denied"));
    const first = vi.fn(),
      second = vi.fn();
    const stopFirst = subscribeCardPreview("account", "target", null, first);
    const stopSecond = subscribeCardPreview("account", "target", null, second);
    try {
      await waitFor(() => expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok" })));
      expect(mocks.api).toHaveBeenCalledOnce();
      window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: { type: "workspace-invalidated" } }));
      expect(first).toHaveBeenLastCalledWith({ status: "loading", preview: null });
      await waitFor(() => expect(second).toHaveBeenLastCalledWith({ status: "unavailable", preview: null }));
    } finally {
      stopFirst();
      stopSecond();
    }
  });
  it("defers offscreen renderers and protects focus and IME composition", () => {
    let callback: IntersectionObserverCallback | undefined, target: Element | undefined;
    class Observer {
      constructor(receive: IntersectionObserverCallback) {
        callback = receive;
      }
      observe(element: Element) {
        target = element;
      }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    try {
      render(<ViewportHarness />);
      expect(screen.getByText("deferred")).toBeVisible();
      const intersect = (isIntersecting: boolean) =>
        act(() => callback!([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
      intersect(true);
      expect(screen.getByText("active")).toBeVisible();
      const input = screen.getByRole("textbox");
      act(() => input.focus());
      intersect(false);
      expect(screen.getByText("active")).toBeVisible();
      fireEvent.compositionStart(input);
      act(() => input.blur());
      expect(screen.getByText("active")).toBeVisible();
      act(() => {
        document.getSelection()?.removeAllRanges();
        document.dispatchEvent(new Event("selectionchange"));
      });
      fireEvent.compositionEnd(input);
      expect(screen.getByText("deferred")).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
