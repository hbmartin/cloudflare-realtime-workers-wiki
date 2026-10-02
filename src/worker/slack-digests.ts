import { digestWindow } from "./slack-schedule";
import { CHANNEL_EVENT_TYPES, type ChannelEventType } from "../shared/activity";
import { OPEN_THREAD_COUNT_SQL, TASK_STATUS_SQL } from "./activity";
import type { Env } from "./env";
import { HttpError } from "./http";
import { digestBlocks, type DigestPage } from "./slack-blocks";
import { round2Installation, validateMapping, revalidateMappings } from "./slack-channels";
import {
  slackApi,
  SlackApiError,
  SlackRateLimitError,
  type SlackInstallation,
  channelActivityActorAccessSql,
} from "./slack";
import { DeliveryInProgressError } from "./notifications";

export type DigestReceipt = {
  id: string;
  installation_id: string;
  installation_generation: number;
  subscription_id: string;
  window_start: number;
  window_end: number;
  channel_id: string;
  state: string;
  event_ids_json: string;
  message_ts: string | null;
  attempted_at: number | null;
  claim_token: string | null;
  claimed_at: number | null;
};
export type Mapping = {
  id: string;
  installation_id: string;
  channel_id: string;
  space_id: string;
  page_id: string | null;
  cadence: string;
  digest_time: string;
  digest_timezone: string | null;
  digest_open_work: number;
  digest_not_before: number;
  muted_at: number | null;
  snoozed_until: number | null;
  notification_blocked_at: number | null;
  created_by: string;
};
export async function digestMapping(env: Env, id: string) {
  return env.DB.prepare(`SELECT m.* FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
    WHERE m.id=? AND i.disconnected_at IS NULL AND i.auth_error IS NULL AND EXISTS(SELECT 1 FROM workspace_members w
      WHERE w.workspace_id=i.workspace_id AND w.user_id=m.created_by AND w.role='owner')`)
    .bind(id)
    .first<Mapping>();
}
function eligible(mapping: Mapping | null, now: number): mapping is Mapping {
  return Boolean(
    mapping &&
    mapping.cadence === "digest" &&
    mapping.digest_timezone &&
    !mapping.notification_blocked_at &&
    !mapping.muted_at &&
    (!mapping.snoozed_until || mapping.snoozed_until <= now),
  );
}
export async function dueRound2Digests(env: Env, timestamp = Date.now()) {
  await revalidateMappings(env);
  const mappings =
    await env.DB.prepare(`SELECT m.id,i.generation FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
    WHERE m.cadence='digest' AND m.digest_timezone IS NOT NULL AND m.muted_at IS NULL AND coalesce(m.snoozed_until,0)<=?
    AND m.notification_blocked_at IS NULL AND i.disconnected_at IS NULL AND i.auth_error IS NULL
    ORDER BY m.digest_not_before,m.id`)
      .bind(timestamp)
      .all<{ id: string; generation: number }>();
  for (const row of mappings.results) {
    const mapping = await digestMapping(env, row.id);
    if (!eligible(mapping, timestamp)) continue;
    const window = digestWindow(timestamp, mapping.digest_time, mapping.digest_timezone!);
    if (window.end <= Math.max(mapping.digest_not_before, mapping.snoozed_until ?? 0)) continue;
    const id = `digest:${mapping.installation_id}:${row.generation}:${mapping.id}:${window.end}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(
        id,
        mapping.installation_id,
        row.generation,
        mapping.id,
        window.start,
        window.end,
        mapping.channel_id,
        timestamp,
      ),
      env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
        SELECT 'outbox:'||r.id,i.workspace_id,'slack_digest',json_object('digestId',r.id),?,? FROM slack_digest_receipts r
        JOIN slack_installations i ON i.id=r.installation_id WHERE r.id=? AND r.state='pending'`).bind(
        timestamp,
        timestamp,
        id,
      ),
    ]);
  }
}

