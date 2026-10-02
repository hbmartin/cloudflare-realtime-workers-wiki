import { DIAGRAM_THUMBNAIL_HEIGHT, DIAGRAM_THUMBNAIL_WIDTH } from "../shared/diagram";
import { round2Installation } from "./slack-channels";
import { slackApi, SlackApiError, SlackRateLimitError, slackHasScopes } from "./slack";
import type { Env } from "./env";

export async function deliverThumbnail(env: Env, id: string) {
  if (env.SLACK_RICH_DIGESTS_ENABLED !== "true" || env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true") return;
  const row = await env.DB.prepare(`SELECT * FROM slack_file_artifacts WHERE id=?`).bind(id).first<{
    id: string;
    installation_id: string;
    installation_generation: number;
    page_id: string;
    content_epoch: number;
    content_sha256: string;
    thumbnail_r2_key: string;
    state: string;
    slack_file_id: string | null;
  }>();
  if (!row || ["uploaded", "failed", "retired"].includes(row.state)) return;
  const installation = await round2Installation(env, row.installation_id, row.installation_generation);
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
  if (!installation || !allowed) {
    await env.DB.prepare(`UPDATE slack_file_artifacts SET state='retired',updated_at=? WHERE id=?`)
      .bind(Date.now(), id)
      .run();
    return;
  }
  if (row.state === "uploading") {
    await env.DB.prepare(
      `UPDATE slack_file_artifacts SET state='failed',last_error='upload_unconfirmed',updated_at=? WHERE id=? AND updated_at<?`,
    )
      .bind(Date.now(), id, Date.now() - 60_000)
      .run();
    return;
  }
  const claimed = await env.DB.prepare(
    `UPDATE slack_file_artifacts SET state='uploading',updated_at=? WHERE id=? AND state='pending'`,
  )
    .bind(Date.now(), id)
    .run();
  if (!claimed.meta.changes) return;
  let allocated = false;
  try {
    if (!env.BROWSER || !slackHasScopes(installation.scopes, ["files:write"])) throw new Error("thumbnail_unavailable");
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
    allocated = true;
    await env.DB.prepare(
      `UPDATE slack_file_artifacts SET slack_file_id=?,updated_at=? WHERE id=? AND state='uploading'`,
    )
      .bind(upload.file_id, Date.now(), id)
      .run();
    const response = await fetch(upload.upload_url, { method: "POST", body: png, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("thumbnail_upload_failed");
    await slackApi(env, installation, "files.completeUploadExternal", {
      files: [{ id: upload.file_id, title: "NoteFlare diagram thumbnail" }],
    });
    await env.DB.prepare(`UPDATE slack_file_artifacts SET state='uploaded',last_error=NULL,updated_at=? WHERE id=?`)
      .bind(Date.now(), id)
      .run();
  } catch (error) {
    const retry = error instanceof SlackRateLimitError && !allocated && !row.slack_file_id;
    await env.DB.prepare(`UPDATE slack_file_artifacts SET state=?,last_error=?,updated_at=? WHERE id=?`)
      .bind(
        retry ? "pending" : "failed",
        error instanceof SlackApiError ? error.code : "thumbnail_upload_failed",
        Date.now(),
        id,
      )
      .run();
    if (retry) throw error;
  }
}
