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
const AUTHORIZATION_LABEL = String.raw`\b((?:proxy-)?authorization(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?`;
const BASIC_HEADER_VALUE = new RegExp(`${AUTHORIZATION_LABEL}Basic[ \\t]+)[A-Za-z0-9+/_=-]+`, "gi");
const BASIC_VALUE = /\bBasic[ \t]+([A-Za-z0-9+/_=-]+)/gi;
const BEARER_HEADER_VALUE = new RegExp(
  `${AUTHORIZATION_LABEL}Bearer[ \\t]+)([A-Za-z0-9._~+/=-]+)(?=$|[^A-Za-z0-9._~+/=-])`,
  "gi",
);
const BEARER_VALUE = /\bBearer[ \t]+([A-Za-z0-9._~+/=-]+)(?=$|[^A-Za-z0-9._~+/=-])/gi;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;
const SECRET_VALUE = /\b(?:(?:sk|crn|ghp|github_pat|secret)_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gi;
const PARTIAL_SECRET_VALUE = /\b(?:(?:sk|crn|ghp|github_pat|secret)_[A-Za-z0-9_-]*|xox[baprs]-[A-Za-z0-9-]*)$/i;
const NESTED_VALUE_BUDGET = 100;
const REDACTED_VALUE = "[redacted]";
const OMITTED_ENTRIES = "[entries omitted]";
const OMITTED_VALUE = "[value omitted]";
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

function redactPartialEmail(value: string) {
  const at = value.lastIndexOf("@");
  if (at < 0) return value;
  let start = at;
  while (start > 0 && isEmailLocal(value.charCodeAt(start - 1))) start -= 1;
  if (start === at) return value;
  for (let index = at + 1; index < value.length; index += 1) {
    if (!isEmailDomain(value.charCodeAt(index))) return value;
  }
  return value.slice(0, start) + "[redacted-email]";
}

function redactKnownValues(value: string, atBoundary = false) {
  let safe = value.replace(BASIC_HEADER_VALUE, `$1${REDACTED_VALUE}`);
  safe = safe.replace(BASIC_VALUE, (match, encoded: string, offset: number) =>
    redactBasicValue(match, encoded, atBoundary && offset + match.length === safe.length),
  );
  safe = safe.replace(BEARER_HEADER_VALUE, (match, _prefix: string, token: string) =>
    redactBearerValue(match, token, true),
  );
  safe = safe
    .replace(BEARER_VALUE, (match, token: string, offset: number) =>
      redactBearerValue(match, token, atBoundary && offset + match.length === safe.length),
    )
    .replace(SECRET_VALUE, "[redacted-secret]")
    .replace(URL_QUERY, "$1");
  safe = redactEmails(safe);
  if (atBoundary) safe = redactPartialEmail(safe).replace(PARTIAL_SECRET_VALUE, "[redacted-secret]");
  return safe;
}

const ATOMIC_SANITIZATION_MARKERS = [
  REDACTED_VALUE,
  "[redacted-email]",
  "[redacted-secret]",
  TRUNCATION_MARKER,
] as const;

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

function fitRedactedPayload(value: string, limit: number) {
  let candidate = value;
  while (candidate.length > limit) {
    const prefix = atomicRedactionPrefix(candidate, limit);
    const redacted = redactKnownValues(prefix, true);
    if (redacted.length < candidate.length) {
      candidate = redacted;
      continue;
    }
    candidate = redactKnownValues(atomicRedactionPrefix(prefix, prefix.length - 1), true);
  }
  return candidate;
}

function boundedSanitizedString(value: string, limit: number) {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, limit));
  const payloadLimit = limit - TRUNCATION_MARKER.length;
  const prefix = atomicRedactionPrefix(value, payloadLimit);
  return fitRedactedPayload(redactKnownValues(prefix, true), payloadLimit) + TRUNCATION_MARKER;
}

function redactedString(value: string, limit = LOG_TEXT_LIMIT) {
  const truncated = value.length > limit;
  if (!truncated) return redactKnownValues(value);
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, limit));
  const payloadLimit = limit - TRUNCATION_MARKER.length;
  const safe = redactKnownValues(wellFormedPrefix(value, payloadLimit), true);
  return fitRedactedPayload(safe, payloadLimit) + TRUNCATION_MARKER;
}

function uniqueKey(base: string, occupied: (candidate: string) => boolean) {
  if (!occupied(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `#${index}`;
    const candidate = base.slice(0, LOG_IDENTIFIER_LIMIT - suffix.length) + suffix;
    if (!occupied(candidate)) return candidate;
  }
}

function uniqueSafeKey(target: Record<string, unknown>, rawKey: string) {
  return uniqueKey(redactedString(rawKey, LOG_IDENTIFIER_LIMIT) || "[empty key]", (key) => Object.hasOwn(target, key));
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
  let high = value.length - 1;
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

function boundedFragment(value: unknown, keyJson?: string): BoundedFragment {
  const wrap = (valueJson: string) => (keyJson === undefined ? valueJson : `${keyJson}:${valueJson}`);
  const valueJson = JSON.stringify(value) ?? "null";
  const full = wrap(valueJson);
  const omitted = wrap(JSON.stringify(OMITTED_VALUE));
  const minimum = full.length <= omitted.length ? full : omitted;
  return {
    full,
    minimum,
    ...(typeof value === "string" && full !== minimum
      ? { compact: (limit: number) => compactStringFragment(value, wrap, limit) }
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

/** @internal Exported for focused size-boundary tests. */
export function boundedNestedJson(value: unknown, limit: number) {
  if (limit < 2) return "";
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length <= limit) return serialized;

  if (Array.isArray(value)) {
    return packBoundedFragments(
      Array.from(value, (item) => boundedFragment(item)),
      "[",
      "]",
      JSON.stringify(OMITTED_ENTRIES),
      limit,
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => JSON.stringify(item) !== undefined);
    const keys = new Set(entries.map(([key]) => key));
    const omissionKey = uniqueKey("omitted", (key) => keys.has(key));
    return packBoundedFragments(
      entries.map(([key, item]) => boundedFragment(item, JSON.stringify(key))),
      "{",
      "}",
      `${JSON.stringify(omissionKey)}:${JSON.stringify(OMITTED_ENTRIES)}`,
      limit,
    );
  }

  return unavailableJson(limit, OMITTED_VALUE);
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
  if (typeof value !== "object") return "[" + typeof value + " omitted]";
  if (depth >= 3) return "[depth omitted]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) return errorLogFields(value, redactedString);
  let keys: string[];
  try {
    keys = Object.keys(value).slice(0, 30);
  } catch {
    return "[object omitted]";
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const key of keys) {
      if (budget.remaining <= 0) {
        result.push(OMITTED_ENTRIES);
        break;
      }
      try {
        result.push(safeNested(Reflect.get(value, key), depth + 1, seen, budget));
      } catch {
        result.push("[property omitted]");
      }
    }
    return result;
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (budget.remaining <= 0) {
      result[uniqueKey("omitted", (candidate) => Object.hasOwn(result, candidate))] = OMITTED_ENTRIES;
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
      result[safeKey] = "[property omitted]";
    }
  }
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
    return "[" + typeof value + " omitted]";
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
          normalizedError[key] = boundedLogString(JSON.stringify(value), LOG_TEXT_LIMIT);
        } catch {
          normalizedError[key] = "[object omitted]";
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
