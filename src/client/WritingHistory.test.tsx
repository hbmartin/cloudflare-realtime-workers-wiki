// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});

describe("writing deletion recovery", () => {
  it.each(["refresh", "query", "document"])(
    "cancels the scheduled %s load when deletion reloads before the debounce",
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

  it.each(["refresh", "query", "document"])(
    "cancels the pending %s reload when deletion reloads immediately",
    async (boundary) => {
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
    },
  );

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
      expect(obsoleteSignal.aborted).toBe(true);
      const current = new URL(String(mocks.api.mock.calls.at(-1)![0]), "https://example.test");
      expect(current.searchParams.get("q")).toBe(boundary === "query" ? "new query" : "");
      expect(current.searchParams.get("pageId")).toBe(boundary === "document" ? "other" : "doc");
      await act(async () => obsolete.resolve({ conversations: [item("to-delete")], nextCursor: null }));
      expect(screen.queryByRole("button", { name: "to-delete" })).toBeNull();
      expect(screen.getByRole("button", { name: "retained" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Delete retained" })).toBeEnabled();
      expect(screen.queryByText("Loading conversations…")).toBeNull();
      expect(reads).toBe(3);
    },
  );

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
