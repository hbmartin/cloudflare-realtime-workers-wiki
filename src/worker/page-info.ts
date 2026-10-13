import type { Env, MemberContext } from "./env";
import { seal, unseal } from "./ai-auth";
import { HttpError } from "./http";
import { pageForMember } from "./page-access";

interface PageContributor {
  id: string;
  name: string;
  firstEditedAt: number;
  lastEditedAt: number;
}

/** Upsert authenticated contributors in the same D1 batch that commits their page revision. */
export function pageContributorStatements(
  database: D1Database,
  pageId: string,
  epoch: number,
  ids: readonly string[],
  timestamp: number,
  evidence?: readonly { id: string; firstEditedAt: number; lastEditedAt: number }[],
) {
  if (!ids.length) return [];
  return [
    database
      .prepare(`INSERT INTO page_contributors(page_id,user_id,first_edit_at,last_edit_at)
    SELECT p.id,json_extract(author.value,'$.id'),json_extract(author.value,'$.firstEditedAt'),json_extract(author.value,'$.lastEditedAt') FROM pages p JOIN json_each(?) author
    WHERE p.id=? AND p.content_epoch=? AND json_extract(author.value,'$.id')<>''
    ON CONFLICT(page_id,user_id) DO UPDATE SET
      first_edit_at=min(page_contributors.first_edit_at,excluded.first_edit_at),
      last_edit_at=max(page_contributors.last_edit_at,excluded.last_edit_at)`)
      .bind(
        JSON.stringify(
          [...new Set(ids)].map(
            (id) =>
              evidence?.find((author) => author.id === id) ?? { id, firstEditedAt: timestamp, lastEditedAt: timestamp },
          ),
        ),
        pageId,
        epoch,
      ),
  ];
}

/** Attach the contributors captured for a version without changing its primary editor field. */
export function versionContributorStatement(database: D1Database, versionId: string, ids: readonly string[]) {
  return database
    .prepare(`INSERT OR IGNORE INTO page_version_contributors(version_id,user_id)
    SELECT v.id,author.value FROM page_versions v JOIN json_each(?) author WHERE v.id=? AND author.value<>''`)
    .bind(JSON.stringify([...new Set(ids)]), versionId);
}

/** Read authorized page metadata and a bounded keyset page of observed contributors. */
export async function readPageInfo(env: Env, member: MemberContext, pageId: string, cursor?: string) {
  const page = await pageForMember(env, member, pageId);
  const binding = `page-info:${member.workspace.id}:${member.user.id}:${pageId}`;
  let after: { at: number; id: string; expiresAt: number } | null = null;
  if (cursor) {
    try {
      after = await unseal(env.BETTER_AUTH_SECRET, binding, cursor);
      if (
        !after ||
        !Number.isFinite(after.at) ||
        typeof after.id !== "string" ||
        !Number.isFinite(after.expiresAt) ||
        after.expiresAt <= Date.now()
      )
        throw new Error("Invalid cursor.");
    } catch {
      throw new HttpError(422, "invalid_contributor_cursor", "Contributor cursor expired or belongs to another page.");
    }
  }
  const [identity, tracking, rows] = await Promise.all([
    env.DB.prepare(`SELECT p.created_by creatorId,creator.name creatorName,p.updated_by editorId,editor.name editorName
      FROM pages p LEFT JOIN user creator ON creator.id=p.created_by LEFT JOIN user editor ON editor.id=p.updated_by
      WHERE p.id=?`)
      .bind(pageId)
      .first<{ creatorId: string; creatorName: string | null; editorId: string | null; editorName: string | null }>(),
    env.DB.prepare("SELECT started_at FROM contributor_tracking WHERE id=1").first<{ started_at: number }>(),
    env.DB.prepare(`SELECT c.user_id id,coalesce(u.name,'Former collaborator') name,
      c.first_edit_at firstEditedAt,c.last_edit_at lastEditedAt FROM page_contributors c LEFT JOIN user u ON u.id=c.user_id
      WHERE c.page_id=? AND (? IS NULL OR c.last_edit_at<? OR (c.last_edit_at=? AND c.user_id>?))
      ORDER BY c.last_edit_at DESC,c.user_id LIMIT 51`)
      .bind(pageId, after?.at ?? null, after?.at ?? null, after?.at ?? null, after?.id ?? "")
      .all<PageContributor>(),
  ]);
  await pageForMember(env, member, pageId);
  const contributors = rows.results.slice(0, 50);
  const last = contributors.at(-1);
  const historySince = tracking?.started_at ?? page.created_at;
  let wordCount = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: "word" }).segment(page.plain_text))
    if (segment.isWordLike) wordCount++;
  return {
    id: page.id,
    createdAt: page.created_at,
    updatedAt: page.updated_at,
    createdBy: identity ? { id: identity.creatorId, name: identity.creatorName ?? "Former collaborator" } : null,
    lastEditedBy: identity?.editorId
      ? { id: identity.editorId, name: identity.editorName ?? "Former collaborator" }
      : null,
    contributors,
    wordCount: page.kind === "table" ? null : wordCount,
    wordCountComplete: page.kind !== "table" && page.plain_text.length < 500_000,
    contributorHistorySince: historySince,
    contributorHistoryComplete: page.created_at >= historySince,
    contributorAttribution: "authenticated_uploaders" as const,
    nextCursor:
      rows.results.length > 50 && last
        ? await seal(env.BETTER_AUTH_SECRET, binding, {
            at: last.lastEditedAt,
            id: last.id,
            expiresAt: Date.now() + 15 * 60_000,
          })
        : null,
  };
}

/** Resolve version authors only after authorizing the containing page. */
export async function versionContributors(
  env: Env,
  member: MemberContext,
  pageId: string,
  versionIds: readonly string[],
) {
  await pageForMember(env, member, pageId, true);
  const rows =
    await env.DB.prepare(`SELECT c.version_id versionId,c.user_id id,coalesce(u.name,'Former collaborator') name
    FROM page_version_contributors c JOIN page_versions v ON v.id=c.version_id LEFT JOIN user u ON u.id=c.user_id
    WHERE v.page_id=? AND v.id IN (SELECT value FROM json_each(?)) ORDER BY c.version_id,c.user_id`)
      .bind(pageId, JSON.stringify(versionIds))
      .all<{ versionId: string; id: string; name: string }>();
  const result = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of rows.results)
    result.set(row.versionId, [...(result.get(row.versionId) ?? []), { id: row.id, name: row.name }]);
  return result;
}
