/**
 * The one filename normalization, applied by the Worker before storing a name and by
 * the import CLI before hashing upload metadata. Both sides must produce identical
 * bytes or every canonical requestHash comparison fails, so there is exactly one copy.
 *
 * Idempotent by construction: the trailing trim runs after the length cap, so
 * re-normalizing an already-normalized name is a no-op even when the cap lands on
 * whitespace.
 */
export function normalizeFilename(name: string) {
  return (
    name
      .replace(/[\r\n"\\/]/g, "_")
      .trim()
      .slice(0, 180)
      .trim() || "download"
  );
}
