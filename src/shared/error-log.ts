function logValue(value: unknown) {
  return typeof value === "bigint" || typeof value === "symbol" || typeof value === "function"
    ? String(value)
    : value === undefined
      ? "undefined"
      : value;
}

export function prefixedErrorLogFields(prefix: string, error: unknown, includeCause = true): Record<string, unknown> {
  if (error instanceof Error) {
    const fields: Record<string, unknown> = {
      [`${prefix}Name`]: error.name,
      [`${prefix}Message`]: error.message,
      [`${prefix}Stack`]: error.stack ?? null,
      [`${prefix}Type`]: "object",
    };
    if (includeCause && error.cause !== undefined && error.cause !== error) {
      Object.assign(fields, prefixedErrorLogFields(`${prefix}Cause`, error.cause, false));
    }
    return fields;
  }
  return {
    [`${prefix}Name`]: null,
    [`${prefix}Message`]: typeof error === "string" ? error : null,
    [`${prefix}Stack`]: null,
    [`${prefix}Type`]: error === null ? "null" : typeof error,
    [`${prefix}Value`]: logValue(error),
  };
}

export function errorLogFields(error: unknown) {
  return prefixedErrorLogFields("error", error);
}
