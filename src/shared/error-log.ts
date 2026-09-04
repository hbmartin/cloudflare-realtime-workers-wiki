export const LOG_IDENTIFIER_LIMIT = 200;
export const LOG_TEXT_LIMIT = 2_000;
export const PERSISTED_ERROR_MESSAGE_LIMIT = 1_000;

const ERROR_NAME_LIMIT = LOG_IDENTIFIER_LIMIT;
const ERROR_CODE_LIMIT = LOG_IDENTIFIER_LIMIT;
const ERROR_MESSAGE_LIMIT = LOG_TEXT_LIMIT;
const ERROR_STACK_LIMIT = 16_000;
const TRUNCATION_MARKER = "…[truncated]";
const NON_WHITESPACE_PATTERN = /\S/u;
const WHITESPACE_PATTERN = /\s/u;

function boundedLogStringRange(value: string, start: number, end: number, limit: number) {
  if (end - start <= limit) return value.slice(start, end);
  if (limit <= 0) return "";
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  let sliceEnd = start + limit - TRUNCATION_MARKER.length;
  const lastCodeUnit = value.charCodeAt(sliceEnd - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) sliceEnd -= 1;
  return `${value.slice(start, sliceEnd)}${TRUNCATION_MARKER}`;
}

export function boundedLogString(value: string, limit: number) {
  return boundedLogStringRange(value, 0, value.length, limit);
}

function property(value: object, name: string): unknown {
  try {
    return Reflect.get(value, name);
  } catch {
    return undefined;
  }
}

function stringProperty(value: object, name: string, limit: number) {
  const candidate = property(value, name);
  return typeof candidate === "string" ? boundedLogString(candidate, limit) : null;
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

export function safeErrorMessage(error: unknown, fallback: string) {
  const message =
    typeof error === "string" ? error : typeof error === "object" && error !== null ? property(error, "message") : null;
  if (typeof message === "string") {
    const start = message.search(NON_WHITESPACE_PATTERN);
    if (start !== -1) {
      let end = message.length;
      while (end > start && WHITESPACE_PATTERN.test(message.charAt(end - 1))) end -= 1;
      return boundedLogStringRange(message, start, end, PERSISTED_ERROR_MESSAGE_LIMIT);
    }
  }
  return boundedLogString(fallback, PERSISTED_ERROR_MESSAGE_LIMIT);
}

function logValue(value: unknown) {
  const primitive = logPrimitive(value, ERROR_MESSAGE_LIMIT);
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
      const logged = logPrimitive(property(objectValue, name), limit);
      if (logged !== undefined) metadata[name] = logged;
    }
    if (Object.keys(metadata).length) return metadata;
  }
  return `[${typeof value} omitted]`;
}

export function prefixedErrorLogFields(prefix: string, error: unknown, includeCause = true): Record<string, unknown> {
  if (isErrorLike(error)) {
    const status = property(error, "status");
    const code = property(error, "code");
    const loggedStatus = typeof status === "number" && Number.isFinite(status) ? status : undefined;
    const loggedCode =
      typeof code === "string"
        ? boundedLogString(code, ERROR_CODE_LIMIT)
        : typeof code === "number" && Number.isFinite(code)
          ? String(code)
          : typeof code === "bigint"
            ? boundedLogString(String(code), ERROR_CODE_LIMIT)
            : undefined;
    const reason = logPrimitive(property(error, "reason"), ERROR_MESSAGE_LIMIT);
    const errno = logPrimitive(property(error, "errno"), ERROR_MESSAGE_LIMIT);
    const syscall = logPrimitive(property(error, "syscall"), ERROR_MESSAGE_LIMIT);
    const fields: Record<string, unknown> = {
      [`${prefix}Name`]: stringProperty(error, "name", ERROR_NAME_LIMIT),
      [`${prefix}Message`]: stringProperty(error, "message", ERROR_MESSAGE_LIMIT),
      [`${prefix}Stack`]: stringProperty(error, "stack", ERROR_STACK_LIMIT),
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
        Object.assign(fields, prefixedErrorLogFields(`${prefix}Cause`, cause, false));
      }
    }
    return fields;
  }
  return {
    [`${prefix}Name`]: null,
    [`${prefix}Message`]: typeof error === "string" ? boundedLogString(error, ERROR_MESSAGE_LIMIT) : null,
    [`${prefix}Stack`]: null,
    [`${prefix}Type`]: error === null ? "null" : typeof error,
    [`${prefix}Value`]: logValue(error),
  };
}

export function errorLogFields(error: unknown) {
  return prefixedErrorLogFields("error", error);
}
