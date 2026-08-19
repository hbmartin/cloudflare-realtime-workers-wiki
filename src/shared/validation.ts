import type { ColumnType, PageKind, Role } from "./types";

export class ValidationError extends Error {}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Expected an object");
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string") throw new ValidationError(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max)
    throw new ValidationError(`${name} must be between 1 and ${max} characters`);
  return normalized;
}

// The shape every generated id takes (`crypto.randomUUID()` today). Exported for
// callers outside the ValidationError-to-422 path, such as the party room
// parser, which has to bound an id but reject it with its own status.
export const ID_PATTERN = /^[\w-]{1,100}$/;

export function nullableId(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new ValidationError(`${name} is invalid`);
  return value;
}

function oneOf<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ValidationError(`${name} is invalid`);
  return value as T;
}

export const role = (value: unknown) => oneOf<Role>(value, "role", ["owner", "editor", "viewer"]);
export const pageKind = (value: unknown) => oneOf<PageKind>(value, "kind", ["document", "table"]);
export const columnType = (value: unknown) =>
  oneOf<ColumnType>(value, "type", ["text", "number", "checkbox", "date", "select"]);
