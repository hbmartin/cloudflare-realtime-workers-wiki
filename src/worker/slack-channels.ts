import { retryableSlackError } from "./slack-delivery";
import { channelInvalidReason } from "./slack-schedule";
import { validTimezone } from "../shared/date-mentions";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import {
  slackApi,
  validatedSlackChannel as validatedChannel,
  SlackApiError,
  SlackRateLimitError,
  recordSlackInstallationError,
  slackInstallationError,
  type SlackInstallation,
} from "./slack";

export async function round2Installation(env: Env, id: string, generation?: number) {
  return env.DB.prepare(`SELECT * FROM slack_installations WHERE id=? AND disconnected_at IS NULL
    AND auth_error IS NULL AND (? IS NULL OR generation=?)`)
    .bind(id, generation ?? null, generation ?? null)
    .first<SlackInstallation>();
}
export async function validateMapping(env: Env, installation: SlackInstallation, mappingId: string, channelId: string) {
  try {
    const channel = await validatedChannel(env, installation, channelId);
    const saved =
      await env.DB.prepare(`UPDATE slack_channel_subscriptions SET channel_name=?,channel_type=?,validation_state='valid',
      validation_error=NULL,bot_is_member=1,validated_at=?,
      notification_blocked_at=CASE WHEN notification_error=validation_error THEN NULL ELSE notification_blocked_at END,
      notification_error=CASE WHEN notification_error=validation_error THEN NULL ELSE notification_error END WHERE id=? AND installation_id=? AND channel_id=?
      AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)
      AND EXISTS(SELECT 1 FROM workspace_members wm JOIN slack_installations i ON i.workspace_id=wm.workspace_id WHERE i.id=installation_id AND wm.user_id=slack_channel_subscriptions.created_by AND wm.role='owner')`)
        .bind(
          channel.name,
          channel.is_private ? "private_channel" : "public_channel",
          Date.now(),
          mappingId,
          installation.id,
          channelId,
          installation.id,
          installation.generation,
        )
        .run();
    return saved.meta.changes > 0;
  } catch (error) {
    if (retryableSlackError(error)) throw error;
    if (!(error instanceof HttpError || error instanceof SlackApiError)) throw error;
    if (error instanceof SlackApiError && slackInstallationError(error))
      await recordSlackInstallationError(env, installation.id, error, installation.generation);
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET validation_state='invalid',validation_error=?,
      validated_at=?,bot_is_member=0,notification_blocked_at=?,notification_error=? WHERE id=? AND installation_id=? AND channel_id=?
      AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)`)
      .bind(
        error.code,
        Date.now(),
        Date.now(),
        error.code,
        mappingId,
        installation.id,
        channelId,
        installation.id,
        installation.generation,
      )
      .run();
    return false;
  }
}
export async function channelDirectory(env: Env, member: MemberContext, cursor?: string) {
  if (member.role !== "owner") throw new HttpError(403, "owner_required", "Only an owner can choose Slack channels.");
  if (env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true")
    throw new HttpError(404, "slack_directory_disabled", "Channel selection is not enabled.");
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE workspace_id=? AND disconnected_at IS NULL`,
  )
    .bind(member.workspace.id)
    .first<SlackInstallation>();
  if (!installation) throw new HttpError(409, "slack_not_connected", "Connect Slack first.");
  try {
    const result = await slackApi(env, installation, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    return {
      channels: result.channels
        .filter((c) => !channelInvalidReason(c))
        .map((c) => ({ id: c.id, name: c.name, private: Boolean(c.is_private) })),
      nextCursor: result.response_metadata?.next_cursor || null,
    };
  } catch (error) {
    if (error instanceof SlackRateLimitError)
      throw new HttpError(429, "slack_rate_limited", "Slack channel search is temporarily rate limited.", {
        retryAfter: error.retryAfter,
      });
    if (error instanceof SlackApiError && error.status < 500)
      throw new HttpError(
        409,
        error.code,
        error.code === "missing_scope"
          ? "Reauthorize Slack channel read access to load the directory."
          : "Slack channel access needs attention.",
      );
    throw error;
  }
}

