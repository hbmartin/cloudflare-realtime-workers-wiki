const ERROR_NAME_LIMIT = 200;
const ERROR_CODE_LIMIT = 200;
const ERROR_MESSAGE_LIMIT = 2_000;
const ERROR_STACK_LIMIT = 16_000;

function bounded(value: string, limit: number) {
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
  return typeof candidate === "string" ? bounded(candidate, limit) : null;
}

function isErrorLike(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (value instanceof Error) return true;
  } catch {
    // A revoked or hostile Proxy can throw while its prototype chain is inspected.
  }
  return (
    typeof property(value, "message") === "string" &&
    (typeof property(value, "name") === "string" || typeof property(value, "stack") === "string")
  );
}

function logPropertyValue(value: unknown) {
  if (typeof value === "string") return bounded(value, ERROR_MESSAGE_LIMIT);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return bounded(String(value), ERROR_MESSAGE_LIMIT);
  return undefined;
}

function logValue(value: unknown) {
  if (typeof value === "string") return bounded(value, ERROR_MESSAGE_LIMIT);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return bounded(String(value), ERROR_MESSAGE_LIMIT);
  if (value === undefined) return "undefined";
  if (typeof value === "object" && value !== null) {
    const metadata: Record<string, string | number | boolean | null> = {};
    for (const name of ["name", "message", "status", "code", "reason", "errno", "syscall"]) {
      const logged = logPropertyValue(property(value, name));
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
      ...(typeof code === "string" ? { [`${prefix}Code`]: bounded(code, ERROR_CODE_LIMIT) } : {}),
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
    [`${prefix}Message`]: typeof error === "string" ? bounded(error, ERROR_MESSAGE_LIMIT) : null,
    [`${prefix}Stack`]: null,
    [`${prefix}Type`]: error === null ? "null" : typeof error,
    [`${prefix}Value`]: logValue(error),
  };
}

export function errorLogFields(error: unknown) {
  return prefixedErrorLogFields("error", error);
}
