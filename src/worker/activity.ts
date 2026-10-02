import type { ActivityItem, ActivityResponse, ChannelEventType } from "../shared/activity";
import { CHANNEL_EVENT_TYPES } from "../shared/activity";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";

export const OPEN_THREAD_COUNT_SQL = `(SELECT count(*) FROM comment_threads t WHERE t.page_id=p.id AND t.resolved_at IS NULL)`;
export const TASK_STATUS_SQL = `(SELECT coalesce(substr(c.select_value,length(r.page_id)+2),'todo')
 FROM table_row_pages link JOIN table_rows r ON r.id=link.row_id JOIN pages list ON list.id=r.page_id AND list.is_task_list=1
 LEFT JOIN table_cells c ON c.row_id=r.id AND c.column_id=r.page_id||'-status'
 WHERE link.page_id=p.id AND list.archived_at IS NULL AND list.import_job_id IS NULL)`;
type ActivityRow = {
  id: string;
  page_id: string;
  space_id: string;
  title: string;
  plain_text: string;
  kind: string;
  actor_name: string | null;
  event_type: ChannelEventType | null;
  created_at: number;
  unresolved_threads: number;
  task_status: "todo" | "doing" | "done" | null;
  archived_at: number | null;
};
function activityItem(row: ActivityRow): ActivityItem {
  return {
    id: row.id,
    pageId: row.page_id,
    spaceId: row.space_id,
    title: row.title,
    excerpt: row.archived_at === null ? row.plain_text.replace(/\s+/g, " ").slice(0, 240) : "",
    kind: row.kind,
    actorName: row.actor_name,
    eventType: row.event_type,
    createdAt: row.created_at,
    unresolvedThreads: row.unresolved_threads,
    taskStatus: row.task_status,
    departure: row.archived_at !== null,
    available: true,
  };
}

export async function listActivity(
  env: Env,
  member: MemberContext,
  query: {
    mode?: string | undefined;
    spaceId?: string | undefined;
    pageId?: string | undefined;
    eventType?: string | undefined;
    mappingId?: string | undefined;
    cursor?: string | undefined;
    from?: string | undefined;
    limit?: number;
  },
): Promise<ActivityResponse> {
  if (env.WORKSPACE_ACTIVITY_ENABLED !== "true")
    throw new HttpError(404, "activity_disabled", "Activity is not enabled.");
  const open = query.mode === "open";
  if (query.mode && !["activity", "open"].includes(query.mode))
    throw new HttpError(422, "invalid_activity_mode", "Choose Activity or Open work.");
  if (query.eventType && !CHANNEL_EVENT_TYPES.includes(query.eventType as ChannelEventType))
    throw new HttpError(422, "invalid_activity_event", "Choose a supported activity type.");
  const limit = Math.max(1, Math.min(100, query.limit ?? 30));
  let scope = "";
  const binds: unknown[] = [member.workspace.id, member.role, member.user.id];
  if (query.spaceId) {
    scope += " AND p.space_id=?";
    binds.push(query.spaceId);
  }
  if (query.pageId) {
    scope += " AND p.id=?";
    binds.push(query.pageId);
  }
  if (query.mappingId) {
    const mapping = await env.DB.prepare(`SELECT m.space_id,m.page_id,m.event_types_json,m.channel_id,m.installation_id
      FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id JOIN spaces s ON s.id=m.space_id
      WHERE m.id=? AND i.workspace_id=? AND i.disconnected_at IS NULL
      AND (?='owner' OR s.visibility='workspace' OR EXISTS(SELECT 1 FROM space_members WHERE space_id=s.id AND user_id=?))`)
      .bind(query.mappingId, member.workspace.id, member.role, member.user.id)
      .first<{
        space_id: string;
        page_id: string | null;
        event_types_json: string;
        channel_id: string;
        installation_id: string;
      }>();
    if (!mapping) throw new HttpError(404, "mapping_unavailable", "This activity filter is unavailable.");
    scope += open
      ? " AND p.space_id=? AND (? IS NULL OR p.id=?)"
      : " AND (a.space_id=? OR a.previous_space_id=?) AND (? IS NULL OR p.id=?)";
    binds.push(
      ...(open
        ? [mapping.space_id, mapping.page_id, mapping.page_id]
        : [mapping.space_id, mapping.space_id, mapping.page_id, mapping.page_id]),
    );
    if (!open) {
      scope += ` AND EXISTS(SELECT 1 FROM json_each(?) WHERE value=a.event_type)
        AND NOT EXISTS(SELECT 1 FROM slack_thread_links l WHERE l.thread_id=a.thread_id
          AND l.installation_id=? AND l.channel_id=? AND l.state IN ('pending','active'))`;
      binds.push(mapping.event_types_json, mapping.installation_id, mapping.channel_id);
    }
  }
  if (!open) {
    const from = query.from ? Number(query.from) : Date.now() - 7 * 86400_000;
    if (!Number.isFinite(from)) throw new HttpError(422, "invalid_activity_date", "Choose a valid activity date.");
    scope += " AND a.created_at>=?";
    binds.push(Math.max(from, Date.now() - 30 * 86400_000));
    if (query.eventType) {
      scope += " AND a.event_type=?";
      binds.push(query.eventType);
    }
  }
  if (query.cursor) {
    try {
      const cursor = JSON.parse(atob(query.cursor)) as { id: string; time: number; mode: string };
      if (
        typeof cursor.id !== "string" ||
        !Number.isFinite(cursor.time) ||
        cursor.mode !== (open ? "open" : "activity")
      )
        throw new Error("cursor");
      scope += open ? " AND p.id>?" : " AND (a.created_at<? OR (a.created_at=? AND a.id<?))";
      binds.push(...(open ? [cursor.id] : [cursor.time, cursor.time, cursor.id]));
    } catch {
      throw new HttpError(422, "invalid_activity_cursor", "Refresh Activity and try again.");
    }
  }
  const rows =
    await env.DB.prepare(`SELECT ${open ? "p.id" : "a.id"} id,p.id page_id,p.space_id,p.title,p.plain_text,p.kind,p.archived_at,
    ${open ? "NULL" : "actor.name"} actor_name,${open ? "NULL" : "a.event_type"} event_type,${open ? "p.updated_at" : "a.created_at"} created_at,
    ${OPEN_THREAD_COUNT_SQL} unresolved_threads,${TASK_STATUS_SQL} task_status
    FROM pages p JOIN spaces s ON s.id=p.space_id
    ${open ? "" : "JOIN workspace_activity a ON a.page_id=p.id LEFT JOIN user actor ON actor.id=a.actor_id"}
    WHERE p.workspace_id=? AND (?='owner' OR s.visibility='workspace' OR EXISTS(SELECT 1 FROM space_members WHERE space_id=s.id AND user_id=?))
      AND p.import_job_id IS NULL AND p.is_template=0
      ${open ? `AND p.archived_at IS NULL AND (${OPEN_THREAD_COUNT_SQL}>0 OR ${TASK_STATUS_SQL} IN ('todo','doing'))` : ""}
      ${scope} ORDER BY ${open ? "p.id" : "a.created_at DESC,a.id DESC"} LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<ActivityRow>();
  const items = rows.results.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(activityItem),
    nextCursor:
      rows.results.length > limit && last
        ? btoa(JSON.stringify({ id: last.id, time: last.created_at, mode: open ? "open" : "activity" }))
        : null,
  };
}
