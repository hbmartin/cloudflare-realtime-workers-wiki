// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page, Space } from "../shared/types";
import { api, authClient } from "./api";
import { SlackSettings } from "./SlackSettings";
import { CHANNEL_EVENT_TYPES } from "../shared/activity";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
  authClient: { linkSocial: vi.fn() },
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
  it("starts personal identity linking and offers a retry after failure", async () => {
    vi.mocked(api).mockResolvedValue({
      available: true,
      installation: { connected: true, teamName: "Product Slack", capabilities: { identity: { available: true } } },
      linked: false,
    });
    vi.mocked(authClient.linkSocial).mockRejectedValueOnce(new Error("Network failure"));
    render(<SlackSettings owner={false} spaces={[space]} pages={[page]} />);
    const connect = await screen.findByRole("button", { name: "Connect Slack identity" });
    fireEvent.click(connect);
    expect(await screen.findByText("Slack identity could not be connected. Try again.")).toBeInTheDocument();
    expect(authClient.linkSocial).toHaveBeenCalledWith({
      provider: "slack",
      callbackURL: "/?view=settings&slack=verified",
      errorCallbackURL: "/?view=settings&slackAuth=callback",
    });
    expect(connect).toBeEnabled();
  });

  it("shows the required security step when the server denies linking", async () => {
    vi.mocked(api).mockResolvedValue({
      available: true,
      installation: { connected: true, capabilities: { identity: { available: true } } },
      linked: false,
    });
    vi.mocked(authClient.linkSocial).mockResolvedValueOnce({
      data: null,
      error: {
        status: 403,
        statusText: "Forbidden",
        code: "SECURITY_REQUIRED",
        message: "Save your recovery resume key before continuing.",
      },
    });
    render(<SlackSettings owner={false} spaces={[space]} pages={[page]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Slack identity" }));
    expect(await screen.findByText("Save your recovery resume key before continuing.")).toBeInTheDocument();
    expect(screen.queryByText("Slack identity could not be connected. Try again.")).not.toBeInTheDocument();
  });
  it.each([
    ["slack_team_mismatch", "Use an account from the connected Slack workspace."],
    [
      "slack_scope_missing",
      "Ask the workspace owner to reauthorize Slack with users:read, then connect your identity again.",
    ],
  ])("shows an actionable callback error: %s", async (code, message) => {
    history.replaceState(null, "", `/?slackAuth=callback&error=${code}`);
    vi.mocked(api).mockResolvedValue({ available: true, installation: null, linked: false });
    render(<SlackSettings owner={false} spaces={[space]} pages={[page]} />);
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("shows paused cleanup remediation and disconnects access separately from sign-in", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/slack/status")
        return {
          available: true,
          installation: { connected: true },
          identity: { state: "verified", accessAuthorized: true, slackUserId: "U123" },
          linked: true,
        };
      if (path === "/api/slack/delivery-health")
        return {
          orphanedFailures: [],
          cleanup: { pending: 0, paused: 3, failed: 0, pausedByReason: [{ reason: "missing_scope", count: 3 }] },
        };
      if (path === "/api/slack/identity") return { ok: true };
      return { subscriptions: [] };
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByText(/Reauthorize Slack with files:write to resume cleanup/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Slack access" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/slack/identity", { method: "DELETE" }));
    expect(
      await screen.findByText("Slack access was disconnected. Your Slack sign-in remains available."),
    ).toBeInTheDocument();
  });

  it("acknowledges a failure for an orphaned link using its encoded identifier", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/slack/status") return { available: true, missing: [], installation: null, linked: false };
      if (path === "/api/slack/delivery-health")
        return { orphanedFailures: [{ id: "orphan:link-1", channelName: "notes", failedDeliveries: 1 }] };
      if (path === "/api/slack/delivery-health/orphan%3Alink-1/acknowledge") return { ok: true };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear failures" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/slack/delivery-health/orphan%3Alink-1/acknowledge", {
        method: "POST",
      }),
    );
  });

  it("reports thumbnail cleanup as manual attention and only acknowledges the health notice", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/slack/status") return { available: true, missing: [], installation: null, linked: false };
      if (path === "/api/slack/delivery-health")
        return {
          orphanedFailures: [
            { id: "slack-file-cleanup:installation", channelName: "Slack thumbnail cleanup", failedDeliveries: 1 },
          ],
        };
      if (path === "/api/slack/delivery-health/slack-file-cleanup%3Ainstallation/acknowledge") return { ok: true };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByText("1 thumbnail cleanup failure needs manual attention.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry cleanup/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear failures" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/slack/delivery-health/slack-file-cleanup%3Ainstallation/acknowledge", {
        method: "POST",
      }),
    );
  });
  it("clearly reports unavailable operator configuration", async () => {
    vi.mocked(api).mockResolvedValue({
      available: false,
      missing: ["SLACK_CLIENT_ID"],
      installation: null,
      linked: false,
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByText(/Slack is unavailable until an operator configures/)).toHaveTextContent(
      "NoteFlare notifications remain available in-app",
    );
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
      expect(api).toHaveBeenCalledWith("/api/slack/channels", expect.objectContaining({ method: "POST" })),
    );
    const saved = vi
      .mocked(api)
      .mock.calls.find(([path, init]) => path === "/api/slack/channels" && init?.method === "POST");
    expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({
      channelId: "C0123456789",
      pageId: page.id,
      cadence: "digest",
    });
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
    expect(await screen.findByText("Your NoteFlare and Slack accounts are linked.")).toBeInTheDocument();
    // The token is single use, so a second POST would burn it and 4xx the retry.
    const linkCalls = vi
      .mocked(api)
      .mock.calls.filter(([path, init]) => path === "/api/slack/link" && init?.method === "POST");
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "POST", body: '{"token":"single-use-token"}' }),
    );
    expect(window.location.search).toBe("?view=settings");
  });

  it("creates a daily mapping with the operator timezone, lifecycle events, and open work", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/slack/status")
        return {
          available: true,
          missing: [],
          linked: true,
          installation: {
            connected: true,
            teamId: "T123",
            teamName: "Product Slack",
            botUserId: "B123",
            scopes: [],
            createdAt: 1,
            updatedAt: 1,
          },
          round2: { channels: true, shares: false, richDigests: false, defaultTimezone: "America/Los_Angeles" },
        };
      if (path === "/api/slack/channel-directory")
        return { channels: [{ id: "C123", name: "canonical-notes", private: true }], nextCursor: null };
      if (path === "/api/slack/channels")
        return init?.method === "POST" ? { subscription: { id: "mapping" } } : { subscriptions: [] };
      if (path === "/api/slack/delivery-health") return { orphanedFailures: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    await screen.findByRole("option", { name: "Private #canonical-notes" });
    fireEvent.change(screen.getByLabelText("Slack channel"), { target: { value: "C123" } });
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "digest" } });
    fireEvent.click(screen.getByRole("button", { name: "Save channel mapping" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/slack/channels", expect.objectContaining({ method: "POST" })),
    );
    const saved = vi
      .mocked(api)
      .mock.calls.find(([path, init]) => path === "/api/slack/channels" && init?.method === "POST");
    expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({
      channelId: "C123",
      cadence: "digest",
      digestTime: "09:00",
      digestTimezone: "America/Los_Angeles",
      digestOpenWork: true,
      eventTypes: [...CHANNEL_EVENT_TYPES],
    });
  });

  it("distinguishes legacy identity migration and bot reauthorization health", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/slack/status") {
        return {
          available: true,
          missing: [],
          installation: {
            teamId: "T123",
            teamName: "Product Slack",
            botUserId: "B123",
            scopes: ["commands", "users:read"],
            connected: true,
            createdAt: 1,
            updatedAt: 1,
            scopeHealth: {
              required: ["commands", "chat:write"],
              granted: ["commands", "users:read"],
              missing: ["chat:write"],
              reauthorizationRequired: true,
            },
            capabilities: {
              identity: { available: true, requiredScopes: ["users:read"], missingScopes: [] },
            },
          },
          linked: true,
          identity: { state: "legacy", slackUserId: "U123", verifiedAt: null },
          reauthorization: { required: true, available: true },
        };
      }
      if (path === "/api/slack/channels") return { subscriptions: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByText(/legacy Slack delivery link still works/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify Slack identity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reauthorize Slack" })).toBeInTheDocument();
    expect(screen.getByText("Missing: chat:write")).toBeInTheDocument();
  });

  it("offers owners reauthorization for bot authentication failure with complete scopes", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/slack/status")
        return {
          available: true,
          missing: [],
          installation: {
            teamId: "T123",
            teamName: "Product Slack",
            botUserId: "B123",
            scopes: ["chat:write"],
            connected: true,
            createdAt: 1,
            updatedAt: 1,
            authError: "invalid_auth",
            scopeHealth: {
              required: ["chat:write"],
              granted: ["chat:write"],
              missing: [],
              reauthorizationRequired: false,
            },
            capabilities: {
              identity: { available: true, requiredScopes: ["users:read"], missingScopes: [] },
            },
          },
          linked: false,
          reauthorization: { required: true, available: true },
        };
      if (path === "/api/slack/channels") return { subscriptions: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByRole("button", { name: "Reauthorize Slack" })).toBeVisible();
    expect(screen.getByText(/Reauthorize the workspace app to resume delivery/)).toBeVisible();
    cleanup();
    render(<SlackSettings owner={false} spaces={[space]} pages={[page]} />);
    expect(await screen.findByText(/Ask an owner to reauthorize the workspace app/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reauthorize Slack" })).not.toBeInTheDocument();
  });

  it("confirms a verified Slack identity without offering migration", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/slack/status") {
        return {
          available: true,
          missing: [],
          installation: {
            teamId: "T123",
            teamName: "Product Slack",
            botUserId: "B123",
            scopes: ["users:read"],
            connected: true,
            createdAt: 1,
            updatedAt: 1,
            scopeHealth: { required: [], granted: ["users:read"], missing: [], reauthorizationRequired: false },
            capabilities: {
              identity: { available: true, requiredScopes: ["users:read"], missingScopes: [] },
            },
          },
          linked: true,
          identity: { state: "verified", slackUserId: "U123", verifiedAt: 1 },
          reauthorization: { required: false, available: true },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SlackSettings owner={false} spaces={[space]} pages={[page]} />);
    expect(await screen.findByText("Your Slack identity is verified.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Slack identity/ })).not.toBeInTheDocument();
  });
});

