import type { CommentBody } from "../shared/types";
import { addCommentReply, setThreadResolved, type CommentPage } from "./comments";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { pageForIntegrationBot } from "./integrations";
import { DeliveryInProgressError } from "./notifications";
import { pageForMember } from "./page-access";
import { logger } from "./observability";
import { broadcastWorkspaceEvent } from "./workspace-events";
import {
  slackApi,
  recordSlackInstallationError,
  slackChannelError,
  slackInstallationError,
  usableBotToken,
  SlackApiError,
  SlackRateLimitError,
  validateSlackIdentity,
  type SlackEventPayload,
  type SlackInteractionPayload,
  type SlackInstallation,
} from "./slack";
import { escapeSlackText, slackCommentText, slackReplyBody } from "./slack-thread-text";
import { threadRootBlocks } from "./slack-blocks";

const SCOPES = ["chat:write", "channels:read", "groups:read", "channels:history", "groups:history", "users:read"];
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TS = /^\d{1,16}\.\d{1,16}$/;
const DENIED = "This NoteFlare thread is unavailable or you no longer have permission to use it.";
const CONNECT = "Connect your Slack account from NoteFlare Settings before using this thread.";
const CONTENT_ERROR =
  "Your Slack reply could not be imported because it is too large or complex. Shorten it and try again.";
const BROADCAST_MISSING = "Your broadcast reply could not be retrieved from the Slack thread.";
const EXPIRED_ACTION = "This action expired. Open the current NoteFlare message and try again.";

type Link = {
  id: string;
  installation_id: string;
  installation_generation: number;
  subscription_id: string | null;
  workspace_id: string;
  page_id: string;
  thread_id: string;
  channel_id: string;
  root_message_ts: string | null;
  state: "pending" | "active" | "retired";
};
export type Identity = { userId: string; accountId: string; verifiedAt: number; slackUserId: string };
export type Input = {
  installationId: string;
  generation: number;
  linkId: string;
  channelId: string;
  threadTs: string;
  slackUserId: string;
  identity: Identity | null;
  text?: string;
  textTooLarge?: boolean;
  broadcast?: boolean;
  resolved?: boolean;
};
type Delivery = {
  id: string;
  link_id: string;
  operation: "root" | "reply" | "refresh";
  actor_id: string;
  comment_id: string | null;
  state: "pending" | "sending" | "sent" | "blocked" | "retired";
  attempted_at: number | null;
  created_at: number;
};

function unavailable(): never {
  throw new HttpError(403, "slack_thread_unavailable", DENIED);
}
export async function installationFor(env: Env, id: string, generation?: number) {
  const row = await env.DB.prepare(`SELECT * FROM slack_installations WHERE id = ? AND disconnected_at IS NULL`)
    .bind(id)
    .first<SlackInstallation>();
  if (!row || (generation !== undefined && row.generation !== generation)) unavailable();
  const scopes = new Set(row.scopes.split(",").map((scope) => scope.trim()));
  if (SCOPES.some((scope) => !scopes.has(scope)))
    throw new SlackApiError("installation", "missing_scope", 403, row.credential_revision);
  return row;
}
async function memberFor(env: Env, workspaceId: string, userId: string): Promise<MemberContext> {
  const row = await env.DB.prepare(`SELECT u.id, u.name, u.email, wm.role, w.name workspace_name, w.location_hint
    FROM user u JOIN workspace_members wm ON wm.user_id = u.id JOIN workspaces w ON w.id = wm.workspace_id
    WHERE u.id = ? AND wm.workspace_id = ?`)
    .bind(userId, workspaceId)
    .first<{
      id: string;
      name: string;
      email: string;
      role: MemberContext["role"];
      workspace_name: string;
      location_hint: string | null;
    }>();
  if (!row) unavailable();
  return {
    user: { id: row.id, name: row.name, email: row.email },
    role: row.role,
    workspace: { id: workspaceId, name: row.workspace_name, locationHint: row.location_hint },
    session: { id: "slack-thread", expiresAt: new Date(Date.now() + 60_000) },
  };
}
export async function identityFor(
  env: Env,
  installation: SlackInstallation,
  slackUserId: string,
): Promise<Identity | null> {
  return env.DB.prepare(`SELECT l.user_id userId, l.better_auth_account_id accountId, l.verified_at verifiedAt, l.slack_user_id slackUserId
    FROM slack_user_links l JOIN account a ON a.id = l.better_auth_account_id AND a.userId = l.user_id
    JOIN workspace_members wm ON wm.user_id = l.user_id AND wm.workspace_id = ?
    WHERE l.installation_id = ? AND l.slack_user_id = ? AND l.installation_generation = ?
      AND l.verification_method = 'slack_openid' AND l.migration_state = 'verified' AND l.verified_at IS NOT NULL
      AND a.providerId = 'slack' AND a.accountId = ?`)
    .bind(
      installation.workspace_id,
      installation.id,
      slackUserId,
      installation.generation,
      `${installation.team_id}:${slackUserId}`,
    )
    .first<Identity>();
}
export async function verifiedMember(
  env: Env,
  installation: SlackInstallation,
  slackUserId: string,
  expected?: Identity | null,
) {
  const identity = await identityFor(env, installation, slackUserId);
  if (
    !identity ||
    (expected !== undefined &&
      (!expected ||
        expected.userId !== identity.userId ||
        expected.accountId !== identity.accountId ||
        expected.verifiedAt !== identity.verifiedAt))
  ) {
    throw new HttpError(403, "slack_identity_required", CONNECT);
  }
  await validateSlackIdentity(
    env,
    { "https://slack.com/team_id": installation.team_id, "https://slack.com/user_id": slackUserId },
    { workspaceId: installation.workspace_id, memberUserId: identity.userId },
  );
  return { identity, member: await memberFor(env, installation.workspace_id, identity.userId) };
}
export async function validateChannel(env: Env, installation: SlackInstallation, channelId: string) {
  const { channel } = await slackApi(env, installation, "conversations.info", { channel: channelId });
  if (
    !channel ||
    channel.id !== channelId ||
    (!channel.is_channel && !channel.is_group) ||
    channel.is_im ||
    channel.is_mpim ||
    !channel.is_member ||
    channel.is_archived ||
    channel.is_ext_shared ||
    channel.is_shared ||
    channel.is_org_shared ||
    channel.pending_shared?.length
  )
    throw new HttpError(403, "slack_channel_invalid", DENIED);
  return channel;
}
export async function requireChannelMember(
  env: Env,
  installation: SlackInstallation,
  channelId: string,
  userId: string,
) {
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await slackApi(env, installation, "conversations.members", {
      channel: channelId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (result.members.includes(userId)) return;
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) unavailable();
  }
  unavailable();
}
function asCommentPage(page: Awaited<ReturnType<typeof pageForMember>>): CommentPage {
  return { ...page, space_id: page.space_id!, effective_role: page.effective_role };
}

