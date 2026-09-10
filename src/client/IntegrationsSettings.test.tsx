// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationsSettings } from "./IntegrationsSettings";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("./api", () => ({
  api: mocks.api,
  apiErrorMessage: (_cause: unknown, fallback: string) => fallback,
  json: (value: unknown) => JSON.stringify(value),
}));

const integration = {
  id: "integration-one",
  name: "Contract test",
  capabilities: {
    readContent: true,
    insertContent: false,
    updateContent: false,
    readComments: false,
    insertComments: false,
    userInformation: "none" as const,
  },
  token: null,
  grantCount: 0,
  revokedAt: null,
  lastUsedAt: null,
};

function loadResponse(
  path: string,
  webhookStatus: "pending_verification" | "active" | "paused" = "pending_verification",
) {
  if (path === "/api/integrations") return { integrations: [integration] };
  if (path === "/api/webhooks")
    return {
      subscriptions: [
        {
          id: "webhook-one",
          integrationId: integration.id,
          integrationName: integration.name,
          url: "https://example.test/hook",
          events: [],
          status: webhookStatus,
        },
      ],
    };
  if (path === "/api/webhook-deliveries") return { deliveries: [] };
  return undefined;
}

describe("integration settings errors", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.api.mockReset();
  });

  it("does not clear a reload failure after a successful mutation", async () => {
    let reloadFailure = false;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === `/api/integrations/${integration.id}` && init?.method === "PATCH") {
        reloadFailure = true;
        return {};
      }
      if (reloadFailure && path === "/api/integrations") throw new Error("reload failed");
      return loadResponse(path);
    });
    render(<IntegrationsSettings owner pages={[]} />);
    const checkbox = await screen.findByRole("checkbox", { name: /Insert content/ });

    fireEvent.click(checkbox);

    expect(await screen.findByRole("alert")).toHaveTextContent("Integrations could not be loaded.");
  });

  it("reports resend failures through the shared mutation error path", async () => {
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/webhooks/webhook-one/resend" && init?.method === "POST") {
        throw new Error("resend failed");
      }
      return loadResponse(path);
    });
    render(<IntegrationsSettings owner pages={[]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Resend" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("The verification request could not be resent."),
    );
  });

  it.each([
    {
      name: "verification",
      status: "pending_verification" as const,
      button: "Verify",
      path: "/api/webhooks/webhook-one/verify",
      method: "POST",
      message: "The webhook could not be verified.",
    },
    {
      name: "revocation",
      status: "pending_verification" as const,
      button: "Revoke",
      path: "/api/integrations/integration-one",
      method: "DELETE",
      message: "The integration could not be revoked.",
    },
    {
      name: "pause",
      status: "active" as const,
      button: "Pause",
      path: "/api/webhooks/webhook-one",
      method: "PATCH",
      message: "The webhook could not be paused.",
    },
    {
      name: "deletion",
      status: "pending_verification" as const,
      button: "Delete",
      path: "/api/webhooks/webhook-one",
      method: "DELETE",
      message: "The webhook could not be deleted.",
    },
  ])("reports $name failures through the shared mutation error path", async (testCase) => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === testCase.path && init?.method === testCase.method) throw new Error(`${testCase.name} failed`);
      return loadResponse(path, testCase.status);
    });
    render(<IntegrationsSettings owner pages={[]} />);

    fireEvent.click(await screen.findByRole("button", { name: testCase.button }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(testCase.message));
  });
});
