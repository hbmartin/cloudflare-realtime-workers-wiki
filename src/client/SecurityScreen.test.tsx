// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityScreen } from "./SecurityScreen";
import { api, authClient } from "./api";
import type { SecurityStatus } from "../shared/security";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
  authClient: {
    signOut: vi.fn(),
    signIn: { passkey: vi.fn() },
    passkey: { addPasskey: vi.fn() },
    twoFactor: { verifyTotp: vi.fn() },
  },
}));
const status: SecurityStatus = {
  state: "enrollment_required",
  totp: false,
  passkeys: 0,
  codesSaved: false,
  fresh: false,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("account protection screens", () => {
  it("offers both enrollment methods and leaves browser trust unchecked", async () => {
    vi.mocked(api).mockResolvedValue(status);
    render(<SecurityScreen initialStatus={status} />);
    expect(screen.getByRole("button", { name: "Create a passkey" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Set up authenticator app" })).toBeVisible();
    expect(screen.getByLabelText("Trust this browser for 30 days")).not.toBeChecked();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/security/status"));
  });

  it("keeps enrollment open when passkey creation is cancelled", async () => {
    vi.mocked(api).mockResolvedValue(status);
    vi.mocked(authClient.passkey.addPasskey).mockResolvedValue({
      data: null,
      error: { message: "Passkey cancelled", status: 400, statusText: "Bad Request" },
    });
    const complete = vi.fn();
    render(<SecurityScreen initialStatus={status} onComplete={complete} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passkey cancelled");
    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Set up authenticator app" })).toBeEnabled();
  });

  it("requires acknowledgment of the displayed recovery-code batch", async () => {
    vi.mocked(api).mockResolvedValue({ ...status, passkeys: 1, fresh: true });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ codes: ["recovery-code"], receipt: "batch-id" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    render(<SecurityScreen initialStatus={{ ...status, passkeys: 1, fresh: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate recovery codes to finish setup" }));
    const acknowledgment = await screen.findByLabelText("I saved my recovery codes");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.click(acknowledgment);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});
