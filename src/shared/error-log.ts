const ERROR_NAME_LIMIT = 200;
const ERROR_CODE_LIMIT = 200;
const ERROR_MESSAGE_LIMIT = 2_000;
const ERROR_STACK_LIMIT = 16_000;

export function boundedLogString(value: string, limit: number) {
  if (value.length <= limit) return value;
  let end = limit;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…[truncated]`;
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return boundedLogString(String(value), stringLimit);
  return undefined;
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
    const fields: Record<string, unknown> = {
      [`${prefix}Name`]: stringProperty(error, "name", ERROR_NAME_LIMIT),
      [`${prefix}Message`]: stringProperty(error, "message", ERROR_MESSAGE_LIMIT),
      [`${prefix}Stack`]: stringProperty(error, "stack", ERROR_STACK_LIMIT),
      [`${prefix}Type`]: "object",
      ...(typeof status === "number" && Number.isFinite(status) ? { [`${prefix}Status`]: status } : {}),
      ...(typeof code === "string" ? { [`${prefix}Code`]: boundedLogString(code, ERROR_CODE_LIMIT) } : {}),
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
