import { round2WakeStatement } from "./slack-delivery-contracts";
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

export function permanentSlackValidationError(error: string | null | undefined) {
  return ["channel_not_found", "not_in_channel", "is_archived", "shared_channel", "unsupported_channel_type"].includes(
    error ?? "",
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
  await round2WakeStatement(env, mappingId).run();
}

export function invalidSlackDestination(error: unknown): error is SlackApiError {
  return (
    definiteSlackRejection(error) &&
    ["channel_not_found", "not_in_channel", "is_archived", "restricted_action", "no_permission"].includes(error.code)
  );
}

export function retireDigestReceiptStatements(env: Env, id: string, token: string, error: string | null = null) {
  const guard = `EXISTS(SELECT 1 FROM slack_digest_receipts root WHERE root.id=? AND root.claim_token=?
    AND NOT EXISTS(SELECT 1 FROM slack_digest_messages uncertain WHERE uncertain.receipt_id=root.id
      AND (uncertain.state IN ('sending','blocked') OR (uncertain.claimed_at>${Date.now() - 60_000} AND uncertain.claim_token IS NOT root.claim_token))))`;
  return [
    env.DB.prepare(`UPDATE slack_channel_events SET round2_state='retired',suppressed_at=coalesce(suppressed_at,?)
      WHERE delivered_at IS NULL AND suppressed_at IS NULL AND round2_state='pending'
        AND (id IN (SELECT value FROM slack_digest_messages child,json_each(child.event_ids_json)
          WHERE child.receipt_id=? AND child.state='pending') OR (
          cadence='digest' AND summary_id IS NULL
          AND EXISTS(SELECT 1 FROM slack_digest_receipts root WHERE root.id=?
            AND root.subscription_id=slack_channel_events.subscription_id
            AND slack_channel_events.created_at>=root.window_start AND slack_channel_events.created_at<root.window_end)
          AND NOT EXISTS(SELECT 1 FROM slack_digest_message_events reserved WHERE reserved.event_id=slack_channel_events.id)))
        AND (claimed_at IS NULL OR claimed_at<=? OR claim_token=?) AND ${guard}`).bind(
      Date.now(),
      id,
      id,
      Date.now() - 60_000,
      token,
      id,
      token,
    ),
    env.DB.prepare(`UPDATE slack_digest_messages SET state='retired',claim_token=NULL,claimed_at=NULL,last_error=?
      WHERE receipt_id=? AND state='pending' AND ${guard}`).bind(error, id, id, token),
    env.DB.prepare(
      `UPDATE slack_digest_receipts SET state='retired',last_error=? WHERE id=? AND claim_token=? AND ${guard}`,
    ).bind(error, id, token, id, token),
  ];
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
      AND (claimed_at IS NULL OR claimed_at<?) AND NOT EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)
      ${table === "slack_digest_receipts" ? "AND NOT EXISTS(SELECT 1 FROM slack_digest_messages child WHERE child.receipt_id=slack_digest_receipts.id AND child.state IN ('sending','blocked'))" : ""}`).bind(
      token,
      Date.now(),
      id,
      Date.now() - 60_000,
      installationId,
      generation,
    ),
    ...(table === "slack_digest_receipts" ? retireDigestReceiptStatements(env, id, token) : []),
    env.DB.prepare(
      `UPDATE ${table} SET state='retired',claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
    ).bind(id, token),
  ]);
}

// The dispatch hook has already classified unsent work as paused or retired.
export class SlackDispatchSkippedError extends Error {}
