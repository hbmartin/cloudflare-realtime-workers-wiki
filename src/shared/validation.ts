import type { ColumnType, PageKind, Role } from "./types";

export class ValidationError extends Error {}

/**
 * Longest stored page title. Shared with the import CLI's preflight so a title the
 * routes would reject is shortened before the run starts, not rejected mid-run.
 */
export const PAGE_TITLE_MAX = 200;

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

// PartyServer hashes the raw pathname segment into the Durable Object name, so
// the authorized room and the addressed room are only the same object when the
// segment is already canonical. `pageId~01`, `~1e0` and `~+1` all coerce to
// epoch 1 through `Number` but address distinct rooms that compact to one R2
// key, so the epoch is matched as canonical decimal text rather than parsed.
// No character `ID_PATTERN` admits needs percent-encoding, which is why callers
// match the segment before decoding and never decode at all.
const DOCUMENT_ROOM_PATTERN = /^([\w-]{1,100})~([1-9]\d{0,9})$/;

// The pieces of a document room name, or null when `room` is not the exact text
// this installation would have produced for them. Bounds the name at 111 bytes,
// well inside the 1,024 past which Cloudflare stops exposing `ctx.id.name`.
export function documentRoom(room: string): { pageId: string; epoch: number } | null {
  const match = DOCUMENT_ROOM_PATTERN.exec(room);
  if (!match) return null;
  return { pageId: match[1]!, epoch: Number(match[2]) };
}

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
