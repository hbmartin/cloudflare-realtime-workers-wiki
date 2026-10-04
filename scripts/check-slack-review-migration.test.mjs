import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSlackReviewMigration } from "./check-slack-review-migration.mjs";

const entrypoint = fileURLToPath(new URL("./check-slack-review-migration.mjs", import.meta.url));
const listing = (names) => `Migrations to be applied:\n${names.join("\n")}\n`;

describe("Slack review migration deployment gate", () => {
  it.each(["0069_slack_file_cleanup.sql", "0070_slack_review_fences.sql"])(
    "requires confirmation while %s is pending",
    (migration) => {
      const pending = listing([migration]);
      expect(() => checkSlackReviewMigration(pending)).toThrow("manually confirmed safe upgrade");
      expect(checkSlackReviewMigration(pending, true)).toEqual([migration]);
    },
  );

  it.each([false, true])("accepts later releases regardless of confirmation: %s", (confirmed) => {
    expect(checkSlackReviewMigration("No migrations to apply!", confirmed)).toEqual([]);
    expect(checkSlackReviewMigration(listing(["0071_future.sql"]), confirmed)).toEqual(["0071_future.sql"]);
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
      input: listing(["0069_slack_file_cleanup.sql", "0070_slack_review_fences.sql"]),
    });
    expect(result.status).toBe(value === "true" ? 0 : 1);
    expect(value === "true" ? result.stdout : result.stderr).toContain(value === "true" ? "2 pending" : "16 minutes");
  });
});
