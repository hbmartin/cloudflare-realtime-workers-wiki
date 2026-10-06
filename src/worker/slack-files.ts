import { processSlackFileCleanup } from "./slack-file-cleanup";
import { thumbnailEligibilitySql } from "./slack-delivery-contracts";
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
  const eligibility = await env.DB.prepare(
    `SELECT ${thumbnailEligibilitySql()} eligibility FROM slack_file_artifacts r WHERE r.id=?`,
  )
    .bind(id)
    .first<{ eligibility: "ready" | "paused" | "obsolete" }>();
  if (eligibility?.eligibility === "paused") return;
  if (eligibility?.eligibility === "obsolete") {
    const retired =
      await env.DB.prepare(`UPDATE slack_file_artifacts AS r SET state='retired',claim_token=NULL,claimed_at=NULL,updated_at=?
      WHERE id=? AND state IN ('pending','uploading') AND (claimed_at IS NULL OR claimed_at<?)
        AND (${thumbnailEligibilitySql()})='obsolete'`)
        .bind(Date.now(), id, Date.now() - 60_000)
        .run();
    if (!retired.meta.changes) throw new DeliveryInProgressError();
    await cleanupAllocation(env, row.installation_id, id, row.slack_file_id);
    return;
  }
  const installation = await round2Installation(env, row.installation_id, row.installation_generation);
  if (!installation) {
    if (
      await env.DB.prepare(
        "SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL AND auth_error IS NOT NULL",
      )
        .bind(row.installation_id, row.installation_generation)
        .first()
    )
      return;
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
    const eligible = async () => {
      const status = await env.DB.prepare(
        `SELECT ${thumbnailEligibilitySql()} eligibility FROM slack_file_artifacts r WHERE r.id=? AND r.claim_token=?`,
      )
        .bind(id, token)
        .first<{ eligibility: "ready" | "paused" | "obsolete" }>();
      if (!status) throw new DeliveryInProgressError();
      if (status.eligibility === "ready") return true;
      await env.DB.prepare(
        `UPDATE slack_file_artifacts SET state=?,updated_at=?,attempt_count=MAX(0,attempt_count-?) WHERE id=? AND claim_token=?`,
      )
        .bind(
          status.eligibility === "paused" ? "pending" : "retired",
          Date.now(),
          status.eligibility === "paused" ? 1 : 0,
          id,
          token,
        )
        .run();
      if (status.eligibility === "obsolete") await cleanupAllocation(env, installation.id, id, row!.slack_file_id);
      return false;
    };
    if (!(await eligible())) return;
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
    if (!(await eligible())) return;
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
