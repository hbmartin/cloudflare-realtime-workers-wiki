import type { Env } from "./env";
import {
  SlackApiError,
  SlackRateLimitError,
  recordSlackInstallationError,
  slackInstallationError,
  type SlackInstallation,
} from "./slack";

export type DeliveryOutcome = "completed" | "paused" | "competing" | "retryable" | "uncertain";

export { thumbnailDeliveryEnabled } from "./slack-delivery-contracts";

// Only definite API rejections prove that no message was created. Transport and
// malformed-response failures must retain the sending checkpoint for reconciliation.
export function definiteSlackRejection(error: unknown): error is SlackApiError {
  return (
    error instanceof SlackApiError &&
    error.status < 500 &&
    ![
      "http_error",
      "invalid_response",
      "internal_error",
      "fatal_error",
      "service_unavailable",
      "request_timeout",
      "org_login_required",
      "team_added_to_org",
    ].includes(error.code)
  );
}

export function retryableSlackError(error: unknown) {
  return error instanceof SlackRateLimitError || (error instanceof SlackApiError && !definiteSlackRejection(error));
}

export async function recordDeliveryError(
  env: Env,
  installation: SlackInstallation,
  error: unknown,
  mappingId?: string,
  channelId?: string,
) {
  if (!(error instanceof SlackApiError)) return;
  if (slackInstallationError(error)) {
    await recordSlackInstallationError(env, installation.id, error, installation.generation);
    return;
  }
  if (["missing_scope", "msg_too_long"].includes(error.code)) return;
  if (mappingId && channelId && definiteSlackRejection(error)) {
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET notification_blocked_at=coalesce(notification_blocked_at,?),notification_error=?
      WHERE id=? AND installation_id=? AND channel_id=? AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)`)
      .bind(Date.now(), error.code, mappingId, installation.id, channelId, installation.id, installation.generation)
      .run();
  }
}

export async function recordPermanentDeliveryFailure(
  env: Env,
  installation: SlackInstallation,
  deliveryId: string,
  mappingId: string,
  channelId: string,
  reason: string,
) {
  await env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
    (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
    SELECT ?,i.workspace_id,?,coalesce(nullif(m.channel_name,''),?),?,? FROM slack_installations i
    LEFT JOIN slack_channel_subscriptions m ON m.id=? AND m.installation_id=i.id
    WHERE i.id=? AND i.generation=?`)
    .bind(deliveryId, mappingId, channelId, reason, Date.now(), mappingId, installation.id, installation.generation)
    .run();
}

export async function wakeRound2Mapping(env: Env, mappingId: string) {
  const now = Date.now();
  await env.DB.prepare(`UPDATE outbox SET enqueued_at=NULL,available_at=?,slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL
    WHERE slack_scope_paused_at IS NULL AND EXISTS(SELECT 1 FROM slack_channel_subscriptions m
      JOIN slack_installations i ON i.id=m.installation_id WHERE m.id=? AND m.notification_blocked_at IS NULL
      AND m.muted_at IS NULL AND coalesce(m.snoozed_until,0)<=? AND i.disconnected_at IS NULL AND i.auth_error IS NULL AND (
      (topic='slack_channel' AND EXISTS(SELECT 1 FROM slack_channel_events r WHERE r.id=slack_round2_receipt_id AND r.subscription_id=m.id AND r.round2_state='pending' AND r.suppressed_at IS NULL AND r.delivered_at IS NULL AND coalesce(r.claimed_at,0)<?)) OR
      (topic='slack_digest' AND EXISTS(SELECT 1 FROM slack_digest_receipts r WHERE r.id=slack_round2_receipt_id AND r.subscription_id=m.id AND r.state='pending' AND coalesce(r.claimed_at,0)<? AND NOT EXISTS(SELECT 1 FROM slack_digest_messages child WHERE child.receipt_id=r.id AND child.state IN ('sending','blocked')))) OR
      (topic='slack_bulk' AND EXISTS(SELECT 1 FROM slack_bulk_receipts r WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND r.channel_id=m.channel_id AND r.state='pending' AND coalesce(r.claimed_at,0)<?)) OR
      (topic='slack_share_refresh' AND EXISTS(SELECT 1 FROM slack_share_refreshes r WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND r.channel_id=m.channel_id AND r.state='pending' AND coalesce(r.claimed_at,0)<?)) OR
      (topic='slack_file_upload' AND EXISTS(SELECT 1 FROM slack_file_artifacts r JOIN pages p ON p.id=r.page_id WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id) AND r.state='pending' AND coalesce(r.claimed_at,0)<?))))`)
    .bind(now, mappingId, now, now - 60_000, now - 60_000, now - 60_000, now - 60_000, now - 60_000)
    .run();
}

export function invalidSlackDestination(error: unknown): error is SlackApiError {
  return (
    definiteSlackRejection(error) &&
    ["channel_not_found", "not_in_channel", "is_archived", "restricted_action", "no_permission"].includes(error.code)
  );
}

export async function retireObsoleteReceipt(
  env: Env,
  table: "slack_digest_receipts" | "slack_bulk_receipts" | "slack_share_refreshes" | "slack_file_artifacts",
  id: string,
  installationId: string,
  generation: number,
) {
  const token = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${table} SET claim_token=?,claimed_at=? WHERE id=? AND state IN ('pending'${table === "slack_file_artifacts" ? ",'uploading'" : ""})
      AND (claimed_at IS NULL OR claimed_at<?) AND NOT EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)`).bind(
      token,
      Date.now(),
      id,
      Date.now() - 60_000,
      installationId,
      generation,
    ),
    env.DB.prepare(
      `UPDATE ${table} SET state='retired',claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
    ).bind(id, token),
  ]);
}
