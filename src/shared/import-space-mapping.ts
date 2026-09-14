import type { ImportPreview } from "./types";

// Bump when ownership, grouping, or structural preview semantics change. Older previews must be inspected again.
export const NOTION_GROUPING_VERSION = 2;

export type ImportOptions = {
  filename: string;
  format: ImportPreview["format"];
  confirmed: boolean;
  groupSpaceIds?: Record<string, string>;
  previewGroupKeys?: string[];
  previewGroupingVersion?: number;
  previewId?: string;
};

export function requireImportOptions(options: Record<string, unknown>): ImportOptions {
  if (
    typeof options.filename !== "string" ||
    typeof options.format !== "string" ||
    !["markdown", "html", "notion_zip"].includes(options.format) ||
    typeof options.confirmed !== "boolean"
  )
    throw new Error("Import options are invalid.");
  const groupSpaceIds = normalizeGroupSpaceIds(options.groupSpaceIds);
  const keys = options.previewGroupKeys;
  if (groupSpaceIds === null || (groupSpaceIds && Object.keys(groupSpaceIds).length === 0)) {
    throw new Error("Import space mappings are invalid.");
  }
  if (
    (options.previewId !== undefined && (typeof options.previewId !== "string" || !options.previewId)) ||
    (options.previewGroupingVersion !== undefined &&
      (!Number.isInteger(options.previewGroupingVersion) || Number(options.previewGroupingVersion) < 1)) ||
    (keys !== undefined &&
      (!Array.isArray(keys) || keys.some((key) => typeof key !== "string") || new Set(keys).size !== keys.length))
  )
    throw new Error("Import preview groups are invalid.");
  if (
    groupSpaceIds &&
    Array.isArray(keys) &&
    (Object.keys(groupSpaceIds).length !== keys.length || keys.some((key) => !Object.hasOwn(groupSpaceIds, key)))
  ) {
    throw new Error("Import space mappings are invalid.");
  }
  return { ...options, groupSpaceIds, previewGroupKeys: keys } as ImportOptions;
}

export function parseImportOptions(options: Record<string, unknown>): ImportOptions | null {
  try {
    return requireImportOptions(options);
  } catch {
    return null;
  }
}

export function isCurrentImportPreview(preview: ImportPreview | undefined, format: ImportPreview["format"]) {
  return Boolean(
    preview &&
    preview.format === format &&
    typeof preview.previewId === "string" &&
    preview.previewId &&
    (format !== "notion_zip" || preview.groupingVersion === NOTION_GROUPING_VERSION),
  );
}

export function hasCurrentImportConfirmation(options: ImportOptions) {
  return Boolean(
    options.confirmed &&
    options.previewId &&
    (options.format !== "notion_zip" || options.previewGroupingVersion === NOTION_GROUPING_VERSION),
  );
}

export function importConfirmationMatchesPreview(options: ImportOptions, preview: ImportPreview | undefined) {
  return Boolean(
    options.confirmed &&
    preview &&
    options.previewId === preview?.previewId &&
    options.previewGroupingVersion === preview?.groupingVersion,
  );
}

export function normalizeGroupSpaceIds(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, spaceId]) => typeof spaceId !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function uniqueMappedSpaceIds(mapping: Record<string, string> | undefined) {
  return new Set(mapping ? Object.values(mapping) : []);
}

export function importDestinationSpaceIds(
  uploadSpaceId: string | null | undefined,
  mapping: Record<string, string> | undefined,
) {
  const destinations = uniqueMappedSpaceIds(mapping);
  if (!mapping && uploadSpaceId) destinations.add(uploadSpaceId);
  return destinations;
}
