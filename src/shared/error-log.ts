export const LOG_IDENTIFIER_LIMIT = 200;
export const LOG_TEXT_LIMIT = 2_000;
export const LOG_STACK_LIMIT = 16_000;
export const PERSISTED_ERROR_MESSAGE_LIMIT = 1_000;

const ERROR_NAME_LIMIT = LOG_IDENTIFIER_LIMIT;
const ERROR_CODE_LIMIT = LOG_IDENTIFIER_LIMIT;
const ERROR_MESSAGE_LIMIT = LOG_TEXT_LIMIT;
const ERROR_STACK_LIMIT = LOG_STACK_LIMIT;
export const TRUNCATION_MARKER = "…[truncated]";
export type LogSanitizer = (value: string, limit: number) => string;

export function wellFormedPrefix(value: string, limit: number) {
  let sliceEnd = Math.min(value.length, Math.max(0, limit));
  const lastCodeUnit = value.charCodeAt(sliceEnd - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) sliceEnd -= 1;
  return value.slice(0, sliceEnd);
}

export function boundedLogString(value: string, limit: number) {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  return `${wellFormedPrefix(value, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function property(value: object, name: string): unknown {
  try {
    return Reflect.get(value, name);
  } catch {
    return undefined;
  }
}

function stringProperty(value: object, name: string, limit: number, sanitize: LogSanitizer) {
  const candidate = property(value, name);
  return typeof candidate === "string" ? boundedLogString(sanitize(candidate, limit), limit) : null;
}

export function safeInstanceOf<Instance>(
  value: unknown,
  constructor: abstract new (...arguments_: never[]) => Instance,
): value is Instance {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

function isErrorLike(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  if (safeInstanceOf(value, Error)) return true;
  return typeof property(value, "message") === "string" || typeof property(value, "stack") === "string";
}

function logPrimitive(value: unknown, stringLimit: number) {
  if (typeof value === "string") return boundedLogString(value, stringLimit);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return boundedLogString(String(value), stringLimit);
  return undefined;
}

export function rawSafeErrorMessage(error: unknown, fallback: string) {
  const message =
    typeof error === "string" ? error : typeof error === "object" && error !== null ? property(error, "message") : null;
  if (typeof message === "string") {
    const trimmed = message.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

export function safeErrorMessage(error: unknown, fallback: string) {
  return boundedLogString(rawSafeErrorMessage(error, fallback), PERSISTED_ERROR_MESSAGE_LIMIT);
}

function logValue(value: unknown, sanitize: LogSanitizer) {
  const primitive = logPrimitive(
    typeof value === "string" ? sanitize(value, ERROR_MESSAGE_LIMIT) : value,
    ERROR_MESSAGE_LIMIT,
  );
  if (primitive !== undefined) return primitive;
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    const objectValue = value as object;
    const metadata: Record<string, string | number | boolean | null> = {};
    const properties = [
      ["name", ERROR_NAME_LIMIT],
      ["message", ERROR_MESSAGE_LIMIT],
      ["stack", ERROR_STACK_LIMIT],
      ["status", ERROR_MESSAGE_LIMIT],
      ["code", ERROR_CODE_LIMIT],
      ["reason", ERROR_MESSAGE_LIMIT],
      ["errno", ERROR_MESSAGE_LIMIT],
      ["syscall", ERROR_MESSAGE_LIMIT],
    ] as const;
    for (const [name, limit] of properties) {
      const candidate = property(objectValue, name);
      const logged = logPrimitive(typeof candidate === "string" ? sanitize(candidate, limit) : candidate, limit);
      if (logged !== undefined) metadata[name] = logged;
    }
    if (Object.keys(metadata).length) return metadata;
  }
  return `[${typeof value} omitted]`;
}

export function prefixedErrorLogFields(
  prefix: string,
  error: unknown,
  includeCause = true,
  sanitize: LogSanitizer = boundedLogString,
): Record<string, unknown> {
  if (isErrorLike(error)) {
    const status = property(error, "status");
    const code = property(error, "code");
    const loggedStatus = typeof status === "number" && Number.isFinite(status) ? status : undefined;
    const loggedCode =
      typeof code === "string"
        ? boundedLogString(sanitize(code, ERROR_CODE_LIMIT), ERROR_CODE_LIMIT)
        : typeof code === "number" && Number.isFinite(code)
          ? String(code)
          : typeof code === "bigint"
            ? boundedLogString(String(code), ERROR_CODE_LIMIT)
            : undefined;
    const reasonValue = property(error, "reason");
    const errnoValue = property(error, "errno");
    const syscallValue = property(error, "syscall");
    const reason = logPrimitive(
      typeof reasonValue === "string" ? sanitize(reasonValue, ERROR_MESSAGE_LIMIT) : reasonValue,
      ERROR_MESSAGE_LIMIT,
    );
    const errno = logPrimitive(
      typeof errnoValue === "string" ? sanitize(errnoValue, ERROR_MESSAGE_LIMIT) : errnoValue,
      ERROR_MESSAGE_LIMIT,
    );
    const syscall = logPrimitive(
      typeof syscallValue === "string" ? sanitize(syscallValue, ERROR_MESSAGE_LIMIT) : syscallValue,
      ERROR_MESSAGE_LIMIT,
    );
    const fields: Record<string, unknown> = {
      [`${prefix}Name`]: stringProperty(error, "name", ERROR_NAME_LIMIT, sanitize),
      [`${prefix}Message`]: stringProperty(error, "message", ERROR_MESSAGE_LIMIT, sanitize),
      [`${prefix}Stack`]: stringProperty(error, "stack", ERROR_STACK_LIMIT, sanitize),
      [`${prefix}Type`]: "object",
      ...(loggedStatus !== undefined ? { [`${prefix}Status`]: loggedStatus } : {}),
      ...(loggedCode !== undefined ? { [`${prefix}Code`]: loggedCode } : {}),
      ...(reason !== undefined ? { [`${prefix}Reason`]: reason } : {}),
      ...(errno !== undefined ? { [`${prefix}Errno`]: errno } : {}),
      ...(syscall !== undefined ? { [`${prefix}Syscall`]: syscall } : {}),
    };
    if (includeCause) {
      const cause = property(error, "cause");
      if (cause !== undefined && cause !== error) {
        Object.assign(fields, prefixedErrorLogFields(`${prefix}Cause`, cause, false, sanitize));
      }
    }
    return fields;
  }
  const message =
    typeof error === "string" ? boundedLogString(sanitize(error, ERROR_MESSAGE_LIMIT), ERROR_MESSAGE_LIMIT) : null;
  return {
    [`${prefix}Name`]: null,
    [`${prefix}Message`]: message,
    [`${prefix}Stack`]: null,
    [`${prefix}Type`]: error === null ? "null" : typeof error,
    [`${prefix}Value`]: message ?? logValue(error, sanitize),
  };
}

export function errorLogFields(error: unknown, sanitize?: LogSanitizer) {
  return prefixedErrorLogFields("error", error, true, sanitize);
}
