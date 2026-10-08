import { type HistoryVerificationOptions } from "./slack-history";
import { mappingDeliveryPauseSql, slackDeliveryFeatures, type DeliveryOutcome } from "./slack-delivery-contracts";
import { logger } from "./observability";
import {
  SlackDispatchSkippedError,
  definiteSlackRejection,
  invalidSlackDestination,
  recordDeliveryError,
  recordSecondarySlackError,
  withSlackPrimaryError,
  recordPermanentDeliveryFailure,
} from "./slack-delivery";
import { DeliveryInProgressError } from "./notifications";
import type { Env } from "./env";
import type { ChannelEventType } from "../shared/activity";
import { ACTIVITY_LABELS } from "../shared/activity";
import { safeSlackText } from "./slack-blocks";
import { round2Installation, validateMappingEvidence, StaleSlackValidationError } from "./slack-channels";
import { reconcileBotPost } from "./slack-digests";
import {
  slackApi,
  SlackApiError,
  SlackRateLimitError,
  channelActivityActorAccessSql,
  channelActivityActorAuthoritySql,
  type SlackInstallation,
} from "./slack";

async function reconcileClaimedChannelPost(
  env: Env,
  installation: SlackInstallation,
  eventId: string,
  channelId: string,
  attemptedAt: number | null,
  token: string,
  options: HistoryVerificationOptions = {},
): Promise<DeliveryOutcome> {
  const result =
    attemptedAt === null
      ? { status: "missing" as const }
      : await reconcileBotPost(env, installation, channelId, `channel:${eventId}`, attemptedAt, undefined, {
          ...options,
          fence: {
            sql: `EXISTS(SELECT 1 FROM slack_channel_events WHERE id=? AND claim_token=?
      AND installation_generation=? AND delivery_channel_id=? AND attempted_at IS ?)`,
            binds: [eventId, token, installation.generation, channelId, attemptedAt],
          },
        });
  if (result.status === "incomplete") return "uncertain";
  const ts = result.status === "confirmed" ? result.ts : null;
  const saved = await env.DB.prepare(`UPDATE slack_channel_events SET round2_state=?,message_ts=?,
    delivered_at=CASE WHEN ? IS NOT NULL THEN ? ELSE delivered_at END
    WHERE id=? AND claim_token=? AND delivered_at IS NULL AND installation_generation=?
      AND delivery_channel_id=? AND attempted_at IS ?
      AND (round2_state IN ('sending','blocked') OR (round2_state='pending' AND attempted_at IS NOT NULL))`)
    .bind(ts ? "sent" : "blocked", ts, ts, Date.now(), eventId, token, installation.generation, channelId, attemptedAt)
    .run();
  if (!saved.meta.changes) throw new DeliveryInProgressError();
  return ts ? "completed" : "uncertain";
}

// History verification is independent of delivery flags and current mapping pauses.
export async function reconcileSlackChannelEvent(
  env: Env,
  eventId: string,
  options: HistoryVerificationOptions = {},
): Promise<DeliveryOutcome> {
  const token = crypto.randomUUID();
  const checkpoint = await env.DB.prepare(`UPDATE slack_channel_events SET claim_token=?,claimed_at=?
    WHERE id=? AND delivered_at IS NULL AND (claimed_at IS NULL OR claimed_at<=?)
      AND (round2_state IN ('sending','blocked') OR (round2_state='pending' AND attempted_at IS NOT NULL))
    RETURNING attempted_at,installation_generation,delivery_channel_id,
      (SELECT installation_id FROM slack_channel_subscriptions WHERE id=subscription_id) installation_id`)
    .bind(token, Date.now(), eventId, Date.now() - 60_000)
    .first<{
      attempted_at: number | null;
      installation_generation: number;
      delivery_channel_id: string;
      installation_id: string;
    }>();
  if (!checkpoint) {
    const live =
      await env.DB.prepare(`SELECT round2_state state FROM slack_channel_events WHERE id=? AND delivered_at IS NULL
      AND (round2_state IN ('sending','blocked') OR (round2_state='pending' AND attempted_at IS NOT NULL))`)
        .bind(eventId)
        .first();
    if (live) throw new DeliveryInProgressError();
    return "completed";
  }
  try {
    const installation = await round2Installation(env, checkpoint.installation_id, checkpoint.installation_generation);
    if (!installation) {
      const retired = await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='retired',delivered_at=?
        WHERE id=? AND claim_token=? AND NOT EXISTS(SELECT 1 FROM slack_installations
          WHERE id=? AND generation=? AND disconnected_at IS NULL)`)
        .bind(Date.now(), eventId, token, checkpoint.installation_id, checkpoint.installation_generation)
        .run();
      if (retired.meta.changes)
        logger.info("slack.delivery.retired", "slack", "Retired obsolete installation work.", {
          eventId,
          installationId: checkpoint.installation_id,
          generation: checkpoint.installation_generation,
        });
      return retired.meta.changes ? "completed" : "paused";
    }
    try {
      return await reconcileClaimedChannelPost(
        env,
        installation,
        eventId,
        checkpoint.delivery_channel_id,
        checkpoint.attempted_at,
        token,
        options,
      );
    } catch (error) {
      try {
        await recordDeliveryError(env, installation, error);
      } catch (secondary) {
        logger.error(
          "slack.channel.recovery_record_failed",
          "slack",
          "Could not record history verification error.",
          { eventId },
          secondary,
        );
      }
      throw error;
    }
  } finally {
    try {
      await env.DB.prepare(
        `UPDATE slack_channel_events SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
      )
        .bind(eventId, token)
        .run();
    } catch (error) {
      logger.error(
        "slack.channel.recovery_release_failed",
        "slack",
        "Could not release history verification claim.",
        { eventId },
        error,
      );
    }
  }
}

