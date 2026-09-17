import { AsyncLocalStorage } from "node:async_hooks";
import {
  boundedLogString,
  errorLogFields,
  LOG_IDENTIFIER_LIMIT,
  LOG_STACK_LIMIT,
  LOG_TEXT_LIMIT,
  TRUNCATION_MARKER,
  rawSafeErrorMessage,
  wellFormedPrefix,
} from "../shared/error-log.ts";
import type { Env } from "./env";

export const OBSERVABILITY_SCHEMA = "notes.observability.v1";

export type ObservabilityTrigger = "fetch" | "scheduled" | "queue" | "workflow" | "durable-object";

export interface ObservabilityContext {
  requestId?: string;
  correlationId?: string;
  rayId?: string;
  trigger: ObservabilityTrigger;
  versionId?: string;
  versionTag?: string;
  metricRouteTemplate?: string;
}

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Readonly<Record<string, unknown>>;

const contextStorage = new AsyncLocalStorage<ObservabilityContext>();
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|body|content|payload|email/i;
const AUTHORIZATION_LABEL = String.raw`(?:HTTP_(?:PROXY_)?AUTHORIZATION|(?:proxy-)?authorization|(?:proxy)?authorizationHeader)`;
const AUTHORIZATION_VALUE_WRAPPERS = String.raw`(?:(?:\\*["']|[\[({])[ \t]*)*`;
const LABELED_AUTHORIZATION_PREFIX = new RegExp(
  String.raw`\b${AUTHORIZATION_LABEL}(?:\\*["'])?(?:[ \t]*(?::|=>|=|,)[ \t]*|[ \t]+)(${AUTHORIZATION_VALUE_WRAPPERS})(?:Basic|Bearer)[ \t]+`,
  "gi",
);
const UNDICI_AUTHORIZATION_PREFIX =
  /\bname[ \t\r\n]*:[ \t\r\n]*(?:\\*["'])(?:proxy-)?authorization(?:\\*["'])[ \t\r\n]*,[ \t\r\n]*value[ \t\r\n]*:[ \t\r\n]*((?:\\*["']))(?:Basic|Bearer)[ \t]+/gi;
const BASIC_VALUE = /\bBasic[ \t]+([A-Za-z0-9+/_=-]+)/gi;
const BEARER_VALUE = /\bBearer[ \t]+([A-Za-z0-9._~+/=-]+)/gi;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;
const SECRET_VALUE = /\b(?:(?:sk|crn|ghp|github_pat|secret)_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gi;
const PARTIAL_SECRET_VALUE = /\b(?:(?:sk|crn|ghp|github_pat|secret)_[A-Za-z0-9_-]*|xox[baprs]-[A-Za-z0-9-]*)$/i;
const NESTED_VALUE_BUDGET = 100;
const REDACTED_VALUE = "[redacted]";
const OMITTED_ENTRIES = "[entries omitted]";
const OMITTED_VALUE = "[value omitted]";
const PROPERTY_OMITTED = "[property omitted]";
const DEPTH_OMITTED = "[depth omitted]";
const CIRCULAR_VALUE = "[circular]";
const OBJECT_OMITTED = "[object omitted]";
const EMPTY_KEY = "[empty key]";
const FUNCTION_OMITTED = "[function omitted]";
const SYMBOL_OMITTED = "[symbol omitted]";
const RESERVED_LOG_FIELDS = new Set([
  "schema",
  "event",
  "severity",
  "component",
  "message",
  "trigger",
  "requestId",
  "correlationId",
  "rayId",
  "versionId",
  "versionTag",
]);

function versionContext(env: Env) {
  const metadata = env.CF_VERSION_METADATA;
  return {
    ...(metadata?.id ? { versionId: metadata.id } : {}),
    ...(metadata?.tag ? { versionTag: metadata.tag } : {}),
  };
}

export function withObservabilityContext<T>(
  env: Env,
  context: Omit<ObservabilityContext, "versionId" | "versionTag">,
  callback: () => T,
) {
  return contextStorage.run({ ...context, ...versionContext(env) }, callback);
}

export function currentObservabilityContext() {
  return contextStorage.getStore();
}

export function setMetricRouteTemplate(template: string) {
  const context = currentObservabilityContext();
  if (context) context.metricRouteTemplate = template || "/unmatched";
}

export function metricRouteTemplate() {
  return currentObservabilityContext()?.metricRouteTemplate ?? "/unmatched";
}

export function correlationHeaders(): Record<string, string> {
  const context = currentObservabilityContext();
  const correlationId = context?.correlationId ?? context?.requestId;
  return correlationId ? { "x-request-id": correlationId } : {};
}

export function withDurableObjectContext<T>(env: Env, request: Request, callback: () => T) {
  const correlationId = request.headers.get("x-request-id") ?? undefined;
  return withObservabilityContext(
    env,
    {
      trigger: "durable-object",
      ...(correlationId ? { requestId: correlationId, correlationId } : {}),
    },
    callback,
  );
}

function isAsciiLetter(code: number) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number) {
  return code >= 48 && code <= 57;
}

