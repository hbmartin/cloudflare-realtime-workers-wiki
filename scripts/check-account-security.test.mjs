import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "./check-account-security.mjs";

const requiredNames = [
  "d1_migrations",
  "user",
  "invites",
  "account_security",
  "session_security",
  "twoFactor",
  "passkey",
  "pending_passkeys",
  "initialize_account_security",
  "authorize_passkey_insert",
  "complete_invite",
];

function result(rows) {
  return { status: 0, stdout: JSON.stringify([{ results: rows }]) };
}

describe("account security preflight exit codes", () => {
  it("returns 0 for a completed passing check", () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(result(requiredNames.map((name) => ({ name, type: "table" }))))
      .mockReturnValueOnce(result([{ name: "claimed_by" }, { name: "claimed_email" }]))
      .mockReturnValueOnce(result([{ name: "0028_mandatory_security.sql" }, { name: "0029_security_lifecycle.sql" }]))
      .mockReturnValueOnce(result([{ users_missing_security: 0 }]));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(main(["--local"], execute)).toBe(0);
      expect(execute).toHaveBeenCalledTimes(4);
      expect(JSON.parse(output.mock.calls[0][0]).outcome).toBe("PASS");
    } finally {
      output.mockRestore();
    }
  });

  it("reserves 1 for a completed failing security check", () => {
    const execute = vi.fn().mockReturnValue(result([{ name: "user", type: "table" }]));
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(main(["--local"], execute)).toBe(1);
      expect(JSON.parse(output.mock.calls[0][0]).outcome).toBe("FAIL");
    } finally {
      output.mockRestore();
    }
  });

  it.each([
    [{ status: 0, stdout: "not-json" }, "malformed JSON"],
    [{ status: 0, stdout: JSON.stringify({ result: [] }) }, "invalid result shape"],
    [{ status: 0, stdout: JSON.stringify([{ results: null }]) }, "invalid result shape"],
    [{ status: 0, stdout: JSON.stringify([{ success: false, results: [] }]) }, "invalid result shape"],
    [{ status: 1, stdout: "" }, "query failed"],
  ])("returns 2 when Wrangler data is unusable: %s", (invalid, message) => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(main(["--local"], () => invalid)).toBe(2);
      expect(output.mock.calls[0][0]).toContain(message);
    } finally {
      output.mockRestore();
    }
  });

  it("uses exit 2 for CLI usage and option errors", () => {
    for (const args of [[], ["--local", "--remote"], ["--local", "--env"], ["--local", "--unknown"]]) {
      const child = spawnSync(process.execPath, [
        fileURLToPath(new URL("./check-account-security.mjs", import.meta.url)),
        ...args,
      ]);
      expect(child.status).toBe(2);
    }
  });

  it("distinguishes Wrangler auth and timeout failures without printing credentials or account IDs", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        main(["--local"], () => ({
          status: 1,
          stdout: "",
          stderr: "Unauthorized for account abcdef1234567890abcdef1234567890; Bearer private-token",
        })),
      ).toBe(2);
      expect(String(output.mock.calls[0][0])).toContain("authentication or permission error");
      expect(String(output.mock.calls[0][0])).not.toContain("private-token");
      expect(String(output.mock.calls[0][0])).not.toContain("abcdef1234567890");
      expect(main(["--local"], () => ({ status: null, stdout: "", error: new Error("ETIMEDOUT") }))).toBe(2);
      expect(String(output.mock.calls[1][0])).toContain("timeout");
    } finally {
      output.mockRestore();
    }
  });

  it("decodes file URLs for paths containing spaces", () => {
    expect(fileURLToPath(new URL("file:///tmp/with%20space/check-account-security.mjs"))).toBe(
      "/tmp/with space/check-account-security.mjs",
    );
  });
});