export async function setSlackMirror(env: Env, member: MemberContext, subscriptionId: string, enabled: boolean) {
  const current = await memberFor(env, member.workspace.id, member.user.id);
  if (current.role !== "owner") unavailable();
  const mapping = await env.DB.prepare(
    `SELECT s.* FROM slack_channel_subscriptions s JOIN slack_installations i ON i.id = s.installation_id WHERE s.id = ? AND i.workspace_id = ? AND i.disconnected_at IS NULL`,
  )
    .bind(subscriptionId, member.workspace.id)
    .first<{ installation_id: string; channel_id: string; space_id: string; page_id: string | null }>();
  if (!mapping) unavailable();
  if (!enabled) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
        (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
        SELECT d.id,?,mapping.id,mapping.channel_name,'mirror_disabled_unconfirmed',?
        FROM slack_thread_deliveries d JOIN slack_thread_links link ON link.id=d.link_id
          JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
        WHERE mapping.id=? AND (d.state='sending' OR
          (d.state='blocked' AND d.failure_reason LIKE 'reconciliation_%')) AND EXISTS
          (SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`).bind(
        member.workspace.id,
        now,
        subscriptionId,
        member.workspace.id,
        member.user.id,
      ),
      env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',
        failure_reason=CASE WHEN state IN ('sending','blocked') THEN 'mirror_disabled_unconfirmed' ELSE 'mirror_disabled' END,
        updated_at=? WHERE link_id IN (SELECT id FROM slack_thread_links WHERE subscription_id=?)
          AND (state IN ('pending','sending') OR
            (state='blocked' AND failure_reason LIKE 'reconciliation_%')) AND EXISTS
          (SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`).bind(
        now,
        subscriptionId,
        member.workspace.id,
        member.user.id,
      ),
      env.DB.prepare(`UPDATE slack_channel_subscriptions SET mirror_enabled=0,updated_at=? WHERE id=?
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`).bind(
        now,
        subscriptionId,
        member.workspace.id,
        member.user.id,
      ),
    ]);
    return;
  }
  const installation = await installationFor(env, mapping.installation_id);
  const link = await env.DB.prepare(
    `SELECT slack_user_id FROM slack_user_links WHERE installation_id = ? AND user_id = ?`,
  )
    .bind(installation.id, member.user.id)
    .first<{ slack_user_id: string }>();
  if (!link) throw new HttpError(403, "slack_identity_required", CONNECT);
  const { identity } = await verifiedMember(env, installation, link.slack_user_id);
  if (mapping.page_id) await pageForMember(env, current, mapping.page_id);
  let channelValidated = false;
  try {
    const channel = await validateChannel(env, installation, mapping.channel_id);
    channelValidated = true;
    await requireChannelMember(env, installation, mapping.channel_id, identity.slackUserId);
    const result =
      await env.DB.prepare(`UPDATE slack_channel_subscriptions SET mirror_enabled = 1, channel_name = ?, channel_type = ?, validation_state = 'valid', validation_error = NULL, validated_at = ?, bot_is_member = 1, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM slack_installations i JOIN workspace_members wm ON wm.workspace_id = i.workspace_id
        JOIN slack_user_links l ON l.installation_id = i.id AND l.user_id = wm.user_id
        JOIN account a ON a.id = l.better_auth_account_id AND a.userId = wm.user_id
        WHERE i.id = ? AND i.generation = ? AND i.disconnected_at IS NULL AND wm.user_id = ? AND wm.role = 'owner'
          AND l.installation_generation = i.generation AND l.verified_at = ? AND l.migration_state = 'verified' AND a.id = ?)
      AND EXISTS (SELECT 1 FROM spaces s WHERE s.id = slack_channel_subscriptions.space_id AND s.workspace_id = ?)
      AND (page_id IS NULL OR EXISTS (SELECT 1 FROM pages p WHERE p.id = slack_channel_subscriptions.page_id AND p.space_id = slack_channel_subscriptions.space_id AND p.archived_at IS NULL AND p.import_job_id IS NULL))`)
        .bind(
          channel.name,
          channel.is_private ? "private_channel" : "public_channel",
          Date.now(),
          Date.now(),
          subscriptionId,
          installation.id,
          installation.generation,
          member.user.id,
          identity.verifiedAt,
          identity.accountId,
          member.workspace.id,
        )
        .run();
    if (!result.meta.changes) unavailable();
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed"))
      throw new HttpError(409, "slack_mirror_conflict", "Disable the existing mirror for this page or space first.");
    if (
      (!channelValidated && error instanceof HttpError && error.code === "slack_channel_invalid") ||
      slackChannelError(error)
    ) {
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
          (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
          SELECT delivery.id,link.workspace_id,?,COALESCE(NULLIF(mapping.channel_name,''),link.channel_id),
            CASE WHEN delivery.state='pending' THEN 'channel_unavailable'
              ELSE 'channel_unavailable_unconfirmed' END,?
          FROM slack_thread_deliveries delivery JOIN slack_thread_links link ON link.id=delivery.link_id
          JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
          WHERE mapping.id=? AND (delivery.state IN ('pending','sending') OR
            (delivery.state='blocked' AND delivery.failure_reason LIKE 'reconciliation_%'))`).bind(
          subscriptionId,
          now,
          subscriptionId,
        ),
        env.DB.prepare(`UPDATE slack_channel_subscriptions SET mirror_enabled = 0, validation_state = 'invalid',
          validation_error = 'channel_unavailable', updated_at = ? WHERE id = ?`).bind(now, subscriptionId),
        env.DB.prepare(`UPDATE slack_thread_links SET state='retired', updated_at=?
          WHERE subscription_id=? AND state IN ('pending','active')`).bind(now, subscriptionId),
        env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired', failure_reason='channel_unavailable', updated_at=?
          WHERE link_id IN (SELECT id FROM slack_thread_links WHERE subscription_id=?)
            AND (state='pending' OR (state='blocked' AND failure_reason='predecessor_blocked'))`).bind(
          now,
          subscriptionId,
        ),
        env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired', failure_reason='channel_unavailable_unconfirmed', updated_at=?
          WHERE link_id IN (SELECT id FROM slack_thread_links WHERE subscription_id=?)
            AND (state='sending' OR (state='blocked' AND failure_reason LIKE 'reconciliation_%'))`).bind(
          now,
          subscriptionId,
        ),
      ]);
    }
    throw error;
  }
}

export async function verifySlackMirrorRecovery(env: Env, member: MemberContext, subscriptionId: string) {
  const current = await memberFor(env, member.workspace.id, member.user.id);
  if (current.role !== "owner") unavailable();
  const mapping = await env.DB.prepare(`SELECT mapping.channel_id,mapping.installation_id
    FROM slack_channel_subscriptions mapping JOIN slack_installations installation
      ON installation.id=mapping.installation_id
    WHERE mapping.id=? AND installation.workspace_id=? AND installation.disconnected_at IS NULL
      AND mapping.mirror_enabled=1`)
    .bind(subscriptionId, member.workspace.id)
    .first<{ channel_id: string; installation_id: string }>();
  if (!mapping) unavailable();
  const installation = await installationFor(env, mapping.installation_id);
  await validateChannel(env, installation, mapping.channel_id);
  const now = Date.now();
  const ownerGuard = `EXISTS (SELECT 1 FROM workspace_members owner
    WHERE owner.workspace_id=? AND owner.user_id=? AND owner.role='owner')`;
  const mappingGuard = `EXISTS (SELECT 1 FROM slack_channel_subscriptions mapping
    JOIN slack_installations installation ON installation.id=mapping.installation_id
    WHERE mapping.id=? AND mapping.mirror_enabled=1 AND mapping.validation_state='valid'
      AND installation.workspace_id=? AND installation.disconnected_at IS NULL
      AND installation.auth_error IS NULL AND installation.credential_revision=?
      AND ${ownerGuard})`;
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE slack_channel_subscriptions SET validation_state='valid',validation_error=NULL,
      validated_at=?,updated_at=? WHERE id=? AND mirror_enabled=1 AND
      EXISTS (SELECT 1 FROM slack_installations installation WHERE installation.id=installation_id
        AND installation.workspace_id=? AND installation.disconnected_at IS NULL
        AND installation.auth_error IS NULL AND installation.credential_revision=?)
      AND ${ownerGuard}`).bind(
      now,
      now,
      subscriptionId,
      member.workspace.id,
      installation.credential_revision,
      member.workspace.id,
      member.user.id,
    ),
    env.DB.prepare(`UPDATE slack_thread_deliveries SET state='sending',failure_reason=NULL,updated_at=?
      WHERE state='blocked' AND failure_reason LIKE 'reconciliation_%'
        AND link_id IN (SELECT id FROM slack_thread_links WHERE subscription_id=? AND state IN ('pending','active'))
        AND ${mappingGuard}`).bind(
      now,
      subscriptionId,
      subscriptionId,
      member.workspace.id,
      installation.credential_revision,
      member.workspace.id,
      member.user.id,
    ),
    env.DB.prepare(`UPDATE outbox SET enqueued_at=NULL,available_at=?,slack_redrive_due_at=NULL
      WHERE id IN (SELECT 'outbox:' || delivery.id FROM slack_thread_deliveries delivery
        JOIN slack_thread_links link ON link.id=delivery.link_id
        WHERE link.subscription_id=? AND delivery.state='sending')
        AND ${mappingGuard}`).bind(
      now,
      subscriptionId,
      subscriptionId,
      member.workspace.id,
      installation.credential_revision,
      member.workspace.id,
      member.user.id,
    ),
  ]);
  if (!result[0]!.meta.changes) unavailable();
}

