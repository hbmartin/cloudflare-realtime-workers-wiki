import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPageMoveMigration, parsePendingMigrations } from "./check-page-move-migration.mjs";

const entrypoint = fileURLToPath(new URL("./check-page-move-migration.mjs", import.meta.url));
const noPending = "✅ No migrations to apply!\n";
const pending = `Migrations to be applied:
┌────────────────────────────────────────┐
│ Name                                   │
├────────────────────────────────────────┤
│ 0010_page_moves.sql                    │
│ 0011_page_move_receipt_envelopes.sql   │
└────────────────────────────────────────┘
`;

describe("page-move migration deployment gate", () => {
  it("parses empty and populated Wrangler migration listings", () => {
    expect(parsePendingMigrations(noPending)).toEqual([]);
    expect(parsePendingMigrations(pending)).toEqual(["0010_page_moves.sql", "0011_page_move_receipt_envelopes.sql"]);
  });

  it.each(["", "Wrangler changed its output", "Migrations to be applied:\n(no table)"])(
    "fails closed for an unrecognized listing: %j",
    (output) => {
      expect(() => parsePendingMigrations(output)).toThrow(
        "Wrangler did not return a recognizable migration listing; refusing to deploy.",
      );
    },
  );

  it("requires explicit confirmation while migration 0011 is pending", () => {
    expect(() => checkPageMoveMigration(pending)).toThrow("0011 requires a manually confirmed safe upgrade.");
    expect(checkPageMoveMigration(pending, true)).toContain("0011_page_move_receipt_envelopes.sql");
  });

  it("executes the same entry point used by the deployment workflow", () => {
    const rejected = spawnSync(process.execPath, [entrypoint, "-"], { encoding: "utf8", input: pending });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("0011 requires a manually confirmed safe upgrade.");

    const accepted = spawnSync(process.execPath, [entrypoint, "-"], {
      encoding: "utf8",
      env: { ...process.env, PAGE_MOVE_RECEIPT_MIGRATION_SAFE: "true" },
      input: pending,
    });
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("Recognized Wrangler migration listing (2 pending).");
  });
});
