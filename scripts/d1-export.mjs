// D1 refuses to export a database containing virtual tables:
//
//   D1 Export error: cannot export databases with Virtual Tables (fts5)
//
// `page_search` is an FTS5 index, so a plain `wrangler d1 export` of this
// schema exits 1 and writes nothing. Every authoritative table is ordinary,
// and the index is derived from `pages`, so this exports the real tables by
// name and leaves the index to be rebuilt on import. See
// docs/BACKUP_AND_RECOVERY.md for the reindex statement.
import { spawnSync } from "node:child_process";

const BINDING = "DB";
// Cloudflare's own bookkeeping. `d1_migrations` is deliberately kept: a
// restored database has to know which migrations it already has. Tables
// prefixed `sqlite_` are SQLite's (sequence counters, ANALYZE statistics); they
// are rebuilt by the engine, cannot be created by an import, and carry stale
// rows naming the FTS shadow tables this export drops.
const INTERNAL_TABLES = new Set(["_cf_METADATA"]);
const isSqliteInternal = (name) => name.startsWith("sqlite_");

const args = process.argv.slice(2);
let output = "backup.sql";
const passthrough = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--output" || arg === "-o") {
    output = args[index + 1] ?? output;
    index += 1;
  } else if (arg.startsWith("--output=")) {
    output = arg.slice("--output=".length);
  } else {
    passthrough.push(arg);
  }
}
if (!passthrough.includes("--local") && !passthrough.includes("--remote")) {
  console.error("Specify --local or --remote, matching the database you mean to export.");
  process.exit(1);
}

function wrangler(commandArgs, { capture = false } = {}) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...commandArgs], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? "";
}

// Shadow tables backing an FTS5 index (page_search_data, _idx, _content,
// _docsize, _config) report as ordinary tables in sqlite_master, so excluding
// `CREATE VIRTUAL TABLE` alone is not enough. Deriving the prefixes from the
// virtual tables actually present keeps this correct if another index is added.
const listing = wrangler(
  [
    "d1",
    "execute",
    BINDING,
    ...passthrough,
    "--json",
    "--command",
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ],
  { capture: true },
);

const parsed = JSON.parse(listing.slice(listing.indexOf("[")));
const rows = parsed.flatMap((result) => result.results ?? []);
if (rows.length === 0) {
  console.error("No tables found. Has `wrangler d1 migrations apply` run against this database?");
  process.exit(1);
}

const virtualTables = rows.filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? "")).map((row) => row.name);
const isDerived = (name) =>
  virtualTables.some((virtualTable) => name === virtualTable || name.startsWith(`${virtualTable}_`));
const tables = rows
  .map((row) => row.name)
  .filter((name) => !INTERNAL_TABLES.has(name) && !isSqliteInternal(name) && !isDerived(name));

console.log(`Exporting ${tables.length} tables; rebuilding ${virtualTables.join(", ") || "nothing"} on import.`);
wrangler(["d1", "export", BINDING, ...passthrough, "--output", output, ...tables.flatMap((name) => ["--table", name])]);