async function linkFor(env: Env, id: string) {
  const link = await env.DB.prepare(`SELECT l.* FROM slack_thread_links l
    JOIN slack_installations i ON i.id = l.installation_id AND i.generation = l.installation_generation AND i.disconnected_at IS NULL
    JOIN slack_channel_subscriptions s ON s.id = l.subscription_id AND s.installation_id = i.id AND s.channel_id = l.channel_id AND s.mirror_enabled = 1 AND s.validation_state = 'valid'
    JOIN pages p ON p.id = l.page_id AND p.workspace_id = l.workspace_id AND p.space_id = s.space_id AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
    JOIN comment_threads t ON t.id = l.thread_id AND t.page_id = p.id AND t.workspace_id = i.workspace_id
    WHERE l.id = ? AND l.state IN ('pending', 'active') AND (s.page_id IS NULL OR s.page_id = p.id)`)
    .bind(id)
    .first<Link>();
  if (!link) unavailable();
  return link;
}
export async function currentInput(env: Env, input: Input) {
  const installation = await installationFor(env, input.installationId, input.generation);
  const link = await linkFor(env, input.linkId);
  if (
    link.installation_id !== installation.id ||
    link.state !== "active" ||
    link.channel_id !== input.channelId ||
    link.root_message_ts !== input.threadTs
  )
    unavailable();
  const { identity, member } = await verifiedMember(env, installation, input.slackUserId, input.identity);
  await validateChannel(env, installation, link.channel_id);
  await requireChannelMember(env, installation, link.channel_id, input.slackUserId);
  const page = asCommentPage(await pageForMember(env, member, link.page_id));
  return { installation, link, identity, member, page };
}

// This assertion runs inside the mutation transaction, after all Slack lookups.
function mutationGuard(env: Env, receiptId: string, input: Input, threadId: string) {
  const table = input.resolved === undefined ? "slack_inbound_receipts" : "slack_interaction_receipts";
  return env.DB.prepare(`INSERT INTO slack_mutation_commits (receipt_id, thread_id, authorized) VALUES (?, ?, EXISTS (
    SELECT 1 FROM slack_thread_links t JOIN slack_installations i ON i.id = t.installation_id
    JOIN slack_channel_subscriptions s ON s.id = t.subscription_id AND s.installation_id = i.id
    JOIN pages p ON p.id = t.page_id AND p.space_id = s.space_id AND p.workspace_id = i.workspace_id
    JOIN spaces sp ON sp.id = p.space_id AND sp.workspace_id = i.workspace_id
    JOIN comment_threads ct ON ct.id = t.thread_id AND ct.page_id = p.id
    JOIN workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = ?
    LEFT JOIN space_members sm ON sm.space_id = sp.id AND sm.user_id = wm.user_id
    JOIN slack_user_links u ON u.installation_id = i.id AND u.user_id = wm.user_id
    JOIN account a ON a.id = u.better_auth_account_id AND a.userId = wm.user_id
    WHERE t.id = ? AND t.thread_id = ? AND t.state = 'active' AND t.root_message_ts = ? AND t.channel_id = ?
      AND i.id = ? AND i.generation = ? AND t.installation_generation = i.generation AND i.disconnected_at IS NULL
      AND s.mirror_enabled = 1 AND s.validation_state = 'valid' AND s.channel_id = t.channel_id AND (s.page_id IS NULL OR s.page_id = p.id)
      AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
      AND (wm.role = 'owner' OR sp.visibility = 'workspace' OR sm.user_id IS NOT NULL)
      AND (? = 0 OR wm.role = 'owner' OR ct.created_by = wm.user_id OR (wm.role <> 'viewer' AND COALESCE(sm.role, 'editor') <> 'viewer'))
      AND u.slack_user_id = ? AND u.installation_generation = i.generation AND u.migration_state = 'verified'
      AND u.verification_method = 'slack_openid' AND u.verified_at = ? AND a.id = ? AND a.providerId = 'slack' AND a.accountId = i.team_id || ':' || u.slack_user_id
      AND NOT EXISTS (SELECT 1 FROM json_each(?) required WHERE instr(',' || i.scopes || ',', ',' || required.value || ',') = 0)
      AND EXISTS (SELECT 1 FROM ${table} receipt WHERE receipt.id = ? AND receipt.processed_at IS NULL
        AND (? = 0 OR receipt.received_at > unixepoch('subsec') * 1000 - 600000))
  ))`).bind(
    receiptId,
    threadId,
    input.identity?.userId ?? "",
    input.linkId,
    threadId,
    input.threadTs,
    input.channelId,
    input.installationId,
    input.generation,
    input.resolved === undefined ? 0 : 1,
    input.slackUserId,
    input.identity?.verifiedAt ?? -1,
    input.identity?.accountId ?? "",
    JSON.stringify(SCOPES),
    receiptId,
    input.resolved === undefined ? 0 : 1,
  );
}

function outboxStatement(env: Env, id: string, workspaceId: string, topic: string, payload: Record<string, unknown>) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, workspaceId, topic, JSON.stringify(payload), Date.now(), Date.now());
}

export async function acceptSlackReply(env: Env, payload: SlackEventPayload) {
  const event = payload.event;
  if (payload.type !== "event_callback" || event?.type !== "message") return false;
  if (
    typeof payload.event_id !== "string" ||
    !ID.test(payload.event_id) ||
    typeof payload.team_id !== "string" ||
    typeof event.user !== "string" ||
    !/^[UW][A-Z0-9]+$/.test(event.user) ||
    typeof event.channel !== "string" ||
    !/^[CG][A-Z0-9]+$/.test(event.channel) ||
    typeof event.ts !== "string" ||
    !TS.test(event.ts) ||
    typeof event.thread_ts !== "string" ||
    !TS.test(event.thread_ts) ||
    event.ts === event.thread_ts ||
    typeof event.text !== "string" ||
    (event.subtype !== undefined && event.subtype !== "thread_broadcast") ||
    event.bot_id !== undefined ||
    event.app_id !== undefined ||
    (event.channel_type !== undefined && event.channel_type !== "channel" && event.channel_type !== "group")
  )
    return true;
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE team_id = ? AND disconnected_at IS NULL`,
  )
    .bind(payload.team_id)
    .first<SlackInstallation>();
  if (!installation || installation.bot_user_id === event.user) return true;
  const link = await env.DB.prepare(
    `SELECT * FROM slack_thread_links WHERE installation_id = ? AND channel_id = ? AND root_message_ts = ? AND state = 'active'`,
  )
    .bind(installation.id, event.channel, event.thread_ts)
    .first<Link>();
  if (!link) return true;
  const broadcast = event.subtype === "thread_broadcast";
  const textTooLarge = !broadcast && new TextEncoder().encode(event.text).length > 16 * 1024;
  const input: Input = {
    installationId: installation.id,
    generation: installation.generation,
    linkId: link.id,
    channelId: event.channel,
    threadTs: event.thread_ts,
    slackUserId: event.user,
    identity: await identityFor(env, installation, event.user),
    ...(broadcast ? { broadcast: true } : textTooLarge ? { textTooLarge: true } : { text: event.text }),
  };
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO slack_inbound_receipts (id, installation_id, event_id, channel_id, message_ts, event_type, thread_id, thread_ts, origin, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?, 'message', ?, ?, 'slack', ?, ?)`).bind(
      id,
      installation.id,
      payload.event_id,
      event.channel,
      event.ts,
      link.thread_id,
      event.thread_ts,
      JSON.stringify(input),
      Date.now(),
    ),
    env.DB.prepare(`INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
      SELECT 'outbox:slack-inbound:' || id, ?, 'slack_inbound_reply', json_object('receiptId', id), ?, ? FROM slack_inbound_receipts
      WHERE installation_id = ? AND channel_id = ? AND message_ts = ? AND event_type = 'message' AND processed_at IS NULL`).bind(
      installation.workspace_id,
      Date.now(),
      Date.now(),
      installation.id,
      event.channel,
      event.ts,
    ),
  ]);
  return true;
}

