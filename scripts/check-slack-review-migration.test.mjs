import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSlackReviewMigration } from "./check-slack-review-migration.mjs";

const entrypoint = fileURLToPath(new URL("./check-slack-review-migration.mjs", import.meta.url));
const listing = (names) => `Migrations to be applied:\n${names.join("\n")}\n`;

describe("Slack review migration deployment gate", () => {
  it.each([
    "0069_slack_file_cleanup.sql",
    "0070_slack_review_fences.sql",
    "0071_slack_authorization_cleanup.sql",
    "0072_slack_link_authorization_started_at.sql",
    "0073_slack_membership_revocation.sql",
    "0074_slack_enqueue_recovery.sql",
    "0075_slack_delivery_recovery.sql",
    "0076_slack_delivery_recovery_followup.sql",
    "0077_slack_recovery_query_indexes.sql",
  ])("requires confirmation while %s is pending", (migration) => {
    const pending = listing([migration]);
    expect(() => checkSlackReviewMigration(pending)).toThrow("manually confirmed safe upgrade");
    expect(checkSlackReviewMigration(pending, true)).toEqual([migration]);
  });

  it.each([false, true])("accepts later releases regardless of confirmation: %s", (confirmed) => {
    expect(checkSlackReviewMigration("No migrations to apply!", confirmed)).toEqual([]);
    expect(checkSlackReviewMigration(listing(["0074_future.sql"]), confirmed)).toEqual(["0074_future.sql"]);
  });

  it.each(["", "Unexpected Wrangler output", "Migrations to be applied:\n(no table)"])(
    "rejects malformed listings even with confirmation: %s",
    (output) => {
      expect(() => checkSlackReviewMigration(output, true)).toThrow("recognizable migration listing");
    },
  );

  it.each([undefined, "false", "1", "true"])("executes the workflow entrypoint with confirmation %s", (value) => {
    const environment = { ...process.env };
    delete environment.SLACK_REVIEW_MIGRATION_SAFE;
    if (value !== undefined) environment.SLACK_REVIEW_MIGRATION_SAFE = value;
    const result = spawnSync(process.execPath, [entrypoint, "-"], {
      encoding: "utf8",
      env: environment,
      input: listing([
        "0069_slack_file_cleanup.sql",
        "0070_slack_review_fences.sql",
        "0071_slack_authorization_cleanup.sql",
      ]),
    });
    expect(result.status).toBe(value === "true" ? 0 : 1);
    expect(value === "true" ? result.stdout : result.stderr).toContain(value === "true" ? "3 pending" : "16 minutes");
  });
});
