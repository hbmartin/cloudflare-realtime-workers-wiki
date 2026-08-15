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

function normalizeWeakEtag(value: string) {
  return value.trim().replace(/^W\//i, "");
}

function splitEntityTags(condition: string) {
  const tags: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < condition.length; index += 1) {
    const character = condition[index];
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      tags.push(condition.slice(start, index));
      start = index + 1;
    }
  }
  tags.push(condition.slice(start));
  return tags;
}

function weakEtagMatches(condition: string, etag: string) {
  return condition.trim() === "*"
    || splitEntityTags(condition).some((candidate) => normalizeWeakEtag(candidate) === normalizeWeakEtag(etag));
}

function strongEtagMatches(condition: string, etag: string) {
  const normalizedEtag = etag.trim();
  if (condition.trim() === "*") return true;
  if (/^W\//i.test(normalizedEtag)) return false;
  return splitEntityTags(condition).some((candidate) => {
    const normalizedCandidate = candidate.trim();
    return !/^W\//i.test(normalizedCandidate) && normalizedCandidate === normalizedEtag;
  });
}

function validHttpDate(value: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function conditionalGetStatus(headers: Headers, object: Pick<R2Object, "httpEtag" | "uploaded">) {
  const uploadedAtSeconds = Math.floor(object.uploaded.getTime() / 1_000);
  const ifMatch = headers.get("if-match");
  if (ifMatch && !strongEtagMatches(ifMatch, object.httpEtag)) return 412;

  if (!ifMatch) {
    const unmodifiedSince = validHttpDate(headers.get("if-unmodified-since"));
    if (unmodifiedSince !== null && uploadedAtSeconds > Math.floor(unmodifiedSince / 1_000)) return 412;
  }

  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch) return weakEtagMatches(ifNoneMatch, object.httpEtag) ? 304 : 200;

  const modifiedSince = validHttpDate(headers.get("if-modified-since"));
  if (modifiedSince !== null && uploadedAtSeconds <= Math.floor(modifiedSince / 1_000)) return 304;
  return 200;
}