export async function acceptSlackThreadAction(env: Env, payload: SlackInteractionPayload) {
  const action = payload.actions?.[0];
  if (
    payload.type !== "block_actions" ||
    !["noteflare_thread_resolve", "noteflare_thread_reopen"].includes(String(action?.action_id))
  )
    return false;
  if (
    payload.actions?.length !== 1 ||
    typeof payload.team?.id !== "string" ||
    typeof payload.user?.id !== "string" ||
    !/^[UW][A-Z0-9]+$/.test(payload.user.id) ||
    typeof payload.channel?.id !== "string" ||
    !/^[CG][A-Z0-9]+$/.test(payload.channel.id) ||
    typeof payload.message?.ts !== "string" ||
    !TS.test(payload.message.ts) ||
    typeof action?.action_ts !== "string" ||
    !TS.test(action.action_ts) ||
    typeof action.value !== "string" ||
    !ID.test(action.value)
  )
    return true;
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE team_id = ? AND disconnected_at IS NULL`,
  )
    .bind(payload.team.id)
    .first<SlackInstallation>();
  if (!installation) return true;
  const input: Input = {
    installationId: installation.id,
    generation: installation.generation,
    linkId: action.value,
    channelId: payload.channel.id,
    threadTs: payload.message.ts,
    slackUserId: payload.user.id,
    identity: await identityFor(env, installation, payload.user.id),
    resolved: action.action_id === "noteflare_thread_resolve",
  };
  const interactionId = `${installation.id}:${payload.user.id}:${payload.channel.id}:${payload.message.ts}:${action.action_ts}:${String(action.action_id)}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO slack_interaction_receipts (id, installation_id, interaction_id, callback_id, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), installation.id, interactionId, action.action_id, JSON.stringify(input), Date.now()),
    env.DB.prepare(`INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
      SELECT 'outbox:slack-action:' || id, ?, 'slack_thread_action', json_object('receiptId', id), ?, ? FROM slack_interaction_receipts WHERE interaction_id = ? AND processed_at IS NULL`).bind(
      installation.workspace_id,
      Date.now(),
      Date.now(),
      interactionId,
    ),
  ]);
  return true;
}

async function mentionMember(env: Env, installation: SlackInstallation, slackUserId: string, pageId: string) {
  try {
    const { member } = await verifiedMember(env, installation, slackUserId);
    await pageForMember(env, member, pageId);
    return { id: member.user.id, name: member.user.name };
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return null;
    throw error;
  }
}
async function mentionSlackId(env: Env, installation: SlackInstallation, userId: string, pageId: string) {
  const link = await env.DB.prepare(
    `SELECT slack_user_id FROM slack_user_links WHERE installation_id = ? AND user_id = ?`,
  )
    .bind(installation.id, userId)
    .first<{ slack_user_id: string }>();
  return link && (await mentionMember(env, installation, link.slack_user_id, pageId)) ? link.slack_user_id : null;
}

async function broadcastReplyText(env: Env, installation: SlackInstallation, input: Input, messageTs: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    let result: Awaited<ReturnType<typeof slackApi<"conversations.replies">>>;
    try {
      result = await slackApi(env, installation, "conversations.replies", {
        channel: input.channelId,
        ts: input.threadTs,
        oldest: String(Math.max(0, Number(messageTs.split(".")[0]) - 5)),
        limit: 100,
        include_all_metadata: true,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "thread_not_found")
        throw new HttpError(422, "slack_broadcast_unavailable", BROADCAST_MISSING);
      throw error;
    }
    const reply = result.messages.find(
      (message) =>
        message.ts === messageTs &&
        message.thread_ts === input.threadTs &&
        message.user === input.slackUserId &&
        !message.bot_id &&
        message.subtype !== "thread_broadcast",
    );
    if (reply && typeof reply.text === "string") return reply.text;
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  throw new HttpError(422, "slack_broadcast_unavailable", BROADCAST_MISSING);
}

export async function deliverSlackMutation(env: Env, receiptId: string, action: boolean) {
  const table = action ? "slack_interaction_receipts" : "slack_inbound_receipts";
  const receipt = await env.DB.prepare(
    `SELECT payload_json, processed_at, outcome, received_at, ${action ? "NULL" : "message_ts"} message_ts FROM ${table} WHERE id = ?`,
  )
    .bind(receiptId)
    .first<{
      payload_json: string | null;
      processed_at: number | null;
      outcome: string | null;
      received_at: number;
      message_ts: string | null;
    }>();
  if (!receipt || receipt.processed_at !== null || !receipt.payload_json) return;
  const input = JSON.parse(receipt.payload_json) as Input;
  try {
    if (action && receipt.received_at <= Date.now() - 10 * 60_000)
      throw new HttpError(403, "slack_action_expired", DENIED);
    const { installation, link, member, page } = await currentInput(env, input);
    if (action) {
      if (typeof input.resolved !== "boolean") unavailable();
      await setThreadResolved(env, member, page, link.thread_id, input.resolved, {
        receiptId,
        guard: mutationGuard(env, receiptId, input, link.thread_id),
      });
    } else {
      const messageTs = receipt.message_ts;
      if (!messageTs || !TS.test(messageTs)) throw new HttpError(422, "invalid_slack_timestamp", CONTENT_ERROR);
      const text = input.broadcast ? await broadcastReplyText(env, installation, input, messageTs) : (input.text ?? "");
      if (input.textTooLarge || new TextEncoder().encode(text).length > 16 * 1024)
        throw new HttpError(413, "slack_comment_too_large", CONTENT_ERROR);
      const body = await slackReplyBody(text, (id) => mentionMember(env, installation, id, link.page_id));
      const [seconds, fraction] = messageTs.split(".");
      const order = BigInt(seconds!) * 1_000_000n + BigInt(fraction!.padEnd(6, "0").slice(0, 6));
      if (order > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(422, "invalid_slack_timestamp", CONTENT_ERROR);
      await addCommentReply(env, member, page, link.thread_id, body, undefined, {
        receiptId,
        commentId: receiptId,
        guard: mutationGuard(env, receiptId, input, link.thread_id),
        slackOrderUs: Number(order),
      });
    }
    await broadcastWorkspaceEvent(env, link.workspace_id, { type: "comments-invalidated", pageId: link.page_id });
    await broadcastWorkspaceEvent(env, link.workspace_id, { type: "notifications-invalidated" });
  } catch (error) {
    // A concurrent winner committed the comment and its receipt in one transaction.
    const done = await env.DB.prepare(`SELECT processed_at FROM ${table} WHERE id = ?`)
      .bind(receiptId)
      .first<{ processed_at: number | null }>();
    if (done?.processed_at !== null && done?.processed_at !== undefined) return;
    if (error instanceof SlackApiError && slackInstallationError(error)) {
      await recordSlackInstallationError(env, input.installationId, error);
      throw error;
    }
    if (String(error).includes("CHECK constraint failed: authorized = 1")) {
      const current = await env.DB.prepare(`SELECT scopes,auth_error,credential_revision
        FROM slack_installations WHERE id=? AND disconnected_at IS NULL`)
        .bind(input.installationId)
        .first<{ scopes: string; auth_error: string | null; credential_revision: number }>();
      if (current) {
        const scopes = new Set(current.scopes.split(",").map((scope) => scope.trim()));
        const code = SCOPES.some((scope) => !scopes.has(scope)) ? "missing_scope" : current.auth_error;
        if (code && ["missing_scope", "invalid_auth", "token_revoked", "account_inactive"].includes(code)) {
          const authError = new SlackApiError("installation", code, 403, current.credential_revision);
          await recordSlackInstallationError(env, input.installationId, authError);
          throw authError;
        }
      }
    }
    const contentError =
      error instanceof HttpError &&
      [
        "slack_comment_too_large",
        "slack_comment_too_complex",
        "comment_too_large",
        "comment_too_complex",
        "empty_comment",
        "invalid_comment",
        "invalid_comment_block",
        "invalid_slack_timestamp",
        "slack_broadcast_unavailable",
      ].includes(error.code);
    const denied =
      (error instanceof HttpError && error.status < 500) ||
      (error instanceof SlackApiError &&
        [
          "channel_not_found",
          "not_in_channel",
          "user_not_found",
          "account_inactive",
          "token_revoked",
          "invalid_auth",
          "missing_scope",
          "no_permission",
        ].includes(error.code)) ||
      String(error).includes("CHECK constraint failed: authorized = 1");
    if (!denied) throw error;
    const reason = contentError
      ? error instanceof HttpError && error.code === "slack_broadcast_unavailable"
        ? BROADCAST_MISSING
        : CONTENT_ERROR
      : error instanceof HttpError && error.code === "slack_identity_required"
        ? CONNECT
        : error instanceof HttpError && error.code === "slack_action_expired"
          ? EXPIRED_ACTION
          : DENIED;
    const installation = await env.DB.prepare(`SELECT workspace_id FROM slack_installations WHERE id = ?`)
      .bind(input.installationId)
      .first<{ workspace_id: string }>();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${table} SET processed_at = ?, outcome = ?, payload_json = NULL WHERE id = ? AND processed_at IS NULL`,
      ).bind(
        Date.now(),
        error instanceof HttpError && error.code === "slack_broadcast_unavailable"
          ? "content_unavailable"
          : contentError
            ? "invalid_content"
            : error instanceof HttpError && error.code === "slack_action_expired"
              ? "expired"
              : "denied",
        receiptId,
      ),
      ...(installation
        ? [
            outboxStatement(
              env,
              `outbox:slack-denial:${receiptId}`,
              installation.workspace_id,
              "slack_interaction_response",
              {
                receiptId,
                action,
                installationId: input.installationId,
                generation: input.generation,
                channelId: input.channelId,
                slackUserId: input.slackUserId,
                threadTs: input.threadTs,
                text: reason,
              },
            ),
          ]
        : []),
    ]);
  }
}

export async function deliverSlackDenial(env: Env, payload: Record<string, unknown>) {
  if (
    typeof payload.receiptId !== "string" ||
    typeof payload.installationId !== "string" ||
    typeof payload.generation !== "number" ||
    typeof payload.channelId !== "string" ||
    typeof payload.slackUserId !== "string" ||
    typeof payload.threadTs !== "string"
  )
    return;
  const table = payload.action === true ? "slack_interaction_receipts" : "slack_inbound_receipts";
  let installation: SlackInstallation;
  try {
    installation = await installationFor(env, payload.installationId, payload.generation);
    await validateChannel(env, installation, payload.channelId);
  } catch (error) {
    if (error instanceof HttpError || (error instanceof SlackApiError && error.status < 500)) return;
    throw error;
  }
  const claimed = await env.DB.prepare(
    `UPDATE ${table} SET denial_sent_at = ? WHERE id = ?
      AND outcome IN ('denied', 'invalid_content', 'content_unavailable', 'expired') AND denial_sent_at IS NULL`,
  )
    .bind(Date.now(), payload.receiptId)
    .run();
  if (!claimed.meta.changes) return;
  try {
    await slackApi(env, installation, "chat.postEphemeral", {
      channel: payload.channelId,
      user: payload.slackUserId,
      ...(payload.action === true ? {} : { thread_ts: payload.threadTs }),
      text:
        payload.reason === "connect" ||
        payload.text === CONNECT ||
        payload.text === "Connect your Slack account from NoteFlare Settings before using this action."
          ? CONNECT
          : payload.reason === "expired" || payload.text === EXPIRED_ACTION
            ? EXPIRED_ACTION
            : payload.text === BROADCAST_MISSING
              ? BROADCAST_MISSING
              : payload.text === CONTENT_ERROR
                ? CONTENT_ERROR
                : DENIED,
    });
  } catch (error) {
    if (error instanceof SlackRateLimitError) {
      await env.DB.prepare(`UPDATE ${table} SET denial_sent_at = NULL WHERE id = ?`).bind(payload.receiptId).run();
      throw error;
    }
    // Ephemeral delivery is best effort; never post a public fallback or retry an ambiguous send.
    logger.warn("slack.thread.denial_unavailable", "slack", "Slack ephemeral denial could not be confirmed.", {
      receiptId: payload.receiptId,
    });
  }
}

async function finishDelivery(env: Env, delivery: Delivery, link: Link, messageTs: string) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_thread_deliveries SET state = 'sent', message_ts = ?, updated_at = ? WHERE id = ? AND state IN ('sending', 'blocked')`,
    ).bind(messageTs, Date.now(), delivery.id),
    ...(delivery.operation === "root"
      ? [
          env.DB.prepare(`UPDATE slack_thread_links SET root_message_ts = ?, state = 'active', updated_at = ? WHERE id = ? AND state = 'pending' AND subscription_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM slack_installations i JOIN slack_channel_subscriptions s ON s.installation_id = i.id WHERE i.id = slack_thread_links.installation_id AND i.generation = slack_thread_links.installation_generation AND i.disconnected_at IS NULL AND s.id = slack_thread_links.subscription_id AND s.mirror_enabled = 1)
      AND EXISTS (SELECT 1 FROM pages p JOIN comment_threads t ON t.page_id=p.id
        WHERE p.id=slack_thread_links.page_id AND p.workspace_id=slack_thread_links.workspace_id
          AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0
          AND t.id=slack_thread_links.thread_id)
      AND EXISTS (SELECT 1 FROM slack_thread_deliveries d WHERE d.id=? AND d.state='sent' AND d.message_ts=?)`).bind(
            messageTs,
            Date.now(),
            link.id,
            delivery.id,
            messageTs,
          ),
        ]
      : []),
  ]);
  await wakeNextSlackDelivery(env, link.id);
}

