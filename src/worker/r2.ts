export function normalizeR2Range(range: R2Range, size: number) {
  const objectSize = Math.max(0, size);
  // R2's runtime object exposes all three keys as getters, so `"suffix" in
  // range` is true even for bounded ranges. Discriminate by the value.
  const suffix = (range as { suffix?: number }).suffix;
  if (typeof suffix === "number") {
    const length = Math.min(Math.max(0, suffix), objectSize);
    return { offset: objectSize - length, length };
  }
  const bounded = range as { offset?: number; length?: number };
  const offset = Math.min(Math.max(0, bounded.offset ?? 0), objectSize);
  const available = objectSize - offset;
  const length = Math.min(Math.max(0, bounded.length ?? available), available);
  return { offset, length };
}
