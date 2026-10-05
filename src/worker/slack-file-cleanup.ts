import type { Env } from "./env";
import type { SlackCleanupHealth } from "../shared/types";
import { definiteSlackRejection } from "./slack-delivery";
import { logger } from "./observability";
import {
  slackApi,
  slackHasScopes,
  slackInstallationError,
  recordSlackInstallationError,
  recordSlackFileScopeError,
  SlackApiError,
  SlackRateLimitError,
  usableBotToken,
  type SlackInstallation,
} from "./slack";

type CleanupJob = {
  id: string;
  workspace_id: string;
  installation_id: string;
  team_id: string;
  bot_user_id: string;
  file_id: string;
  attempt_count: number;
};
const RETRY_MS = 15 * 60_000;
const LEASE_MS = 60_000;

export async function slackFileCleanupHealth(env: Env, workspaceId: string): Promise<SlackCleanupHealth> {
  const rows =
    await env.DB.prepare(`SELECT state,coalesce(last_error,'cleanup_credentials_unavailable') reason,count(*) count
    FROM slack_file_cleanup_jobs WHERE workspace_id=? AND state IN ('pending','paused','failed') GROUP BY state,coalesce(last_error,'cleanup_credentials_unavailable')`)
      .bind(workspaceId)
      .all<{ state: "pending" | "paused" | "failed"; reason: string; count: number }>();
  const health: SlackCleanupHealth = { pending: 0, paused: 0, failed: 0, pausedByReason: [] };
  for (const row of rows.results) {
    health[row.state] += row.count;
    if (row.state === "paused") health.pausedByReason.push({ reason: row.reason, count: row.count });
  }
  return health;
}