function isAsciiWord(code: number) {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 95;
}

function isEmailLocal(code: number) {
  return isAsciiLetter(code) || isAsciiDigit(code) || "._%+-".includes(String.fromCharCode(code));
}

function isEmailDomain(code: number) {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 46 || code === 45;
}

function redactEmails(value: string) {
  const parts: string[] = [];
  let cursor = 0;
  let at = value.indexOf("@");
  while (at >= 0) {
    let start = at;
    while (start > cursor && isEmailLocal(value.charCodeAt(start - 1))) start -= 1;
    while (start < at && !isAsciiWord(value.charCodeAt(start))) start += 1;

    let end = at + 1;
    let dot = -1;
    let tldLength = 0;
    let validTld = false;
    let validEnd = -1;
    while (end < value.length && isEmailDomain(value.charCodeAt(end))) {
      const code = value.charCodeAt(end);
      if (code === 46) {
        dot = end;
        tldLength = 0;
        validTld = true;
      } else if (dot >= 0) {
        validTld = validTld && isAsciiLetter(code);
        tldLength += 1;
      }
      const next = value.charCodeAt(end + 1);
      if (dot > at + 1 && validTld && tldLength >= 2 && !isAsciiWord(next)) validEnd = end + 1;
      end += 1;
    }

    if (start < at && validEnd > 0) {
      parts.push(value.slice(cursor, start), "[redacted-email]");
      cursor = validEnd;
    }
    at = value.indexOf("@", Math.max(at + 1, cursor));
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

function redactBasicValue(match: string, encoded: string, atBoundary = false) {
  try {
    if (atob(encoded).includes(":")) return match.slice(0, match.length - encoded.length) + REDACTED_VALUE;
  } catch {
    // Malformed Base64 and ordinary prose are not credentials.
  }
  if (atBoundary) return match.slice(0, match.length - encoded.length) + REDACTED_VALUE;
  return match;
}

function redactBearerValue(match: string, token: string, force = false) {
  const trailingPunctuation = token.match(/\.+$/)?.[0] ?? "";
  const candidate = token.slice(0, token.length - trailingPunctuation.length);
  return force || candidate.length >= 16 || /[0-9._~+/=-]/.test(candidate)
    ? match.slice(0, match.length - token.length) + REDACTED_VALUE + trailingPunctuation
    : match;
}

function partialEmailStart(value: string) {
  const at = value.lastIndexOf("@");
  if (at < 0) return -1;
  let start = at;
  while (start > 0 && isEmailLocal(value.charCodeAt(start - 1))) start -= 1;
  if (start === at) return -1;
  for (let index = at + 1; index < value.length; index += 1) {
    if (!isEmailDomain(value.charCodeAt(index))) return -1;
  }
  return start;
}

type QuoteDelimiter = { backslashes: number; quote: '"' | "'" };

function precedingBackslashes(value: string, index: number, lowerBound = 0) {
  let start = index;
  while (start > lowerBound && value[start - 1] === "\\") start -= 1;
  return index - start;
}

function lastQuoteDelimiter(value: string): QuoteDelimiter | undefined {
  let delimiter: QuoteDelimiter | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '"' && character !== "'") continue;
    delimiter = { backslashes: precedingBackslashes(value, index), quote: character };
  }
  return delimiter;
}

