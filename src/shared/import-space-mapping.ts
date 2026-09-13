import type { ImportPreview } from "./types";

export const NOTION_GROUPING_VERSION = 1;

export type ImportOptions = {
  filename: string;
  format: ImportPreview["format"];
  confirmed: boolean;
  groupSpaceIds?: Record<string, string>;
  previewGroupKeys?: string[];
  previewGroupingVersion?: number;
};

export function parseImportOptions(options: Record<string, unknown>): ImportOptions | null {
  const groupSpaceIds = normalizeGroupSpaceIds(options.groupSpaceIds);
  const keys = options.previewGroupKeys;
  if (
    typeof options.filename !== "string" ||
    typeof options.format !== "string" ||
    !["markdown", "html", "notion_zip"].includes(options.format) ||
    typeof options.confirmed !== "boolean" ||
    groupSpaceIds === null ||
    (options.previewGroupingVersion !== undefined &&
      (!Number.isInteger(options.previewGroupingVersion) || Number(options.previewGroupingVersion) < 1)) ||
    (keys !== undefined &&
      (!Array.isArray(keys) || keys.some((key) => typeof key !== "string") || new Set(keys).size !== keys.length)) ||
    (groupSpaceIds &&
      (Object.keys(groupSpaceIds).length === 0 ||
        (Array.isArray(keys) &&
          (Object.keys(groupSpaceIds).length !== keys.length ||
            keys.some((key) => !Object.hasOwn(groupSpaceIds, key))))))
  )
    return null;
  return { ...options, groupSpaceIds, previewGroupKeys: keys } as ImportOptions;
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
