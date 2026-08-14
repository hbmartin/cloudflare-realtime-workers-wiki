import type { ColumnType, PageKind, Role } from "./types";

export class ValidationError extends Error {}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Expected an object");
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string") throw new ValidationError(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new ValidationError(`${name} must be between 1 and ${max} characters`);
  return normalized;
}

export function nullableId(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[\w-]{1,100}$/.test(value)) throw new ValidationError(`${name} is invalid`);
  return value;
}

export function integer(value: unknown, name: string, min = 0): number {
  if (!Number.isInteger(value) || (value as number) < min) throw new ValidationError(`${name} must be an integer`);
  return value as number;
}

export function oneOf<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ValidationError(`${name} is invalid`);
  return value as T;
}

export const role = (value: unknown) => oneOf<Role>(value, "role", ["owner", "editor", "viewer"]);
export const pageKind = (value: unknown) => oneOf<PageKind>(value, "kind", ["document", "table"]);
export const columnType = (value: unknown) =>
  oneOf<ColumnType>(value, "type", ["text", "number", "checkbox", "date", "select"]);