export async function syncRound2Configuration(env: Env) {
  const activity = env.WORKSPACE_ACTIVITY_ENABLED === "true" ? 1 : 0;
  const share = env.SLACK_SHARE_REFRESH_ENABLED === "true" ? 1 : 0;
  const validation = env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" ? 1 : 0;
  const rich = env.SLACK_RICH_DIGESTS_ENABLED === "true" ? 1 : 0;
  const zone =
    env.SLACK_DIGEST_DEFAULT_TIMEZONE && validTimezone(env.SLACK_DIGEST_DEFAULT_TIMEZONE)
      ? env.SLACK_DIGEST_DEFAULT_TIMEZONE
      : null;
  try {
    await env.DB.prepare(`UPDATE round2_runtime SET activity_enabled=?,share_enabled=?,validation_enabled=?,rich_enabled=?,timezone=?,
    activity_started_at=CASE WHEN ?=1 THEN coalesce(activity_started_at,?) ELSE activity_started_at END
    WHERE id=1 AND (activity_enabled<>? OR share_enabled<>? OR validation_enabled<>? OR rich_enabled<>? OR timezone IS NOT ?)`)
      .bind(activity, share, validation, rich, zone, activity, Date.now(), activity, share, validation, rich, zone)
      .run();
  } catch (error) {
    // Disabled controls must not break health/auth diagnostics on an older database.
    if (
      !activity &&
      !share &&
      !validation &&
      !rich &&
      error instanceof Error &&
      error.message.includes("no such table: round2_runtime")
    )
      return { activationError: null };
    throw error;
  }
  if (!validation) return { activationError: null };
  if (!zone)
    return {
      activationError:
        "Set a valid SLACK_DIGEST_DEFAULT_TIMEZONE before initializing Slack channel mappings. Existing saved schedules remain active.",
    };
  await env.DB.prepare(`UPDATE slack_channel_subscriptions SET digest_timezone=coalesce(digest_timezone,?),
    digest_not_before=?,round2_initialized=1,event_types_json=(SELECT json_group_array(value) FROM
      (SELECT value FROM json_each(event_types_json) UNION SELECT 'page_created' UNION SELECT 'page_moved' UNION SELECT 'page_archived' UNION SELECT 'task_status_changed'))
    WHERE round2_initialized=0`)
    .bind(zone, Date.now())
    .run();
  return { activationError: null };
}
export async function revalidateMappings(env: Env, dryRun = false, workspaceId?: string) {
  if (env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true" && !dryRun) return [];
  const rows =
    await env.DB.prepare(`SELECT m.id,m.installation_id,m.channel_id,i.auth_error FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
    WHERE i.disconnected_at IS NULL AND (i.auth_error IS NULL OR ?=1) AND (? IS NULL OR i.workspace_id=?) AND (?=1 OR coalesce(m.validated_at,0)<?) ORDER BY coalesce(m.validated_at,0),m.id`)
      .bind(dryRun ? 1 : 0, workspaceId ?? null, workspaceId ?? null, dryRun ? 1 : 0, Date.now() - 15 * 60_000)
      .all<{ id: string; installation_id: string; channel_id: string; auth_error: string | null }>();
  const report: Array<{ id: string; valid: boolean; reason: string | null }> = [];
  const limited = new Set<string>();
  for (const row of rows.results) {
    if (row.auth_error) {
      report.push({ id: row.id, valid: false, reason: row.auth_error });
      continue;
    }
    if (limited.has(row.installation_id)) {
      if (dryRun) report.push({ id: row.id, valid: false, reason: "rate_limited" });
      continue;
    }
    const installation = await round2Installation(env, row.installation_id);
    if (!installation) continue;
    try {
      if (dryRun) {
        await validatedChannel(env, installation, row.channel_id);
        report.push({ id: row.id, valid: true, reason: null });
      } else {
        const valid = await validateMapping(env, installation, row.id, row.channel_id);
        report.push({ id: row.id, valid, reason: null });
      }
    } catch (error) {
      if (error instanceof SlackRateLimitError) {
        limited.add(row.installation_id);
        if (dryRun) report.push({ id: row.id, valid: false, reason: "rate_limited" });
        continue;
      }
      if (dryRun && (error instanceof SlackApiError || error instanceof HttpError))
        report.push({ id: row.id, valid: false, reason: error.code });
      else
        report.push({
          id: row.id,
          valid: false,
          reason: error instanceof SlackApiError ? error.code : "validation_retry_pending",
        });
    }
  }
  return report;
}
