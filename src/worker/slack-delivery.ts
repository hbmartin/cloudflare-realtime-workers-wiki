import type { Env } from "./env";
import {
  SlackApiError,
  SlackRateLimitError,
  recordSlackInstallationError,
  slackInstallationError,
  type SlackInstallation,
} from "./slack";

export type DeliveryOutcome = "completed" | "paused" | "competing" | "retryable" | "uncertain";

export function thumbnailDeliveryEnabled(env: Env) {
  return (
    env.SLACK_RICH_DIGESTS_ENABLED === "true" &&
    env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" &&
    env.WORKSPACE_ACTIVITY_ENABLED === "true"
  );
}

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
  if (mappingId && channelId && definiteSlackRejection(error)) {
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET notification_blocked_at=coalesce(notification_blocked_at,?),notification_error=?
      WHERE id=? AND installation_id=? AND channel_id=? AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)`)
      .bind(Date.now(), error.code, mappingId, installation.id, channelId, installation.id, installation.generation)
      .run();
  }
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