function consumeOpeningValueWrappers(value: string, start: number) {
  let cursor = start;
  while (cursor < value.length) {
    while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
    if (cursor >= value.length || value.startsWith(REDACTED_VALUE, cursor)) {
      return { cursor, delimiter: undefined };
    }
    if ("[({".includes(value[cursor]!)) {
      cursor += 1;
      continue;
    }
    const slashStart = cursor;
    while (cursor < value.length && value[cursor] === "\\") cursor += 1;
    const character = value[cursor];
    if (character === '"' || character === "'") {
      return {
        cursor: cursor + 1,
        delimiter: { backslashes: cursor - slashStart, quote: character } satisfies QuoteDelimiter,
      };
    }
    return { cursor: slashStart, delimiter: undefined };
  }
  return { cursor, delimiter: undefined };
}

function isCredentialBoundary(value: string, index: number) {
  const character = value[index]!;
  if (/\s/u.test(character) || ",;}])!?".includes(character)) return true;
  if (character !== ".") return false;
  let runEnd = index + 1;
  while (value[runEnd] === ".") runEnd += 1;
  const next = value[runEnd];
  return next === undefined || /\s/u.test(next) || ",;}])!?\"'".includes(next);
}

function labeledCredentialEnd(value: string, start: number, delimiter: QuoteDelimiter | undefined) {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (isCredentialBoundary(value, index)) return index;
    if (delimiter) {
      if (character !== '"' && character !== "'") continue;
      const backslashes = precedingBackslashes(value, index, start);
      if (
        character !== delimiter.quote ||
        (backslashes % 2 === delimiter.backslashes % 2 &&
          (delimiter.backslashes === 0 || backslashes <= delimiter.backslashes))
      ) {
        return index - backslashes;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      return index - precedingBackslashes(value, index, start);
    }
  }
  return value.length;
}