async function retireInvalidReconciledLink(env: Env, link: Link, delivery: Delivery) {
  try {
    await outboundAuthority(env, link, delivery.actor_id);
    if (delivery.comment_id) {
      const comment = await env.DB.prepare(
        `SELECT user_id FROM comments WHERE id=? AND thread_id=? AND deleted_at IS NULL`,
      )
        .bind(delivery.comment_id, link.thread_id)
        .first<{ user_id: string }>();
      if (!comment || !(await currentAuthorCanRead(env, link, comment.user_id))) unavailable();
    }
    return;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) throw error;
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE slack_thread_links SET state='retired',updated_at=?
      WHERE id=? AND state IN ('pending','active')`).bind(now, link.id),
    env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',failure_reason='link_unavailable',updated_at=?
      WHERE link_id=? AND state='pending'`).bind(now, link.id),
  ]);
}

export async function wakeNextSlackDelivery(env: Env, linkId: string) {
  const now = Date.now();
  // Reply and refresh have separate orderings. Start the retry clock only when
  // each delivery can actually run, and wake both queues after a completion.
  await env.DB.prepare(`UPDATE outbox SET enqueued_at=NULL, available_at=?, slack_redrive_due_at=NULL,
      slack_eligible_started_at=COALESCE(slack_eligible_started_at,?),
      slack_auth_pause_baseline_ms=CASE WHEN slack_eligible_started_at IS NULL THEN
        (SELECT i.auth_paused_ms+CASE WHEN i.auth_error_at IS NULL THEN 0 ELSE MAX(0,?-i.auth_error_at) END
         FROM slack_installations i WHERE i.workspace_id=outbox.workspace_id AND i.disconnected_at IS NULL)
        ELSE slack_auth_pause_baseline_ms END
    WHERE id IN (SELECT 'outbox:' || d.id FROM slack_thread_deliveries d
      JOIN slack_thread_links link ON link.id=d.link_id
      WHERE d.link_id=? AND d.state='pending' AND
        (d.operation='root' OR link.root_message_ts IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM slack_thread_deliveries prior
          WHERE prior.link_id=d.link_id AND prior.id<>d.id AND prior.state IN ('pending','sending','blocked')
            AND (d.operation<>'root' AND
              (prior.operation='root' OR
                (d.operation<>'refresh' AND prior.operation<>'refresh' AND
                  (prior.created_at<d.created_at OR (prior.created_at=d.created_at AND prior.id<d.id))) OR
                (d.operation='refresh' AND prior.operation='refresh' AND
                  (prior.created_at<d.created_at OR (prior.created_at=d.created_at AND prior.id<d.id))))))
    ) AND (enqueued_at IS NOT NULL OR slack_eligible_started_at IS NULL)`)
    .bind(now, now, now, linkId)
    .run();
}