export async function deliverRound2ChannelEvent(env: Env, eventId: string, reconcileOnly = false) {
  if (reconcileOnly) {
    await reconcileSlackChannelEvent(env, eventId);
    return;
  }
  if (!slackDeliveryFeatures(env).slack_channel) return;
  const token = crypto.randomUUID();
  const claim =
    await env.DB.prepare(`UPDATE slack_channel_events SET claim_token=?,claimed_at=? WHERE id=? AND delivered_at IS NULL
    AND (suppressed_at IS NULL OR round2_state IN ('sending'))
    AND round2_state IN ('pending','sending') AND (claimed_at IS NULL OR claimed_at<?)`)
      .bind(token, Date.now(), eventId, Date.now() - 60_000)
      .run();
  if (!claim.meta.changes) {
    const live = await env.DB.prepare(
      `SELECT 1 FROM slack_channel_events WHERE id=? AND round2_state IN ('pending','sending') AND delivered_at IS NULL
        AND (suppressed_at IS NULL OR round2_state IN ('sending'))`,
    )
      .bind(eventId)
      .first();
    if (live) throw new DeliveryInProgressError();
    return;
  }
  try {
    const load = () =>
      env.DB.prepare(`SELECT e.*,m.installation_id,m.channel_id,m.space_id mapping_space,m.page_id mapping_page,m.muted_at,m.snoozed_until,
      m.notification_blocked_at,m.created_by,m.validation_state,m.validation_error,m.validation_revision,
      ${mappingDeliveryPauseSql("m", Date.now())} delivery_paused,
      EXISTS(SELECT 1 FROM json_each(m.event_types_json) WHERE value=e.event_type) event_enabled,
      EXISTS(SELECT 1 FROM slack_thread_links mirror WHERE mirror.installation_id=i.id AND mirror.channel_id=m.channel_id
        AND mirror.thread_id=e.thread_id AND mirror.state IN ('pending','active')) mirrored,i.disconnected_at,i.auth_error,i.generation current_generation,e.installation_generation generation,e.delivery_channel_id,p.title,p.space_id current_space,p.archived_at,p.import_job_id,p.is_template,actor.name actor_name,
      ${channelActivityActorAccessSql.replace(/\bpage\./g, "p.").replaceAll("event.", "e.")} actor_access,
      ${channelActivityActorAuthoritySql.replace(/\bpage\./g, "p.").replaceAll("event.", "e.")} actor_authority,
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
          actor_authority: number;
          validation_revision: number;
          delivery_paused: number;
          mapped: number;
          owner_valid: number;
          validation_state: string;
          validation_error: string | null;
          event_enabled: number;
          mirrored: number;
          archived_at: number | null;
          import_job_id: string | null;
          is_template: number;
          notification_blocked_at: number | null;
        }>();
    let row = await load();
    if (!row) return;
    const installation = await round2Installation(env, row.installation_id, row.generation);
    if (!installation) {
      const retired = await env.DB.prepare(
        `UPDATE slack_channel_events SET round2_state='retired',delivered_at=? WHERE id=? AND claim_token=? AND NOT EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)`,
      )
        .bind(Date.now(), eventId, token, row.installation_id, row.generation)
        .run();
      if (retired.meta.changes)
        logger.info("slack.delivery.retired", "slack", "Retired obsolete installation work.", {
          eventId,
          installationId: row.installation_id,
          generation: row.generation,
        });
      return;
    }
    const id = `channel:${eventId}`;
    const finish = async (ts: string | null, state = "sent", revision?: number) => {
      const result = await env.DB.prepare(
        `UPDATE slack_channel_events SET round2_state=?,message_ts=?,delivered_at=?,attempted_at=CASE WHEN ?='retired' THEN NULL ELSE attempted_at END WHERE id=? AND claim_token=?
          AND (? IS NULL OR EXISTS(SELECT 1 FROM slack_channel_subscriptions m WHERE m.id=slack_channel_events.subscription_id AND m.validation_revision=?
            AND m.muted_at IS NULL AND coalesce(m.snoozed_until,0)<=${Date.now()}
            AND EXISTS(SELECT 1 FROM slack_installations i WHERE i.id=m.installation_id AND i.auth_error IS NULL AND i.disconnected_at IS NULL)
            AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.topic='slack_channel' AND o.slack_round2_receipt_id=slack_channel_events.id AND o.slack_scope_paused_at IS NOT NULL)))`,
      )
        .bind(state, ts, Date.now(), state, eventId, token, revision ?? null, revision ?? null)
        .run();
      if (revision !== undefined && !result.meta.changes) throw new StaleSlackValidationError();
    };
    if (row.round2_state === "sending" || row.attempted_at !== null) {
      await reconcileClaimedChannelPost(env, installation, eventId, row.delivery_channel_id, row.attempted_at, token);
      return;
    }
    if (row.delivery_channel_id !== row.channel_id || !row.owner_valid || row.import_job_id || row.is_template) {
      await finish(null, "retired");
      return;
    }
    if (row.delivery_paused) return;
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
    const validation = await validateMappingEvidence(env, installation, row.subscription_id, row.channel_id);
    if (validation.outcome !== "valid") {
      if (validation.outcome === "permanent") await finish(null, "retired", validation.revision);
      return;
    }
    row = await load();
    if (!row) return;
    if (row.validation_revision !== validation.revision) throw new StaleSlackValidationError();
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
    if (row.delivery_paused) return;
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
            if (row.validation_revision !== validation.revision) throw new StaleSlackValidationError();
            if (
              row.current_generation !== installation.generation ||
              row.disconnected_at !== null ||
              row.channel_id !== row.delivery_channel_id ||
              !row.owner_valid ||
              !row.event_enabled ||
              row.mirrored ||
              row.import_job_id ||
              row.is_template
            ) {
              await finish(null, "retired");
              throw new SlackDispatchSkippedError();
            }
            if (
              row.validation_state !== "valid" ||
              row.auth_error ||
              row.notification_blocked_at ||
              row.muted_at ||
              (row.snoozed_until && row.snoozed_until > Date.now())
            )
              throw new SlackDispatchSkippedError();
            const departure = row.archived_at !== null || row.current_space !== row.mapping_space;
            if (!row.actor_authority || (!row.actor_access && !departure)) {
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
            if (current.validation_revision !== validation.revision) throw new StaleSlackValidationError();
            if (
              current.current_generation !== installation.generation ||
              current.disconnected_at !== null ||
              current.channel_id !== current.delivery_channel_id ||
              !current.owner_valid ||
              !current.event_enabled ||
              current.mirrored ||
              current.import_job_id ||
              current.is_template ||
              !current.actor_authority ||
              (!current.actor_access && current.archived_at === null && current.current_space === current.mapping_space)
            ) {
              await finish(null, "retired");
              throw new SlackDispatchSkippedError();
            }
            if (
              current.validation_state !== "valid" ||
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
        await withSlackPrimaryError(error, "rewind", { eventId }, () =>
          env.DB.prepare(`UPDATE slack_channel_events SET round2_state='pending',attempted_at=NULL
        WHERE id=? AND claim_token=? AND round2_state='sending'`)
            .bind(eventId, token)
            .run(),
        );
      if (error instanceof SlackDispatchSkippedError) return;
      await withSlackPrimaryError(error, "record", { eventId }, () =>
        recordDeliveryError(env, installation, error, destination.subscriptionId, destination.channelId),
      );
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
        await withSlackPrimaryError(error, "rewind", { eventId }, () =>
          env.DB.prepare(
            `UPDATE slack_channel_events SET round2_state='pending',attempted_at=NULL WHERE id=? AND claim_token=?`,
          )
            .bind(eventId, token)
            .run(),
        );
      }
      throw error;
    }
  } catch (error) {
    await recordSecondarySlackError("lookup", { eventId }, async () => {
      const installation = await env.DB.prepare(
        "SELECT i.* FROM slack_installations i JOIN slack_channel_subscriptions m ON m.installation_id=i.id JOIN slack_channel_events e ON e.subscription_id=m.id WHERE e.id=? AND e.claim_token=? AND i.generation=e.installation_generation",
      )
        .bind(eventId, token)
        .first<SlackInstallation>();
      if (installation) await recordDeliveryError(env, installation, error);
    });
    throw error;
  } finally {
    await recordSecondarySlackError("release", { eventId }, () =>
      env.DB.prepare(`UPDATE slack_channel_events SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`)
        .bind(eventId, token)
        .run(),
    );
  }
}