function redactAuthorizationMatches(
  value: string,
  pattern: RegExp,
  delimiterForMatch: (match: RegExpExecArray) => QuoteDelimiter | undefined,
) {
  const parts: string[] = [];
  let cursor = 0;
  pattern.lastIndex = 0;
  let match = pattern.exec(value);
  while (match) {
    const opening = consumeOpeningValueWrappers(value, pattern.lastIndex);
    const markerEnd = value.startsWith(REDACTED_VALUE, opening.cursor)
      ? opening.cursor + REDACTED_VALUE.length
      : undefined;
    const markerSuffix = markerEnd === undefined ? undefined : value[markerEnd];
    if (
      markerEnd !== undefined &&
      (markerSuffix === undefined ||
        markerSuffix === '"' ||
        markerSuffix === "'" ||
        isCredentialBoundary(value, markerEnd))
    ) {
      pattern.lastIndex = markerEnd;
      match = pattern.exec(value);
      continue;
    }
    const delimiter = opening.delimiter ?? delimiterForMatch(match);
    const end = labeledCredentialEnd(value, markerEnd ?? opening.cursor, delimiter);
    if (end > opening.cursor) {
      parts.push(value.slice(cursor, opening.cursor), REDACTED_VALUE);
      cursor = end;
      pattern.lastIndex = end;
    }
    match = pattern.exec(value);
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

function redactLabeledAuthorizationValues(value: string) {
  const labeled = redactAuthorizationMatches(value, LABELED_AUTHORIZATION_PREFIX, (match) =>
    lastQuoteDelimiter(match[1] ?? ""),
  );
  return redactAuthorizationMatches(labeled, UNDICI_AUTHORIZATION_PREFIX, (match) =>
    lastQuoteDelimiter(match[1] ?? ""),
  );
}

function redactKnownValues(value: string) {
  let safe = redactLabeledAuthorizationValues(value);
  safe = safe.replace(BASIC_VALUE, (match, encoded: string) => redactBasicValue(match, encoded));
  safe = safe
    .replace(BEARER_VALUE, (match, token: string) => redactBearerValue(match, token))
    .replace(SECRET_VALUE, "[redacted-secret]")
    .replace(URL_QUERY, "$1");
  return redactEmails(safe);
}

const ATOMIC_SANITIZATION_MARKERS = [
  REDACTED_VALUE,
  "[redacted-email]",
  "[redacted-secret]",
  TRUNCATION_MARKER,
  OMITTED_ENTRIES,
  OMITTED_VALUE,
  PROPERTY_OMITTED,
  DEPTH_OMITTED,
  CIRCULAR_VALUE,
  OBJECT_OMITTED,
  EMPTY_KEY,
  FUNCTION_OMITTED,
  SYMBOL_OMITTED,
] as const;

const EXACT_SANITIZATION_MARKERS = new Set<string>(ATOMIC_SANITIZATION_MARKERS);

function atomicRedactionPrefix(value: string, limit: number) {
  let end = wellFormedPrefix(value, limit).length;
  let previousEnd: number;
  do {
    previousEnd = end;
    for (const marker of ATOMIC_SANITIZATION_MARKERS) {
      const start = value.lastIndexOf(marker, Math.max(0, end - 1));
      if (start >= 0 && start < end && start + marker.length > end) end = start;
    }
  } while (end < previousEnd);
  return wellFormedPrefix(value, end);
}

function boundaryReplacement(value: string) {
  for (const pattern of [/\bBasic[ \t]+([A-Za-z0-9+/_=-]*)$/i, /\bBearer[ \t]+([A-Za-z0-9._~+/=-]*)$/i]) {
    const match = pattern.exec(value);
    if (match) return { marker: REDACTED_VALUE, start: value.length - (match[1]?.length ?? 0) };
  }
  const secret = PARTIAL_SECRET_VALUE.exec(value);
  if (secret) return { marker: "[redacted-secret]", start: secret.index };
  const emailStart = partialEmailStart(value);
  return emailStart >= 0 ? { marker: "[redacted-email]", start: emailStart } : undefined;
}

function redactTruncationBoundary(value: string, limit: number) {
  const replacement = boundaryReplacement(value);
  if (!replacement) return value;
  const prefix = value.slice(0, replacement.start);
  const redacted = prefix + replacement.marker;
  return redacted.length <= limit ? redacted : prefix;
}

function boundedSanitizedPayload(value: string, limit: number, scrubBoundary: boolean) {
  const prefix = value.length <= limit ? value : atomicRedactionPrefix(value, limit);
  return scrubBoundary ? redactTruncationBoundary(prefix, limit) : prefix;
}

function boundedSanitizedString(value: string, limit: number) {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, limit));
  const payloadLimit = limit - TRUNCATION_MARKER.length;
  return boundedSanitizedPayload(value, payloadLimit, true) + TRUNCATION_MARKER;
}

function redactedString(value: string, limit = LOG_TEXT_LIMIT) {
  const truncated = value.length > limit;
  if (!truncated) return boundedSanitizedString(redactKnownValues(value), limit);
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, limit));
  const payloadLimit = limit - TRUNCATION_MARKER.length;
  const safe = redactKnownValues(wellFormedPrefix(value, payloadLimit));
  return boundedSanitizedPayload(safe, payloadLimit, true) + TRUNCATION_MARKER;
}

