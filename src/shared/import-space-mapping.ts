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
