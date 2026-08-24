/**
 * Counts what happened and prints it once at the end.
 *
 * An import degrades content in ways the operator has to be able to act on, so every
 * skipped file, flattened block, and unresolved link is counted by reason with the first
 * page it appeared in. Progress lines are throttled so a long run stays readable.
 */
const PROGRESS_INTERVAL_MS = 5_000;

const plural = (count, singular) => `${count} ${count === 1 ? singular : `${singular}s`}`;

function printEntries(heading, entries) {
  if (!entries.size) return;
  console.log(heading);
  const sorted = [...entries.entries()].sort((left, right) => right[1].count - left[1].count);
  for (const [, entry] of sorted) {
    const where = entry.firstSeenIn ? ` first in "${entry.firstSeenIn}"` : "";
    console.log(`  ${entry.code.padEnd(32)} ${String(entry.count).padStart(6)}${where}`);
    if (entry.detail) console.log(`    ${entry.detail}`);
  }
}

export function createReport({ verbose = false } = {}) {
  const warnings = new Map();
  const errors = new Map();
  const lastPrinted = new Map();
  let context = null;

  const record = (target, code, detail) => {
    const key = detail ? `${code}:${detail}` : code;
    const entry = target.get(key) ?? { code, detail, count: 0, firstSeenIn: context };
    entry.count += 1;
    target.set(key, entry);
  };
  return {
    /** Names the page whose conversion is running, so issues can point at it. */
    inPage(title) {
      context = title;
    },
    issue(code, detail = "") {
      record(warnings, code, detail);
    },
    error(code, detail = "") {
      record(errors, code, detail);
    },
    get errorCount() {
      return [...errors.values()].reduce((total, entry) => total + entry.count, 0);
    },
    progress(phase, done, total, note = "") {
      const now = Date.now();
      const due = verbose || done === total || now - (lastPrinted.get(phase) ?? 0) >= PROGRESS_INTERVAL_MS;
      if (!due) return;
      lastPrinted.set(phase, now);
      console.log(`${phase}: ${done} of ${total}${note ? ` (${note})` : ""}.`);
    },
    print(summary) {
      const tables = summary.databases
        ? `, and ${plural(summary.databases, "table page")} holding ${plural(summary.rows ?? 0, "row")}.`
        : ".";
      console.log(
        `Imported ${plural(summary.pages, "page")}; wrote content for ${plural(summary.written, "page")}${tables}`,
      );
      if (warnings.size || errors.size) {
        console.log("");
        printEntries("Warnings (content was intentionally degraded):", warnings);
        if (warnings.size && errors.size) console.log("");
        printEntries("Data errors (the import is incomplete):", errors);
      }
      console.log("");
      console.log(
        "Search, backlinks, and mention previews follow a 30-second compaction alarm rather than these writes.",
      );
    },
  };
}