describe("Slack thread mirror controls", () => {
  function setupMirror(identity = "verified", mirrorEnabled = false, blockedDeliveries = 0) {
    let enabled = mirrorEnabled;
    let mutedAt: number | null = null;
    let snoozedUntil: number | null = null;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/slack/status")
        return {
          available: true,
          missing: [],
          linked: true,
          identity: { state: identity, slackUserId: "UOWNER", verifiedAt: 1 },
          installation: {
            teamId: "T123",
            teamName: "Slack",
            botUserId: "UBOT",
            scopes: [],
            connected: true,
            createdAt: 1,
            updatedAt: 1,
          },
        };
      if (path === "/api/slack/channels/mapping/mirror" && init?.method === "PATCH") {
        enabled = (JSON.parse(String(init.body)) as { mirrorEnabled: boolean }).mirrorEnabled;
        return {};
      }
      if (path === "/api/slack/channels/mapping/pause" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body)) as { mode: string; hours?: number };
        mutedAt = input.mode === "mute" ? Date.now() : null;
        snoozedUntil = input.mode === "snooze" ? Date.now() + (input.hours ?? 0) * 3_600_000 : null;
        return {};
      }
      if (path === "/api/slack/channels")
        return {
          subscriptions: [
            {
              id: "mapping",
              spaceId: space.id,
              pageId: null,
              channelId: "C123",
              channelName: "product",
              eventTypes: ["reply"],
              cadence: "immediate",
              mirrorEnabled: enabled,
              blockedDeliveries,
              mutedAt,
              snoozedUntil,
              validationState: "valid",
            },
          ],
        };
      return {};
    });
  }
  it("requires explicit owner opt-in and supports disabling an enabled mapping", async () => {
    setupMirror();
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable thread mirror for #product" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/slack/channels/mapping/mirror",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ mirrorEnabled: true }) }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Disable thread mirror for #product" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/slack/channels/mapping/mirror",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ mirrorEnabled: false }) }),
      ),
    );
  });
  it("keeps enabling disabled for legacy identities", async () => {
    setupMirror("legacy");
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByRole("button", { name: "Enable thread mirror for #product" })).toBeDisabled();
  });
  it("shows uncertain delivery health while allowing the owner to disable mirroring", async () => {
    setupMirror("verified", true, 2);
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    expect(await screen.findByText(/2 deliveries need reconciliation/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable thread mirror for #product" })).toBeEnabled();
  });
  it("shows mute state and lets an owner unmute without an active root", async () => {
    setupMirror();
    render(<SlackSettings owner spaces={[space]} pages={[page]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mute #product" }));
    expect(await screen.findByText("Muted until you unmute this mapping.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unmute #product" }));
    await waitFor(() => expect(screen.queryByText("Muted until you unmute this mapping.")).not.toBeInTheDocument());
    const pauseCalls = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path === "/api/slack/channels/mapping/pause").length;
    fireEvent.change(screen.getByLabelText("Snooze updates for #product"), { target: { value: "8" } });
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/api/slack/channels/mapping/pause")).toHaveLength(
      pauseCalls,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply snooze for #product" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/slack/channels/mapping/pause",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ mode: "snooze", hours: 8 }) }),
      ),
    );
  });
  it("does not expose mapping controls to non-owners", async () => {
    setupMirror();
    render(<SlackSettings owner={false} spaces={[space]} pages={[page]} />);
    await screen.findByText("Your Slack identity is verified.");
    expect(screen.queryByRole("button", { name: /thread mirror/ })).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith("/api/slack/channels");
  });
});
