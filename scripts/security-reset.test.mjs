import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPassword } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./security-reset.mjs";

const success = { status: 0, stdout: JSON.stringify([{ success: true, meta: { changes: 1 } }]) };
const passwordArgs = ["owner@example.test", "--local", "--identity-verified", "--password-only"];
let log;
let error;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function executor(result = success) {
  let file;
  let sql;
  const execute = vi.fn((_command, args) => {
    file = args[args.indexOf("--file") + 1];
    sql = readFileSync(file, "utf8");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(log).not.toHaveBeenCalled();
    return result;
  });
  return { execute, file: () => file, sql: () => sql };
}

describe("operator security reset", () => {
  it.each(["--local", "--remote"])("sets a hashed random password with %s targeting", async (target) => {
    const captured = executor();
    const before = Date.now();
    expect(
      await main([" OWNER@EXAMPLE.TEST ", target, "--identity-verified", "--password-only"], captured.execute),
    ).toBe(0);
    const output = log.mock.calls[0][0];
    const password = output.match(/Replacement password: ([\w-]+)/)[1];
    expect(password).toHaveLength(32);
    const sql = captured.sql();
    const hash = sql.match(/password='([^']+)'/)[1];
    expect(await verifyPassword({ hash, password })).toBe(true);
    expect(await verifyPassword({ hash, password: "password123" })).toBe(false);
    expect(sql).toContain("email='owner@example.test'");
    expect(Number(sql.match(/updatedAt=(\d+)/)[1])).toBeGreaterThanOrEqual(before);
    expect(sql).not.toContain(password);
    expect(sql).not.toContain("security_resets");
    expect(output).not.toContain("Expires:");
    expect(output).not.toContain("Reset token:");
    const [command, args, options] = captured.execute.mock.calls[0];
    expect(command).toBe("pnpm");
    expect(args).toEqual([
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      ...(target === "--remote" ? ["--env", "production", "--remote"] : ["--local"]),
      "--file",
      captured.file(),
      "--json",
    ]);
    expect(options).toEqual({ encoding: "utf8" });
    expect(existsSync(dirname(captured.file()))).toBe(false);
  });

  it("escapes apostrophes in the normalized email", async () => {
    const captured = executor();
    expect(await main([" O'NEIL@EXAMPLE.TEST ", ...passwordArgs.slice(1)], captured.execute)).toBe(0);
    expect(captured.sql()).toContain("email='o''neil@example.test'");
  });

  it("retains the full reset and its thirty-minute token without the flag", async () => {
    const captured = executor({ status: 0, stdout: JSON.stringify([{ success: true, meta: { changes: 12 } }]) });
    const before = Date.now();
    expect(await main(passwordArgs.slice(0, -1), captured.execute)).toBe(0);
    const output = log.mock.calls[0][0];
    const token = output.match(/Reset token: ([\w-]+)/)[1];
    expect(token).toHaveLength(43);
    expect(captured.sql()).toContain("INSERT OR REPLACE INTO security_resets");
    expect(captured.sql()).toContain(createHash("sha256").update(token).digest("hex"));
    expect(captured.sql()).not.toContain(token);
    const expiresAt = Date.parse(output.match(/Expires: (.+)/)[1]);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(output).not.toContain("Replacement password:");
    expect(existsSync(dirname(captured.file()))).toBe(false);
  });

  it.each(
    [
      [],
      ["--local", "--identity-verified"],
      ["owner@example.test", "--local", "--password-only"],
      ["owner@example.test", "--identity-verified", "--password-only"],
      ["owner@example.test", "--local", "--remote", "--identity-verified", "--password-only"],
      [...passwordArgs, "--unknown"],
      [...passwordArgs, "another@example.test"],
    ].map((args) => ({ args })),
  )("rejects invalid arguments before contacting D1: %j", async ({ args }) => {
    const execute = vi.fn();
    expect(await main(args, execute)).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain("--password-only");
  });

  it.each([
    { status: 1, stderr: "private diagnostic details", stdout: "" },
    { status: null, error: new Error("spawn failed"), stdout: "" },
    { status: 0, stdout: "not-json" },
    { status: 0, stdout: "null" },
    { status: 0, stdout: "{}" },
    { status: 0, stdout: "[]" },
    { status: 0, stdout: JSON.stringify([{ success: false, meta: { changes: 1 } }]) },
    { status: 0, stdout: JSON.stringify([{ success: true }]) },
    { status: 0, stdout: JSON.stringify([{ success: true, meta: { changes: "1" } }]) },
    { status: 0, stdout: JSON.stringify([{ success: true, meta: { changes: 0 } }]) },
    { status: 0, stdout: JSON.stringify([{ success: true, meta: { changes: 2 } }]) },
  ])("prints no password and cleans up after an unsuccessful result: %j", async (result) => {
    const captured = executor(result);
    expect(await main(passwordArgs, captured.execute)).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).not.toContain("private diagnostic details");
    expect(existsSync(dirname(captured.file()))).toBe(false);
  });

  it("cleans up when execution throws", async () => {
    const captured = executor();
    expect(
      await main(passwordArgs, (...args) => {
        captured.execute(...args);
        throw new Error("Execution failed");
      }),
    ).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(existsSync(dirname(captured.file()))).toBe(false);
  });

  it("returns failure without printing a token for an unknown full-reset account", async () => {
    const captured = executor({ status: 0, stdout: JSON.stringify([{ success: true, meta: { changes: 0 } }]) });
    expect(await main(passwordArgs.slice(0, -1), captured.execute)).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain("No matching account");
  });

  it("runs directly as a CLI and rejects missing identity confirmation", () => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./security-reset.mjs", import.meta.url)),
        "owner@example.test",
        "--local",
        "--password-only",
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("--identity-verified");
  });
});