export async function processSlackFileCleanup(env: Env, id: string) {
  const now = Date.now();
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE slack_file_cleanup_jobs SET claim_token=?,claimed_at=?
    WHERE id=? AND state='pending' AND next_attempt_at<=? AND (claimed_at IS NULL OR claimed_at<=?)`)
    .bind(token, now, id, now, now - LEASE_MS)
    .run();
  if (!claim.meta.changes) return false;
  const save = async (state: string, error: string | null, next: number | null = null) => {
    await env.DB.prepare(`UPDATE slack_file_cleanup_jobs SET state=?,last_error=?,next_attempt_at=?,updated_at=?,claim_token=NULL,claimed_at=NULL
      WHERE id=? AND claim_token=?`)
      .bind(state, error, next, Date.now(), id, token)
      .run();
  };
  try {
    const job = await env.DB.prepare("SELECT * FROM slack_file_cleanup_jobs WHERE id=? AND claim_token=?")
      .bind(id, token)
      .first<CleanupJob>();
    if (!job) return false;
    if (job.attempt_count >= 2) {
      await save("failed", "cleanup_delete_unconfirmed");
      return false;
    }
    const installation =
      await env.DB.prepare(`SELECT * FROM slack_installations WHERE workspace_id=? AND team_id=? AND bot_user_id=?
      AND disconnected_at IS NULL AND auth_error IS NULL`)
        .bind(job.workspace_id, job.team_id, job.bot_user_id)
        .first<SlackInstallation>();
    if (
      !installation ||
      (installation.file_scope_error_revision !== null && installation.file_scope_error_revision !== undefined) ||
      !slackHasScopes(installation.scopes, ["files:write"])
    ) {
      await save("paused", installation ? "missing_scope" : "cleanup_credentials_unavailable");
      return false;
    }
    let preparedToken: string;
    try {
      preparedToken = await usableBotToken(env, installation);
    } catch (error) {
      const paused =
        error instanceof SlackApiError &&
        ((error.code === "missing_scope" && (await recordSlackFileScopeError(env, installation, error))) ||
          (slackInstallationError(error) &&
            (await recordSlackInstallationError(env, installation.id, error, installation.generation))));
      await save(
        paused ? "paused" : "pending",
        error instanceof SlackApiError ? error.code : "cleanup_credentials_unavailable",
        paused ? null : Date.now() + RETRY_MS,
      );
      return false;
    }
    // The reservation is durable before dispatch. A crash can consume a slot,
    // but never permits a third potentially effective dispatch or deletion under a changed identity.
    const reserved = await env.DB.prepare(`UPDATE slack_file_cleanup_jobs SET attempt_count=attempt_count+1,updated_at=?
      WHERE id=? AND claim_token=? AND attempt_count<2 AND EXISTS(SELECT 1 FROM slack_installations
        WHERE id=? AND generation=? AND credential_revision=? AND team_id=? AND bot_user_id=? AND disconnected_at IS NULL AND auth_error IS NULL AND file_scope_error_revision IS NULL)`)
      .bind(
        Date.now(),
        id,
        token,
        installation.id,
        installation.generation,
        installation.credential_revision,
        job.team_id,
        job.bot_user_id,
      )
      .run();
    if (!reserved.meta.changes) {
      // No dispatch occurred. Re-read credentials on the next maintenance pass;
      // a normal token rotation must not leave a permanently paused job.
      await save("pending", "cleanup_credentials_changed", Date.now() + RETRY_MS);
      return false;
    }
    try {
      await slackApi(env, installation, "files.delete", { file: job.file_id }, { timeoutMs: 10_000, preparedToken });
      await save("completed", null);
    } catch (error) {
      if (error instanceof SlackRateLimitError) {
        // Slack definitively rejected dispatch. Refund only our reservation,
        // and persist the deadline before releasing this claim.
        await env.DB.prepare(`UPDATE slack_file_cleanup_jobs SET attempt_count=attempt_count-1,
          state='pending',last_error='rate_limited',next_attempt_at=?,updated_at=?,claim_token=NULL,claimed_at=NULL
          WHERE id=? AND claim_token=? AND attempt_count=?`)
          .bind(Math.max(Date.now() + RETRY_MS, error.retryAt), Date.now(), id, token, job.attempt_count + 1)
          .run();
        return true;
      }
      if (error instanceof SlackApiError && error.code === "file_deleted") {
        await save("completed", null);
        return false;
      }
      const code = error instanceof SlackApiError ? error.code : "cleanup_delete_unconfirmed";
      const authError = error instanceof SlackApiError && slackInstallationError(error);
      const pause =
        error instanceof SlackApiError &&
        ((error.code === "missing_scope" && (await recordSlackFileScopeError(env, installation, error))) ||
          (authError && (await recordSlackInstallationError(env, installation.id, error, installation.generation))));
      if (
        job.attempt_count + 1 >= 2 ||
        (!pause && !authError && code !== "missing_scope" && definiteSlackRejection(error))
      )
        await save("failed", code);
      else if (pause) await save("paused", code);
      else await save("pending", code, Date.now() + RETRY_MS);
      return false;
    }
    return false;
  } finally {
    await env.DB.prepare(
      "UPDATE slack_file_cleanup_jobs SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?",
    )
      .bind(id, token)
      .run();
  }
}

export async function processDueSlackFileCleanup(env: Env) {
  const now = Date.now();
  const rows = await env.DB.prepare(`SELECT id,workspace_id,team_id FROM slack_file_cleanup_jobs
    WHERE state='pending' AND next_attempt_at<=? AND (claimed_at IS NULL OR claimed_at<=?) ORDER BY next_attempt_at,id LIMIT 25`)
    .bind(now, now - LEASE_MS)
    .all<{ id: string; workspace_id: string; team_id: string }>();
  const limited = new Set<string>();
  for (const row of rows.results) {
    const installation = `${row.workspace_id}:${row.team_id}`;
    if (limited.has(installation)) continue;
    try {
      if (await processSlackFileCleanup(env, row.id)) limited.add(installation);
    } catch (error) {
      logger.warn(
        "slack.file_cleanup.failed",
        "slack",
        "Thumbnail cleanup will retry through maintenance",
        { cleanupId: row.id },
        error,
      );
    }
  }
}
