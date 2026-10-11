// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function settle() {
  await act(async () => vi.advanceTimersByTimeAsync(200));
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.api.mockReset();
  mocks.api.mockResolvedValue({ conversations: [], nextCursor: null });
});
afterEach(() => vi.useRealTimers());

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
