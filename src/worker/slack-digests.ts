import {
  definiteSlackRejection,
  invalidSlackDestination,
  recordDeliveryError,
  retireObsoleteReceipt,
  thumbnailDeliveryEnabled,
} from "./slack-delivery";
import { logger } from "./observability";
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
function eligible(mapping: Mapping | null, now: number): boolean {
  return Boolean(
    mapping &&
    mapping.cadence === "digest" &&
    mapping.digest_timezone &&
    !mapping.notification_blocked_at &&
    !mapping.muted_at &&
    (!mapping.snoozed_until || mapping.snoozed_until <= now),
  );
}

function digestEventFilter(
  mapping: Mapping,
  receipt: Pick<DigestReceipt, "window_start" | "window_end">,
  message?: { event_ids_json: string },
) {
  return {
    sql: `e.subscription_id=? AND e.cadence='digest' AND e.summary_id IS NULL AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
      AND e.created_at>=? AND e.created_at<?
      AND (? IS NULL OR e.id IN (SELECT value FROM json_each(?)))
      AND (? IS NOT NULL OR NOT EXISTS(SELECT 1 FROM slack_digest_message_events reserved WHERE reserved.event_id=e.id))
      AND NOT EXISTS(SELECT 1 FROM slack_thread_links l WHERE l.thread_id=e.thread_id AND l.installation_id=? AND l.channel_id=? AND l.state IN ('pending','active'))
      AND (${channelActivityActorAccessSql.replaceAll("event.", "e.")} OR page.archived_at IS NOT NULL OR page.space_id<>?)
      AND page.import_job_id IS NULL AND page.is_template=0
      AND (page.space_id=? OR e.previous_space_id=?) AND (? IS NULL OR page.id=?)`,
    binds: [
      mapping.id,
      receipt.window_start,
      receipt.window_end,
      message?.event_ids_json ?? null,
      message?.event_ids_json ?? null,
      message?.event_ids_json ?? null,
      mapping.installation_id,
      mapping.channel_id,
      mapping.space_id,
      mapping.space_id,
      mapping.space_id,
      mapping.page_id,
      mapping.page_id,
    ],
  };
}
export async function dueRound2Digests(env: Env, timestamp = Date.now()) {
  await revalidateMappings(env);
  const mappings =
    await env.DB.prepare(`SELECT m.id,i.generation FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
    WHERE m.round2_initialized=1 AND m.cadence='digest' AND m.digest_timezone IS NOT NULL AND m.muted_at IS NULL AND coalesce(m.snoozed_until,0)<=?
    AND m.notification_blocked_at IS NULL AND i.disconnected_at IS NULL AND i.auth_error IS NULL
    ORDER BY m.digest_not_before,m.id`)
      .bind(timestamp)
      .all<{ id: string; generation: number }>();
  for (const row of mappings.results) {
    const mapping = await digestMapping(env, row.id);
    if (!mapping || !eligible(mapping, timestamp)) continue;
    let window;
    try {
      window = digestWindow(timestamp, mapping.digest_time, mapping.digest_timezone!);
    } catch (error) {
      logger.warn(
        "slack.digest.invalid_schedule",
        "slack",
        "Skipped an invalid digest schedule",
        { mappingId: mapping.id },
        error,
      );
      continue;
    }
    if (window.end <= Math.max(mapping.digest_not_before, mapping.snoozed_until ?? 0)) continue;
    const id = `digest:${mapping.installation_id}:${row.generation}:${mapping.id}:${window.end}`;
    const filter = digestEventFilter(mapping, { window_start: window.start, window_end: window.end });
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
      env.DB.prepare(`UPDATE slack_digest_receipts SET state='pending' WHERE id=? AND state IN ('sent','skipped') AND coalesce(last_error,'')<>'legacy_reconciled'
        AND EXISTS(SELECT 1 FROM slack_channel_events e JOIN pages page ON page.id=e.page_id WHERE ${filter.sql})`).bind(
        id,
        ...filter.binds,
      ),
      env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
        SELECT 'outbox:'||r.id,i.workspace_id,'slack_digest',json_object('digestId',r.id),?,? FROM slack_digest_receipts r
        JOIN slack_installations i ON i.id=r.installation_id WHERE r.id=? AND r.state='pending'`).bind(
        timestamp,
        timestamp,
        id,
      ),
      env.DB.prepare(
        `UPDATE outbox SET enqueued_at=NULL,available_at=?,slack_redrive_due_at=? WHERE id='outbox:'||? AND EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND state='pending')`,
      ).bind(timestamp, timestamp + 60_000, id, id),
    ]);
  }
}

export async function digestPages(
  env: Env,
  mapping: Mapping,
  receipt: DigestReceipt,
  installation: SlackInstallation,
  message?: { page_ids_json: string; event_ids_json: string },
): Promise<DigestPage[]> {
  const threads = OPEN_THREAD_COUNT_SQL.replaceAll("p.", "page.");
  const status = TASK_STATUS_SQL.replaceAll("p.", "page.");
  const filter = digestEventFilter(mapping, receipt, message);
  const rows =
    await env.DB.prepare(`SELECT page.id,page.title,page.plain_text,page.kind,page.content_epoch,page.archived_at,
    MAX(e.created_at) changed_at,${threads} unresolved_threads,${status} task_status,
    json_group_array(json_object('eventId',e.id,'id',e.actor_id,'name',actor.name,'type',e.event_type)) events,
    EXISTS(SELECT 1 FROM slack_channel_subscriptions current_mapping WHERE current_mapping.installation_id=?
      AND current_mapping.channel_id=? AND current_mapping.space_id=page.space_id
      AND (current_mapping.page_id IS NULL OR current_mapping.page_id=page.id) AND current_mapping.validation_state='valid') mapped,
    MIN(CASE WHEN ${channelActivityActorAccessSql.replaceAll("event.", "e.")} THEN 1 ELSE 0 END) actor_access
    FROM slack_channel_events e JOIN pages page ON page.id=e.page_id LEFT JOIN user actor ON actor.id=e.actor_id
    WHERE ${filter.sql}
    GROUP BY page.id ORDER BY changed_at DESC,page.id LIMIT 10`)
      .bind(installation.id, mapping.channel_id, ...filter.binds)
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
    const events = JSON.parse(row.events) as Array<{
      eventId: string;
      id: string | null;
      name: string | null;
      type: ChannelEventType;
    }>;
    const actors = new Map(events.map((e) => [e.id, e.name ?? "Former collaborator"]));
    const item: DigestPage = {
      pageId: row.id,
      eventIds: events.map((e) => e.eventId),
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
      AND page.id NOT IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR page.id IN (SELECT value FROM json_each(?)))
      AND (? IS NOT NULL OR NOT EXISTS(SELECT 1 FROM slack_digest_messages prior,json_each(prior.page_ids_json) used WHERE prior.receipt_id=? AND used.value=page.id))
      ORDER BY unresolved_threads DESC,page.id LIMIT ?`)
        .bind(
          mapping.space_id,
          installation.workspace_id,
          mapping.page_id,
          mapping.page_id,
          JSON.stringify(result.map((p) => p.pageId)),
          message?.page_ids_json ?? null,
          message?.page_ids_json ?? null,
          message?.page_ids_json ?? null,
          receipt.id,
          10 - result.length,
        )
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
  if (!thumbnailDeliveryEnabled(env)) return;
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
type DigestMessage = {
  id: string;
  receipt_id: string;
  sequence: number;
  state: string;
  page_ids_json: string;
  event_ids_json: string;
  attempted_at: number | null;
};

