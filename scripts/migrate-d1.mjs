import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parsePendingMigrations } from "./check-page-move-migration.mjs";
import { checkSlackReviewMigration } from "./check-slack-review-migration.mjs";

// Match 0067's backfill exactly: only each receipt's first ten changed pages.
export const digestCollisionSql = `WITH selected_pages AS (
  SELECT r.id receipt_id,e.page_id,
    row_number() OVER (PARTITION BY r.id ORDER BY max(e.created_at) DESC,e.page_id) page_rank
  FROM slack_digest_receipts r JOIN slack_channel_events e ON e.subscription_id=r.subscription_id
  WHERE r.state='pending' AND e.cadence='digest' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
    AND e.created_at>=r.window_start AND e.created_at<r.window_end
  GROUP BY r.id,e.page_id
), assignments AS (
  SELECT e.id event_id,r.id receipt_id FROM selected_pages p
  JOIN slack_digest_receipts r ON r.id=p.receipt_id
  JOIN slack_channel_events e ON e.subscription_id=r.subscription_id AND e.page_id=p.page_id
  WHERE p.page_rank<=10 AND e.cadence='digest' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
    AND e.created_at>=r.window_start AND e.created_at<r.window_end
), collisions AS (
  SELECT event_id,count(*) receipt_count FROM assignments GROUP BY event_id HAVING count(*)>1
)
SELECT c.event_id,c.receipt_count,count(*) OVER () collision_count,
  (SELECT json_group_array(receipt_id) FROM
    (SELECT receipt_id FROM assignments a WHERE a.event_id=c.event_id ORDER BY receipt_id LIMIT 10)) receipts_json
FROM collisions c ORDER BY c.event_id LIMIT 20;`;

function checkResult(result, stage) {
  if (result.error?.code === "ETIMEDOUT")
    throw new Error(`Wrangler ${stage} timed out${result.signal ? ` (${result.signal})` : ""}.`);
  if (result.status !== 0)
    throw new Error(`Wrangler ${stage} failed.${result.stderr?.trim() ? ` ${result.stderr.trim()}` : ""}`);
}

function queryRows(result, stage) {
  checkResult(result, stage);
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Wrangler ${stage} returned malformed JSON.`);
  }
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((entry) => !entry || entry.success !== true || !Array.isArray(entry.results))
  )
    throw new Error(`Wrangler ${stage} returned an invalid result.`);
  return value.flatMap((entry) => entry.results);
}

export function main(argv, execute, { slackReviewMigrationSafe = false } = {}) {
  try {
    const args = [...argv];
    let preflightTimeoutMs = 300_000;
    const timeoutOption = args.indexOf("--preflight-timeout-ms");
    if (timeoutOption !== -1) {
      const value = args[timeoutOption + 1];
      if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
        throw new Error("--preflight-timeout-ms requires a positive integer.");
      preflightTimeoutMs = Number(value);
      args.splice(timeoutOption, 2);
    }
    if (args.filter((arg) => arg === "--local" || arg === "--remote").length !== 1)
      throw new Error("Choose --local or --remote.");
    for (let i = 0; i < args.length; i++) {
      if (["--env", "--persist-to"].includes(args[i])) {
        if (!args[++i] || args[i].startsWith("--")) throw new Error("Missing migration option value.");
      } else if (!["--local", "--remote"].includes(args[i])) throw new Error(`Unknown migration option: ${args[i]}`);
    }
    const listing = execute(["d1", "migrations", "list", "DB", ...args], { timeout: 60_000, stdio: "pipe" });
    checkResult(listing, "migration listing");
    const pending = parsePendingMigrations(listing.stdout);
    if (args.includes("--remote")) checkSlackReviewMigration(listing.stdout, slackReviewMigrationSafe);
    if (pending.includes("0067_review_delivery.sql")) {
      const query = (sql, stage) =>
        queryRows(
          execute(["d1", "execute", "DB", ...args, "--json", "--command", sql], {
            timeout: preflightTimeoutMs,
            stdio: "pipe",
          }),
          stage,
        );
      const schema = query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('slack_digest_receipts','slack_channel_events');",
        "migration schema preflight",
      );
      if (schema.some((row) => !row || typeof row.name !== "string"))
        throw new Error("Invalid preflight schema result.");
      if (schema.length === 2) {
        const collisions = query(digestCollisionSql, "digest collision preflight");
        if (
          collisions.some(
            (row) =>
              !row ||
              typeof row.event_id !== "string" ||
              !Number.isSafeInteger(row.receipt_count) ||
              row.receipt_count < 2 ||
              !Number.isSafeInteger(row.collision_count) ||
              row.collision_count < 1 ||
              typeof row.receipts_json !== "string",
          )
        )
          throw new Error("Invalid digest collision result.");
        if (collisions.length) {
          const samples = collisions.slice(0, 20).map((row) => {
            const receipts = JSON.parse(row.receipts_json);
            if (!Array.isArray(receipts) || receipts.length > 10 || receipts.some((id) => typeof id !== "string"))
              throw new Error("Invalid receipt identifiers.");
            return {
              eventId: row.event_id.slice(0, 200),
              receiptCount: row.receipt_count,
              receipts: receipts.map((id) => id.slice(0, 200)),
            };
          });
          console.error(
            JSON.stringify({
              check: "0067-digest-assignments",
              outcome: "FAIL",
              collisionCount: collisions[0].collision_count,
              samples,
            }),
          );
          throw new Error(
            "0067 would assign events to multiple pending digest receipts. Stop legacy digest scheduling, export D1, and repair the reported windows before retrying. No migrations were applied.",
          );
        }
      } else if (
        !pending.includes("0066_slack_round2.sql") ||
        schema.some((row) => row.name === "slack_digest_receipts")
      ) {
        throw new Error("Legacy digest schema is incomplete; refusing to apply migrations.");
      }
    }
    const applied = execute(["d1", "migrations", "apply", "DB", ...args], { stdio: "inherit" });
    if (applied.stdout) console.log(applied.stdout);
    checkResult(applied, "migration application");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (typeof import.meta.main !== "boolean")
  throw new Error("This script requires a Node.js runtime with import.meta.main support.");
if (import.meta.main) {
  const wrangler = createRequire(import.meta.url).resolve("wrangler");
  process.exitCode = main(
    process.argv.slice(2),
    (args, options) =>
      spawnSync(process.execPath, [wrangler, ...args], {
        encoding: "utf8",
        ...options,
      }),
    { slackReviewMigrationSafe: process.env.SLACK_REVIEW_MIGRATION_SAFE === "true" },
  );
}
