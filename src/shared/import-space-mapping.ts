export function normalizeGroupSpaceIds(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, spaceId]) => typeof spaceId !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function uniqueMappedSpaceIds(mapping: Record<string, string> | undefined) {
  return new Set(mapping ? Object.values(mapping) : []);
}