async function nextMessage(
  env: Env,
  receipt: DigestReceipt,
  mapping: Mapping,
  installation: SlackInstallation,
  token: string,
) {
  const existing = await env.DB.prepare(
    `SELECT * FROM slack_digest_messages WHERE receipt_id=? AND state NOT IN ('sent','skipped','retired') ORDER BY sequence LIMIT 1`,
  )
    .bind(receipt.id)
    .first<DigestMessage>();
  if (existing) return existing;
  const pages = await digestPages(env, mapping, receipt, installation);
  if (!pages.length) return null;
  const sequence = (await env.DB.prepare(
    `SELECT coalesce(max(sequence)+1,0) n FROM slack_digest_messages WHERE receipt_id=?`,
  )
    .bind(receipt.id)
    .first<{ n: number }>())!.n;
  const message = {
    id: `${receipt.id}:message:${sequence}`,
    receipt_id: receipt.id,
    sequence,
    state: "pending",
    page_ids_json: JSON.stringify(pages.map((p) => p.pageId)),
    event_ids_json: JSON.stringify(pages.flatMap((p) => p.eventIds ?? [])),
    attempted_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO slack_digest_messages(id,receipt_id,sequence,page_ids_json,event_ids_json,claim_token)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`).bind(
      message.id,
      receipt.id,
      sequence,
      message.page_ids_json,
      message.event_ids_json,
      token,
      receipt.id,
      token,
    ),
    env.DB.prepare(
      `INSERT INTO slack_digest_message_events(event_id,message_id) SELECT value,? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM slack_digest_messages WHERE id=? AND claim_token=?)`,
    ).bind(message.id, message.event_ids_json, message.id, token),
  ]);
  return message;
}

export async function deliverDigest(env: Env, id: string, reconcileOnly = false) {
  if (env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true") return;
  if (env.SLACK_RICH_DIGESTS_ENABLED === "true" && env.WORKSPACE_ACTIVITY_ENABLED !== "true")
    throw new HttpError(409, "activity_required", "Enable workspace activity before rich Slack digests.");
  let receipt = await env.DB.prepare(`SELECT * FROM slack_digest_receipts WHERE id=?`).bind(id).first<DigestReceipt>();
  if (reconcileOnly && receipt && !["sending", "blocked"].includes(receipt.state)) return;
  if (
    !receipt ||
    ["sent", "skipped", "retired"].includes(receipt.state) ||
    (!reconcileOnly && receipt.state === "blocked")
  )
    return;
  const installation = await round2Installation(env, receipt.installation_id, receipt.installation_generation);
  if (!installation) {
    await retireObsoleteReceipt(
      env,
      "slack_digest_receipts",
      id,
      receipt.installation_id,
      receipt.installation_generation,
    );
    return;
  }
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE slack_digest_receipts SET claim_token=?,claimed_at=? WHERE id=? AND state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""}) AND (claimed_at IS NULL OR claimed_at<?)`,
  )
    .bind(token, Date.now(), id, Date.now() - 60_000)
    .run();
  if (!claim.meta.changes) throw new DeliveryInProgressError();
  const updateRoot = async (state: string, ts: string | null = null, error: string | null = null) =>
    env.DB.prepare(
      `UPDATE slack_digest_receipts SET state=?,message_ts=coalesce(?,message_ts),last_error=? WHERE id=? AND claim_token=?`,
    )
      .bind(state, ts, error, id, token)
      .run();
  try {
    receipt = (await env.DB.prepare(`SELECT * FROM slack_digest_receipts WHERE id=? AND claim_token=?`)
      .bind(id, token)
      .first<DigestReceipt>())!;
    if (!receipt) throw new DeliveryInProgressError();
    let message = await env.DB.prepare(
      `SELECT * FROM slack_digest_messages WHERE receipt_id=? AND state IN ('pending','sending','blocked') ORDER BY sequence LIMIT 1`,
    )
      .bind(id)
      .first<DigestMessage>();
    // A pre-migration uncertain post retains its original delivery ID. Its old
    // event list was not trustworthy evidence of which pages were rendered.
    const hasChildren = await env.DB.prepare("SELECT 1 FROM slack_digest_messages WHERE receipt_id=? LIMIT 1")
      .bind(id)
      .first();
    let legacyReconciled = false;
    if ((receipt.state === "sending" || reconcileOnly) && !message && !hasChildren) {
      if (!receipt.attempted_at) return;
      const ts = await reconcileBotPost(env, installation, receipt.channel_id, id, receipt.attempted_at);
      if (!ts) {
        await updateRoot("blocked", null, "post_unconfirmed");
        return;
      }
      // The legacy checkpoint includes every event considered for its first ten
      // pages. Reconstruct that immutable prefix after confirming its original ID.
      const prefix = await env.DB.prepare(`SELECT e.page_id,json_group_array(e.id) event_ids FROM slack_channel_events e
        WHERE e.id IN (SELECT value FROM json_each(?)) GROUP BY e.page_id ORDER BY max(e.created_at) DESC,e.page_id LIMIT 10`)
        .bind(receipt.event_ids_json)
        .all<{ page_id: string; event_ids: string }>();
      const memberIds = JSON.stringify(prefix.results.flatMap((p) => JSON.parse(p.event_ids) as string[]));
      const messageId = `${id}:message:0`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO slack_digest_messages(id,receipt_id,sequence,state,page_ids_json,event_ids_json,message_ts,attempted_at)
          SELECT ?,?,0,'sent',?,?,?,? WHERE EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`).bind(
          messageId,
          id,
          JSON.stringify(prefix.results.map((p) => p.page_id)),
          memberIds,
          ts,
          receipt.attempted_at,
          id,
          token,
        ),
        env.DB.prepare(`INSERT INTO slack_digest_message_events(event_id,message_id) SELECT value,? FROM json_each(?)
          WHERE EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`).bind(
          messageId,
          memberIds,
          id,
          token,
        ),
        env.DB.prepare(`UPDATE slack_channel_events SET delivered_at=? WHERE id IN (SELECT value FROM json_each(?))
          AND EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`).bind(
          Date.now(),
          memberIds,
          id,
          token,
        ),
      ]);
      await updateRoot("pending", ts);
      legacyReconciled = true;
    }
    if (reconcileOnly && !legacyReconciled && !message?.attempted_at) return;
    let mapping = await digestMapping(env, receipt.subscription_id);
    const finishMessage = async (state: string, ts: string | null) => {
      if (!message) return;
      await env.DB.batch([
        env.DB.prepare(`UPDATE slack_channel_events SET delivered_at=? WHERE id IN (SELECT value FROM json_each(?))
          AND EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?) AND ?='sent'`).bind(
          Date.now(),
          message.event_ids_json,
          id,
          token,
          state,
        ),
        env.DB.prepare(`UPDATE slack_digest_messages SET state=?,message_ts=?,claim_token=NULL,claimed_at=NULL WHERE id=?
          AND EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`).bind(
          state,
          ts,
          message.id,
          id,
          token,
        ),
      ]);
    };
    if (legacyReconciled) {
      // Continue below by preparing the next message, without posting twice in this attempt.
    } else if (message?.state === "sending" || (reconcileOnly && message?.attempted_at)) {
      const ts = await reconcileBotPost(
        env,
        installation,
        receipt.channel_id,
        message.sequence === 0 ? id : message.id,
        message.attempted_at!,
      );
      if (!ts) {
        await updateRoot("blocked", null, "post_unconfirmed");
        return;
      }
      await finishMessage("sent", ts);
      await updateRoot("pending", ts);
    } else {
      if (!mapping || mapping.channel_id !== receipt.channel_id || !eligible(mapping, Date.now())) {
        if (mapping?.notification_blocked_at) return;
        await updateRoot("retired");
        return;
      }
      if (
        receipt.window_end <= Math.max(mapping.digest_not_before, mapping.snoozed_until ?? 0) ||
        digestWindow(Date.now(), mapping.digest_time, mapping.digest_timezone!).end !== receipt.window_end
      ) {
        await updateRoot("retired");
        return;
      }
      if (!(await validateMapping(env, installation, mapping.id, mapping.channel_id))) return;
      mapping = await digestMapping(env, receipt.subscription_id);
      if (!mapping || mapping.channel_id !== receipt.channel_id || !eligible(mapping, Date.now())) return;
      message ??= await nextMessage(env, receipt, mapping, installation, token);
      if (!message) {
        await updateRoot("skipped");
        return;
      }
      const pages = await digestPages(env, mapping, receipt, installation, message);
      if (!pages.length) {
        await finishMessage("retired", null);
      } else {
        const attemptedAt = Date.now();
        const sending = await env.DB.prepare(
          `UPDATE slack_digest_receipts SET state='sending',attempted_at=?,event_ids_json=? WHERE id=? AND claim_token=?`,
        )
          .bind(attemptedAt, message.event_ids_json, id, token)
          .run();
        if (!sending.meta.changes) throw new DeliveryInProgressError();
        const checkpoint =
          await env.DB.prepare(`UPDATE slack_digest_messages SET state='sending',attempted_at=?,claim_token=?,claimed_at=? WHERE id=? AND state='pending'
          AND EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`)
            .bind(attemptedAt, token, attemptedAt, message.id, id, token)
            .run();
        if (!checkpoint.meta.changes) throw new DeliveryInProgressError();
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
            metadata: {
              event_type: "noteflare_digest",
              event_payload: { delivery_id: message.sequence === 0 ? id : message.id },
            },
            unfurl_links: false,
            unfurl_media: false,
            parse: "none",
          });
          await finishMessage("sent", posted.ts);
          await updateRoot("pending", posted.ts);
        } catch (error) {
          await recordDeliveryError(env, installation, error, mapping.id, mapping.channel_id);
          if (invalidSlackDestination(error)) {
            await finishMessage("retired", null);
            await updateRoot("retired", null, error.code);
            return;
          }
          if (error instanceof SlackRateLimitError || definiteSlackRejection(error)) {
            await env.DB.prepare(
              `UPDATE slack_digest_messages SET state='pending',attempted_at=NULL,last_error=? WHERE id=? AND claim_token=?`,
            )
              .bind(error instanceof SlackApiError ? error.code : "rate_limited", message.id, token)
              .run();
            await updateRoot("pending");
          }
          throw error;
        }
      }
    }
    if (
      !mapping ||
      !eligible(mapping, Date.now()) ||
      digestWindow(Date.now(), mapping.digest_time, mapping.digest_timezone!).end !== receipt.window_end
    ) {
      await updateRoot("retired");
      return;
    }
    const next = await nextMessage(env, receipt, mapping, installation, token);
    if (!next) {
      await updateRoot("sent");
      return;
    }
    await updateRoot("pending");
    await env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
      SELECT ?,?,'slack_digest',json_object('digestId',?),?,? WHERE EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`)
      .bind(`outbox:${next.id}`, installation.workspace_id, id, Date.now(), Date.now(), id, token)
      .run();
  } catch (error) {
    await recordDeliveryError(env, installation, error);
    throw error;
  } finally {
    await env.DB.prepare(
      `UPDATE slack_digest_receipts SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
    )
      .bind(id, token)
      .run();
    await env.DB.prepare(
      `UPDATE slack_digest_messages SET claim_token=NULL,claimed_at=NULL WHERE receipt_id=? AND claim_token=?`,
    )
      .bind(id, token)
      .run();
  }
}
