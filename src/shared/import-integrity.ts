import type { DocumentProjection } from "./document-projection";

export type CanonicalTableColumn = {
  name: string;
  type: string;
  options: string[];
};

export type CanonicalTableRow = Array<string | number | boolean | null>;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

/** Stable JSON used by both the Worker and the importer for request receipts. */
export function canonicalJson(value: unknown) {
  return JSON.stringify(normalize(value));
}

export async function sha256Hex(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalDocumentProjection(projection: DocumentProjection) {
  return {
    plainText: projection.plainText,
    pageReferenceIds: [...new Set(projection.pageReferences.map(({ targetId }) => targetId))].sort(),
    memberMentionIds: [...new Set(projection.memberMentions.map(({ targetId }) => targetId))].sort(),
  };
}

export function documentProjectionHash(projection: DocumentProjection) {
  return sha256Hex(canonicalJson(canonicalDocumentProjection(projection)));
}

function canonicalTable(columns: CanonicalTableColumn[], rows: CanonicalTableRow[]) {
  return { columns, rows };
}

export function tableContentHash(columns: CanonicalTableColumn[], rows: CanonicalTableRow[]) {
  return sha256Hex(canonicalJson(canonicalTable(columns, rows)));
}
