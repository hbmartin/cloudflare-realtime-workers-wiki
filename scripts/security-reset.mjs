import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";

const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const flags = ["--local", "--remote", "--identity-verified", "--password-only"];

export function passwordResetSql(email, hash, updatedAt) {
  return `UPDATE account SET password=${quote(hash)},updatedAt=${updatedAt}
    WHERE providerId='credential' AND userId=(SELECT id FROM user WHERE email=${quote(email.trim().toLowerCase())})
      AND (SELECT COUNT(*) FROM account credentials WHERE credentials.userId=account.userId AND credentials.providerId='credential')=1;`;
}

export async function main(args, execute = spawnSync) {
  const email = args[0]?.trim();
  const local = args.includes("--local");
  const remote = args.includes("--remote");
  const passwordOnly = args.includes("--password-only");
  if (
    !email ||
    email.startsWith("--") ||
    local === remote ||
    !args.includes("--identity-verified") ||
    args.some((arg, index) => index > 0 && !flags.includes(arg))
  ) {
    console.error(
      "Usage: pnpm security:reset <email> --local|--remote --identity-verified [--password-only]\nVerify the person's identity outside the app before issuing a reset. The default reset immediately revokes factors, sessions, trust, and recovery codes. --password-only sets and prints a random replacement password, preserving all other security state.",
    );
    return 1;
  }
  let directory;
  try {
    const secret = randomBytes(passwordOnly ? 24 : 32).toString("base64url");
    const hash = passwordOnly ? await hashPassword(secret) : createHash("sha256").update(secret).digest("hex");
    const now = Date.now();
    const expiresAt = now + 30 * 60_000;
    directory = mkdtempSync(join(tmpdir(), "notes-security-reset-"));
    const file = join(directory, "reset.sql");
    writeFileSync(
      file,
      passwordOnly
        ? passwordResetSql(email, hash, now)
        : `INSERT OR REPLACE INTO security_resets(token_hash,user_id,expires_at)
    SELECT '${hash}',id,${expiresAt} FROM user WHERE email=${quote(email.toLowerCase())};`,
      { mode: 0o600 },
    );
    const result = execute(
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
    if (result.error || result.status !== 0) throw new Error("Wrangler reset failed. No credential printed.");
    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new Error("Wrangler returned malformed JSON. No credential printed.");
    }
    if (
      !Array.isArray(output) ||
      output.length !== 1 ||
      output[0]?.success !== true ||
      !Number.isSafeInteger(output[0]?.meta?.changes) ||
      output[0].meta.changes < 0
    ) {
      throw new Error("Wrangler returned an invalid reset result. No credential printed.");
    }
    const changes = output[0].meta.changes;
    if (passwordOnly ? changes !== 1 : changes === 0) {
      throw new Error(
        passwordOnly
          ? "Expected exactly one existing password credential for this email. No password printed."
          : "No matching account. No reset issued.",
      );
    }
    console.log(
      passwordOnly
        ? `Password reset for ${email}. Deliver this password privately after identity verification. Other security state is unchanged.\nReplacement password: ${secret}`
        : `Account protection reset for ${email}. Deliver this token privately after identity verification.\nExpires: ${new Date(expiresAt).toISOString()}\nReset token: ${secret}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Reset failed. No credential printed.");
    return 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
