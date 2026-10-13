/** Combine additive actor evidence from new and compatible legacy event payloads. */
export function eventContributorIds(input: {
  actorId?: string | null;
  contributorIds?: readonly string[];
  data?: Record<string, unknown>;
}) {
  const embedded = Array.isArray(input.data?.contributorIds) ? input.data.contributorIds : [];
  return [
    ...new Set(
      [...(input.contributorIds ?? []), ...embedded, input.actorId].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
}

/** SQL expressions are fixed caller-owned fragments, never request input. */
export function contributorsJsonSql(ids: string, actor: string) {
  return `(SELECT json_group_array(json_object('id',author.value,'name',coalesce(contributor.name,'Former collaborator')))
    FROM json_each(CASE WHEN json_array_length(${ids})>0 THEN ${ids} WHEN nullif(${actor},'') IS NOT NULL THEN json_array(${actor}) ELSE '[]' END) author
    LEFT JOIN user contributor ON contributor.id=author.value WHERE author.type='text' AND author.value<>'')`;
}

/** Preserve first occurrence ordering while tolerating retired historical identities. */
export function eventContributors(value: string) {
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows)) return [];
    const contributors = new Map<string, { id: string; name: string }>();
    for (const row of rows)
      if (row && typeof row.id === "string" && row.id && typeof row.name === "string")
        contributors.set(row.id, { id: row.id, name: row.name });
    return [...contributors.values()];
  } catch {
    return [];
  }
}
