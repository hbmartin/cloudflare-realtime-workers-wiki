import { AsyncLocalStorage } from "node:async_hooks";
import {
  boundedLogString,
  errorLogFields,
  LOG_IDENTIFIER_LIMIT,
  LOG_STACK_LIMIT,
  LOG_TEXT_LIMIT,
  TRUNCATION_MARKER,
  rawSafeErrorMessage,
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
const BASIC_HEADER_VALUE = /\b((?:proxy-)?authorization[ \t]*:[ \t]*Basic[ \t]+)[A-Za-z0-9+/_=-]+/gi;
const BASIC_VALUE = /\bBasic[ \t]+([A-Za-z0-9+/_=-]+)/gi;
const BEARER_VALUE = /\bBearer[ \t]+\S+/gi;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;
const SECRET_VALUE = /\b(?:(?:sk|crn|ghp|github_pat|secret)_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gi;
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

    const boundedLocal = start === 0 || !isAsciiWord(value.charCodeAt(start - 1));
    if (start < at && validEnd > 0 && boundedLocal) {
      parts.push(value.slice(cursor, start), "[redacted-email]");
      cursor = validEnd;
    }
    at = value.indexOf("@", Math.max(at + 1, cursor));
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

function redactBasicValue(match: string, encoded: string) {
  try {
    if (atob(encoded).includes(":")) return match.slice(0, match.length - encoded.length) + REDACTED_VALUE;
  } catch {
    // Malformed Base64 and ordinary prose are not credentials.
  }
  return match;
}

function redactKnownValues(value: string) {
  let safe = value
    .replace(BASIC_HEADER_VALUE, `$1${REDACTED_VALUE}`)
    .replace(BASIC_VALUE, redactBasicValue)
    .replace(BEARER_VALUE, `Bearer ${REDACTED_VALUE}`)
    .replace(SECRET_VALUE, "[redacted-secret]")
    .replace(URL_QUERY, "$1");
  safe = redactEmails(safe);
  return safe;
}

function maskTrailingRun(value: string, limit: number) {
  const bounded = value.slice(0, Math.max(0, limit));
  let start = bounded.length;
  while (start > 0 && !/\s/u.test(bounded[start - 1]!)) start -= 1;
  if (start === bounded.length) return bounded;
  const prefixLimit = Math.max(0, limit - REDACTED_VALUE.length);
  return bounded.slice(0, Math.min(start, prefixLimit)) + REDACTED_VALUE.slice(0, limit);
}

function truncatedRedactedString(value: string, limit: number) {
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  const payloadLimit = limit - TRUNCATION_MARKER.length;
  return maskTrailingRun(value, payloadLimit) + TRUNCATION_MARKER;
}

function redactedString(value: string, limit = LOG_TEXT_LIMIT) {
  const truncated = value.length > limit;
  const payloadLimit = truncated ? Math.max(0, limit - TRUNCATION_MARKER.length) : limit;
  const safe = redactKnownValues(value.slice(0, payloadLimit));
  return truncated || safe.length > limit ? truncatedRedactedString(safe, limit) : safe;
}

function uniqueSafeKey(target: Record<string, unknown>, rawKey: string) {
  const base = redactedString(rawKey, LOG_IDENTIFIER_LIMIT) || "[empty key]";
  if (!Object.hasOwn(target, base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `#${index}`;
    const candidate = base.slice(0, LOG_IDENTIFIER_LIMIT - suffix.length) + suffix;
    if (!Object.hasOwn(target, candidate)) return candidate;
  }
}

function fitStringCandidate(value: string, limit: number, candidate: (value: string) => unknown): string | undefined {
  let low = TRUNCATION_MARKER.length + REDACTED_VALUE.length;
  let high = Math.min(value.length - 1, limit);
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const compact = truncatedRedactedString(value, middle);
    if (JSON.stringify(candidate(compact)).length <= limit) {
      best = compact;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function appendArrayOmission(result: unknown[], limit: number) {
  while (result.length > 0 && JSON.stringify([...result, OMITTED_ENTRIES]).length > limit) result.pop();
  if (JSON.stringify([...result, OMITTED_ENTRIES]).length <= limit) result.push(OMITTED_ENTRIES);
}

function appendObjectOmission(result: Record<string, unknown>, limit: number) {
  let key = uniqueSafeKey(result, "omitted");
  while (Object.keys(result).length > 0) {
    const candidate = Object.assign(Object.create(null), result, { [key]: OMITTED_ENTRIES });
    if (JSON.stringify(candidate).length <= limit) break;
    delete result[Object.keys(result).at(-1)!];
    key = uniqueSafeKey(result, "omitted");
  }
  result[key] = OMITTED_ENTRIES;
}

function boundedNestedJson(value: unknown, limit: number) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= limit) return serialized;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const hasMore = index < value.length - 1;
      const tail = hasMore ? [OMITTED_ENTRIES] : [];
      const item = value[index];
      if (JSON.stringify([...result, item, ...tail]).length <= limit) {
        result.push(item);
        continue;
      }
      let retained = false;
      if (typeof item === "string") {
        const compact = fitStringCandidate(item, limit, (candidate) => [...result, candidate, ...tail]);
        if (compact !== undefined) {
          result.push(compact);
          retained = true;
        }
      }
      if (!retained && JSON.stringify([...result, OMITTED_VALUE, ...tail]).length <= limit) {
        result.push(OMITTED_VALUE);
        retained = true;
      }
      if (hasMore || !retained) appendArrayOmission(result, limit);
      break;
    }
    return JSON.stringify(result);
  }

  if (value !== null && typeof value === "object") {
    const result = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(value);
    for (let index = 0; index < entries.length; index += 1) {
      const [key, item] = entries[index]!;
      const hasMore = index < entries.length - 1;
      const candidate = Object.assign(Object.create(null), result, { [key]: item });
      const omissionKey = hasMore ? uniqueSafeKey(candidate, "omitted") : undefined;
      if (omissionKey) candidate[omissionKey] = OMITTED_ENTRIES;
      if (JSON.stringify(candidate).length <= limit) {
        result[key] = item;
        continue;
      }
      let retained = false;
      if (typeof item === "string") {
        const compact = fitStringCandidate(item, limit, (compacted) => {
          const attempted = Object.assign(Object.create(null), result, { [key]: compacted });
          if (omissionKey) attempted[omissionKey] = OMITTED_ENTRIES;
          return attempted;
        });
        if (compact !== undefined) {
          result[key] = compact;
          retained = true;
        }
      }
      if (!retained) {
        const attempted = Object.assign(Object.create(null), result, { [key]: OMITTED_VALUE });
        if (omissionKey) attempted[omissionKey] = OMITTED_ENTRIES;
        if (JSON.stringify(attempted).length <= limit) {
          result[key] = OMITTED_VALUE;
          retained = true;
        }
      }
      if (hasMore || !retained) appendObjectOmission(result, limit);
      break;
    }
    return JSON.stringify(result);
  }

  return JSON.stringify(OMITTED_VALUE);
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
      result[uniqueSafeKey(result, "omitted")] = OMITTED_ENTRIES;
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
