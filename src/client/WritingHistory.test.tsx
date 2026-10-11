// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useLayoutEffect } from "react";
import type { AiConversation } from "../shared/ai";
import { WritingHistory } from "./WritingHistory";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: mocks.api }));
type HistoryPage = { conversations: AiConversation[]; nextCursor: string | null };
function item(id: string, title = id, locked = false): AiConversation {
  return { id, title, pageId: "doc", locked, updatedAt: 1, expiresAt: Date.now() + 86400000 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await act(async () => vi.advanceTimersByTimeAsync(200));
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.api.mockReset();
  mocks.api.mockResolvedValue({ conversations: [], nextCursor: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("writing history refresh", () => {
  it("revalidates loaded pages with fresh cursors and updates titles, deletions and locks", async () => {
    let refreshed = false;
    mocks.api.mockImplementation(async (path: string) => {
      const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
      if (!refreshed)
        return cursor
          ? { conversations: [item("second"), item("deleted")], nextCursor: "old-third" }
          : { conversations: [item("first")], nextCursor: "old-second" };
      if (!cursor) return { conversations: [item("first", "Updated title")], nextCursor: "fresh-second" };
      expect(cursor).toBe("fresh-second");
      return {
        conversations: [item("first", "Updated title"), item("second", "Locked conversation", true)],
        nextCursor: "fresh-third",
      };
    });
    const onOpen = vi.fn();
    const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "retained query" } });
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    expect(screen.getByRole("button", { name: "deleted" })).toBeVisible();
    refreshed = true;
    view.rerender(<WritingHistory pageId="doc" onOpen={onOpen} refreshVersion={1} />);
    await settle();
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toHaveValue("retained query");
    expect(screen.getAllByRole("button", { name: "Updated title" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Locked conversation" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "deleted" })).toBeNull();
    expect(screen.getByRole("button", { name: "Load more conversations" })).toBeEnabled();
    expect(mocks.api).toHaveBeenCalledTimes(4);
    expect(
      mocks.api.mock.calls
        .slice(-2)
        .map(([path]) => new URL(String(path), "https://example.test").searchParams.get("q")),
    ).toEqual(["retained query", "retained query"]);
  });

  it("commits a refresh only after every loaded page succeeds and retains depth after failure", async () => {
    let refreshed = false,
      failSecond = true;
    mocks.api.mockImplementation(async (path: string) => {
      const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
      if (!refreshed)
        return { conversations: [item(cursor ? "second" : "first")], nextCursor: cursor ? "old-third" : "old-second" };
      if (!cursor) return { conversations: [item("new-first")], nextCursor: "fresh-second" };
      if (failSecond) throw new TypeError("Offline");
      return { conversations: [item("new-second")], nextCursor: "fresh-third" };
    });
    const onOpen = vi.fn();
    const view = render(<WritingHistory onOpen={onOpen} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    refreshed = true;
    view.rerender(<WritingHistory onOpen={onOpen} refreshVersion={1} />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("History needs a network connection.");
    expect(screen.getByRole("button", { name: "first" })).toBeVisible();
    expect(screen.getByRole("button", { name: "second" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "new-first" })).toBeNull();
    expect(screen.getByRole("button", { name: "Load more conversations" })).toBeEnabled();
    failSecond = false;
    view.rerender(<WritingHistory onOpen={onOpen} refreshVersion={2} />);
    await settle();
    expect(screen.getByRole("button", { name: "new-second" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(6);
  });

  it("reduces loaded depth when refreshed history ends early", async () => {
    mocks.api
      .mockResolvedValueOnce({ conversations: [item("first")], nextCursor: "second" })
      .mockResolvedValueOnce({ conversations: [item("second")], nextCursor: "third" })
      .mockResolvedValue({ conversations: [item("only")], nextCursor: null });
    const onOpen = vi.fn();
    const view = render(<WritingHistory onOpen={onOpen} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    view.rerender(<WritingHistory onOpen={onOpen} refreshVersion={1} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Load more conversations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "second" })).toBeNull();
    expect(screen.getByRole("button", { name: "only" })).toBeVisible();
    expect(mocks.api).toHaveBeenCalledTimes(3);
  });

  it.each(["query", "document", "refresh", "dispose"])(
    "aborts and ignores pending Load more after %s",
    async (boundary) => {
      const stale = deferred<HistoryPage>();
      mocks.api
        .mockResolvedValueOnce({ conversations: [item("first")], nextCursor: "second" })
        .mockImplementationOnce(() => stale.promise)
        .mockResolvedValue({ conversations: [item("fresh")], nextCursor: null });
      const onOpen = vi.fn();
      const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
      await settle();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
      const signal = (mocks.api.mock.calls[1]![1] as RequestInit).signal!;
      if (boundary === "query") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new query" } });
      else if (boundary === "dispose") view.unmount();
      else
        view.rerender(
          <WritingHistory pageId={boundary === "document" ? "other" : "doc"} onOpen={onOpen} refreshVersion={1} />,
        );
      expect(signal.aborted).toBe(true);
      if (boundary !== "dispose") await settle();
      await act(async () => stale.resolve({ conversations: [item("obsolete")], nextCursor: "obsolete-next" }));
      expect(screen.queryByRole("button", { name: "obsolete" })).toBeNull();
      expect(screen.queryByRole("button", { name: "fresh" })?.textContent ?? null).toBe(
        boundary === "dispose" ? null : "fresh",
      );
      expect(screen.queryByRole("button", { name: "Load more conversations" })).toBeNull();
    },
  );

  it("rejects an older full refresh even when it finishes after the replacement", async () => {
    const stale = deferred<HistoryPage>();
    mocks.api
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({ conversations: [item("fresh")], nextCursor: null });
    const onOpen = vi.fn();
    const view = render(<WritingHistory onOpen={onOpen} />);
    await settle();
    const signal = (mocks.api.mock.calls[0]![1] as RequestInit).signal!;
    view.rerender(<WritingHistory onOpen={onOpen} refreshVersion={1} />);
    await settle();
    expect(signal.aborted).toBe(true);
    await act(async () => stale.resolve({ conversations: [item("obsolete")], nextCursor: "old" }));
    expect(screen.getByRole("button", { name: "fresh" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "obsolete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more conversations" })).toBeNull();
  });

  it("resets loaded depth for a new search and document", async () => {
    mocks.api.mockResolvedValue({ conversations: [item("first")], nextCursor: "next" });
    const onOpen = vi.fn();
    const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new search" } });
    await settle();
    expect(mocks.api).toHaveBeenCalledTimes(3);
    expect(new URL(String(mocks.api.mock.calls[2]![0]), "https://example.test").searchParams.get("cursor")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    view.rerender(<WritingHistory pageId="other" onOpen={onOpen} />);
    await settle();
    expect(mocks.api).toHaveBeenCalledTimes(5);
    expect(new URL(String(mocks.api.mock.calls[4]![0]), "https://example.test").searchParams.get("pageId")).toBe(
      "other",
    );
  });
  it.each(["query", "document"])(
    "resets completed and requested depth after a debounced %s round-trip",
    async (boundary) => {
      const stale = deferred<HistoryPage>();
      let reads = 0;
      mocks.api.mockImplementation((url: string) => {
        if (++reads === 3) return stale.promise;
        const cursor = new URL(url, "https://example.test").searchParams.get("cursor");
        return Promise.resolve({
          conversations: [item(cursor ? "second" : "first")],
          nextCursor: cursor ? "third" : "second",
        });
      });
      const onOpen = vi.fn();
      const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
      await settle();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
      const signal = (mocks.api.mock.calls[2]![1] as RequestInit).signal!;
      if (boundary === "query") {
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "other query" } });
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
      } else {
        view.rerender(<WritingHistory pageId="other" onOpen={onOpen} />);
        view.rerender(<WritingHistory pageId="doc" onOpen={onOpen} />);
      }
      expect(signal.aborted).toBe(true);
      await settle();
      expect(reads).toBe(4);
      expect(screen.getByRole("button", { name: "first" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "second" })).toBeNull();
      await act(async () => stale.resolve({ conversations: [item("obsolete-third")], nextCursor: null }));
      expect(screen.queryByRole("button", { name: "obsolete-third" })).toBeNull();
      expect(screen.getByRole("button", { name: "Load more conversations" })).toBeEnabled();
    },
  );
});

describe("writing deletion recovery", () => {
  it.each(["refresh", "query", "document"])(
    "coordinates the scheduled %s load with deletion before the debounce",
    async (boundary) => {
      const deleted = deferred<{ ok: boolean }>(),
        refreshed = deferred<HistoryPage>();
      let reads = 0;
      mocks.api.mockImplementation((_url: string, options?: RequestInit) => {
        if (options?.method === "DELETE") return deleted.promise;
        return ++reads === 1
          ? Promise.resolve({ conversations: [item("to-delete")], nextCursor: null })
          : refreshed.promise;
      });
      const onOpen = vi.fn();
      const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
      await settle();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete to-delete" })));
      if (boundary === "query") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new query" } });
      else
        view.rerender(
          <WritingHistory pageId={boundary === "document" ? "other" : "doc"} onOpen={onOpen} refreshVersion={1} />,
        );
      await act(async () => vi.advanceTimersByTimeAsync(100));
      await act(async () => deleted.resolve({ ok: true }));
      expect(reads).toBe(boundary === "document" ? 1 : 2);
      if (boundary === "document") await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(reads).toBe(2);
      const [url, options] = mocks.api.mock.calls.at(-1)!;
      const current = new URL(String(url), "https://example.test");
      expect(current.searchParams.get("q")).toBe(boundary === "query" ? "new query" : "");
      expect(current.searchParams.get("pageId")).toBe(boundary === "document" ? "other" : "doc");
      const signal = (options as RequestInit).signal!;
      await settle();
      expect(reads).toBe(2);
      expect(signal.aborted).toBe(false);
      expect(screen.getByText("Loading conversations…")).toBeVisible();
      await act(async () => refreshed.resolve({ conversations: [item("retained")], nextCursor: null }));
      expect(screen.getByRole("button", { name: "Delete retained" })).toBeEnabled();
      expect(screen.queryByText("Loading conversations…")).toBeNull();
    },
  );

  it.each(["query", "document"])("clears a deletion error when the %s changes", async (boundary) => {
    mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === "DELETE") throw new TypeError("Deletion failed");
      return { conversations: [item("retained")], nextCursor: null };
    });
    const onOpen = vi.fn();
    const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete retained" })));
    expect(screen.getByRole("alert")).toHaveTextContent("History could not be deleted.");
    if (boundary === "query") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new query" } });
    else view.rerender(<WritingHistory pageId="other" onOpen={onOpen} />);
    expect(screen.queryByRole("alert")).toBeNull();
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["query", "document", "round trip"])("ignores a late deletion failure after a scope %s", async (boundary) => {
    const deleted = deferred<{ ok: boolean }>();
    mocks.api.mockImplementation((_url: string, options?: RequestInit) =>
      options?.method === "DELETE"
        ? deleted.promise
        : Promise.resolve({ conversations: [item("retained")], nextCursor: null }),
    );
    const onOpen = vi.fn();
    const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete retained" })));
    if (boundary === "document") view.rerender(<WritingHistory pageId="other" onOpen={onOpen} />);
    else {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new query" } });
      if (boundary === "round trip") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    }
    await settle();
    await act(async () => deleted.reject(new TypeError("Deletion failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete retained" })).toBeEnabled();
  });

  it("shows list and deletion errors independently and dismisses only the deletion error", async () => {
    mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === "DELETE") throw new TypeError("Deletion failed");
      return { conversations: [item("retained")], nextCursor: null };
    });
    const onOpen = vi.fn();
    const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete retained" })));
    mocks.api.mockRejectedValueOnce(new TypeError("List failed"));
    view.rerender(<WritingHistory pageId="doc" onOpen={onOpen} refreshVersion={1} />);
    await settle();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByText("History could not be deleted.")).toBeVisible();
    expect(screen.getByText("History needs a network connection.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss deletion error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("History needs a network connection.");
    view.rerender(<WritingHistory pageId="doc" onOpen={onOpen} refreshVersion={2} />);
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("writing history deletion", () => {
  it.each(["single", "all"])("reconciles %s deletion after history remounts before DELETE settles", async (kind) => {
    const deleted = deferred<{ ok: boolean }>();
    let committed = false,
      reads = 0;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.api.mockImplementation((_path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return deleted.promise;
      reads++;
      return Promise.resolve({
        conversations: committed ? (kind === "all" ? [] : [item("retained")]) : [item("to-delete"), item("retained")],
        nextCursor: null,
      });
    });
    const view = render(<WritingHistory onOpen={vi.fn()} />);
    await settle();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: kind === "all" ? "Delete all my conversations" : "Delete to-delete" }),
      ),
    );
    expect(mocks.api.mock.calls[1]![0]).toBe(`/api/ai/conversations${kind === "all" ? "" : "/to-delete"}`);
    view.unmount();
    render(<WritingHistory onOpen={vi.fn()} />);
    await settle();
    expect(reads).toBe(2);
    expect(screen.getByRole("button", { name: "to-delete" })).toBeVisible();
    committed = true;
    await act(async () => deleted.resolve({ ok: true }));
    await settle();
    expect(reads).toBe(3);
    expect(screen.queryByRole("button", { name: "to-delete" })).toBeNull();
    expect(screen.queryByText("No conversations found.") !== null).toBe(kind === "all");
    expect(screen.queryByRole("button", { name: "retained" }) !== null).toBe(kind !== "all");
  });

  it.each(["success", "failure"])("notifies mounted history views only after deletion %s", async (outcome) => {
    const deleted = deferred<{ ok: boolean }>();
    let committed = false;
    const reads: string[] = [];
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return deleted.promise;
      reads.push(path);
      return Promise.resolve({ conversations: committed ? [item("retained")] : [item("to-delete")], nextCursor: null });
    });
    const documentView = render(<WritingHistory pageId="doc" onOpen={vi.fn()} />);
    const libraryView = render(<WritingHistory onOpen={vi.fn()} />);
    const documentHistory = within(documentView.container),
      libraryHistory = within(libraryView.container);
    fireEvent.change(libraryHistory.getByRole("searchbox"), { target: { value: "retained query" } });
    await settle();
    expect(reads).toHaveLength(2);
    await act(async () => fireEvent.click(documentHistory.getByRole("button", { name: "Delete to-delete" })));
    committed = outcome === "success";
    await act(async () =>
      outcome === "success" ? deleted.resolve({ ok: true }) : deleted.reject(new TypeError("Deletion failed")),
    );
    await settle();
    expect(reads).toHaveLength(outcome === "success" ? 4 : 2);
    expect(libraryHistory.getByRole("searchbox")).toHaveValue("retained query");
    expect(
      documentHistory.getByRole("button", { name: outcome === "success" ? "retained" : "to-delete" }),
    ).toBeVisible();
    expect(
      libraryHistory.getByRole("button", { name: outcome === "success" ? "retained" : "to-delete" }),
    ).toBeVisible();
    expect(
      documentHistory.queryByRole("button", { name: outcome === "success" ? "to-delete" : "retained" }),
    ).toBeNull();
    expect(libraryHistory.queryByRole("button", { name: outcome === "success" ? "to-delete" : "retained" })).toBeNull();
    expect(reads.slice(-2).map((path) => new URL(path, "https://example.test").searchParams.get("pageId"))).toEqual([
      "doc",
      null,
    ]);
    expect(new URL(reads.at(-1)!, "https://example.test").searchParams.get("q")).toBe("retained query");
    expect(documentHistory.queryByRole("alert") !== null).toBe(outcome === "failure");
    expect(documentHistory.queryByRole("alert")?.textContent ?? "").toContain(
      outcome === "failure" ? "History could not be deleted." : "",
    );
    expect(libraryHistory.queryByRole("alert")).toBeNull();
  });

  it.each(["refresh", "query", "document"])("coordinates the pending %s reload with deletion", async (boundary) => {
    const deleted = deferred<{ ok: boolean }>(),
      refreshed = deferred<HistoryPage>();
    let committed = false,
      reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return deleted.promise;
      const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
      reads++;
      if (!committed)
        return Promise.resolve({
          conversations: [item(cursor ? "second" : "to-delete")],
          nextCursor: cursor ? "old-third" : "old-second",
        });
      return cursor
        ? Promise.resolve({ conversations: [item("second")], nextCursor: "fresh-third" })
        : refreshed.promise;
    });
    const onOpen = vi.fn();
    const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "retained query" } });
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete to-delete" })));
    if (boundary === "query") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new query" } });
    else
      view.rerender(
        <WritingHistory pageId={boundary === "document" ? "other" : "doc"} onOpen={onOpen} refreshVersion={1} />,
      );
    await act(async () => vi.advanceTimersByTimeAsync(100));
    committed = true;
    await act(async () => deleted.resolve({ ok: true }));
    expect(reads).toBe(boundary === "document" ? 2 : 3);
    if (boundary === "document") await act(async () => vi.advanceTimersByTimeAsync(100));
    const [path, options] = mocks.api.mock.calls.at(-1)!;
    const signal = (options as RequestInit).signal!;
    const params = new URL(String(path), "https://example.test").searchParams;
    expect(params.get("q")).toBe(boundary === "query" ? "new query" : "retained query");
    expect(params.get("pageId")).toBe(boundary === "document" ? "other" : "doc");
    expect(reads).toBe(3);
    expect(screen.getByText("Loading conversations…")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(signal.aborted).toBe(false);
    expect(reads).toBe(3);
    await act(async () => refreshed.resolve({ conversations: [item("first")], nextCursor: "fresh-second" }));
    await settle();
    expect(reads).toBe(boundary === "refresh" ? 4 : 3);
    expect(screen.queryByRole("button", { name: "to-delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "first" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "second" }) !== null).toBe(boundary === "refresh");
    expect(screen.getByRole("button", { name: "Load more conversations" })).toBeEnabled();
  });

  it.each(["refresh", "query", "document"])(
    "reconciles a late deletion with the current list after %s",
    async (boundary) => {
      const deleted = deferred<{ ok: boolean }>();
      const obsolete = deferred<HistoryPage>();
      let committed = false,
        reads = 0;
      mocks.api.mockImplementation((_path: string, options?: RequestInit) => {
        if (options?.method === "DELETE") return deleted.promise;
        reads++;
        if (reads === 2) return obsolete.promise;
        return Promise.resolve({
          conversations: committed ? [item("retained")] : [item("to-delete"), item("retained")],
          nextCursor: null,
        });
      });
      const onOpen = vi.fn();
      const view = render(<WritingHistory pageId="doc" onOpen={onOpen} />);
      await settle();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete to-delete" })));
      expect(mocks.api.mock.calls[1]![1]).toEqual({ method: "DELETE" });
      expect(screen.getByRole("button", { name: "Delete retained" })).toBeDisabled();
      if (boundary === "query") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new query" } });
      else
        view.rerender(
          <WritingHistory pageId={boundary === "document" ? "other" : "doc"} onOpen={onOpen} refreshVersion={1} />,
        );
      await settle();
      const obsoleteSignal = (mocks.api.mock.calls[2]![1] as RequestInit).signal!;
      committed = true;
      await act(async () => deleted.resolve({ ok: true }));
      expect(obsoleteSignal.aborted).toBe(boundary !== "document");
      const current = new URL(String(mocks.api.mock.calls.at(-1)![0]), "https://example.test");
      expect(current.searchParams.get("q")).toBe(boundary === "query" ? "new query" : "");
      expect(current.searchParams.get("pageId")).toBe(boundary === "document" ? "other" : "doc");
      await act(async () =>
        obsolete.resolve({
          conversations: [boundary === "document" ? { ...item("unrelated"), pageId: "other" } : item("to-delete")],
          nextCursor: null,
        }),
      );
      expect(screen.queryByRole("button", { name: "to-delete" })).toBeNull();
      const retained = boundary === "document" ? "unrelated" : "retained";
      expect(screen.getByRole("button", { name: retained })).toBeVisible();
      expect(screen.getByRole("button", { name: `Delete ${retained}` })).toBeEnabled();
      expect(screen.queryByText("Loading conversations…")).toBeNull();
      expect(reads).toBe(boundary === "document" ? 2 : 3);
    },
  );

  it("preserves requested pagination depth through repeated deletion reloads", async () => {
    const deleted = deferred<{ ok: boolean }>(),
      stale = deferred<HistoryPage>(),
      next = deferred<HistoryPage>();
    let committed = false;
    const libraryReads: string[] = [];
    const librarySignals: AbortSignal[] = [];
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return deleted.promise;
      const params = new URL(url, "https://example.test").searchParams;
      if (params.has("pageId"))
        return Promise.resolve({ conversations: committed ? [] : [item("to-delete")], nextCursor: null });
      libraryReads.push(url);
      librarySignals.push(options!.signal!);
      if (params.get("cursor") === "old-second") return stale.promise;
      if (params.get("cursor")) return next.promise;
      return Promise.resolve({
        conversations: [item(committed ? "fresh-first" : "to-delete")],
        nextCursor: committed ? "fresh-second" : "old-second",
      });
    });
    const doc = within(render(<WritingHistory pageId="doc" onOpen={vi.fn()} />).container);
    const library = within(render(<WritingHistory onOpen={vi.fn()} />).container);
    fireEvent.change(library.getByRole("searchbox"), { target: { value: "retained query" } });
    await settle();
    await act(async () => fireEvent.click(doc.getByRole("button", { name: "Delete to-delete" })));
    await act(async () => fireEvent.click(library.getByRole("button", { name: "Load more conversations" })));
    committed = true;
    await act(async () => deleted.resolve({ ok: true }));
    expect(librarySignals[1]!.aborted).toBe(true);
    expect(library.getByRole("button", { name: "to-delete" })).toBeVisible();
    expect(library.queryByRole("button", { name: "fresh-first" })).toBeNull();
    expect(library.getByRole("button", { name: "Load more conversations" })).toBeDisabled();
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent("notes:writing-history-deleted", {
          detail: { kind: "single", id: "another", pageId: "doc" },
        }),
      ),
    );
    expect(librarySignals[3]!.aborted).toBe(true);
    expect(libraryReads.map((url) => new URL(url, "https://example.test").searchParams.get("cursor"))).toEqual([
      null,
      "old-second",
      null,
      "fresh-second",
      null,
      "fresh-second",
    ]);
    expect(
      libraryReads.every((url) => new URL(url, "https://example.test").searchParams.get("q") === "retained query"),
    ).toBe(true);
    await act(async () => next.resolve({ conversations: [item("fresh-second")], nextCursor: "fresh-third" }));
    await act(async () => stale.resolve({ conversations: [item("obsolete-second")], nextCursor: null }));
    expect(library.getByRole("button", { name: "fresh-first" })).toBeVisible();
    expect(library.getByRole("button", { name: "fresh-second" })).toBeVisible();
    expect(library.queryByRole("button", { name: "to-delete" })).toBeNull();
    expect(library.queryByRole("button", { name: "obsolete-second" })).toBeNull();
    expect(library.getByRole("button", { name: "Load more conversations" })).toBeEnabled();
    expect(library.queryByRole("alert")).toBeNull();
  });

  it("retains requested depth and old items after a deletion reload fails", async () => {
    const stale = deferred<HistoryPage>();
    mocks.api
      .mockResolvedValueOnce({ conversations: [item("old-first")], nextCursor: "old-second" })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ conversations: [item("fresh-first")], nextCursor: "fresh-second" })
      .mockRejectedValueOnce(new TypeError("Second page failed"))
      .mockResolvedValueOnce({ conversations: [item("fresh-first")], nextCursor: "fresh-second" })
      .mockResolvedValueOnce({ conversations: [item("fresh-second")], nextCursor: "fresh-third" });
    render(<WritingHistory onOpen={vi.fn()} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    const refresh = () =>
      window.dispatchEvent(
        new CustomEvent("notes:writing-history-deleted", {
          detail: { kind: "single", id: "removed", pageId: "doc" },
        }),
      );
    await act(async () => refresh());
    expect(screen.getByRole("alert")).toHaveTextContent("History needs a network connection.");
    expect(screen.getByRole("button", { name: "old-first" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "fresh-first" })).toBeNull();
    await act(async () => refresh());
    expect(screen.getByRole("button", { name: "fresh-second" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(6);
    await act(async () => stale.resolve({ conversations: [item("obsolete-second")], nextCursor: null }));
    expect(screen.queryByRole("button", { name: "obsolete-second" })).toBeNull();
  });

  it("does not retain extra requested depth after an ordinary append failure", async () => {
    mocks.api
      .mockResolvedValueOnce({ conversations: [item("first")], nextCursor: "second" })
      .mockRejectedValueOnce(new TypeError("Append failed"))
      .mockResolvedValue({ conversations: [item("fresh-first")], nextCursor: "fresh-second" });
    render(<WritingHistory onOpen={vi.fn()} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    expect(screen.getByRole("alert")).toHaveTextContent("More conversations could not be loaded.");
    await act(async () =>
      window.dispatchEvent(new CustomEvent("notes:writing-history-deleted", { detail: { kind: "all" } })),
    );
    expect(mocks.api).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "fresh-first" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Load more conversations" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["single", "all"])("targets mounted documents and libraries after %s deletion", async (kind) => {
    const deleted = deferred<{ ok: boolean }>(),
      unrelatedPage = deferred<HistoryPage>();
    const dispatched = vi.spyOn(window, "dispatchEvent");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let committed = false,
      unrelatedSignal: AbortSignal | undefined,
      unrelatedReads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return deleted.promise;
      const params = new URL(url, "https://example.test").searchParams;
      if (params.get("pageId") === "other") {
        unrelatedReads++;
        if (committed && kind === "all") return Promise.resolve({ conversations: [], nextCursor: null });
        if (params.get("cursor")) {
          unrelatedSignal = options!.signal!;
          return unrelatedPage.promise;
        }
        return Promise.resolve({
          conversations: [{ ...item("other-first"), pageId: "other" }],
          nextCursor: "other-second",
        });
      }
      return Promise.resolve({ conversations: committed ? [] : [item("to-delete")], nextCursor: null });
    });
    const doc = within(render(<WritingHistory pageId="doc" onOpen={vi.fn()} />).container);
    const other = within(render(<WritingHistory pageId="other" onOpen={vi.fn()} />).container);
    const library = within(render(<WritingHistory onOpen={vi.fn()} />).container);
    await settle();
    await act(async () =>
      fireEvent.click(
        library.getByRole("button", {
          name: kind === "single" ? "Delete to-delete" : "Delete all my conversations",
        }),
      ),
    );
    await act(async () => fireEvent.click(other.getByRole("button", { name: "Load more conversations" })));
    committed = true;
    await act(async () => deleted.resolve({ ok: true }));
    const event = dispatched.mock.calls.find(([value]) => value.type === "notes:writing-history-deleted")![0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect((event as CustomEvent).detail).toEqual(
      kind === "single" ? { kind: "single", id: "to-delete", pageId: "doc" } : { kind: "all" },
    );
    expect(doc.getByText("No conversations found.")).toBeVisible();
    expect(library.getByText("No conversations found.")).toBeVisible();
    expect(unrelatedSignal!.aborted).toBe(kind === "all");
    expect(unrelatedReads).toBe(kind === "all" ? 3 : 2);
    await act(async () =>
      unrelatedPage.resolve({ conversations: [{ ...item("other-second"), pageId: "other" }], nextCursor: null }),
    );
    expect(other.queryByRole("button", { name: "other-first" }) !== null).toBe(kind === "single");
    expect(other.queryByRole("button", { name: "other-second" }) !== null).toBe(kind === "single");
    expect(other.queryByText("No conversations found.") !== null).toBe(kind === "all");
  });

  it.each([false, true])("keeps a commit-time deletion reload alive with StrictMode=%s", async (strict) => {
    const refreshed = deferred<HistoryPage>();
    mocks.api
      .mockResolvedValueOnce({ conversations: [item("initial")], nextCursor: null })
      .mockImplementation(() => refreshed.promise);
    function DeleteDuringCommit({ pageId, active }: { pageId: string; active: boolean }) {
      useLayoutEffect(() => {
        if (active)
          window.dispatchEvent(
            new CustomEvent("notes:writing-history-deleted", {
              detail: { kind: "single", id: "removed", pageId },
            }),
          );
      }, [pageId, active]);
      return null;
    }
    const onOpen = vi.fn();
    const tree = (pageId: string, active: boolean) => {
      const content = (
        <>
          <WritingHistory pageId={pageId} onOpen={onOpen} />
          <DeleteDuringCommit pageId={pageId} active={active} />
        </>
      );
      return strict ? <StrictMode>{content}</StrictMode> : content;
    };
    const view = render(tree("doc", false));
    await settle();
    view.rerender(tree("other", true));
    expect(mocks.api).toHaveBeenCalledTimes(2);
    const signal = (mocks.api.mock.calls[1]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    expect(new URL(String(mocks.api.mock.calls[1]![0]), "https://example.test").searchParams.get("pageId")).toBe(
      "other",
    );
    await settle();
    expect(signal.aborted).toBe(false);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    await act(async () =>
      refreshed.resolve({ conversations: [{ ...item("fresh"), pageId: "other" }], nextCursor: null }),
    );
    expect(screen.getByRole("button", { name: "fresh" })).toBeVisible();
    view.unmount();
    await act(async () =>
      window.dispatchEvent(new CustomEvent("notes:writing-history-deleted", { detail: { kind: "all" } })),
    );
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("retains loaded depth and blocks pagination and repeat deletes until deletion settles", async () => {
    const deleted = deferred<{ ok: boolean }>();
    let committed = false;
    mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return deleted.promise;
      const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
      return {
        conversations: committed ? [item(cursor ? "second" : "first")] : [item(cursor ? "second" : "to-delete")],
        nextCursor: cursor ? "third" : "second",
      };
    });
    render(<WritingHistory onOpen={vi.fn()} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete to-delete" })));
    expect(screen.getByRole("button", { name: "Load more conversations" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete second" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete second" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more conversations" }));
    expect(mocks.api).toHaveBeenCalledTimes(3);
    committed = true;
    await act(async () => deleted.resolve({ ok: true }));
    expect(screen.getByRole("button", { name: "first" })).toBeVisible();
    expect(screen.getByRole("button", { name: "second" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Load more conversations" })).toBeEnabled();
    expect(mocks.api).toHaveBeenCalledTimes(5);
  });

  it("keeps deletion failure visible through concurrent and subsequent list reads", async () => {
    const deleted = deferred<{ ok: boolean }>();
    const refreshed = deferred<HistoryPage>();
    let reads = 0;
    mocks.api.mockImplementation((_path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return deleted.promise;
      return ++reads === 2
        ? refreshed.promise
        : Promise.resolve({ conversations: [item("retained")], nextCursor: null });
    });
    const onOpen = vi.fn();
    const view = render(<WritingHistory onOpen={onOpen} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete retained" })));
    view.rerender(<WritingHistory onOpen={onOpen} refreshVersion={1} />);
    await settle();
    await act(async () => deleted.reject(new TypeError("Deletion failed")));
    await act(async () => refreshed.resolve({ conversations: [item("retained")], nextCursor: null }));
    expect(screen.getByRole("alert")).toHaveTextContent("History could not be deleted.");
    view.rerender(<WritingHistory onOpen={onOpen} refreshVersion={2} />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("History could not be deleted.");
    mocks.api.mockResolvedValue({ conversations: [], nextCursor: null });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete retained" })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No conversations found.")).toBeVisible();
  });

  it.each(["success", "failure"])("does not reload after an unmounted deletion settles with %s", async (outcome) => {
    const deleted = deferred<{ ok: boolean }>();
    mocks.api.mockImplementation((_path: string, options?: RequestInit) =>
      options?.method === "DELETE"
        ? deleted.promise
        : Promise.resolve({ conversations: [item("to-delete")], nextCursor: null }),
    );
    const view = render(<WritingHistory onOpen={vi.fn()} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete to-delete" })));
    view.unmount();
    await act(async () =>
      outcome === "success" ? deleted.resolve({ ok: true }) : deleted.reject(new TypeError("Deletion failed")),
    );
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
