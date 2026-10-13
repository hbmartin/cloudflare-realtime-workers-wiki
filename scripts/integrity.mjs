import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { evaluateMetadataIntegrity, INTEGRITY_PAGE_COLUMNS, integrityMetadataSql } from "../src/shared/integrity.ts";
import { emptyDatabaseSchema, queryRows } from "./migrate-d1.mjs";

/** Read-only metadata check usable by REST or Wrangler deployment adapters. */
export function metadataIntegrityCheck(query, { limit = 100_000 } = {}) {
  const tables = query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", "integrity schema");
  if (emptyDatabaseSchema(tables))
    return {
      ok: true,
      complete: true,
      checkedPages: 0,
      failures: [],
      incomplete: [],
      classifications: {},
      supportedTables: [],
    };
  const names = new Set(tables.map((table) => table.name));
  if (!names.has("pages") || !names.has("spaces") || !names.has("workspaces"))
    return {
      ok: false,
      complete: false,
      checkedPages: 0,
      failures: [],
      incomplete: [{ code: "unsupported_core_schema" }],
      classifications: {},
    };
  const columns = new Set(query("PRAGMA table_info(pages)", "integrity page schema").map((column) => column.name));
  if (INTEGRITY_PAGE_COLUMNS.split(",").some((column) => !columns.has(column)))
    return {
      ok: false,
      complete: false,
      checkedPages: 0,
      failures: [],
      incomplete: [{ code: "unsupported_page_schema" }],
      classifications: {},
    };
  const statements = integrityMetadataSql(limit);
  const supported = {
    workspaces: true,
    pages: true,
    spaces: true,
    rowPages: names.has("table_row_pages") && names.has("table_rows"),
    sources: names.has("page_import_sources"),
    artifacts: names.has("attachments"),
  };
  const sourceTables = {
    workspaces: "workspaces",
    pages: "pages",
    spaces: "spaces",
    rowPages: "table_row_pages",
    sources: "page_import_sources",
    artifacts: "attachments",
  };
  const summarySql = Object.entries(supported)
    .filter(([, enabled]) => enabled)
    .map(([key]) => `SELECT '${key}' source,count(*) rows FROM ${sourceTables[key]}`)
    .join(" UNION ALL ");
  const counts = query(summarySql, "integrity coverage counts");
  if (
    counts.some((row) => !supported[row.source] || !Number.isSafeInteger(row.rows) || row.rows < 0) ||
    counts.length !== Object.values(supported).filter(Boolean).length
  )
    throw new Error("Invalid integrity coverage counts.");
  const baselineSql =
    "SELECT count(*) pages,cast(coalesce(sum(revision),0) AS TEXT) revisions,cast(coalesce(sum(content_epoch),0) AS TEXT) epochs,cast(coalesce(sum(updated_at),0) AS TEXT) updates FROM pages";
  const baseline = query(baselineSql, "integrity initial revision");
  const data = { complete: true };
  for (const [key, sql] of Object.entries(statements)) {
    const rows = supported[key] ? query(sql, `integrity ${key}`) : [];
    if (rows.length > limit || (supported[key] && rows.length !== counts.find((row) => row.source === key)?.rows))
      data.complete = false;
    data[key] = rows.slice(0, limit);
  }
  const result = evaluateMetadataIntegrity(data);
  if (JSON.stringify(baseline) !== JSON.stringify(query(baselineSql, "integrity final revision"))) {
    result.incomplete.push({ code: "workspace_revision_changed" });
    result.complete = false;
    result.ok = false;
  }
  return { ...result, supportedTables: Object.keys(supported).filter((key) => supported[key]) };
}

