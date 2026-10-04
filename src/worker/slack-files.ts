import { processSlackFileCleanup } from "./slack-file-cleanup";
import { logger } from "./observability";
import { DeliveryInProgressError } from "./notifications";
import {
  definiteSlackRejection,
  recordDeliveryError,
  retireObsoleteReceipt,
  thumbnailDeliveryEnabled,
} from "./slack-delivery";
import { DIAGRAM_THUMBNAIL_HEIGHT, DIAGRAM_THUMBNAIL_WIDTH } from "../shared/diagram";
import { round2Installation } from "./slack-channels";
import { slackApi, SlackApiError, SlackRateLimitError, slackHasScopes, recordSlackFileScopeError } from "./slack";
import type { Env } from "./env";

async function cleanupAllocation(env: Env, installationId: string, artifactId: string, fileId: string | null) {
  if (!fileId) return;
  try {
    const job = await env.DB.prepare("SELECT id FROM slack_file_cleanup_jobs WHERE installation_id=? AND file_id=?")
      .bind(installationId, fileId)
      .first<{ id: string }>();
    if (job) await processSlackFileCleanup(env, job.id);
  } catch (error) {
    logger.warn(
      "slack.file_cleanup.deferred",
      "slack",
      "Abandoned allocation retained for cleanup",
      { artifactId },
      error,
    );
  }
}

