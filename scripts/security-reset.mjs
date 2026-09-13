import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const email = args[0];
const local = args.includes("--local");
const remote = args.includes("--remote");
if (
  !email ||
  local === remote ||
  !args.includes("--identity-verified") ||
  args.some((arg, index) => index > 0 && !["--local", "--remote", "--identity-verified"].includes(arg))
) {
  console.error(
    "Usage: pnpm security:reset <email> --local|--remote --identity-verified\nVerify the person's identity outside the app before issuing a reset. Remote resets revoke all factors and sessions immediately.",
  );
  process.exit(1);
}
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const expiresAt = Date.now() + 30 * 60_000;
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const directory = mkdtempSync(join(tmpdir(), "notes-security-reset-"));
try {
  const file = join(directory, "reset.sql");
  writeFileSync(
    file,
    `INSERT OR REPLACE INTO security_resets(token_hash,user_id,expires_at)
    SELECT '${hash}',id,${expiresAt} FROM user WHERE email=${quote(email.toLowerCase())};`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      ...(remote ? ["--env", "production", "--remote"] : ["--local"]),
      "--file",
      file,
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "Reset failed.");
  const output = JSON.parse(result.stdout);
  if (!output.some((item) => item.success && item.meta?.changes > 0))
    throw new Error("No matching account. No reset issued.");
  console.log(
    `Account protection reset for ${email}. Deliver this token privately after identity verification.\nExpires: ${new Date(expiresAt).toISOString()}\nReset token: ${token}`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
