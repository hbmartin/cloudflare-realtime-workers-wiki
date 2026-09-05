// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page, Space } from "../shared/types";
import { api } from "./api";
import { SlackSettings } from "./SlackSettings";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));

const space: Space = {
  id: "space-1",
  workspaceId: "workspace-1",
  name: "General",
  slug: "general",
  description: "",
  icon: null,
  position: "a0",
  visibility: "workspace",
  effectiveRole: "owner",
  createdAt: 1,
  updatedAt: 1,
};

const page: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  spaceId: space.id,
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Launch plan",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  history.replaceState(null, "", "/");
});

describe("SlackSettings", () => {
  it("clearly reports unavailable operator configuration", async () => {
    vi.mocked(api).mockResolvedValue({
      available: false,
      missing: ["SLACK_CLIENT_ID"],
      installation: null,
      linked: false,
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByText(/Slack is unavailable until an operator configures/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to Slack" })).not.toBeInTheDocument();
  });

  it("lets an owner map a channel to a page and choose delivery cadence", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/slack/status") {
        return {
          available: true,
          missing: [],
          installation: {
            teamId: "T123",
            teamName: "Product Slack",
            botUserId: "B123",
            scopes: [],
            connected: true,
            createdAt: 1,
            updatedAt: 1,
          },
          linked: true,
        };
      }
      if (path === "/api/slack/channels" && !init?.method) return { subscriptions: [] };
      if (path === "/api/slack/channels" && init?.method === "POST") return { subscription: { id: "mapping" } };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByText("Product Slack")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Page scope"), { target: { value: page.id } });
    fireEvent.change(screen.getByLabelText("Channel ID"), { target: { value: "C0123456789" } });
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "launch" } });
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "digest" } });
    fireEvent.click(screen.getByRole("button", { name: "Save channel mapping" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/slack/channels",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"channelId":"C0123456789"'),
        }),
      ),
    );
    expect(await screen.findByText("Slack channel mapping saved.")).toBeInTheDocument();
  });

  it("consumes a Slack account link once and removes it from browser history", async () => {
    history.replaceState(null, "", "/?view=settings&slackLink=single-use-token");
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/slack/link" && init?.method === "POST") return { ok: true };
      if (path === "/api/slack/status") {
        return { available: true, missing: [], installation: null, linked: true };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner={false} spaces={[space]} pages={[page]} />);
    expect(await screen.findByText("Your Notes and Slack accounts are linked.")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(
      "/api/slack/link",
      expect.objectContaining({ method: "POST", body: '{"token":"single-use-token"}' }),
    );
    expect(window.location.search).toBe("?view=settings");
  });
});
