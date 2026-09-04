import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NO_PENDING_MIGRATIONS = "No migrations to apply!";
const PENDING_MIGRATIONS = "Migrations to be applied:";
const PAGE_MOVE_RECEIPT_MIGRATION = "0011_page_move_receipt_envelopes.sql";

export function parsePendingMigrations(output) {
  const hasNoPendingMigrations = output.includes(NO_PENDING_MIGRATIONS);
  const pendingMarkerIndex = output.indexOf(PENDING_MIGRATIONS);
  if (hasNoPendingMigrations && pendingMarkerIndex === -1) return [];
  if (hasNoPendingMigrations || pendingMarkerIndex === -1) {
    throw new Error("Wrangler did not return a recognizable migration listing; refusing to deploy.");
  }

  const names = output.slice(pendingMarkerIndex + PENDING_MIGRATIONS.length).match(/\b[\w.-]+\.sql\b/g) ?? [];
  if (names.length === 0) {
    throw new Error("Wrangler did not return a recognizable migration listing; refusing to deploy.");
  }
  return [...new Set(names)];
}

export function checkPageMoveMigration(output, confirmed = false) {
  const pending = parsePendingMigrations(output);
  if (pending.includes(PAGE_MOVE_RECEIPT_MIGRATION) && !confirmed) {
    throw new Error(
      "0011 requires a manually confirmed safe upgrade.\n" +
        "Quiesce page moves or deploy a compatible bridge Worker, then run this workflow manually with the 0011 confirmation checked.",
    );
  }
  return pending;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const listingPath = process.argv[2];
    if (!listingPath) throw new Error("Pass the captured Wrangler migration listing path.");
    const listing = readFileSync(listingPath === "-" ? 0 : listingPath, "utf8");
    const pending = checkPageMoveMigration(listing, process.env.PAGE_MOVE_RECEIPT_MIGRATION_SAFE === "true");
    console.log(`Recognized Wrangler migration listing (${pending.length} pending).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
