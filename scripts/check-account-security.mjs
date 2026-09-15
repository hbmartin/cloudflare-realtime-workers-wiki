// Read-only deployment preflight. Never prints account identifiers or credentials.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const USAGE =
  "Usage: node scripts/check-account-security.mjs --remote --env production (or --local [--persist-to path])";

function options(argv) {
  const args = [...argv];
  if (args.filter((arg) => arg === "--local" || arg === "--remote").length !== 1) throw new Error(USAGE);
  for (let i = 0; i < args.length; i++) {
    if (["--env", "--persist-to"].includes(args[i])) {
      if (!args[++i] || args[i].startsWith("--")) throw new Error("Missing option value");
    } else if (!["--local", "--remote"].includes(args[i])) {
      throw new Error(`Unknown option: ${args[i]}`);
    }
  }
  if (args.includes("--remote") && !args.includes("--env")) args.push("--env", "production");
  return args;
}

function rowsFromWrangler(result) {
  if (result.status !== 0) {
    const details = `${result.stderr ?? ""} ${result.error?.message ?? ""}`;
    const reason = /unauthorized|forbidden|authentication|permission|expired|invalid token/i.test(details)
      ? "authentication or permission error"
      : /timeout|timed out|etimedout/i.test(details)
        ? "timeout"
        : /network|connection|enotfound|econnreset/i.test(details)
          ? "network error"
          : "query error";
    throw new Error(`Wrangler query failed (${reason}; exit ${result.status ?? "unknown"})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned malformed JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => !entry || entry.success === false || !Array.isArray(entry.results))
  ) {
    throw new Error("Wrangler returned an invalid result shape");
  }
  const rows = parsed.flatMap((entry) => entry.results);
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Wrangler returned an invalid result row");
  }
  return rows;
}

export function main(argv, execute) {
  try {
    const args = options(argv);
    const query = (sql) => rowsFromWrangler(execute(["d1", "execute", "DB", ...args, "--json", "--command", sql]));
    const schema = query("SELECT name,type FROM sqlite_master WHERE type IN ('table','trigger');");
    if (schema.some((row) => typeof row.name !== "string" || typeof row.type !== "string")) {
      throw new Error("Wrangler returned an invalid schema result");
    }
    const required = new Map([
      ["d1_migrations", "table"],
      ["user", "table"],
      ["invites", "table"],
      ["account_security", "table"],
      ["session_security", "table"],
      ["twoFactor", "table"],
      ["passkey", "table"],
      ["pending_passkeys", "table"],
      ["initialize_account_security", "trigger"],
      ["authorize_passkey_insert", "trigger"],
      ["complete_invite", "trigger"],
    ]);
    const missing = [...required]
      .filter(([name, type]) => !schema.some((row) => row.name === name && row.type === type))
      .map(([name]) => name);
    if (missing.length) {
      console.error(JSON.stringify({ check: "security-schema", outcome: "FAIL", missing }));
      return 1;
    }
    const columns = query("PRAGMA table_info(invites);");
    const migrations = query(
      "SELECT name FROM d1_migrations WHERE name IN ('0028_mandatory_security.sql','0029_security_lifecycle.sql');",
    );
    const integrityRows = query(
      "SELECT COUNT(*) AS users_missing_security FROM user u LEFT JOIN account_security a ON a.user_id=u.id WHERE a.user_id IS NULL;",
    );
    if (
      columns.some((row) => typeof row.name !== "string") ||
      migrations.some((row) => typeof row.name !== "string") ||
      integrityRows.length !== 1 ||
      !Number.isSafeInteger(integrityRows[0].users_missing_security) ||
      integrityRows[0].users_missing_security < 0
    ) {
      throw new Error("Wrangler returned an invalid check result");
    }
    const missingColumns = ["claimed_by", "claimed_email"].filter(
      (name) => !columns.some((column) => column.name === name),
    );
    const integrity = integrityRows[0];
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
    return passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Account security preflight failed");
    return 2;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), (args) => {
    const wrangler = createRequire(import.meta.url).resolve("wrangler");
    return spawnSync(process.execPath, [wrangler, ...args], { encoding: "utf8", timeout: 60_000 });
  });
}
