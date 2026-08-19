/**
 * Counts what happened and prints it once at the end.
 *
 * An import degrades content in ways the operator has to be able to act on, so every
 * skipped file, flattened block, and unresolved link is counted by reason with the first
 * page it appeared in. Progress lines are throttled so a long run stays readable.
 */
const PROGRESS_INTERVAL_MS = 5_000;

const plural = (count, singular) => `${count} ${count === 1 ? singular : `${singular}s`}`;

export function createReport({ verbose = false } = {}) {
  const issues = new Map();
  const lastPrinted = new Map();
  let context = null;

  return {
    /** Names the page whose conversion is running, so issues can point at it. */
    inPage(title) {
      context = title;
    },
    issue(code, detail = "") {
      const key = detail ? `${code}:${detail}` : code;
      const entry = issues.get(key) ?? { count: 0, firstSeenIn: context };
      entry.count += 1;
      issues.set(key, entry);
    },
    progress(phase, done, total, note = "") {
      const now = Date.now();
      const due = verbose || done === total || now - (lastPrinted.get(phase) ?? 0) >= PROGRESS_INTERVAL_MS;
      if (!due) return;
      lastPrinted.set(phase, now);
      console.log(`${phase}: ${done} of ${total}${note ? ` (${note})` : ""}.`);
    },
    print(summary) {
      console.log(
        `Imported ${plural(summary.pages, "page")}; wrote content for ${summary.written}` +
          (summary.databases ? `, and created ${plural(summary.databases, "table page")}.` : "."),
      );
      if (issues.size) {
        console.log("");
        console.log("Skipped or degraded, by reason:");
        const sorted = [...issues.entries()].sort((left, right) => right[1].count - left[1].count);
        for (const [key, entry] of sorted) {
          const where = entry.firstSeenIn ? ` first in "${entry.firstSeenIn}"` : "";
          console.log(`  ${key.slice(0, 52).padEnd(54)} ${String(entry.count).padStart(6)}${where}`);
        }
      }
      console.log("");
      console.log(
        "Search, backlinks, and mention previews follow a 30-second compaction alarm rather than these writes.",
      );
    },
  };
}
