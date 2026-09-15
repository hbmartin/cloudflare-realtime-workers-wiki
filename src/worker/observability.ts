import { AsyncLocalStorage } from "node:async_hooks";
import {
  boundedLogString,
  errorLogFields,
  LOG_IDENTIFIER_LIMIT,
  LOG_STACK_LIMIT,
  LOG_TEXT_LIMIT,
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
const BEARER_VALUE = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;
const SECRET_VALUE = /\b(?:(?:sk|crn|ghp|github_pat|secret)_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gi;
const PARTIAL_SECRET_VALUE = /\b(?:(?:sk|crn|ghp|github_pat|secret)_[A-Za-z0-9_-]*|xox[baprs]-[A-Za-z0-9-]*)$/i;
const TRUNCATION_MARKER = "…[truncated]";
const NESTED_VALUE_BUDGET = 100;
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
    while (start > cursor && at - start < 64 && isEmailLocal(value.charCodeAt(start - 1))) start -= 1;
    let end = at + 1;
    while (end < value.length && end - at <= 253 && isEmailDomain(value.charCodeAt(end))) end += 1;
    let domainEnd = end;
    while (domainEnd > at + 1 && value.charCodeAt(domainEnd - 1) === 46) domainEnd -= 1;
    const dot = value.lastIndexOf(".", domainEnd - 1);
    const tldLength = domainEnd - dot - 1;
    let validTld = tldLength >= 2 && tldLength <= 63;
    for (let index = dot + 1; validTld && index < domainEnd; index += 1) {
      validTld = isAsciiLetter(value.charCodeAt(index));
    }
    const boundedLocal = start === 0 || !isEmailLocal(value.charCodeAt(start - 1));
    const boundedDomain = end === value.length || !isEmailDomain(value.charCodeAt(end));
    if (start < at && dot > at + 1 && validTld && boundedLocal && boundedDomain) {
      parts.push(value.slice(cursor, start), "[redacted-email]");
      cursor = domainEnd;
    }
    at = value.indexOf("@", Math.max(at + 1, cursor));
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

function redactPartialEmail(value: string) {
  const at = value.lastIndexOf("@");
  if (at < 0 || value.length - at > 254) return value;
  let start = at;
  while (start > 0 && at - start < 64 && isEmailLocal(value.charCodeAt(start - 1))) start -= 1;
  if (start === at) return value;
  for (let index = at + 1; index < value.length; index += 1) {
    if (!isEmailDomain(value.charCodeAt(index))) return value;
  }
  return value.slice(0, start) + "[redacted-email]";
}

function redactKnownValues(value: string, truncated = false) {
  let safe = value
    .replace(BASIC_HEADER_VALUE, "$1[redacted]")
    .replace(BEARER_VALUE, "Bearer [redacted]")
    .replace(SECRET_VALUE, "[redacted-secret]")
    .replace(URL_QUERY, "$1");
  safe = redactEmails(safe);
  if (truncated) safe = redactPartialEmail(safe).replace(PARTIAL_SECRET_VALUE, "[redacted-secret]");
  return safe;
}

function redactedString(value: string, limit = LOG_TEXT_LIMIT) {
  const truncated = value.length > limit;
  const bounded = boundedLogString(value, limit);
  const payload = truncated ? bounded.slice(0, -TRUNCATION_MARKER.length) : bounded;
  const safe = redactKnownValues(payload, truncated);
  return boundedLogString(truncated ? safe + TRUNCATION_MARKER : safe, limit);
}

export function safeTelemetryErrorMessage(error: unknown, fallback: string) {
  return redactedString(rawSafeErrorMessage(error, fallback), 1_000);
}

function safeNested(value: unknown, depth: number, seen: WeakSet<object>, budget: { remaining: number }): unknown {
  if (budget.remaining <= 0) return "[entries omitted]";
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
        result.push("[entries omitted]");
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
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (budget.remaining <= 0) {
      result["omitted"] = "[entries omitted]";
      break;
    }
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    try {
      result[key] = safeNested(Reflect.get(value, key), depth + 1, seen, budget);
    } catch {
      result[key] = "[property omitted]";
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
    const serialized = JSON.stringify(safeNested(value, 0, new WeakSet(), { remaining: NESTED_VALUE_BUDGET }));
    if (!serialized) return JSON.stringify("[" + typeof value + " omitted]");
    return serialized.length > LOG_TEXT_LIMIT ? JSON.stringify("[object truncated]") : serialized;
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
  const safeFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_LOG_FIELDS.has(key)) continue;
    const safe = safeField(key, value);
    if (safe !== undefined) safeFields[key] = safe;
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
