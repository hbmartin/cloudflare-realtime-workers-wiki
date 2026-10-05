import {
  SlackDispatchSkippedError,
  definiteSlackRejection,
  invalidSlackDestination,
  recordDeliveryError,
  recordPermanentDeliveryFailure,
} from "./slack-delivery";
import { DeliveryInProgressError } from "./notifications";
import type { Env } from "./env";
import type { ChannelEventType } from "../shared/activity";
import { ACTIVITY_LABELS } from "../shared/activity";
import { safeSlackText } from "./slack-blocks";
import { round2Installation, validateMapping } from "./slack-channels";
import { reconcileBotPost } from "./slack-digests";
import {
  slackApi,
  SlackApiError,
  SlackRateLimitError,
  channelActivityActorAccessSql,
  type SlackInstallation,
} from "./slack";

export async function deliverRound2ChannelEvent(env: Env, eventId: string, reconcileOnly = false) {
  const token = crypto.randomUUID();
  const claim =
    await env.DB.prepare(`UPDATE slack_channel_events SET claim_token=?,claimed_at=? WHERE id=? AND delivered_at IS NULL
    AND (suppressed_at IS NULL OR round2_state IN ('sending'${reconcileOnly ? ",'blocked'" : ""}))
    AND round2_state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""}) AND (claimed_at IS NULL OR claimed_at<?)`)
      .bind(token, Date.now(), eventId, Date.now() - 60_000)
      .run();
  if (!claim.meta.changes) {
    const live = await env.DB.prepare(
      `SELECT 1 FROM slack_channel_events WHERE id=? AND round2_state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""}) AND delivered_at IS NULL
        AND (suppressed_at IS NULL OR round2_state IN ('sending'${reconcileOnly ? ",'blocked'" : ""}))`,
    )
      .bind(eventId)
      .first();
    if (live) throw new DeliveryInProgressError();
    return;
  }
  try {
    const load = () =>
      env.DB.prepare(`SELECT e.*,m.installation_id,m.channel_id,m.space_id mapping_space,m.page_id mapping_page,m.muted_at,m.snoozed_until,
      m.notification_blocked_at,m.created_by,m.validation_state,
      EXISTS(SELECT 1 FROM json_each(m.event_types_json) WHERE value=e.event_type) event_enabled,
      EXISTS(SELECT 1 FROM slack_thread_links mirror WHERE mirror.installation_id=i.id AND mirror.channel_id=m.channel_id
        AND mirror.thread_id=e.thread_id AND mirror.state IN ('pending','active')) mirrored,i.disconnected_at,i.auth_error,i.generation current_generation,e.installation_generation generation,e.delivery_channel_id,p.title,p.space_id current_space,p.archived_at,p.import_job_id,p.is_template,actor.name actor_name,
      ${channelActivityActorAccessSql.replace(/\bpage\./g, "p.").replaceAll("event.", "e.")} actor_access,
      EXISTS(SELECT 1 FROM slack_channel_subscriptions allowed WHERE allowed.installation_id=i.id AND allowed.channel_id=m.channel_id AND allowed.space_id=p.space_id
        AND (allowed.page_id IS NULL OR allowed.page_id=p.id) AND allowed.validation_state='valid') mapped,
      EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=i.workspace_id AND w.user_id=m.created_by AND w.role='owner') owner_valid
      FROM slack_channel_events e JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN slack_installations i ON i.id=m.installation_id
      JOIN pages p ON p.id=e.page_id LEFT JOIN user actor ON actor.id=e.actor_id WHERE e.id=?`)
        .bind(eventId)
        .first<{
          claim_token: string;
          suppressed_at: number | null;
          delivered_at: number | null;
          disconnected_at: number | null;
          auth_error: string | null;
          round2_state: string;
          attempted_at: number | null;
          installation_id: string;
          generation: number;
          current_generation: number;
          channel_id: string;
          delivery_channel_id: string;
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
          validation_state: string;
          event_enabled: number;
          mirrored: number;
          archived_at: number | null;
          import_job_id: string | null;
          is_template: number;
          notification_blocked_at: number | null;
        }>();
    let row = await load();
    if (!row || (reconcileOnly && !["sending", "blocked"].includes(row.round2_state))) return;
    const installation = await round2Installation(env, row.installation_id, row.generation);
    if (!installation) {
      await env.DB.prepare(
        `UPDATE slack_channel_events SET round2_state='retired',delivered_at=? WHERE id=? AND claim_token=? AND NOT EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)`,
      )
        .bind(Date.now(), eventId, token, row.installation_id, row.generation)
        .run();
      return;
    }
    const id = `channel:${eventId}`;
    const finish = async (ts: string | null, state = "sent") =>
      env.DB.prepare(
        `UPDATE slack_channel_events SET round2_state=?,message_ts=?,delivered_at=?,attempted_at=CASE WHEN ?='retired' THEN NULL ELSE attempted_at END WHERE id=? AND claim_token=?`,
      )
        .bind(state, ts, Date.now(), state, eventId, token)
        .run();
    if (row.round2_state === "sending" || reconcileOnly) {
      const ts = await reconcileBotPost(env, installation, row.delivery_channel_id, id, row.attempted_at!);
      if (ts) await finish(ts);
      else
        await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='blocked' WHERE id=? AND claim_token=?`)
          .bind(eventId, token)
          .run();
      return;
    }
    if (row.delivery_channel_id !== row.channel_id || !row.owner_valid || row.import_job_id || row.is_template) {
      await finish(null, "retired");
      return;
    }
    if (row.notification_blocked_at || row.muted_at || (row.snoozed_until && row.snoozed_until > Date.now())) return;
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
      const failure = await env.DB.prepare(
        "SELECT validation_error FROM slack_channel_subscriptions WHERE id=? AND channel_id=?",
      )
        .bind(row.subscription_id, row.channel_id)
        .first<{ validation_error: string | null }>();
      if (
        ["channel_not_found", "not_in_channel", "is_archived", "shared_channel", "unsupported_channel_type"].includes(
          failure?.validation_error ?? "",
        )
      )
        await finish(null, "retired");
      return;
    }
    row = await load();
    if (!row) return;
    if (
      row.current_generation !== installation.generation ||
      row.channel_id !== row.delivery_channel_id ||
      !row.owner_valid ||
      row.import_job_id ||
      row.is_template
    ) {
      await finish(null, "retired");
      return;
    }
    if (row.notification_blocked_at || row.muted_at || (row.snoozed_until && row.snoozed_until > Date.now())) return;
    const destination = { subscriptionId: row.subscription_id, channelId: row.channel_id };
    let dispatched = false;
    try {
      const posted = await slackApi(
        env,
        installation,
        "chat.postMessage",
        { channel: row.channel_id, text: "" },
        {
          onDispatch: () => {
            dispatched = true;
          },
          beforeDispatch: async () => {
            row = await load();
            if (!row || row.claim_token !== token || row.round2_state !== "pending")
              throw new DeliveryInProgressError();
            if (
              row.current_generation !== installation.generation ||
              row.disconnected_at !== null ||
              row.channel_id !== row.delivery_channel_id ||
              !row.owner_valid ||
              !row.event_enabled ||
              row.mirrored ||
              row.validation_state !== "valid" ||
              row.import_job_id ||
              row.is_template
            ) {
              await finish(null, "retired");
              throw new SlackDispatchSkippedError();
            }
            if (
              row.auth_error ||
              row.notification_blocked_at ||
              row.muted_at ||
              (row.snoozed_until && row.snoozed_until > Date.now())
            )
              throw new SlackDispatchSkippedError();
            const departure = row.archived_at !== null || row.current_space !== row.mapping_space;
            if (!row.actor_access && !departure) {
              await finish(null, "retired");
              throw new SlackDispatchSkippedError();
            }
            const sending = await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='sending',attempted_at=?
            WHERE id=? AND claim_token=? AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL`)
              .bind(Date.now(), eventId, token)
              .run();
            if (!sending.meta.changes) throw new DeliveryInProgressError();
            // Recheck after the checkpoint's asynchronous write as well as token refresh.
            const current = await load();
            if (
              !current ||
              current.claim_token !== token ||
              current.round2_state !== "sending" ||
              current.suppressed_at !== null ||
              current.delivered_at !== null
            )
              throw new DeliveryInProgressError();
            if (
              current.current_generation !== installation.generation ||
              current.disconnected_at !== null ||
              current.channel_id !== current.delivery_channel_id ||
              !current.owner_valid ||
              !current.event_enabled ||
              current.mirrored ||
              current.validation_state !== "valid" ||
              current.import_job_id ||
              current.is_template ||
              (!current.actor_access && current.archived_at === null && current.current_space === current.mapping_space)
            ) {
              await finish(null, "retired");
              throw new SlackDispatchSkippedError();
            }
            if (
              current.auth_error ||
              current.notification_blocked_at ||
              current.muted_at ||
              (current.snoozed_until && current.snoozed_until > Date.now())
            )
              throw new SlackDispatchSkippedError();
            const currentDeparture = current.archived_at !== null || current.current_space !== current.mapping_space;
            const available = Boolean(current.actor_access && current.mapped);
            const title = available ? safeSlackText(current.title, 200) : "A page is no longer available";
            const actor = available ? safeSlackText(current.actor_name ?? "A collaborator", 80) : "A collaborator";
            const text = `${actor} · ${ACTIVITY_LABELS[current.event_type]} · ${title}`;
            return {
              channel: current.channel_id,
              text,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    verbatim: true,
                    text: `${text}${available && !currentDeparture ? `\n<${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(current.page_id)}|Open in NoteFlare>` : ""}`,
                  },
                },
              ],
              metadata: { event_type: "noteflare_channel_activity", event_payload: { delivery_id: id } },
              unfurl_links: false,
              unfurl_media: false,
            };
          },
        },
      );
      await finish(posted.ts);
    } catch (error) {
      if (!dispatched)
        await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='pending',attempted_at=NULL
        WHERE id=? AND claim_token=? AND round2_state='sending'`)
          .bind(eventId, token)
          .run();
      if (error instanceof SlackDispatchSkippedError) return;
      await recordDeliveryError(env, installation, error, destination.subscriptionId, destination.channelId);
      if (error instanceof SlackApiError && error.code === "msg_too_long") {
        await recordPermanentDeliveryFailure(
          env,
          installation,
          id,
          destination.subscriptionId,
          destination.channelId,
          error.code,
        );
        await finish(null, "retired");
        return;
      }
      if (invalidSlackDestination(error)) {
        await finish(null, "retired");
        return;
      }
      if (error instanceof SlackRateLimitError || definiteSlackRejection(error)) {
        await env.DB.prepare(
          `UPDATE slack_channel_events SET round2_state='pending',attempted_at=NULL WHERE id=? AND claim_token=?`,
        )
          .bind(eventId, token)
          .run();
      }
      throw error;
    }
  } catch (error) {
    const installation = await env.DB.prepare(
      "SELECT i.* FROM slack_installations i JOIN slack_channel_subscriptions m ON m.installation_id=i.id JOIN slack_channel_events e ON e.subscription_id=m.id WHERE e.id=? AND e.claim_token=? AND i.generation=e.installation_generation",
    )
      .bind(eventId, token)
      .first<SlackInstallation>();
    if (installation) await recordDeliveryError(env, installation, error);
    throw error;
  } finally {
    await env.DB.prepare(
      `UPDATE slack_channel_events SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
    )
      .bind(eventId, token)
      .run();
  }
}
