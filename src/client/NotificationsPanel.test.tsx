// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification, NotificationPreference } from "../shared/types";
import { NotificationsPanel } from "./NotificationsPanel";

const notification: Notification = {
  id: "mention:comment-1:user-1",
  eventType: "mention",
  actor: { id: "user-2", name: "Ada", email: "ada@example.test" },
  space: { id: "space-1", name: "General" },
  page: { id: "page-1", title: "Launch notes", icon: null },
  threadId: "thread-1",
  data: { commentId: "comment-1" },
  readAt: null,
  archivedAt: null,
  createdAt: Date.UTC(2026, 8, 5),
};

const preferences: NotificationPreference[] = [
  { eventType: "mention", inApp: true, email: "immediate", slack: "off", timezone: "UTC" },
  { eventType: "reply", inApp: true, email: "immediate", slack: "off", timezone: "UTC" },
  { eventType: "thread_resolved", inApp: true, email: "immediate", slack: "off", timezone: "UTC" },
  { eventType: "thread_reopened", inApp: true, email: "immediate", slack: "off", timezone: "UTC" },
  { eventType: "page_edit", inApp: true, email: "digest", slack: "off", timezone: "UTC" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

describe("NotificationsPanel", () => {
  it("opens an unread item and marks it read", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/notifications/read")) return jsonResponse({ ok: true });
      return jsonResponse({ notifications: [notification], unreadCount: 1, hasMore: false });
    });
    vi.stubGlobal("fetch", fetchMock);
    const select = vi.fn();
    const close = vi.fn();
    const unread = vi.fn();
    render(<NotificationsPanel revision={0} onClose={close} onSelectPage={select} onUnreadCountChange={unread} />);

    fireEvent.click(await screen.findByRole("button", { name: /Open Launch notes/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/notifications/read", expect.objectContaining({ method: "POST" })),
    );
    expect(select).toHaveBeenCalledWith("page-1");
    expect(close).toHaveBeenCalledOnce();
    expect(unread).toHaveBeenCalledWith(1);
  });

  it("makes unavailable email and Slack delivery explicit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("notification-preferences")
          ? jsonResponse({
              preferences,
              configured: false,
              channels: { email: { available: false }, slack: { available: false } },
            })
          : jsonResponse({ notifications: [], unreadCount: 0, hasMore: false }),
      ),
    );
    render(<NotificationsPanel revision={0} onClose={vi.fn()} onSelectPage={vi.fn()} onUnreadCountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notification settings" }));
    expect(await screen.findByText(/Email is unavailable/)).toBeInTheDocument();
    expect(screen.getAllByText("Slack unavailable")).toHaveLength(5);
    expect(screen.getByRole("combobox", { name: "Mentions email" })).toBeDisabled();
  });
});