function uniqueKey(base: string, occupied: (candidate: string) => boolean) {
  if (!occupied(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `#${index}`;
    const trailingMarker = ATOMIC_SANITIZATION_MARKERS.find((marker) => base.endsWith(marker));
    const candidate = trailingMarker
      ? atomicRedactionPrefix(
          base.slice(0, -trailingMarker.length),
          LOG_IDENTIFIER_LIMIT - trailingMarker.length - suffix.length,
        ) +
        trailingMarker +
        suffix
      : atomicRedactionPrefix(base, LOG_IDENTIFIER_LIMIT - suffix.length) + suffix;
    if (!occupied(candidate)) return candidate;
  }
}

function uniqueSafeKey(target: Record<string, unknown>, rawKey: string) {
  return uniqueKey(redactedString(rawKey, LOG_IDENTIFIER_LIMIT) || EMPTY_KEY, (key) => Object.hasOwn(target, key));
}

type BoundedFragment = {
  full: string;
  minimum: string;
  compact?: (limit: number) => string | undefined;
};

function containerLength(fragments: readonly string[]) {
  return 2 + fragments.reduce((length, fragment) => length + fragment.length, 0) + Math.max(0, fragments.length - 1);
}

function compactStringFragment(value: string, wrap: (valueJson: string) => string, limit: number) {
  let low = TRUNCATION_MARKER.length;
  let high = Math.min(value.length - 1, limit);
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = wrap(JSON.stringify(boundedSanitizedString(value, middle)));
    if (candidate.length <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function compactNestedFragment(
  value: object,
  serialized: string | undefined,
  wrap: (valueJson: string) => string,
  limit: number,
) {
  const valueLimit = limit - wrap("").length;
  if (valueLimit < 2) return undefined;
  const compacted = boundedNestedJsonFromSerialization(value, valueLimit, serialized);
  if (!compacted.startsWith("[") && !compacted.startsWith("{")) {
    return undefined;
  }
  const candidate = wrap(compacted);
  return candidate.length <= limit ? candidate : undefined;
}

function boundedFragment(
  value: unknown,
  keyJson?: string,
  serialized = JSON.stringify(value) ?? "null",
): BoundedFragment {
  const wrap = (valueJson: string) => (keyJson === undefined ? valueJson : `${keyJson}:${valueJson}`);
  const full = wrap(serialized);
  const omitted = wrap(JSON.stringify(OMITTED_VALUE));
  const atomic = typeof value === "string" && EXACT_SANITIZATION_MARKERS.has(value);
  const minimum = atomic || full.length <= omitted.length ? full : omitted;
  return {
    full,
    minimum,
    ...(!atomic && typeof value === "string" && full !== minimum
      ? { compact: (limit: number) => compactStringFragment(value, wrap, limit) }
      : value !== null && typeof value === "object" && full !== minimum
        ? { compact: (limit: number) => compactNestedFragment(value, serialized, wrap, limit) }
        : {}),
  };
}

function unavailableJson(limit: number, marker: string) {
  const serialized = JSON.stringify(marker);
  if (serialized.length <= limit) return serialized;
  if (limit >= 4) return "null";
  return limit >= 2 ? JSON.stringify("") : "";
}

function packBoundedFragments(
  fragments: readonly BoundedFragment[],
  opening: "[" | "{",
  closing: "]" | "}",
  omission: string,
  limit: number,
) {
  const minimums = fragments.map(({ minimum }) => minimum);
  const allFit = containerLength(minimums) <= limit;
  const retained: Array<{ descriptor: BoundedFragment; value: string }> = [];
  let dropped = false;

  if (allFit) {
    for (let index = 0; index < fragments.length; index += 1) {
      retained.push({ descriptor: fragments[index]!, value: minimums[index]! });
    }
  } else {
    if (containerLength([omission]) > limit) return unavailableJson(limit, OMITTED_ENTRIES);
    for (let index = 0; index < fragments.length; index += 1) {
      const minimum = minimums[index]!;
      if (containerLength([...retained.map(({ value }) => value), minimum, omission]) <= limit) {
        retained.push({ descriptor: fragments[index]!, value: minimum });
      } else {
        dropped = true;
      }
    }
  }

  const rendered = () => [...retained.map(({ value }) => value), ...(dropped ? [omission] : [])];
  for (const item of retained) {
    const available = item.value.length + limit - containerLength(rendered());
    const candidate =
      item.descriptor.full.length <= available ? item.descriptor.full : item.descriptor.compact?.(available);
    if (candidate && candidate !== item.value) item.value = candidate;
  }
  return `${opening}${rendered().join(",")}${closing}`;
}

function boundedNestedJsonFromSerialization(value: unknown, limit: number, serialized: string | undefined) {
  if (limit < 2) return "";
  if (serialized !== undefined && serialized.length <= limit) return serialized;

  if (Array.isArray(value)) {
    return packBoundedFragments(
      Array.from(value, (item) => {
        const itemJson = JSON.stringify(item) ?? "null";
        return boundedFragment(item, undefined, itemJson);
      }),
      "[",
      "]",
      JSON.stringify(OMITTED_ENTRIES),
      limit,
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).flatMap(([key, item]) => {
      const itemJson = JSON.stringify(item);
      return itemJson === undefined ? [] : [{ item, itemJson, key }];
    });
    const keys = new Set(entries.map(({ key }) => key));
    const omissionKey = uniqueKey("omitted", (key) => keys.has(key));
    return packBoundedFragments(
      entries.map(({ item, itemJson, key }) => boundedFragment(item, JSON.stringify(key), itemJson)),
      "{",
      "}",
      `${JSON.stringify(omissionKey)}:${JSON.stringify(OMITTED_ENTRIES)}`,
      limit,
    );
  }

  return unavailableJson(limit, OMITTED_VALUE);
}

/** @internal Exported for focused size-boundary tests. */
export function boundedNestedJson(value: unknown, limit: number) {
  return boundedNestedJsonFromSerialization(value, limit, JSON.stringify(value));
}

export function safeTelemetryErrorMessage(error: unknown, fallback: string) {
  return redactedString(rawSafeErrorMessage(error, fallback), 1_000);
}

function safeNested(value: unknown, depth: number, seen: WeakSet<object>, budget: { remaining: number }): unknown {
  if (budget.remaining <= 0) return OMITTED_ENTRIES;
  budget.remaining -= 1;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
  }
  if (typeof value === "string") return redactedString(value);
  if (typeof value === "bigint") return boundedLogString(String(value), LOG_IDENTIFIER_LIMIT);
  if (value === undefined) return undefined;
  if (typeof value !== "object") return typeof value === "function" ? FUNCTION_OMITTED : SYMBOL_OMITTED;
  if (depth >= 3) return DEPTH_OMITTED;
  if (seen.has(value)) return CIRCULAR_VALUE;
  seen.add(value);
  if (value instanceof Error) return errorLogFields(value, redactedString);
  let allKeys: string[];
  try {
    allKeys = Object.keys(value);
  } catch {
    return OBJECT_OMITTED;
  }
  const keys = allKeys.slice(0, 30);
  const keysTruncated = keys.length < allKeys.length;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let omitted = keysTruncated;
    for (const key of keys) {
      if (budget.remaining <= 0) {
        omitted = true;
        break;
      }
      try {
        result.push(safeNested(Reflect.get(value, key), depth + 1, seen, budget));
      } catch {
        result.push(PROPERTY_OMITTED);
      }
    }
    if (omitted) result.push(OMITTED_ENTRIES);
    return result;
  }
  const result = Object.create(null) as Record<string, unknown>;
  let omitted = keysTruncated;
  for (const key of keys) {
    if (budget.remaining <= 0) {
      omitted = true;
      break;
    }
    const safeKey = uniqueSafeKey(result, key);
    if (SENSITIVE_KEY.test(key)) {
      result[safeKey] = REDACTED_VALUE;
      continue;
    }
    try {
      result[safeKey] = safeNested(Reflect.get(value, key), depth + 1, seen, budget);
    } catch {
      result[safeKey] = PROPERTY_OMITTED;
    }
  }
  if (omitted) result[uniqueKey("omitted", (candidate) => Object.hasOwn(result, candidate))] = OMITTED_ENTRIES;
  return result;
}

function safeField(key: string, value: unknown): string | number | boolean | null | undefined {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalizedKey = key.toLowerCase();
    const limit = normalizedKey.endsWith("stack")
      ? LOG_STACK_LIMIT
      : normalizedKey.endsWith("id")
        ? LOG_IDENTIFIER_LIMIT
        : LOG_TEXT_LIMIT;
    return redactedString(value, limit);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return boundedLogString(String(value), LOG_IDENTIFIER_LIMIT);
  if (value === undefined) return undefined;
  try {
    return boundedNestedJson(safeNested(value, 0, new WeakSet(), { remaining: NESTED_VALUE_BUDGET }), LOG_TEXT_LIMIT);
  } catch {
    return typeof value === "function" ? FUNCTION_OMITTED : OBJECT_OMITTED;
  }
}

function structuredLog(
  level: LogLevel,
  event: string,
  component: string,
  message: string,
  fields: LogFields = {},
  error?: unknown,
) {
  const context = currentObservabilityContext();
  const safeContext: Record<string, unknown> = {};
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (key === "metricRouteTemplate") continue;
      const safe = safeField(key, value);
      if (safe !== undefined) safeContext[key] = safe;
    }
  }
  const safeFields = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_LOG_FIELDS.has(key)) continue;
    const safe = safeField(key, value);
    if (safe !== undefined) safeFields[uniqueSafeKey(safeFields, key)] = safe;
  }
  const normalizedError: Record<string, unknown> = {};
  if (error !== undefined) {
    for (const [key, value] of Object.entries(errorLogFields(error, redactedString))) {
      if (value === undefined) continue;
      if (value !== null && typeof value === "object") {
        try {
          normalizedError[key] = boundedNestedJson(value, LOG_TEXT_LIMIT);
        } catch {
          normalizedError[key] = OBJECT_OMITTED;
        }
      } else {
        normalizedError[key] = value;
      }
    }
  }
  const record = {
    ...safeFields,
    ...normalizedError,
    ...safeContext,
    schema: OBSERVABILITY_SCHEMA,
    event: boundedLogString(event, LOG_IDENTIFIER_LIMIT),
    severity: level,
    component: boundedLogString(component, LOG_IDENTIFIER_LIMIT),
    message: redactedString(message),
  };
  console[level](record);
  return record;
}

