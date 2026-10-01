import { DeliveryInProgressError } from "./notifications";
import type { Env } from "./env";
import type { ChannelEventType } from "../shared/activity";
import { ACTIVITY_LABELS } from "../shared/activity";
import { safeSlackText } from "./slack-blocks";
import { round2Installation, validateMapping } from "./slack-channels";
import { reconcileBotPost } from "./slack-digests";
import { slackApi, SlackApiError, SlackRateLimitError, channelActivityActorAccessSql } from "./slack";

export async function deliverRound2ChannelEvent(env: Env, eventId: string, reconcileOnly = false) {
  const token = crypto.randomUUID();
  const claim =
    await env.DB.prepare(`UPDATE slack_channel_events SET claim_token=?,claimed_at=? WHERE id=? AND delivered_at IS NULL
    AND suppressed_at IS NULL AND round2_state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""}) AND (claimed_at IS NULL OR claimed_at<?)`)
      .bind(token, Date.now(), eventId, Date.now() - 60_000)
      .run();
  if (!claim.meta.changes) {
    const live = await env.DB.prepare(
      `SELECT 1 FROM slack_channel_events WHERE id=? AND round2_state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""}) AND delivered_at IS NULL AND suppressed_at IS NULL`,
    )
      .bind(eventId)
      .first();
    if (live) throw new DeliveryInProgressError();
    return;
  }
  try {
    const row =
      await env.DB.prepare(`SELECT e.*,m.installation_id,m.channel_id,m.space_id mapping_space,m.page_id mapping_page,m.muted_at,m.snoozed_until,
      m.notification_blocked_at,m.created_by,i.generation,p.title,p.space_id current_space,p.archived_at,p.import_job_id,p.is_template,actor.name actor_name,
      ${channelActivityActorAccessSql.replace(/\bpage\./g, "p.").replaceAll("event.", "e.")} actor_access,
      EXISTS(SELECT 1 FROM slack_channel_subscriptions allowed WHERE allowed.installation_id=i.id AND allowed.channel_id=m.channel_id AND allowed.space_id=p.space_id
        AND (allowed.page_id IS NULL OR allowed.page_id=p.id) AND allowed.validation_state='valid') mapped,
      EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=i.workspace_id AND w.user_id=m.created_by AND w.role='owner') owner_valid
      FROM slack_channel_events e JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN slack_installations i ON i.id=m.installation_id
      JOIN pages p ON p.id=e.page_id LEFT JOIN user actor ON actor.id=e.actor_id WHERE e.id=?`)
        .bind(eventId)
        .first<{
          round2_state: string;
          attempted_at: number | null;
          installation_id: string;
          generation: number;
          channel_id: string;
          subscription_id: string;
          page_id: string;
          thread_id: string | null;
          mapping_space: string;
          current_space: string;
          mapping_page: string | null;
          muted_at: number | null;
          snoozed_until: number | null;
          title: string;
          actor_name: string | null;
          event_type: ChannelEventType;
          actor_access: number;
          mapped: number;
          owner_valid: number;
          archived_at: number | null;
          import_job_id: string | null;
          is_template: number;
          notification_blocked_at: number | null;
        }>();
    if (!row || (reconcileOnly && !["sending", "blocked"].includes(row.round2_state))) return;
    const installation = await round2Installation(env, row.installation_id, row.generation);
    if (!installation) return;
    const id = `channel:${eventId}`;
    const finish = async (ts: string | null, state = "sent") =>
      env.DB.prepare(
        `UPDATE slack_channel_events SET round2_state=?,message_ts=?,delivered_at=? WHERE id=? AND claim_token=?`,
      )
        .bind(state, ts, Date.now(), eventId, token)
        .run();
    if (row.round2_state === "sending" || reconcileOnly) {
      const ts = await reconcileBotPost(env, installation, row.channel_id, id, row.attempted_at!);
      if (ts) await finish(ts);
      else
        await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='blocked' WHERE id=?`).bind(eventId).run();
      return;
    }
    if (
      !row.owner_valid ||
      row.muted_at ||
      (row.snoozed_until && row.snoozed_until > Date.now()) ||
      row.import_job_id ||
      row.is_template
    ) {
      await finish(null, "retired");
      return;
    }
    const mirrored =
      row.thread_id &&
      (await env.DB.prepare(
        `SELECT 1 FROM slack_thread_links WHERE installation_id=? AND channel_id=? AND thread_id=? AND state IN ('pending','active')`,
      )
        .bind(row.installation_id, row.channel_id, row.thread_id)
        .first());
    if (mirrored) {
      await finish(null, "retired");
      return;
    }
    if (!(await validateMapping(env, installation, row.subscription_id, row.channel_id))) {
      await finish(null, "retired");
      return;
    }
    const departure = row.archived_at !== null || row.current_space !== row.mapping_space;
    if (!row.actor_access && !departure) {
      await finish(null, "retired");
      return;
    }
    const available = Boolean(row.actor_access && row.mapped);
    const title = available ? safeSlackText(row.title, 200) : "A page is no longer available";
    const actor = available ? safeSlackText(row.actor_name ?? "A collaborator", 80) : "A collaborator";
    const text = `${actor} · ${ACTIVITY_LABELS[row.event_type]} · ${title}`;
    await env.DB.prepare(
      `UPDATE slack_channel_events SET round2_state='sending',attempted_at=? WHERE id=? AND claim_token=?`,
    )
      .bind(Date.now(), eventId, token)
      .run();
    try {
      const posted = await slackApi(env, installation, "chat.postMessage", {
        channel: row.channel_id,
        text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              verbatim: true,
              text: `${text}${available && !departure ? `\n<${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(row.page_id)}|Open in NoteFlare>` : ""}`,
            },
          },
        ],
        metadata: { event_type: "noteflare_channel_activity", event_payload: { delivery_id: id } },
        unfurl_links: false,
        unfurl_media: false,
      });
      await finish(posted.ts);
    } catch (error) {
      if (error instanceof SlackRateLimitError)
        await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='pending' WHERE id=?`).bind(eventId).run();
      else if (
        error instanceof SlackApiError &&
        error.status < 500 &&
        !["http_error", "invalid_response", "internal_error", "fatal_error"].includes(error.code)
      )
        await finish(null, "retired");
      throw error;
    }
  } finally {
    await env.DB.prepare(
      `UPDATE slack_channel_events SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
    )
      .bind(eventId, token)
      .run();
  }
}
