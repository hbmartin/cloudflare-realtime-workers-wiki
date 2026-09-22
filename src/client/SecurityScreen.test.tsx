// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.resetAllMocks();
});
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
    await act(async () => {});
    expect(api).not.toHaveBeenCalled();
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

  it("uses a fresh Slack primary proof without asking a password for TOTP setup", async () => {
    const slackStatus = {
      ...status,
      slackPrimary: { available: true, expiresAt: Date.now() + 60_000 },
    };
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/security/setup-totp" ? { totpURI: "otpauth://totp/NoteFlare?secret=SLACKPRIMARY" } : slackStatus,
    );
    render(<SecurityScreen initialStatus={slackStatus} />);
    expect(screen.queryByLabelText("Account password")).not.toBeInTheDocument();
    expect(screen.getByText(/recent Slack sign-in confirms the primary factor/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator app" }));
    await screen.findByLabelText("Setup key");
    expect(api).toHaveBeenCalledWith("/api/security/setup-totp", { method: "POST", body: "{}" });
  });

  it("requires acknowledgment of the displayed recovery-code batch", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/security/recovery-codes"
        ? { codes: ["recovery-code"], receipt: "batch-id" }
        : { ...status, passkeys: 1, fresh: true },
    );
    render(<SecurityScreen initialStatus={{ ...status, passkeys: 1, fresh: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate recovery codes to finish setup" }));
    const acknowledgment = await screen.findByLabelText("I saved my recovery codes");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.click(acknowledgment);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

describe("protection recovery flows", () => {
  it("allows re-verification while codes are displayed without replacing the batch", async () => {
    let acknowledged = false;
    let fresh = false;
    const complete = vi.fn();
    const enrolled = { ...status, totp: true, fresh: true };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/security/recovery-codes") return { codes: ["keep-this-code"], receipt: "same-batch" };
      if (path === "/api/security/acknowledge-codes") {
        if (!fresh) throw new Error("Verify again to continue.");
        acknowledged = true;
        return { success: true };
      }
      return { ...enrolled, fresh, codesSaved: acknowledged };
    });
    vi.mocked(authClient.twoFactor.verifyTotp).mockImplementation(async () => {
      fresh = true;
      return { data: { token: "token", user: {} }, error: null } as Awaited<
        ReturnType<typeof authClient.twoFactor.verifyTotp>
      >;
    });
    render(<SecurityScreen initialStatus={enrolled} onComplete={complete} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate recovery codes to finish setup" }));
    fireEvent.click(await screen.findByLabelText("I saved my recovery codes"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Verify again");
    const input = screen.getByLabelText("Authenticator code");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("Account protection verified. Continue to confirm your saved recovery codes.");
    expect(screen.getByText("keep-this-code")).toBeVisible();
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/api/security/recovery-codes")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/api/security/acknowledge-codes", {
      method: "POST",
      body: JSON.stringify({ receipt: "same-batch" }),
    });
  });

  it("offers password-protected resumption only when the server allows it", async () => {
    const recovery = { ...status, state: "recovery_required" as const, recoveryCanResume: true };
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/security/setup-totp" ? { totpURI: "otpauth://totp/NoteFlare?secret=EXPIRED" } : recovery,
    );
    render(<SecurityScreen initialStatus={recovery} />);
    const setup = screen.getByLabelText("Account password");
    fireEvent.change(setup, { target: { value: "password123" } });
    fireEvent.submit(setup.closest("form")!);
    await screen.findByLabelText("Setup key");
    const input = screen.getByLabelText("Password to resume recovery");
    fireEvent.change(input, { target: { value: "password123" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("Recovery resumed. Finish restoring an authenticator or passkey.");
    expect(screen.queryByLabelText("Setup key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up authenticator app" })).toBeVisible();
    expect(api).toHaveBeenCalledWith("/api/security/resume-recovery", {
      method: "POST",
      body: JSON.stringify({ password: "password123" }),
    });
  });

  it("uses the shared API fallback for non-JSON failures", async () => {
    const original = await vi.importActual<typeof import("./api")>("./api");
    vi.mocked(api).mockImplementation(original.api);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SecurityScreen initialStatus={status} />);
    const input = screen.getByLabelText("Account password");
    fireEvent.change(input, { target: { value: "password123" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Request failed (502).");
  });
});
