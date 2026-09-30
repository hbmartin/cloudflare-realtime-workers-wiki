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

  it("revokes a connection loaded from an older page and refreshes the list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let revoked = false;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        revoked = true;
        return undefined;
      }
      if (path === "/api/oauth/workspace") return { enabled: true };
      return path.endsWith("?cursor=next")
        ? { connections: [older], nextCursor: null }
        : { connections: [recent], nextCursor: revoked ? null : "next" };
    });
    render(<OAuthConnectionsSettings owner />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more connections" }));
    const oldName = await screen.findByText("Older client");
    fireEvent.click(oldName.closest("li")!.querySelector("button")!);
    await waitFor(() => expect(screen.queryByText("Older client")).not.toBeInTheDocument());
    expect(mocks.api).toHaveBeenCalledWith("/api/oauth/connections/older", { method: "DELETE" });
  });
});