export async function digestPages(
  env: Env,
  mapping: Mapping,
  receipt: DigestReceipt,
  installation: SlackInstallation,
): Promise<DigestPage[]> {
  const threads = OPEN_THREAD_COUNT_SQL.replaceAll("p.", "page.");
  const status = TASK_STATUS_SQL.replaceAll("p.", "page.");
  const rows =
    await env.DB.prepare(`SELECT page.id,page.title,page.plain_text,page.kind,page.content_epoch,page.archived_at,
    MAX(e.created_at) changed_at,${threads} unresolved_threads,${status} task_status,
    json_group_array(json_object('id',e.actor_id,'name',actor.name,'type',e.event_type)) events,
    EXISTS(SELECT 1 FROM slack_channel_subscriptions current_mapping WHERE current_mapping.installation_id=?
      AND current_mapping.channel_id=? AND current_mapping.space_id=page.space_id
      AND (current_mapping.page_id IS NULL OR current_mapping.page_id=page.id) AND current_mapping.validation_state='valid') mapped,
    MIN(CASE WHEN ${channelActivityActorAccessSql.replaceAll("event.", "e.")} THEN 1 ELSE 0 END) actor_access
    FROM slack_channel_events e JOIN pages page ON page.id=e.page_id LEFT JOIN user actor ON actor.id=e.actor_id
    WHERE e.subscription_id=? AND e.cadence='digest' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
      AND e.created_at>=? AND e.created_at<?
      AND NOT EXISTS(SELECT 1 FROM slack_thread_links l WHERE l.thread_id=e.thread_id AND l.installation_id=? AND l.channel_id=? AND l.state IN ('pending','active'))
      AND (${channelActivityActorAccessSql.replaceAll("event.", "e.")} OR page.archived_at IS NOT NULL OR page.space_id<>?)
      AND page.import_job_id IS NULL AND page.is_template=0
      AND (page.space_id=? OR e.previous_space_id=?) AND (? IS NULL OR page.id=?)
    GROUP BY page.id ORDER BY changed_at DESC,page.id LIMIT 11`)
      .bind(
        installation.id,
        mapping.channel_id,
        mapping.id,
        receipt.window_start,
        receipt.window_end,
        installation.id,
        mapping.channel_id,
        mapping.space_id,
        mapping.space_id,
        mapping.space_id,
        mapping.page_id,
        mapping.page_id,
      )
      .all<{
        id: string;
        title: string;
        plain_text: string;
        kind: string;
        content_epoch: number;
        archived_at: number | null;
        changed_at: number;
        unresolved_threads: number;
        task_status: DigestPage["taskStatus"];
        events: string;
        mapped: number;
        actor_access: number;
      }>();
  const result: DigestPage[] = [];
  for (const row of rows.results) {
    const departure = row.archived_at !== null || !row.mapped;
    if (!row.actor_access && !departure) continue;
    const available = Boolean(row.mapped && row.actor_access);
    const events = JSON.parse(row.events) as Array<{ id: string | null; name: string | null; type: ChannelEventType }>;
    const actors = new Map(events.map((e) => [e.id, e.name ?? "Former collaborator"]));
    const item: DigestPage = {
      pageId: row.id,
      title: available ? row.title : "A page is no longer available",
      excerpt: available && !departure ? Array.from(row.plain_text.replace(/\s+/g, " ")).slice(0, 240).join("") : "",
      actors: available ? [...actors.values()] : [],
      actorCount: available ? actors.size : 0,
      eventTypes: CHANNEL_EVENT_TYPES.filter((type) => events.some((e) => e.type === type)),
      unresolvedThreads: available ? row.unresolved_threads : 0,
      taskStatus: available ? row.task_status : null,
      changedAt: row.changed_at,
      departure,
      available,
    };
    if (row.kind === "diagram" && available && !departure)
      await attachThumbnail(env, item, installation, row.content_epoch);
    result.push(item);
  }
  if (mapping.digest_open_work && result.length < 10) {
    const open =
      await env.DB.prepare(`SELECT page.id,page.title,page.plain_text,page.kind,page.content_epoch,${threads} unresolved_threads,${status} task_status
      FROM pages page WHERE page.space_id=? AND page.workspace_id=? AND (? IS NULL OR page.id=?) AND page.archived_at IS NULL
      AND page.import_job_id IS NULL AND page.is_template=0 AND (${threads}>0 OR ${status} IN ('todo','doing'))
      ORDER BY unresolved_threads DESC,page.id`)
        .bind(mapping.space_id, installation.workspace_id, mapping.page_id, mapping.page_id)
        .all<{
          id: string;
          title: string;
          plain_text: string;
          kind: string;
          content_epoch: number;
          unresolved_threads: number;
          task_status: DigestPage["taskStatus"];
        }>();
    for (const row of open.results) {
      if (result.some((item) => item.pageId === row.id)) continue;
      const item: DigestPage = {
        pageId: row.id,
        title: row.title,
        excerpt: Array.from(row.plain_text.replace(/\s+/g, " ")).slice(0, 240).join(""),
        actors: [],
        actorCount: 0,
        eventTypes: [],
        unresolvedThreads: row.unresolved_threads,
        taskStatus: row.task_status,
        changedAt: 0,
        departure: false,
        available: true,
      };
      if (row.kind === "diagram") await attachThumbnail(env, item, installation, row.content_epoch);
      result.push(item);
      if (result.length >= 10) break;
    }
  }
  return result.slice(0, 10);
}
async function attachThumbnail(env: Env, item: DigestPage, installation: SlackInstallation, epoch: number) {
  if (env.SLACK_RICH_DIGESTS_ENABLED !== "true") return;
  const thumbnail = await env.DB.prepare(
    `SELECT thumbnail_hash,thumbnail_r2_key FROM diagram_projections WHERE page_id=? AND content_epoch=?`,
  )
    .bind(item.pageId, epoch)
    .first<{ thumbnail_hash: string; thumbnail_r2_key: string }>();
  if (!thumbnail) return;
  const id = `file:${installation.id}:${installation.generation}:${item.pageId}:${epoch}:${thumbnail.thumbnail_hash}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO slack_file_artifacts(id,installation_id,installation_generation,page_id,content_epoch,content_sha256,thumbnail_r2_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      id,
      installation.id,
      installation.generation,
      item.pageId,
      epoch,
      thumbnail.thumbnail_hash,
      thumbnail.thumbnail_r2_key,
      Date.now(),
      Date.now(),
    ),
    env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
      SELECT 'outbox:'||id,?,'slack_file_upload',json_object('artifactId',id),?,? FROM slack_file_artifacts WHERE id=? AND state='pending'`).bind(
      installation.workspace_id,
      Date.now(),
      Date.now(),
      id,
    ),
  ]);
  const cached = await env.DB.prepare(`SELECT slack_file_id FROM slack_file_artifacts WHERE id=? AND state='uploaded'`)
    .bind(id)
    .first<{ slack_file_id: string }>();
  if (cached) item.fileId = cached.slack_file_id;
}
export async function reconcileBotPost(
  env: Env,
  installation: SlackInstallation,
  channel: string,
  id: string,
  attemptedAt: number,
  threadTs?: string,
) {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const input = {
      channel,
      oldest: String((attemptedAt - 5000) / 1000),
      limit: 100,
      include_all_metadata: true,
      ...(cursor ? { cursor } : {}),
    };
    const result = threadTs
      ? await slackApi(env, installation, "conversations.replies", { ...input, ts: threadTs })
      : await slackApi(env, installation, "conversations.history", input);
    const found = result.messages.filter(
      (m) =>
        m.user === installation.bot_user_id &&
        m.metadata?.event_payload?.delivery_id === id &&
        (threadTs ? m.thread_ts === threadTs : !m.thread_ts || m.thread_ts === m.ts),
    );
    if (found.length === 1) return found[0]!.ts;
    if (found.length > 1) return null;
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) return null;
  }
  return null;
}
async function finishDigest(env: Env, receipt: DigestReceipt, ts: string | null, state = "sent") {
  await env.DB.batch([
    env.DB.prepare(`UPDATE slack_channel_events SET delivered_at=? WHERE subscription_id=? AND cadence='digest'
      AND delivered_at IS NULL AND suppressed_at IS NULL AND created_at>=? AND created_at<?`).bind(
      Date.now(),
      receipt.subscription_id,
      receipt.window_start,
      receipt.window_end,
    ),
    env.DB.prepare(
      `UPDATE slack_digest_receipts SET state=?,message_ts=?,claim_token=NULL,claimed_at=NULL WHERE id=?`,
    ).bind(state, ts, receipt.id),
  ]);
}
export async function deliverDigest(env: Env, id: string, reconcileOnly = false) {
  if (env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true") return;
  let receipt = await env.DB.prepare(`SELECT * FROM slack_digest_receipts WHERE id=?`).bind(id).first<DigestReceipt>();
  if (
    !receipt ||
    ["sent", "skipped", "retired"].includes(receipt.state) ||
    (!reconcileOnly && receipt.state === "blocked")
  )
    return;
  if (reconcileOnly && !["sending", "blocked"].includes(receipt.state)) return;
  const installation = await round2Installation(env, receipt.installation_id, receipt.installation_generation);
  if (!installation) {
    await finishDigest(env, receipt, null, "retired");
    return;
  }
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE slack_digest_receipts SET claim_token=?,claimed_at=? WHERE id=? AND state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""}) AND (claimed_at IS NULL OR claimed_at<?)`,
  )
    .bind(token, Date.now(), id, Date.now() - 60_000)
    .run();
  if (!claim.meta.changes) throw new DeliveryInProgressError();
  try {
    receipt = (await env.DB.prepare(`SELECT * FROM slack_digest_receipts WHERE id=?`).bind(id).first<DigestReceipt>())!;
    if (receipt.state === "sending" || reconcileOnly) {
      const ts = await reconcileBotPost(env, installation, receipt.channel_id, receipt.id, receipt.attempted_at!);
      if (ts) await finishDigest(env, receipt, ts);
      else
        await env.DB.prepare(
          `UPDATE slack_digest_receipts SET state='blocked',last_error='post_unconfirmed' WHERE id=?`,
        )
          .bind(id)
          .run();
      return;
    }
    const mapping = await digestMapping(env, receipt.subscription_id);
    if (
      !eligible(mapping, Date.now()) ||
      receipt.window_end <= Math.max(mapping.digest_not_before, mapping.snoozed_until ?? 0) ||
      digestWindow(Date.now(), mapping.digest_time, mapping.digest_timezone!).end !== receipt.window_end
    ) {
      await finishDigest(env, receipt, null, "retired");
      return;
    }
    if (!(await validateMapping(env, installation, mapping.id, mapping.channel_id))) return;
    const pages = await digestPages(env, mapping, receipt, installation);
    if (!pages.length) {
      await finishDigest(env, receipt, null, "skipped");
      return;
    }
    if (env.SLACK_RICH_DIGESTS_ENABLED === "true" && env.WORKSPACE_ACTIVITY_ENABLED !== "true")
      throw new HttpError(409, "activity_required", "Enable workspace activity before rich Slack digests.");
    const events = await env.DB.prepare(
      `SELECT id FROM slack_channel_events WHERE subscription_id=? AND cadence='digest' AND delivered_at IS NULL AND suppressed_at IS NULL AND created_at>=? AND created_at<?`,
    )
      .bind(mapping.id, receipt.window_start, receipt.window_end)
      .all<{ id: string }>();
    await env.DB.prepare(
      `UPDATE slack_digest_receipts SET state='sending',attempted_at=?,event_ids_json=? WHERE id=? AND claim_token=?`,
    )
      .bind(Date.now(), JSON.stringify(events.results.map((e) => e.id)), id, token)
      .run();
    try {
      const posted = await slackApi(env, installation, "chat.postMessage", {
        channel: mapping.channel_id,
        text: `NoteFlare daily digest: ${pages.length} pages`,
        blocks: digestBlocks(
          pages,
          new URL(env.BETTER_AUTH_URL).origin,
          mapping.id,
          env.SLACK_RICH_DIGESTS_ENABLED === "true",
        ),
        metadata: { event_type: "noteflare_digest", event_payload: { delivery_id: id } },
        unfurl_links: false,
        unfurl_media: false,
        parse: "none",
      });
      await finishDigest(env, receipt, posted.ts);
    } catch (error) {
      if (error instanceof SlackRateLimitError)
        await env.DB.prepare(`UPDATE slack_digest_receipts SET state='pending' WHERE id=?`).bind(id).run();
      else if (
        error instanceof SlackApiError &&
        error.status < 500 &&
        !["http_error", "invalid_response", "internal_error", "fatal_error"].includes(error.code)
      )
        await env.DB.prepare(`UPDATE slack_digest_receipts SET state='blocked',last_error=? WHERE id=?`)
          .bind(error.code, id)
          .run();
      throw error;
    }
  } finally {
    await env.DB.prepare(
      `UPDATE slack_digest_receipts SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
    )
      .bind(id, token)
      .run();
  }
}
