import type { Env, MemberContext } from "./env";
import { pageJson, type PageJsonRow } from "./page-row";

export type MentionCursor = { firstSeenAt: number; pageId: string };

export async function mentionsInbox(
  env: Env,
  member: MemberContext,
  asOf: number,
  before: MentionCursor | null,
  limit: number,
) {
  const rows = await env.DB.prepare(
    `SELECT source.*, mention.excerpt, mention.first_seen_at,
            space.name space_name, actor.name actor_name,
            CASE WHEN mention.first_seen_at > COALESCE(reads.read_at, 0) THEN 1 ELSE 0 END unread
       FROM member_mentions mention
       JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       JOIN spaces space ON space.id = source.space_id
       LEFT JOIN space_members sm ON sm.space_id = space.id AND sm.user_id = ?
       LEFT JOIN workspace_members actor_member ON actor_member.workspace_id = mention.workspace_id
         AND actor_member.user_id = mention.first_seen_actor_id
       LEFT JOIN user actor ON actor.id = actor_member.user_id
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ? AND mention.first_seen_at <= ?
        AND source.import_job_id IS NULL AND source.is_template = 0
        AND (? = 'owner' OR space.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        AND (? IS NULL OR mention.first_seen_at < ?
          OR (mention.first_seen_at = ? AND source.id > ?))
      ORDER BY mention.first_seen_at DESC, source.id LIMIT ?`,
  )
    .bind(
      member.user.id,
      member.workspace.id,
      member.user.id,
      asOf,
      member.role,
      before?.firstSeenAt ?? null,
      before?.firstSeenAt ?? null,
      before?.firstSeenAt ?? null,
      before?.pageId ?? null,
      limit + 1,
    )
    .all<
      PageJsonRow & {
        excerpt: string;
        first_seen_at: number;
        unread: number;
        space_name: string;
        actor_name: string | null;
      }
    >();
  const pageRows = rows.results.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    asOf,
    nextCursor: rows.results.length > limit && last ? { firstSeenAt: last.first_seen_at, pageId: last.id } : null,
    mentions: pageRows.map((row) => ({
      page: pageJson(row),
      excerpt: row.excerpt,
      firstSeenAt: row.first_seen_at,
      unread: Boolean(row.unread),
      spaceName: row.space_name,
      actorName: row.actor_name,
    })),
  };
}

export async function markMentionsRead(env: Env, member: MemberContext, through: number) {
  await env.DB.prepare(
    `INSERT INTO mention_reads (workspace_id, user_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`,
  )
    .bind(member.workspace.id, member.user.id, through)
    .run();
}