async function retireRejectedDelivery(env: Env, delivery: Delivery, reason: string) {
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired', failure_reason=?, updated_at=?
      WHERE id=? AND state IN ('pending','sending') RETURNING id`).bind(reason, now, delivery.id),
    env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
      (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
      SELECT ?,link.workspace_id,COALESCE(link.subscription_id,'orphan:' || link.id),
        COALESCE(mapping.channel_name,link.channel_id),?,?
      FROM slack_thread_links link LEFT JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
      WHERE link.id=? AND EXISTS (SELECT 1 FROM slack_thread_deliveries d
        WHERE d.id=? AND d.state='retired' AND d.failure_reason=?)`).bind(
      delivery.id,
      reason,
      now,
      delivery.link_id,
      delivery.id,
      reason,
    ),
    ...(delivery.operation === "root"
      ? [
          env.DB.prepare(`UPDATE slack_thread_links SET state='retired',updated_at=? WHERE id=?
        AND EXISTS (SELECT 1 FROM slack_thread_deliveries d WHERE d.id=? AND d.state='retired'
          AND d.failure_reason=?)`).bind(now, delivery.link_id, delivery.id, reason),
          env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',failure_reason='root_rejected',updated_at=?
        WHERE link_id=? AND id<>? AND state='pending'
          AND EXISTS (SELECT 1 FROM slack_thread_deliveries d WHERE d.id=? AND d.state='retired'
            AND d.failure_reason=?)`).bind(now, delivery.link_id, delivery.id, delivery.id, reason),
        ]
      : []),
  ]);
  if (result[0]!.meta.changes && delivery.operation !== "root") await wakeNextSlackDelivery(env, delivery.link_id);
}

async function retireMirrorChannel(env: Env, delivery: Delivery, reason: string) {
  const link = await env.DB.prepare(`SELECT subscription_id FROM slack_thread_links WHERE id=?`)
    .bind(delivery.link_id)
    .first<{ subscription_id: string | null }>();
  const now = Date.now();
  if (link?.subscription_id) {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
        (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
        SELECT d.id,thread_link.workspace_id,?,COALESCE(NULLIF(mapping.channel_name,''),thread_link.channel_id),
          CASE WHEN d.state='pending' THEN ? ELSE 'channel_unavailable_unconfirmed' END,?
        FROM slack_thread_deliveries d JOIN slack_thread_links thread_link ON thread_link.id=d.link_id
        JOIN slack_channel_subscriptions mapping ON mapping.id=thread_link.subscription_id
        WHERE mapping.id=? AND (d.state IN ('pending','sending') OR
          (d.state='blocked' AND d.failure_reason LIKE 'reconciliation_%'))`).bind(
        link.subscription_id,
        reason,
        now,
        link.subscription_id,
      ),
      env.DB.prepare(`UPDATE slack_channel_subscriptions SET mirror_enabled=0, validation_state='invalid',
        validation_error='channel_unavailable', updated_at=? WHERE id=?`).bind(now, link.subscription_id),
      env.DB.prepare(`UPDATE slack_thread_links SET state='retired', updated_at=?
        WHERE subscription_id=? AND state IN ('pending','active')`).bind(now, link.subscription_id),
      env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired', failure_reason=?, updated_at=?
        WHERE link_id IN (SELECT id FROM slack_thread_links WHERE subscription_id=?)
          AND (state='pending' OR (state='blocked' AND failure_reason='predecessor_blocked'))`).bind(
        reason,
        now,
        link.subscription_id,
      ),
      env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired', failure_reason=?, updated_at=?
        WHERE link_id IN (SELECT id FROM slack_thread_links WHERE subscription_id=?)
          AND (state='sending' OR (state='blocked' AND failure_reason LIKE 'reconciliation_%'))`).bind(
        `channel_unavailable_unconfirmed`,
        now,
        link.subscription_id,
      ),
    ]);
  } else await retireRejectedDelivery(env, delivery, reason);
}
async function reconcileDelivery(env: Env, installation: SlackInstallation, link: Link, delivery: Delivery) {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const input = {
      channel: link.channel_id,
      oldest: String(Math.max(0, (delivery.attempted_at ?? delivery.created_at) / 1000 - 5)),
      limit: 100,
      include_all_metadata: true,
      ...(cursor ? { cursor } : {}),
    };
    const result =
      delivery.operation === "root"
        ? await slackApi(env, installation, "conversations.history", input)
        : await slackApi(env, installation, "conversations.replies", { ...input, ts: link.root_message_ts! });
    const found = result.messages.filter(
      (message) =>
        message.user === installation.bot_user_id &&
        message.metadata?.event_type === "noteflare_thread_delivery" &&
        message.metadata.event_payload?.delivery_id === delivery.id &&
        (delivery.operation === "root"
          ? !message.thread_ts || message.thread_ts === message.ts
          : message.thread_ts === link.root_message_ts),
    );
    if (found.length === 1 && TS.test(found[0]!.ts)) return found[0]!.ts;
    if (found.length > 1) return null;
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) return null;
  }
  return null;
}

const transientSlackLookup = (error: SlackApiError) =>
  error.status >= 500 ||
  ["ratelimited", "internal_error", "service_unavailable", "fatal_error", "invalid_response", "http_error"].includes(
    error.code,
  );

async function installationPauseClock(env: Env, installationId: string) {
  const row = await env.DB.prepare(`SELECT auth_paused_ms,auth_error_at FROM slack_installations WHERE id=?`)
    .bind(installationId)
    .first<{ auth_paused_ms: number; auth_error_at: number | null }>();
  return (
    (row?.auth_paused_ms ?? 0) +
    (row?.auth_error_at === null || row?.auth_error_at === undefined ? 0 : Math.max(0, Date.now() - row.auth_error_at))
  );
}

async function pauseHistoryClock(env: Env, delivery: Delivery, installationId?: string) {
  const id =
    installationId ??
    (
      await env.DB.prepare(`SELECT installation_id FROM slack_thread_links WHERE id=?`)
        .bind(delivery.link_id)
        .first<{ installation_id: string }>()
    )?.installation_id;
  if (!id) return;
  const now = Date.now();
  await env.DB.prepare(`UPDATE slack_thread_deliveries SET history_paused_at=?,history_pause_auth_ms=?
    WHERE id=? AND state='sending' AND history_paused_at IS NULL`)
    .bind(now, await installationPauseClock(env, id), delivery.id)
    .run();
}

async function resumeHistoryClock(env: Env, delivery: Delivery, installationId: string) {
  const now = Date.now();
  const auth = await installationPauseClock(env, installationId);
  await env.DB.prepare(`UPDATE slack_thread_deliveries
    SET history_pause_total_ms=history_pause_total_ms+
      MAX(0,? - history_paused_at - MAX(0,? - history_pause_auth_ms)),
      history_paused_at=NULL,history_pause_auth_ms=NULL
    WHERE id=? AND state='sending' AND history_paused_at IS NOT NULL`)
    .bind(now, auth, delivery.id)
    .run();
}

function definitelyNotPosted(error: unknown) {
  return (
    error instanceof SlackRateLimitError ||
    (error instanceof SlackApiError &&
      error.status < 500 &&
      [
        "ratelimited",
        "channel_not_found",
        "not_in_channel",
        "is_archived",
        "invalid_arguments",
        "invalid_blocks",
        "msg_too_long",
        "restricted_action",
        "no_permission",
        "invalid_auth",
        "token_revoked",
        "account_inactive",
        "missing_scope",
      ].includes(error.code))
  );
}
async function blockSlackDelivery(
  env: Env,
  delivery: { id: string; link_id: string; operation: "root" | "reply" | "refresh"; created_at: number },
  reason = "reconciliation_inconclusive",
) {
  const now = Date.now();
  // A pending row has never begun a send and must not become uncertain because
  // a stale redrive observed a different state before another consumer reset it.
  await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='blocked',failure_reason=?,updated_at=?
    WHERE id=? AND state='sending'`)
    .bind(reason, now, delivery.id)
    .run();
  logger.warn("slack.thread.delivery_blocked", "slack", "Slack delivery is blocked; no duplicate will be posted.", {
    deliveryId: delivery.id,
  });
}

export async function retireUncertainSlackDelivery(
  env: Env,
  delivery: { id: string; link_id: string; operation: "root" | "reply" | "refresh" },
) {
  const now = Date.now();
  const reason = "reconciliation_expired";
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE slack_thread_deliveries
      SET state='retired',failure_reason=?,updated_at=? WHERE id=?
        AND (state='sending' OR (state='blocked' AND failure_reason LIKE 'reconciliation_%'))
        AND NOT EXISTS (SELECT 1 FROM slack_thread_links link WHERE link.id=slack_thread_deliveries.link_id
          AND link.claim_token IS NOT NULL AND link.claimed_at>?)`).bind(reason, now, delivery.id, now - 60_000),
    env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
      (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
      SELECT ?,link.workspace_id,COALESCE(link.subscription_id,'orphan:' || link.id),
        COALESCE(mapping.channel_name,link.channel_id),?,?
      FROM slack_thread_links link LEFT JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
      WHERE link.id=? AND EXISTS (SELECT 1 FROM slack_thread_deliveries d
        WHERE d.id=? AND d.state='retired' AND d.failure_reason=?)`).bind(
      delivery.id,
      reason,
      now,
      delivery.link_id,
      delivery.id,
      reason,
    ),
    ...(delivery.operation === "root"
      ? [
          env.DB.prepare(`UPDATE slack_thread_links SET state='retired',updated_at=? WHERE id=? AND state='pending'
        AND EXISTS (SELECT 1 FROM slack_thread_deliveries d WHERE d.id=? AND d.state='retired'
          AND d.failure_reason=?)`).bind(now, delivery.link_id, delivery.id, reason),
          env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',failure_reason='root_unconfirmed',updated_at=?
        WHERE link_id=? AND id<>? AND state='pending'
          AND EXISTS (SELECT 1 FROM slack_thread_deliveries d WHERE d.id=? AND d.state='retired'
            AND d.failure_reason=?)`).bind(now, delivery.link_id, delivery.id, delivery.id, reason),
        ]
      : []),
  ]);
  if (!result[0]!.meta.changes) return false;
  if (delivery.operation !== "root") await wakeNextSlackDelivery(env, delivery.link_id);
  return true;
}
async function outboundAuthority(env: Env, link: Link, actorId: string) {
  const current = await linkFor(env, link.id);
  const installation = await installationFor(env, current.installation_id, current.installation_generation);
  const actor = await env.DB.prepare(`SELECT account_type FROM user WHERE id = ?`)
    .bind(actorId)
    .first<{ account_type: string }>();
  if (actor?.account_type === "bot") {
    const page = await pageForIntegrationBot(env, current.workspace_id, actorId, current.page_id);
    if (!page) unavailable();
    return { current, installation, member: null, page: { ...page, effective_role: "editor" as const } };
  }
  const member = await memberFor(env, current.workspace_id, actorId);
  const page = await pageForMember(env, member, current.page_id);
  return { current, installation, member, page };
}