/** Follow every owner API cursor; an incomplete, stale or failed scan can never pass. */
export async function contentIntegrityCheck(baseUrl, cookie, { fetcher = fetch, maxBatches = 10_000 } = {}) {
  if (!baseUrl || !cookie) throw new Error("Content checks require INTEGRITY_BASE_URL and INTEGRITY_SESSION_COOKIE.");
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))
    throw new Error("Integrity API URL must use HTTPS.");
  const failures = [];
  const incomplete = [];
  const classifications = {};
  const seen = new Set();
  let cursor;
  let checkedPages = 0;
  let totalPages;
  for (let batch = 0; batch < maxBatches; batch++) {
    const url = new URL("/api/admin/integrity", base);
    url.searchParams.set("mode", "content");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetcher(url, {
      headers: { cookie },
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Integrity API returned HTTP ${response.status}.`);
    const body = await response.json();
    if (
      !body ||
      body.scope !== "stored_canonical_content" ||
      !Array.isArray(body.failures) ||
      !Array.isArray(body.incomplete) ||
      !Number.isSafeInteger(body.checkedPages) ||
      body.checkedPages < 0 ||
      !Number.isSafeInteger(body.totalPages) ||
      body.totalPages < 0 ||
      typeof body.complete !== "boolean" ||
      !(body.nextCursor === null || typeof body.nextCursor === "string")
    )
      throw new Error("Integrity API returned invalid coverage metadata.");
    if (totalPages !== undefined && totalPages !== body.totalPages)
      incomplete.push({ code: "workspace_revision_changed" });
    totalPages = body.totalPages;
    checkedPages += body.checkedPages;
    failures.push(...body.failures);
    incomplete.push(...body.incomplete);
    for (const [kind, count] of Object.entries(body.classifications ?? {})) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Integrity API returned invalid classifications.");
      classifications[kind] = (classifications[kind] ?? 0) + count;
    }
    if (!body.nextCursor) {
      if (!body.complete || checkedPages !== totalPages) incomplete.push({ code: "content_coverage_incomplete" });
      return {
        ok: failures.length === 0 && incomplete.length === 0,
        complete: incomplete.length === 0,
        checkedPages,
        totalPages,
        failures,
        incomplete,
        classifications,
      };
    }
    if (seen.has(body.nextCursor) || body.checkedPages === 0) throw new Error("Integrity API cursor did not advance.");
    seen.add(body.nextCursor);
    cursor = body.nextCursor;
  }
  return {
    ok: false,
    complete: false,
    checkedPages,
    totalPages,
    failures,
    incomplete: [...incomplete, { code: "integrity_batch_limit" }],
    classifications,
  };
}

export async function main(argv, execute, environment = process.env) {
  try {
    const args = [...argv];
    const content = args.includes("--content");
    const metadata = args.includes("--metadata");
    if (content && metadata) throw new Error("Choose --metadata or --content.");
    const passthrough = args.filter((arg) => arg !== "--metadata" && arg !== "--content");
    let result;
    if (content) {
      if (passthrough.length) throw new Error("Content mode uses INTEGRITY_BASE_URL and INTEGRITY_SESSION_COOKIE.");
      result = await contentIntegrityCheck(environment.INTEGRITY_BASE_URL, environment.INTEGRITY_SESSION_COOKIE);
    } else {
      if (passthrough.filter((arg) => arg === "--local" || arg === "--remote").length !== 1)
        throw new Error("Choose --local or --remote.");
      for (let i = 0; i < passthrough.length; i++) {
        if (["--env", "--persist-to", "--config"].includes(passthrough[i])) {
          if (!passthrough[++i] || passthrough[i].startsWith("--")) throw new Error("Missing integrity option value.");
        } else if (!["--local", "--remote"].includes(passthrough[i]))
          throw new Error(`Unknown integrity option: ${passthrough[i]}`);
      }
      result = metadataIntegrityCheck((sql, stage) =>
        queryRows(
          execute(["d1", "execute", "DB", ...passthrough, "--json", "--command", sql], {
            timeout: 300_000,
            stdio: "pipe",
          }),
          stage,
        ),
      );
    }
    console.log(JSON.stringify({ check: content ? "stored-content-integrity" : "metadata-integrity", ...result }));
    return result.ok && result.complete ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const wrangler = createRequire(import.meta.url).resolve("wrangler");
  process.exitCode = await main(process.argv.slice(2), (args, options) =>
    spawnSync(process.execPath, [wrangler, ...args], { encoding: "utf8", ...options }),
  );
}
