// Read-only deployment preflight. Never prints account identifiers or credentials.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const wrangler = createRequire(import.meta.url).resolve("wrangler");

const args = process.argv.slice(2);
if (args.filter((arg) => arg === "--local" || arg === "--remote").length !== 1) {
  console.error(
    "Usage: node scripts/check-account-security.mjs --remote --env production (or --local [--persist-to path])",
  );
  process.exit(2);
}
for (let i = 0; i < args.length; i++) {
  if (["--env", "--persist-to"].includes(args[i])) {
    if (!args[++i] || args[i].startsWith("--")) throw new Error("Missing option value");
  } else if (!["--local", "--remote"].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
}
if (args.includes("--remote") && !args.includes("--env")) args.push("--env", "production");

function query(sql) {
  const result = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", ...args, "--json", "--command", sql], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || result.error?.message);
    process.exit(2);
  }
  return JSON.parse(result.stdout).flatMap((entry) => entry.results ?? []);
}

const schema = query("SELECT name,type FROM sqlite_master WHERE type IN ('table','trigger');");
const names = new Set(schema.map((row) => row.name));
const required = [
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
const missing = required.filter((name) => !names.has(name));
if (missing.length) {
  console.error(JSON.stringify({ check: "security-schema", outcome: "FAIL", missing }));
  process.exit(1);
}
const columns = query("PRAGMA table_info(invites);");
const missingColumns = ["claimed_by", "claimed_email"].filter(
  (name) => !columns.some((column) => column.name === name),
);
const migrations = query(
  "SELECT name FROM d1_migrations WHERE name IN ('0028_mandatory_security.sql','0029_security_lifecycle.sql');",
);
const integrity = query(
  "SELECT COUNT(*) AS users_missing_security FROM user u LEFT JOIN account_security a ON a.user_id=u.id WHERE a.user_id IS NULL;",
)[0];
const passed = !missingColumns.length && migrations.length === 2 && integrity.users_missing_security === 0;
console.log(
  JSON.stringify(
    {
      check: "account-security",
      outcome: passed ? "PASS" : "FAIL",
      missingColumns,
      migrations: migrations.map((row) => row.name),
      ...integrity,
    },
    null,
    2,
  ),
);
process.exitCode = passed ? 0 : 1;