export const logger = {
  debug: (event: string, component: string, message: string, fields?: LogFields) =>
    structuredLog("debug", event, component, message, fields),
  info: (event: string, component: string, message: string, fields?: LogFields) =>
    structuredLog("info", event, component, message, fields),
  warn: (event: string, component: string, message: string, fields?: LogFields, error?: unknown) =>
    structuredLog("warn", event, component, message, fields, error),
  error: (event: string, component: string, message: string, fields?: LogFields, error?: unknown) =>
    structuredLog("error", event, component, message, fields, error),
};

export interface MetricPoint {
  event: string;
  component: string;
  operation?: string;
  outcome?: string;
  code?: string;
  subtype?: string;
  durationMs?: number;
  bytes?: number;
  attempts?: number;
  lagMs?: number;
  backlog?: number;
  connections?: number;
}

export function recordMetric(env: Env, point: MetricPoint) {
  env.OBSERVABILITY?.writeDataPoint({
    indexes: [boundedLogString(point.event, LOG_IDENTIFIER_LIMIT)],
    blobs: [
      OBSERVABILITY_SCHEMA,
      boundedLogString(point.component, LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.operation ?? "", LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.outcome ?? "", LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.code ?? "", LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.subtype ?? "", LOG_IDENTIFIER_LIMIT),
      env.CF_VERSION_METADATA?.id ?? "local",
    ],
    doubles: [
      point.durationMs ?? 0,
      point.bytes ?? 0,
      point.attempts ?? 0,
      point.lagMs ?? 0,
      point.backlog ?? 0,
      point.connections ?? 0,
      point.bytes === undefined ? 0 : 1,
    ],
  });
}

export function traced<T>(
  tracing: ExecutionContext["tracing"] | undefined,
  name: string,
  attributes: Readonly<Record<string, string | number | boolean | undefined>>,
  callback: () => T,
) {
  if (!tracing) return callback();
  return tracing.enterSpan(name, (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    return callback();
  });
}
