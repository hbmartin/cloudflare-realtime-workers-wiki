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

function normalizeEtag(value: string) {
  return value.trim().replace(/^W\//i, "");
}

function etagMatches(condition: string, etag: string) {
  return condition.trim() === "*"
    || condition.split(",").some((candidate) => normalizeEtag(candidate) === normalizeEtag(etag));
}

function validHttpDate(value: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function conditionalGetStatus(headers: Headers, object: Pick<R2Object, "httpEtag" | "uploaded">) {
  const uploadedAtSeconds = Math.floor(object.uploaded.getTime() / 1_000);
  const ifMatch = headers.get("if-match");
  if (ifMatch && !etagMatches(ifMatch, object.httpEtag)) return 412;

  if (!ifMatch) {
    const unmodifiedSince = validHttpDate(headers.get("if-unmodified-since"));
    if (unmodifiedSince !== null && uploadedAtSeconds > Math.floor(unmodifiedSince / 1_000)) return 412;
  }

  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch) return etagMatches(ifNoneMatch, object.httpEtag) ? 304 : 412;

  const modifiedSince = validHttpDate(headers.get("if-modified-since"));
  if (modifiedSince !== null && uploadedAtSeconds <= Math.floor(modifiedSince / 1_000)) return 304;
  return 412;
}