export async function deliverThumbnail(env: Env, id: string) {
  if (!thumbnailDeliveryEnabled(env)) return;
  let row = await env.DB.prepare(`SELECT * FROM slack_file_artifacts WHERE id=?`).bind(id).first<{
    id: string;
    installation_id: string;
    installation_generation: number;
    page_id: string;
    content_epoch: number;
    content_sha256: string;
    thumbnail_r2_key: string;
    state: string;
    slack_file_id: string | null;
    upload_phase: string;
    upload_url: string | null;
    attempt_count: number;
  }>();
  if (!row || ["uploaded", "failed", "retired"].includes(row.state)) return;
  const installation = await round2Installation(env, row.installation_id, row.installation_generation);
  if (!installation) {
    await retireObsoleteReceipt(env, "slack_file_artifacts", id, row.installation_id, row.installation_generation);
    await cleanupAllocation(env, row.installation_id, id, row.slack_file_id);
    return;
  }
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE slack_file_artifacts SET claim_token=?,claimed_at=?,state='uploading',attempt_count=attempt_count+1 WHERE id=? AND state IN ('pending','uploading') AND (claimed_at IS NULL OR claimed_at<?)`,
  )
    .bind(token, Date.now(), id, Date.now() - 60_000)
    .run();
  if (!claim.meta.changes) throw new DeliveryInProgressError();
  const checkpoint = async (phase: string) => {
    const result = await env.DB.prepare(
      "UPDATE slack_file_artifacts SET upload_phase=?,updated_at=? WHERE id=? AND claim_token=?",
    )
      .bind(phase, Date.now(), id, token)
      .run();
    if (!result.meta.changes) throw new DeliveryInProgressError();
  };
  try {
    row = await env.DB.prepare("SELECT * FROM slack_file_artifacts WHERE id=? AND claim_token=?")
      .bind(id, token)
      .first<NonNullable<typeof row>>();
    if (!row) throw new DeliveryInProgressError();
    const allowed =
      await env.DB.prepare(`SELECT 1 FROM pages p JOIN diagram_projections d ON d.page_id=p.id AND d.content_epoch=p.content_epoch
    JOIN slack_channel_subscriptions m ON m.space_id=p.space_id AND (m.page_id IS NULL OR m.page_id=p.id)
    JOIN slack_installations i ON i.id=m.installation_id
    WHERE p.id=? AND p.content_epoch=? AND d.thumbnail_hash=? AND d.thumbnail_r2_key=? AND p.archived_at IS NULL
    AND p.import_job_id IS NULL AND p.is_template=0 AND i.id=? AND i.generation=? AND i.disconnected_at IS NULL
    AND m.cadence='digest' AND m.validation_state='valid' AND m.notification_blocked_at IS NULL
    AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=p.workspace_id AND wm.user_id=m.created_by AND wm.role='owner')`)
        .bind(
          row.page_id,
          row.content_epoch,
          row.content_sha256,
          row.thumbnail_r2_key,
          row.installation_id,
          row.installation_generation,
        )
        .first();
    if (!allowed) {
      await env.DB.prepare(`UPDATE slack_file_artifacts SET state='retired',updated_at=? WHERE id=? AND claim_token=?`)
        .bind(Date.now(), id, token)
        .run();
      await cleanupAllocation(env, installation.id, id, row.slack_file_id);
      return;
    }
    if (!env.BROWSER) throw new Error("thumbnail_unavailable");
    if (
      (installation.file_scope_error_revision !== null && installation.file_scope_error_revision !== undefined) ||
      !slackHasScopes(installation.scopes, ["files:write"])
    )
      throw new SlackApiError("files.getUploadURLExternal", "missing_scope", 200, installation.credential_revision, [
        "files:write",
      ]);
    // Each attempt renders new bytes, so its allocation must declare their size.
    // An uncertain completion also gets a replacement rather than completing twice.
    if (row.slack_file_id || row.upload_url) {
      const abandoned = row.slack_file_id;
      await env.DB.prepare(
        "UPDATE slack_file_artifacts SET slack_file_id=NULL,upload_url=NULL,upload_phase='prepare' WHERE id=? AND claim_token=?",
      )
        .bind(id, token)
        .run();
      await checkpoint("prepare");
      row.slack_file_id = null;
      row.upload_url = null;
      await cleanupAllocation(env, installation.id, id, abandoned);
    }
    const source = await env.BUCKET.get(row.thumbnail_r2_key);
    if (!source || source.size > 2 * 1024 * 1024) throw new Error("thumbnail_unavailable");
    const svg = new Uint8Array(await source.arrayBuffer());
    // Only our private projection is embedded. The rendering page cannot load network resources.
    let binary = "";
    for (const byte of svg) binary += String.fromCharCode(byte);
    const rendered = await env.BROWSER.quickAction("screenshot", {
      html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"></head><body style="margin:0;width:${DIAGRAM_THUMBNAIL_WIDTH}px;height:${DIAGRAM_THUMBNAIL_HEIGHT}px"><img width="${DIAGRAM_THUMBNAIL_WIDTH}" height="${DIAGRAM_THUMBNAIL_HEIGHT}" src="data:image/svg+xml;base64,${btoa(binary)}"></body></html>`,
      screenshotOptions: { type: "png", fullPage: true },
    });
    if (!rendered.ok) throw new Error("thumbnail_render_failed");
    const png = await rendered.arrayBuffer();
    if (png.byteLength > 5 * 1024 * 1024) throw new Error("thumbnail_too_large");
    // Recheck after rasterization, before transferring content outside NoteFlare.
    const current = await env.DB.prepare(`SELECT 1 FROM pages p JOIN diagram_projections d ON d.page_id=p.id
      WHERE p.id=? AND p.content_epoch=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND d.thumbnail_hash=?
      AND EXISTS(SELECT 1 FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
        JOIN workspace_members wm ON wm.workspace_id=i.workspace_id AND wm.user_id=m.created_by AND wm.role='owner'
        WHERE i.id=? AND i.generation=? AND i.disconnected_at IS NULL AND m.space_id=p.space_id AND (m.page_id IS NULL OR m.page_id=p.id)
        AND m.validation_state='valid' AND m.notification_blocked_at IS NULL)`)
      .bind(row.page_id, row.content_epoch, row.content_sha256, installation.id, installation.generation)
      .first();
    if (!current) throw new Error("thumbnail_unavailable");
    const upload = await slackApi(env, installation, "files.getUploadURLExternal", {
      filename: "diagram.png",
      length: png.byteLength,
    });
    const now = Date.now();
    // A replaced claim or removed artifact must not strand Slack's allocation.
    // Keep its original identity in the ledger in the same transaction as the save.
    const saved = await env.DB.batch([
      env.DB.prepare(
        `UPDATE slack_file_artifacts SET slack_file_id=?,upload_url=?,upload_phase='upload',updated_at=?,
          cleanup_workspace_id=?,cleanup_team_id=?,cleanup_bot_user_id=? WHERE id=? AND claim_token=?`,
      ).bind(
        upload.file_id,
        upload.upload_url,
        now,
        installation.workspace_id,
        installation.team_id,
        installation.bot_user_id,
        id,
        token,
      ),
      env.DB.prepare(`INSERT OR IGNORE INTO slack_file_cleanup_jobs
        (id,workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,next_attempt_at,last_error,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,'pending',?,'allocation_claim_lost',?,?
        WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM slack_file_artifacts WHERE installation_id=? AND slack_file_id=?)`).bind(
        `slack-file-cleanup:${installation.id}:${upload.file_id}`,
        installation.workspace_id,
        installation.id,
        installation.generation,
        installation.team_id,
        installation.bot_user_id,
        upload.file_id,
        id,
        now,
        now,
        now,
        installation.workspace_id,
        installation.id,
        upload.file_id,
      ),
    ]);
    if (!saved[0]!.meta.changes) throw new DeliveryInProgressError();
    row.slack_file_id = upload.file_id;
    await checkpoint("upload");
    const response = await fetch(upload.upload_url, { method: "POST", body: png, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`thumbnail_upload_http_${response.status}`);
    await checkpoint("complete");
    await slackApi(env, installation, "files.completeUploadExternal", {
      files: [{ id: upload.file_id, title: "NoteFlare diagram thumbnail" }],
    });
    await env.DB.prepare(
      `UPDATE slack_file_artifacts SET state='uploaded',last_error=NULL,upload_phase='done',updated_at=? WHERE id=? AND claim_token=?`,
    )
      .bind(Date.now(), id, token)
      .run();
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "missing_scope")
      await recordSlackFileScopeError(env, installation, error);
    await recordDeliveryError(env, installation, error);
    const code =
      error instanceof SlackRateLimitError
        ? "rate_limited"
        : error instanceof SlackApiError
          ? error.code
          : error instanceof Error
            ? error.message
            : "thumbnail_upload_failed";
    const pause =
      error instanceof SlackApiError &&
      ["missing_scope", "invalid_auth", "token_revoked", "account_inactive"].includes(error.code);
    const retry =
      pause ||
      ((row?.attempt_count ?? 8) < 8 &&
        !(definiteSlackRejection(error) || ["thumbnail_unavailable", "thumbnail_too_large"].includes(code)));
    await env.DB.prepare(
      `UPDATE slack_file_artifacts SET state=?,last_error=?,updated_at=? WHERE id=? AND claim_token=?`,
    )
      .bind(retry ? "pending" : "failed", code, Date.now(), id, token)
      .run();
    if (retry) throw error;
    await cleanupAllocation(env, installation.id, id, row?.slack_file_id ?? null);
  } finally {
    await env.DB.prepare(
      "UPDATE slack_file_artifacts SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?",
    )
      .bind(id, token)
      .run();
  }
}
