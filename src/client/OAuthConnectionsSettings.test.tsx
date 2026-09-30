// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthConnectionsSettings } from "./OAuthConnectionsSettings";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({
  api: mocks.api,
  apiErrorMessage: (_cause: unknown, fallback: string) => fallback,
  json: (value: unknown) => JSON.stringify(value),
}));

const recent = {
  id: "recent",
  clientId: "client",
  name: "Recent client",
  scopes: ["pages:read"],
  createdAt: 2,
  revokedAt: null,
};
const older = { ...recent, id: "older", name: "Older client", createdAt: 1 };

beforeEach(() => {
  mocks.api.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("OAuth connection settings", () => {
  it("loads older connections without duplicating existing entries", async () => {
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/oauth/workspace"
        ? { enabled: true }
        : path.endsWith("?cursor=next")
          ? { connections: [recent, older], nextCursor: null }
          : { connections: [recent], nextCursor: "next" },
    );
    render(<OAuthConnectionsSettings owner />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more connections" }));
    expect(await screen.findByText("Older client")).toBeInTheDocument();
    expect(screen.getAllByText("Recent client")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more connections" })).not.toBeInTheDocument();
    expect(mocks.api.mock.calls.filter(([path]) => path === "/api/oauth/workspace")).toHaveLength(1);
  });

  it("preserves visible connections and allows retry after a page load fails", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes("?cursor=")) throw new Error("unavailable");
      return path === "/api/oauth/workspace" ? { enabled: true } : { connections: [recent], nextCursor: "next" };
    });
    render(<OAuthConnectionsSettings owner={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more connections" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connections could not be loaded.");
    expect(screen.getByText("Recent client")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more connections" })).toBeEnabled());
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("updates the owner workspace toggle through the settings API", async () => {
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/oauth/workspace" ? { enabled: true } : { connections: [], nextCursor: null },
    );
    render(<OAuthConnectionsSettings owner />);
    const toggle = await screen.findByRole("checkbox", { name: "Allow MCP connections in this workspace" });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(mocks.api).toHaveBeenCalledWith("/api/oauth/workspace", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
  });

  it("revokes an older connection without losing loaded rows or the next cursor", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return undefined;
      if (path === "/api/oauth/workspace") return { enabled: true };
      return path.endsWith("?cursor=next")
        ? { connections: [older], nextCursor: "last" }
        : { connections: [recent], nextCursor: "next" };
    });
    render(<OAuthConnectionsSettings owner />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more connections" }));
    const oldName = await screen.findByText("Older client");
    fireEvent.click(oldName.closest("li")!.querySelector("button")!);
    await waitFor(() => expect(oldName.closest("li")).toHaveTextContent("Disconnected"));
    expect(screen.getByText("Recent client")).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "Load more connections" });
    await waitFor(() => expect(more).toBeEnabled());
    expect(screen.getByRole("list").compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mocks.api.mock.calls.filter(([path]) => path === "/api/oauth/connections")).toHaveLength(1);
    expect(mocks.api).toHaveBeenCalledWith("/api/oauth/connections/older", { method: "DELETE" });
  });

  it("shows every loaded connection as disconnected when MCP is disabled and keeps them disconnected on enable", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/oauth/workspace") return { enabled: true };
      return path.endsWith("?cursor=next")
        ? { connections: [older], nextCursor: "last" }
        : { connections: [recent], nextCursor: "next" };
    });
    render(<OAuthConnectionsSettings owner />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more connections" }));
    await screen.findByText("Older client");
    const toggle = screen.getByRole("checkbox", { name: "Allow MCP connections in this workspace" });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getAllByText(/Disconnected/)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more connections" })).toBeEnabled();
    expect(screen.getByText(/each client must reconnect/)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getAllByText(/Disconnected/)).toHaveLength(2);
    expect(mocks.api.mock.calls.filter(([path]) => path === "/api/oauth/connections")).toHaveLength(1);
  });
});
