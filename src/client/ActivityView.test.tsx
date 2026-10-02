// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ActivityView } from "./ActivityView";
import type { Page } from "../shared/types";
import type { ActivityItem, ActivityResponse } from "../shared/activity";
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
const item: ActivityItem = {
  id: "event",
  pageId: "page",
  spaceId: "space",
  title: "Launch plan",
  excerpt: "Ready to review",
  kind: "document",
  actorName: "Owner",
  eventType: "page_created",
  createdAt: Date.now(),
  unresolvedThreads: 2,
  taskStatus: null,
  departure: false,
  available: true,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  history.replaceState(null, "", "/");
});
describe("ActivityView", () => {
  it("loads seven-day history and cursor pagination without a Slack installation", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path.includes("cursor=")
        ? { items: [{ ...item, id: "second", title: "Second page" }], nextCursor: null }
        : { items: [item], nextCursor: "more" },
    );
    const onSelect = vi.fn();
    const existing = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation((path, options) =>
      path === "/api/pages/tree?archived=true" ? Promise.resolve({ pages: [] }) : existing!(path, options),
    );
    render(<ActivityView spaces={[]} pages={[]} onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole("button", { name: "Launch plan" }));
    expect(onSelect).toHaveBeenCalledWith("page");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: "Second page" });
    expect(screen.getByLabelText("History")).toHaveValue("7");
  });
  it("opens mapping links as a live activity and open-work overview", async () => {
    history.replaceState(null, "", "/?view=activity&mapping=map");
    vi.mocked(api).mockImplementation(async (path) => ({
      items: [
        path.includes("mode=open")
          ? { ...item, id: "task", title: "Unfinished task", eventType: null, taskStatus: "doing" }
          : item,
      ],
      nextCursor: null,
    }));
    const existing = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation((path, options) =>
      path === "/api/pages/tree?archived=true" ? Promise.resolve({ pages: [] }) : existing!(path, options),
    );
    render(<ActivityView spaces={[]} pages={[]} onSelect={vi.fn()} />);
    await screen.findByRole("region", { name: "Current open work" });
    expect(api).toHaveBeenCalledWith(expect.stringContaining("mapping=map"));
    fireEvent.click(screen.getByRole("tab", { name: "Open work" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Open work" })).toHaveAttribute("aria-selected", "true"),
    );
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Workspace activity" })).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.queryByRole("region", { name: "Current open work" })).not.toBeInTheDocument();
    const feed = screen
      .getByRole("region", { name: "Workspace activity" })
      .querySelector(".activity-feed")! as HTMLElement;
    expect(within(feed).getByRole("button", { name: "Unfinished task" })).toBeInTheDocument();
    expect(within(feed).getByText(/No new activity · Owner · In progress/)).toBeInTheDocument();
  });
  it("offers pages from every accessible space and archived departure targets", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/pages/tree?archived=true"
        ? {
            pages: [
              { id: "archived", spaceId: "other-space", title: "Archived planning", archivedAt: 1, isTemplate: false },
            ],
          }
        : { items: [], nextCursor: null },
    );
    render(
      <ActivityView
        spaces={[]}
        pages={[
          { id: "other", spaceId: "other-space", title: "Other space", archivedAt: null, isTemplate: false } as Page,
        ]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Other space" })).toBeInTheDocument();
    await screen.findByRole("option", { name: "Archived planning (archived)" });
    fireEvent.change(screen.getByLabelText("Page"), { target: { value: "archived" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining("page=archived")));
  });
  it("ignores stale results when the user changes tabs", async () => {
    let resolveOld: (value: ActivityResponse) => void = () => {};
    vi.mocked(api).mockImplementation(async (path) =>
      path.includes("mode=open")
        ? { items: [], nextCursor: null }
        : new Promise<ActivityResponse>((resolve) => {
            resolveOld = resolve;
          }),
    );
    const existing = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation((path, options) =>
      path === "/api/pages/tree?archived=true" ? Promise.resolve({ pages: [] }) : existing!(path, options),
    );
    render(<ActivityView spaces={[]} pages={[]} onSelect={vi.fn()} />);
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining("/api/activity?mode=activity")));
    fireEvent.click(screen.getByRole("tab", { name: "Open work" }));
    await screen.findByText("No open work.");
    await act(async () => resolveOld({ items: [item], nextCursor: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Launch plan" })).not.toBeInTheDocument());
  });

  it("refreshes archive, restore, and deletion choices and favors current pages", async () => {
    const current = {
      id: "page",
      spaceId: "space",
      title: "Current title",
      archivedAt: null,
      isTemplate: false,
    } as Page;
    let archived = [{ ...current, title: "Old title", archivedAt: 1 }];
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/pages/tree?archived=true" ? { pages: archived } : { items: [], nextCursor: null },
    );
    const onSelect = vi.fn();
    const { rerender } = render(<ActivityView spaces={[]} pages={[current]} onSelect={onSelect} />);
    await screen.findByText("No activity in this period.");
    expect(screen.getByRole("option", { name: "Current title" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Old title (archived)" })).not.toBeInTheDocument();
    archived = [{ ...current, archivedAt: 2 }];
    rerender(<ActivityView spaces={[]} pages={[]} onSelect={onSelect} archiveRefreshVersion={1} />);
    await screen.findByRole("option", { name: "Current title (archived)" });
    rerender(<ActivityView spaces={[]} pages={[current]} onSelect={onSelect} archiveRefreshVersion={2} />);
    expect(screen.getByRole("option", { name: "Current title" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Current title (archived)" })).not.toBeInTheDocument();
    archived = [];
    rerender(<ActivityView spaces={[]} pages={[]} onSelect={onSelect} archiveRefreshVersion={3} />);
    await waitFor(() =>
      expect(screen.getAllByRole("option").some((option) => option.textContent?.includes("title"))).toBe(false),
    );
  });

  it("ignores superseded archive responses and keeps the last list on refresh failure", async () => {
    const old = { id: "old", title: "Old archive", spaceId: "space", archivedAt: 1, isTemplate: false } as Page;
    const fresh = { ...old, id: "fresh", title: "Fresh archive" };
    const pending: Array<(value: { pages: Page[] }) => void> = [];
    let refresh = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path !== "/api/pages/tree?archived=true") return { items: [], nextCursor: null };
      if (refresh++ === 0) return { pages: [old] };
      if (refresh === 4) throw new Error("offline");
      return new Promise<{ pages: Page[] }>((resolve) => pending.push(resolve));
    });
    const onSelect = vi.fn();
    const { rerender } = render(<ActivityView spaces={[]} pages={[]} onSelect={onSelect} />);
    await screen.findByRole("option", { name: "Old archive (archived)" });
    rerender(<ActivityView spaces={[]} pages={[]} onSelect={onSelect} archiveRefreshVersion={1} />);
    rerender(<ActivityView spaces={[]} pages={[]} onSelect={onSelect} archiveRefreshVersion={2} />);
    await act(async () => pending[1]!({ pages: [fresh] }));
    expect(screen.getByRole("option", { name: "Fresh archive (archived)" })).toBeInTheDocument();
    await act(async () => pending[0]!({ pages: [old] }));
    expect(screen.queryByRole("option", { name: "Old archive (archived)" })).not.toBeInTheDocument();
    await act(async () =>
      rerender(<ActivityView spaces={[]} pages={[]} onSelect={onSelect} archiveRefreshVersion={3} />),
    );
    expect(screen.getByRole("option", { name: "Fresh archive (archived)" })).toBeInTheDocument();
  });
});
