import { readFileSync } from "node:fs";
import { parsePendingMigrations } from "./check-page-move-migration.mjs";

const GUARDED_MIGRATIONS = [
  "0069_slack_file_cleanup.sql",
  "0070_slack_review_fences.sql",
  "0071_slack_authorization_cleanup.sql",
  "0072_slack_link_authorization_started_at.sql",
  "0073_slack_membership_revocation.sql",
  "0074_slack_enqueue_recovery.sql",
  "0075_slack_delivery_recovery.sql",
];

export function checkSlackReviewMigration(output, confirmed = false) {
  const pending = parsePendingMigrations(output);
  if (!confirmed && GUARDED_MIGRATIONS.some((name) => pending.includes(name))) {
    throw new Error(
      "Slack review migrations require a manually confirmed safe upgrade.\n" +
        "Pause the delivery queue and disable live Slack channel validation, then allow 16 minutes for existing invocations to finish.\n" +
        "Keep both paused through migration and deployment. Set SLACK_REVIEW_MIGRATION_SAFE=true or manually dispatch with confirm_slack_review_migration_safe checked. See docs/DEPLOYMENT.md.",
    );
  }
  return pending;
}

if (typeof import.meta.main !== "boolean") {
  throw new Error("This script requires a Node.js runtime with import.meta.main support.");
}
if (import.meta.main) {
  try {
    const listingPath = process.argv[2];
    if (!listingPath) throw new Error("Pass the captured Wrangler migration listing path.");
    const listing = readFileSync(listingPath === "-" ? 0 : listingPath, "utf8");
    const pending = checkSlackReviewMigration(listing, process.env.SLACK_REVIEW_MIGRATION_SAFE === "true");
    console.log(`Recognized Wrangler migration listing (${pending.length} pending).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
