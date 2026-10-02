// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ActivityView } from "./ActivityView";
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
    render(<ActivityView spaces={[]} pages={[]} onSelect={vi.fn()} />);
    await screen.findByRole("region", { name: "Current open work" });
    expect(api).toHaveBeenCalledWith(expect.stringContaining("mapping=map"));
    fireEvent.click(screen.getByRole("tab", { name: "Open work" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Open work" })).toHaveAttribute("aria-selected", "true"),
    );
    await screen.findByText(/No new activity · Owner · In progress/);
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
    render(<ActivityView spaces={[]} pages={[]} onSelect={vi.fn()} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Open work" }));
    await screen.findByText("No open work.");
    resolveOld({ items: [item], nextCursor: null });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Launch plan" })).not.toBeInTheDocument());
  });
});
