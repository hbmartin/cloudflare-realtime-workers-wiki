import { slackAccessAuthorization } from "./slack-identity";
import { definiteSlackRejection, recordDeliveryError, retireObsoleteReceipt } from "./slack-delivery";
import type { Env } from "./env";
import { sha256Hex } from "../shared/import-integrity";
import { unfurlBlocks } from "./slack-blocks";
import { round2Installation } from "./slack-channels";
import { channelInvalidReason } from "./slack-schedule";
import { reconcileBotPost } from "./slack-digests";
import { slackApi, SlackApiError, SlackRateLimitError } from "./slack";
import { DeliveryInProgressError } from "./notifications";

type Refresh = {
  id: string;
  reference_id: string;
  revision: number;
  installation_id: string;
  installation_generation: number;
  workspace_id: string;
  page_id: string;
  channel_id: string;
  message_ts: string;
  url: string;
  reference_kind: string;
  share_link_id: string | null;
  observed_user_id: string | null;
  state: string;
  attempted_at: number | null;
  rendered_hash: string | null;
  fallback_thread_ts: string | null;
};
async function shareRefreshBlocks(env: Env, row: Refresh) {
  const page = await env.DB.prepare(`SELECT p.title,p.kind,p.plain_text,p.archived_at,p.import_job_id,
    EXISTS(SELECT 1 FROM workspace_members wm JOIN spaces s ON s.id=p.space_id WHERE wm.workspace_id=p.workspace_id AND wm.user_id=?
      AND EXISTS(SELECT 1 FROM slack_authorized_user_links link JOIN slack_share_references reference ON reference.id=?
        WHERE link.user_id=wm.user_id AND link.installation_id=? AND coalesce(link.verified_at,link.linked_at)<=reference.created_at)
      AND (wm.role='owner' OR s.visibility='workspace' OR EXISTS(SELECT 1 FROM space_members WHERE space_id=s.id AND user_id=wm.user_id))) can_read,
    EXISTS(SELECT 1 FROM slack_channel_subscriptions m WHERE m.installation_id=? AND m.channel_id=? AND m.space_id=p.space_id
      AND (m.page_id IS NULL OR m.page_id=p.id) AND m.validation_state='valid'
      AND EXISTS(SELECT 1 FROM workspace_members owner WHERE owner.workspace_id=p.workspace_id AND owner.user_id=m.created_by AND owner.role='owner')) mapped
    FROM pages p WHERE p.id=? AND p.workspace_id=?`)
    .bind(
      row.observed_user_id,
      row.reference_id,
      row.installation_id,
      row.installation_id,
      row.channel_id,
      row.page_id,
      row.workspace_id,
    )
    .first<{
      title: string;
      kind: string;
      plain_text: string;
      archived_at: number | null;
      import_job_id: string | null;
      can_read: number;
      mapped: number;
    }>();
  const share = await env.DB.prepare(`SELECT s.id,s.url_key,s.revoked_at,
    EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=s.workspace_id AND wm.user_id=s.created_by AND wm.role='owner') owner_valid
    FROM share_links s WHERE s.workspace_id=? AND s.root_page_id=? AND (?='page' OR s.id=?)
    ORDER BY (s.revoked_at IS NULL) DESC,s.created_at DESC,s.id DESC LIMIT 1`)
    .bind(row.workspace_id, row.page_id, row.reference_kind, row.share_link_id)
    .first<{ id: string; url_key: string; revoked_at: number | null; owner_valid: number }>();
  if (
    !page ||
    !page.can_read ||
    !page.mapped ||
    page.archived_at !== null ||
    page.import_job_id ||
    (share && !share.owner_valid)
  ) {
    return {
      state: "unavailable",
      shareId: share?.id ?? null,
      blocks: [{ type: "section", text: { type: "plain_text", text: "This NoteFlare page is no longer available." } }],
      text: "This NoteFlare page is no longer available.",
    };
  }
  const revoked = Boolean(share && share.revoked_at !== null);
  const blocks = unfurlBlocks({
    title: page.title,
    excerpt: page.plain_text || "A NoteFlare page",
    referenceId: row.reference_id,
    shareActive: Boolean(share && !revoked),
  });
  // Diagrams have previews but do not support public shares.
  if (page.kind === "diagram") blocks.splice(1, 1);
  if (revoked) {
    blocks.splice(1, 0, {
      type: "section",
      text: { type: "mrkdwn", verbatim: true, text: "*Public access was revoked.*" },
    } as (typeof blocks)[number]);
    // The owner action returns a replacement privately; this URL stays pinned to its revoked share.
  }
  return {
    state: revoked ? "revoked" : share ? "active" : "unshared",
    shareId: share?.id ?? null,
    blocks,
    text: revoked
      ? "Public access to this NoteFlare page was revoked."
      : share
        ? "A public share is available for this NoteFlare page."
        : "This NoteFlare page has no active public share.",
  };
}
export async function deliverShareRefresh(env: Env, id: string, reconcileOnly = false) {
  if (env.SLACK_SHARE_REFRESH_ENABLED !== "true") return;
  let row = await env.DB.prepare(`SELECT * FROM slack_share_refreshes WHERE id=?`).bind(id).first<Refresh>();
  if (!row || ["sent", "retired"].includes(row.state) || (!reconcileOnly && row.state === "blocked")) return;
  if (reconcileOnly && !["sending", "blocked"].includes(row.state)) return;
  const installation = await round2Installation(env, row.installation_id, row.installation_generation);
  if (!installation) {
    await retireObsoleteReceipt(env, "slack_share_refreshes", id, row.installation_id, row.installation_generation);
    return;
  }
  const token = crypto.randomUUID();
  const claim =
    await env.DB.prepare(`UPDATE slack_share_refreshes SET claim_token=?,claimed_at=? WHERE id=? AND state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""})
    AND (claimed_at IS NULL OR claimed_at<?) AND NOT EXISTS(SELECT 1 FROM slack_share_refreshes busy WHERE busy.installation_id=slack_share_refreshes.installation_id
      AND busy.channel_id=slack_share_refreshes.channel_id AND busy.message_ts=slack_share_refreshes.message_ts AND busy.id<>slack_share_refreshes.id AND busy.claimed_at>=?)`)
      .bind(token, Date.now(), id, Date.now() - 60_000, Date.now() - 60_000)
      .run();
  if (!claim.meta.changes) throw new DeliveryInProgressError();
  try {
    row = (await env.DB.prepare(`SELECT * FROM slack_share_refreshes WHERE id=? AND claim_token=?`)
      .bind(id, token)
      .first<Refresh>())!;
    if (!row) throw new DeliveryInProgressError();
    const finish = async (hash: string, state = "sent") => {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE slack_share_refreshes SET state=?,rendered_hash=?,last_error=NULL WHERE id=? AND claim_token=?`,
        ).bind(state, hash, id, token),
        env.DB.prepare(
          `UPDATE slack_share_references SET rendered_hash=?,state=?,last_error=NULL,updated_at=? WHERE id=? AND installation_generation=?
          AND EXISTS(SELECT 1 FROM slack_share_refreshes owned WHERE owned.id=? AND owned.claim_token=?)
          AND NOT EXISTS(SELECT 1 FROM slack_share_refreshes newer WHERE newer.reference_id=slack_share_references.id
            AND newer.revision>? AND newer.state IN ('sent','retired'))`,
        ).bind(
          hash,
          state === "retired" ? "retired" : "updated",
          Date.now(),
          row!.reference_id,
          row!.installation_generation,
          id,
          token,
          row!.revision,
        ),
      ]);
    };
    if (row.state === "sending" || reconcileOnly) {
      const ts = await reconcileBotPost(
        env,
        installation,
        row.channel_id,
        row.id,
        row.attempted_at!,
        row.fallback_thread_ts ?? row.message_ts,
      );
      if (ts) {
        await env.DB.prepare(`UPDATE slack_share_refreshes SET fallback_ts=? WHERE id=? AND claim_token=?`)
          .bind(ts, id, token)
          .run();
        await finish(row.rendered_hash!);
      } else
        await env.DB.prepare(
          `UPDATE slack_share_refreshes SET state='blocked',last_error='fallback_unconfirmed' WHERE id=? AND claim_token=?`,
        )
          .bind(id, token)
          .run();
      return;
    }
    const { channel } = await slackApi(env, installation, "conversations.info", { channel: row.channel_id });
    // Read authorization/lifecycle state after the last remote lookup, immediately before the effect.
    const reference = await env.DB.prepare(
      `SELECT observed_user_id,created_at FROM slack_share_references WHERE id=? AND installation_generation=?`,
    )
      .bind(row.reference_id, row.installation_generation)
      .first<{ observed_user_id: string | null; created_at: number }>();
    if (reference) row.observed_user_id = reference.observed_user_id;
    const rendered = await shareRefreshBlocks(env, row);
    const hash = await sha256Hex(
      JSON.stringify({ state: rendered.state, share: rendered.shareId, blocks: rendered.blocks }),
    );
    const prior = await env.DB.prepare(`SELECT rendered_hash FROM slack_share_references WHERE id=?
      UNION ALL SELECT rendered_hash FROM (SELECT rendered_hash FROM slack_share_refreshes WHERE reference_id=? AND state IN ('sent','retired') ORDER BY revision DESC LIMIT 1) LIMIT 1`)
      .bind(row.reference_id, row.reference_id)
      .first<{ rendered_hash: string | null }>();
    if (prior?.rendered_hash === hash) {
      await finish(hash, rendered.state === "unavailable" ? "retired" : "sent");
      return;
    }
    if (!channel || channel.is_archived) {
      await finish(hash, "retired");
      return;
    }
    if (
      rendered.state !== "unavailable" &&
      channelInvalidReason(channel) &&
      channelInvalidReason(channel) !== "not_in_channel"
    ) {
      await finish(hash, "retired");
      return;
    }
    try {
      await slackApi(
        env,
        installation,
        "chat.unfurl",
        {
          channel: row.channel_id,
          ts: row.message_ts,
          unfurls: { [row.url]: { blocks: rendered.blocks } },
        },
        undefined,
        undefined,
        undefined,
        rendered.state !== "unavailable" && row.observed_user_id
          ? slackAccessAuthorization(env, installation, { userId: row.observed_user_id }, reference?.created_at)
          : undefined,
      );
      await finish(hash, rendered.state === "unavailable" ? "retired" : "sent");
    } catch (error) {
      await recordDeliveryError(env, installation, error);
      if (
        !(error instanceof SlackApiError) ||
        ["invalid_auth", "token_revoked", "account_inactive", "missing_scope"].includes(error.code)
      )
        throw error;
      if (
        [
          "cannot_find_message",
          "message_not_found",
          "cannot_find_channel",
          "channel_not_found",
          "not_in_channel",
          "no_permission",
        ].includes(error.code)
      ) {
        await finish(hash, "retired");
        return;
      }
      // Ordinary authorized unfurls do not require bot membership. A fallback
      // reply does, so retire a rejected preview without attempting a post.
      if (!channel.is_member) {
        await finish(hash, "retired");
        return;
      }
      // Retry temporary service failures. Other permanent attachment rejections may
      // still permit a bot reply, which requires an independently accessible original.
      if (
        error.status >= 500 ||
        [
          "internal_error",
          "fatal_error",
          "service_unavailable",
          "request_timeout",
          "org_login_required",
          "team_added_to_org",
        ].includes(error.code)
      )
        throw error;
      const messages = await slackApi(env, installation, "conversations.history", {
        channel: row.channel_id,
        oldest: row.message_ts,
        latest: row.message_ts,
        inclusive: true,
        limit: 1,
        include_all_metadata: true,
      });
      const original = messages.messages.find((m) => m.ts === row!.message_ts);
      if (!original) {
        await finish(hash, "retired");
        return;
      }
      const sending = await env.DB.prepare(
        `UPDATE slack_share_refreshes SET state='sending',attempted_at=?,rendered_hash=?,fallback_thread_ts=? WHERE id=? AND claim_token=?`,
      )
        .bind(Date.now(), hash, original.thread_ts ?? row.message_ts, id, token)
        .run();
      if (!sending.meta.changes) throw new DeliveryInProgressError();
      let posted;
      try {
        posted = await slackApi(env, installation, "chat.postMessage", {
          channel: row.channel_id,
          thread_ts: original.thread_ts ?? row.message_ts,
          text: rendered.text,
          metadata: { event_type: "noteflare_share_refresh", event_payload: { delivery_id: id } },
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (postError) {
        if (postError instanceof SlackRateLimitError || definiteSlackRejection(postError))
          await env.DB.prepare(
            `UPDATE slack_share_refreshes SET state='pending',attempted_at=NULL WHERE id=? AND claim_token=?`,
          )
            .bind(id, token)
            .run();
        throw postError;
      }
      await env.DB.prepare(`UPDATE slack_share_refreshes SET fallback_ts=? WHERE id=? AND claim_token=?`)
        .bind(posted.ts, id, token)
        .run();
      await finish(hash, rendered.state === "unavailable" ? "retired" : "sent");
    }
  } catch (error) {
    await recordDeliveryError(env, installation, error);
    if (
      definiteSlackRejection(error) &&
      ["channel_not_found", "not_in_channel", "is_archived", "message_not_found", "cannot_find_message"].includes(
        error.code,
      )
    ) {
      await env.DB.prepare("UPDATE slack_share_refreshes SET state=?,last_error=? WHERE id=? AND claim_token=?")
        .bind(row?.state === "sending" || reconcileOnly ? "blocked" : "retired", error.code, id, token)
        .run();
      return;
    }
    await env.DB.prepare("UPDATE slack_share_refreshes SET last_error=? WHERE id=? AND claim_token=?")
      .bind(error instanceof SlackApiError ? error.code : "lookup_or_delivery_failed", id, token)
      .run();
    throw error;
  } finally {
    await env.DB.prepare(
      `UPDATE slack_share_refreshes SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?`,
    )
      .bind(id, token)
      .run();
  }
}