async function currentAuthorCanRead(env: Env, link: Link, authorId: string) {
  const actor = await env.DB.prepare(`SELECT account_type FROM user WHERE id = ?`)
    .bind(authorId)
    .first<{ account_type: string }>();
  if (actor?.account_type === "bot")
    return Boolean(await pageForIntegrationBot(env, link.workspace_id, authorId, link.page_id));
  try {
    await pageForMember(env, await memberFor(env, link.workspace_id, authorId), link.page_id);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return false;
    throw error;
  }
}

export async function deliverSlackThread(env: Env, deliveryId: string) {
  const delivery = await env.DB.prepare(`SELECT * FROM slack_thread_deliveries WHERE id = ?`)
    .bind(deliveryId)
    .first<Delivery>();
  if (!delivery || ["sent", "retired", "blocked"].includes(delivery.state)) return;
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE slack_thread_links SET claim_token = ?, claimed_at = ? WHERE id = ? AND (claim_token IS NULL OR claimed_at < ?)`,
  )
    .bind(token, Date.now(), delivery.link_id, Date.now() - 60_000)
    .run();
  if (!claim.meta.changes) throw new DeliveryInProgressError();
  try {
    // Re-read after claiming: a previous consumer may have just completed this delivery.
    const currentDelivery = await env.DB.prepare(`SELECT * FROM slack_thread_deliveries WHERE id = ?`)
      .bind(deliveryId)
      .first<Delivery>();
    if (!currentDelivery || ["sent", "retired", "blocked"].includes(currentDelivery.state)) return;
    Object.assign(delivery, currentDelivery);
    const link = await env.DB.prepare(`SELECT * FROM slack_thread_links WHERE id=?`)
      .bind(delivery.link_id)
      .first<Link>();
    if (!link) unavailable();
    const installed = await installationFor(env, link.installation_id, link.installation_generation);
    // A lost post response must be reconciled before a later author revocation
    // can retire this root and permit a duplicate root for the thread.
    if (delivery.state === "sending" && delivery.operation !== "refresh") {
      let recovered: string | null;
      try {
        recovered = await reconcileDelivery(env, installed, link, delivery);
      } catch (error) {
        await pauseHistoryClock(env, delivery, installed.id);
        if (error instanceof SlackApiError && !transientSlackLookup(error)) {
          if (slackInstallationError(error)) {
            await recordSlackInstallationError(env, installed.id, error);
            throw error;
          }
          await blockSlackDelivery(env, delivery, `reconciliation_${error.code}`);
          return;
        }
        throw error;
      }
      await resumeHistoryClock(env, delivery, installed.id);
      if (recovered) {
        await finishDelivery(env, delivery, link, recovered);
        await retireInvalidReconciledLink(env, link, delivery);
      }
      return;
    }
    await linkFor(env, delivery.link_id);
    await validateChannel(env, installed, link.channel_id);
    const { installation, member, page } = await outboundAuthority(env, link, delivery.actor_id);
    if (delivery.operation !== "root" && !link.root_message_ts) {
      throw new DeliveryInProgressError();
    }
    const earlier = await env.DB.prepare(`SELECT 1 FROM slack_thread_deliveries WHERE link_id = ? AND id <> ?
      AND state IN ('pending','sending','blocked')
      AND (operation = 'root' OR
        (operation = ? AND ? = 'refresh' AND (created_at < ? OR (created_at = ? AND id < ?))) OR
        (? = 'reply' AND operation = 'reply' AND (created_at < ? OR (created_at = ? AND id < ?)))) LIMIT 1`)
      .bind(
        link.id,
        delivery.id,
        delivery.operation,
        delivery.operation,
        delivery.created_at,
        delivery.created_at,
        delivery.id,
        delivery.operation,
        delivery.created_at,
        delivery.created_at,
        delivery.id,
      )
      .first();
    if (earlier && delivery.operation !== "root") throw new DeliveryInProgressError();
    if (delivery.operation === "refresh") {
      const newer = await env.DB.prepare(`SELECT 1 FROM slack_thread_deliveries
        WHERE link_id=? AND operation='refresh' AND state='pending' AND id<>?
          AND (created_at>? OR (created_at=? AND id>?)) LIMIT 1`)
        .bind(link.id, delivery.id, delivery.created_at, delivery.created_at, delivery.id)
        .first();
      if (newer) {
        await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',failure_reason='superseded',updated_at=?
          WHERE id=? AND state IN ('pending','sending')`)
          .bind(Date.now(), delivery.id)
          .run();
        await wakeNextSlackDelivery(env, link.id);
        return;
      }
    }
    if (delivery.operation === "root") {
      const mapping = await env.DB.prepare(
        `SELECT muted_at, snoozed_until FROM slack_channel_subscriptions WHERE id = ?`,
      )
        .bind(link.subscription_id)
        .first<{ muted_at: number | null; snoozed_until: number | null }>();
      if (!mapping || mapping.muted_at !== null || (mapping.snoozed_until ?? 0) > Date.now()) unavailable();
    }
    const thread = await env.DB.prepare(
      `SELECT resolved_at, created_by FROM comment_threads WHERE id = ? AND page_id = ?`,
    )
      .bind(link.thread_id, page.id)
      .first<{ resolved_at: number | null; created_by: string }>();
    if (!thread) unavailable();
    if (
      delivery.operation === "refresh" &&
      member?.role !== "owner" &&
      page.effective_role === "viewer" &&
      thread.created_by !== member?.user.id
    )
      unavailable();
    const rootDelivery =
      delivery.operation === "refresh"
        ? await env.DB.prepare(
            `SELECT comment_id FROM slack_thread_deliveries WHERE link_id = ? AND operation = 'root'`,
          )
            .bind(link.id)
            .first<{ comment_id: string | null }>()
        : delivery;
    const comment = await env.DB.prepare(
      `SELECT c.body_json, c.user_id, u.name FROM comments c JOIN user u ON u.id = c.user_id WHERE c.id = ? AND c.thread_id = ? AND c.deleted_at IS NULL`,
    )
      .bind(rootDelivery?.comment_id ?? null, link.thread_id)
      .first<{ body_json: string; user_id: string; name: string }>();
    if (!comment && delivery.operation !== "refresh") unavailable();
    let body = "Comment unavailable.";
    if (comment) {
      const authorCanRead = await currentAuthorCanRead(env, link, comment.user_id);
      if (!authorCanRead && delivery.operation !== "refresh") unavailable();
      if (authorCanRead) {
        const authorName = escapeSlackText(comment.name)
          .slice(0, 150)
          .replace(/&[^;]*$/g, "");
        const commentText = await slackCommentText(JSON.parse(comment.body_json) as CommentBody, (id) =>
          mentionSlackId(env, installation, id, link.page_id),
        );
        body = `${authorName}: ${commentText}`;
      }
    }
    const url = `${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(link.page_id)}`;
    const heading = `${thread.resolved_at ? "Resolved" : "Open"} · ${escapeSlackText(page.title.slice(0, 200))}`;
    let text = delivery.operation === "reply" ? body : `${heading}\n${body}\n<${url}|Open in NoteFlare>`;
    const controlState =
      delivery.operation === "reply"
        ? null
        : await env.DB.prepare(`SELECT muted_at, snoozed_until FROM slack_channel_subscriptions WHERE id = ?`)
            .bind(link.subscription_id)
            .first<{ muted_at: number | null; snoozed_until: number | null }>();
    const shareActive =
      delivery.operation === "reply"
        ? null
        : await env.DB.prepare(
            `SELECT 1 FROM share_links WHERE root_page_id = ? AND workspace_id = ? AND revoked_at IS NULL`,
          )
            .bind(link.page_id, link.workspace_id)
            .first();
    const rootBlocks = (content: string) =>
      threadRootBlocks({
        heading,
        body: content,
        url,
        linkId: link.id,
        resolved: Boolean(thread.resolved_at),
        muted: Boolean(controlState?.muted_at || (controlState?.snoozed_until ?? 0) > Date.now()),
        shareActive: Boolean(shareActive),
        shareEligible: page.kind !== "diagram",
      });
    let blocks: unknown[] =
      delivery.operation === "reply"
        ? [{ type: "section", text: { type: "mrkdwn", verbatim: true, text: body } }]
        : rootBlocks(body);
    // Revalidate local authority after Slack lookups, then fence the irreversible send.
    await outboundAuthority(env, link, delivery.actor_id);
    if (comment && !(await currentAuthorCanRead(env, link, comment.user_id))) {
      if (delivery.operation !== "refresh") unavailable();
      body = "Comment unavailable.";
      text = `${heading}\n${body}\n<${url}|Open in NoteFlare>`;
      blocks = rootBlocks(body);
    }
    const sendToken = await usableBotToken(env, installation);
    const sending = await env.DB.prepare(
      `UPDATE slack_thread_deliveries SET state = 'sending', attempted_at = COALESCE(attempted_at, ?),
        auth_pause_baseline_ms=COALESCE(auth_pause_baseline_ms,
          (SELECT i.auth_paused_ms+CASE WHEN i.auth_error_at IS NULL THEN 0 ELSE MAX(0,?-i.auth_error_at) END
            FROM slack_installations i WHERE i.id=?)),
        updated_at = ? WHERE id = ? AND state IN ('pending', 'sending')
        AND EXISTS (SELECT 1 FROM slack_thread_links WHERE id = ? AND claim_token = ? AND state IN ('pending', 'active'))`,
    )
      .bind(Date.now(), Date.now(), installation.id, Date.now(), delivery.id, link.id, token)
      .run();
    if (!sending.meta.changes) throw new DeliveryInProgressError();
    delivery.state = "sending";
    try {
      const result =
        delivery.operation === "refresh"
          ? await slackApi(
              env,
              installation,
              "chat.update",
              {
                channel: link.channel_id,
                ts: link.root_message_ts!,
                text,
                blocks,
              },
              undefined,
              undefined,
              sendToken,
            )
          : await slackApi(
              env,
              installation,
              "chat.postMessage",
              {
                channel: link.channel_id,
                text,
                blocks,
                ...(delivery.operation === "reply" ? { thread_ts: link.root_message_ts! } : {}),
                metadata: { event_type: "noteflare_thread_delivery", event_payload: { delivery_id: delivery.id } },
                parse: "none",
                unfurl_links: false,
                unfurl_media: false,
              },
              undefined,
              undefined,
              sendToken,
            );
      if (result.channel !== link.channel_id || !TS.test(result.ts))
        throw new Error("Slack message result is incomplete.");
      await finishDelivery(env, delivery, link, result.ts);
    } catch (error) {
      if (definitelyNotPosted(error)) {
        const reset = await env.DB.prepare(
          `UPDATE slack_thread_deliveries SET state='pending',attempted_at=NULL,
            auth_pause_baseline_ms=NULL,history_paused_at=NULL,history_pause_auth_ms=NULL,
            history_pause_total_ms=0 WHERE id=? AND state='sending'`,
        )
          .bind(delivery.id)
          .run();
        if (reset.meta.changes) delivery.state = "pending";
      }
      // Unknown outcomes remain 'sending'; redelivery reconciles rather than re-posting.
      throw error;
    }
  } catch (error) {
    if (error instanceof HttpError && error.code === "slack_channel_invalid") {
      if (delivery.operation === "refresh") {
        await retireRejectedDelivery(env, delivery, error.code);
        return;
      }
      if (delivery.state === "sending") {
        await pauseHistoryClock(env, delivery);
        await blockSlackDelivery(env, delivery, "reconciliation_channel_unavailable");
        return;
      }
      await retireMirrorChannel(env, delivery, "channel_unavailable");
      return;
    }
    if (error instanceof SlackApiError) {
      if (slackInstallationError(error)) {
        const installationId = (
          await env.DB.prepare(`SELECT installation_id FROM slack_thread_links WHERE id=?`)
            .bind(delivery.link_id)
            .first<{ installation_id: string }>()
        )?.installation_id;
        if (installationId) await recordSlackInstallationError(env, installationId, error);
        throw error;
      }
      if (slackChannelError(error)) {
        if (delivery.operation === "refresh") {
          await retireRejectedDelivery(env, delivery, error.code);
          return;
        }
        if (delivery.state === "sending") {
          await pauseHistoryClock(env, delivery);
          await blockSlackDelivery(env, delivery, `reconciliation_${error.code}`);
          return;
        }
        await retireMirrorChannel(env, delivery, error.code);
        return;
      }
      if (error.code === "message_not_found" && delivery.operation === "refresh") {
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
            (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
            SELECT d.id,link.workspace_id,COALESCE(link.subscription_id,'orphan:' || link.id),
              COALESCE(NULLIF(mapping.channel_name,''),link.channel_id),'root_message_not_found_unconfirmed',?
            FROM slack_thread_deliveries d JOIN slack_thread_links link ON link.id=d.link_id
            LEFT JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
            WHERE d.link_id=? AND (d.state='sending' OR
              (d.state='blocked' AND d.failure_reason LIKE 'reconciliation_%'))`).bind(now, delivery.link_id),
          env.DB.prepare(`UPDATE slack_thread_links SET state='retired',updated_at=? WHERE id=?`).bind(
            now,
            delivery.link_id,
          ),
          env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',
            failure_reason=CASE WHEN state='sending' OR (state='blocked' AND failure_reason LIKE 'reconciliation_%')
              THEN 'root_message_not_found_unconfirmed' ELSE 'root_message_not_found' END, updated_at=?
            WHERE link_id=? AND (state IN ('pending','sending') OR
              (state='blocked' AND failure_reason LIKE 'reconciliation_%'))`).bind(now, delivery.link_id),
        ]);
        return;
      }
      if (["invalid_arguments", "invalid_blocks", "msg_too_long"].includes(error.code)) {
        await retireRejectedDelivery(env, delivery, error.code);
        return;
      }
    }
    if (error instanceof HttpError && error.status < 500) {
      if (delivery.operation === "refresh") {
        await retireRejectedDelivery(env, delivery, error.code);
        return;
      }
      const current = await env.DB.prepare(`SELECT state FROM slack_thread_deliveries WHERE id=?`)
        .bind(delivery.id)
        .first<{ state: string }>();
      if (current?.state === "sending") {
        await blockSlackDelivery(env, delivery, `reconciliation_${error.code}`);
        return;
      }
      await retireRejectedDelivery(env, delivery, error.code);
      return;
    }
    throw error;
  } finally {
    await env.DB.prepare(
      `UPDATE slack_thread_links SET claim_token = NULL, claimed_at = NULL WHERE id = ? AND claim_token = ?`,
    )
      .bind(delivery.link_id, token)
      .run();
  }
}
