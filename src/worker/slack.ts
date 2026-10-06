import { slackAccessAuthorization, slackGrantStartSql } from "./slack-identity";
import type { ChannelEventType } from "../shared/activity";
import { defaultDigestTimezone, digestWindow, channelInvalidReason } from "./slack-schedule";
import type {
  NotificationEventType,
  SlackCapability,
  SlackCapabilityHealth,
  SlackChannelSubscription,
  SlackStatus,
} from "../shared/types";
import { tracing } from "cloudflare:workers";
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, hmacSha256 } from "../shared/security";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { DeliveryInProgressError } from "./delivery-claim";
import { freshSecurityAuthorization, freshSecurityGuard } from "./security";
import { safeSlackText, unfurlBlocks } from "./slack-blocks";
import { currentObservabilityContext, logger, recordMetric, traced } from "./observability";

import {
  PENDING_SHARE_RESPONSE_SQL,
  SLACK_MIRROR_SCOPES,
  ROUND2_OUTBOX_SQL,
  ROUND2_NON_CHANNEL_TOPICS_SQL,
  SLACK_PAUSED_SCOPES_SQL,
  slackScopeRequirements,
  slackScopesGrantedSql,
  round2WakeStatement,
  resumeSlackFileCleanup,
} from "./slack-delivery-contracts";
export { SLACK_MIRROR_SCOPES } from "./slack-delivery-contracts";
export const SLACK_REDRIVE_STALE_MS = 30 * 60_000;

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const LINK_TOKEN_TTL_MS = 10 * 60_000;
const REQUEST_WINDOW_SECONDS = 5 * 60;
const TOKEN_VERSION = "v1";
const SLACK_BOT_SCOPES = [
  "commands",
  "chat:write",
  "links:read",
  "links:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "users:read",
  "reactions:read",
  "files:write",
] as const;

const SLACK_CAPABILITY_SCOPES: Record<SlackCapability, readonly string[]> = {
  search: ["commands"],
  unfurls: ["links:read", "links:write"],
  notifications: ["chat:write"],
  identity: ["users:read"],
  messageEvents: ["channels:history", "groups:history"],
  capture: ["channels:history", "groups:history", "reactions:read"],
  files: ["files:write"],
};

export type SlackInstallation = {
  file_scope_error_revision?: number | null;
  generation: number;
  credential_revision: number;
  id: string;
  workspace_id: string;
  team_id: string;
  team_name: string;
  bot_user_id: string;
  bot_token_ciphertext: string;
  bot_refresh_token_ciphertext: string | null;
  token_expires_at: number | null;
  disconnected_at: number | null;
  scopes: string;
};

export type SlackEventPayload = {
  type?: unknown;
  event_id?: unknown;
  challenge?: unknown;
  team_id?: unknown;
  event?: {
    type?: unknown;
    user?: unknown;
    channel?: unknown;
    message_ts?: unknown;
    event_ts?: unknown;
    subtype?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    text?: unknown;
    bot_id?: unknown;
    app_id?: unknown;
    channel_type?: unknown;
    links?: Array<{ url?: unknown }>;
  };
};

export type SlackInteractionPayload = {
  type?: unknown;
  callback_id?: unknown;
  trigger_id?: unknown;
  action_ts?: unknown;
  channel?: { id?: unknown };
  message?: { ts?: unknown; text?: unknown; thread_ts?: unknown; user?: unknown };
  actions?: Array<{ action_id?: unknown; action_ts?: unknown; value?: unknown; selected_option?: { value?: unknown } }>;
  team?: { id?: unknown };
  user?: { id?: unknown };
  view?: {
    id?: unknown;
    hash?: unknown;
    private_metadata?: unknown;
    callback_id?: unknown;
    state?: { values?: unknown };
  };
  container?: { channel_id?: unknown; message_ts?: unknown; app_unfurl_url?: unknown };
  app_unfurl?: { app_unfurl_url?: unknown };
  value?: unknown;
  action_id?: unknown;
};

export class SlackRateLimitError extends Error {
  constructor(
    readonly retryAfter: number,
    readonly method = "unknown",
    readonly retryAt = Date.now() + retryAfter * 1000,
  ) {
    super("Slack rate limit reached.");
    this.name = "SlackRateLimitError";
  }
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status: number,
    readonly credentialRevision = 0,
    readonly neededScopes: readonly string[] = [],
  ) {
    super(`Slack ${method} failed.`);
    this.name = "SlackApiError";
  }
}

const INSTALLATION_ERRORS = new Set(["invalid_auth", "token_revoked", "account_inactive", "invalid_refresh_token"]);
const CHANNEL_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
  "no_permission",
]);
export const slackInstallationError = (error: unknown): boolean =>
  error instanceof SlackApiError && INSTALLATION_ERRORS.has(error.code);
export const slackMissingScope = (error: unknown): error is SlackApiError =>
  error instanceof SlackApiError && error.code === "missing_scope";
export const slackHasScopes = (scopes: string, required: readonly string[]): boolean => {
  const granted = new Set(scopes.split(",").map((scope) => scope.trim()));
  return required.every((scope) => granted.has(scope));
};
export const slackChannelError = (error: unknown): boolean =>
  error instanceof SlackApiError && CHANNEL_ERRORS.has(error.code);

export async function recordSlackInstallationError(
  env: Env,
  installationId: string,
  error: SlackApiError,
  generation?: number,
  condition?: { sql: string; binds: (string | number | null)[] },
) {
  const result = await env.DB.prepare(
    `UPDATE slack_installations SET auth_error=?, auth_error_at=COALESCE(auth_error_at,?)
      WHERE id=? AND disconnected_at IS NULL AND credential_revision=? AND (? IS NULL OR generation=?)
        ${condition ? `AND (${condition.sql})` : ""}`,
  )
    .bind(
      error.code,
      Date.now(),
      installationId,
      error.credentialRevision,
      generation ?? null,
      generation ?? null,
      ...(condition?.binds ?? []),
    )
    .run();
  return result.meta.changes > 0;
}

export async function recordSlackFileScopeError(env: Env, installation: SlackInstallation, error: SlackApiError) {
  const saved = await env.DB.prepare(`UPDATE slack_installations SET file_scope_error_revision=?
    WHERE id=? AND generation=? AND credential_revision=? AND disconnected_at IS NULL`)
    .bind(error.credentialRevision, installation.id, installation.generation, error.credentialRevision)
    .run();
  return saved.meta.changes > 0;
}

export type SlackUser = {
  id: string;
  team_id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
};

export type SlackApiContracts = {
  "chat.getPermalink": { input: { channel: string; message_ts: string }; output: { permalink: string } };
  "conversations.info": {
    input: { channel: string };
    output: {
      channel: {
        id: string;
        name: string;
        is_channel?: boolean;
        is_group?: boolean;
        is_private?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        is_member?: boolean;
        is_archived?: boolean;
        is_ext_shared?: boolean;
        is_shared?: boolean;
        is_org_shared?: boolean;
        pending_shared?: unknown[];
      };
    };
  };
  "conversations.list": {
    input: { types: string; exclude_archived: boolean; limit: number; cursor?: string };
    output: {
      channels: SlackApiContracts["conversations.info"]["output"]["channel"][];
      response_metadata?: { next_cursor?: string };
    };
  };
  "files.delete": { input: { file: string }; output: Record<string, never> };
  "files.getUploadURLExternal": {
    input: { filename: string; length: number };
    output: { upload_url: string; file_id: string };
  };
  "files.completeUploadExternal": {
    input: { files: Array<{ id: string; title: string }> };
    output: { files: Array<{ id: string; title?: string }> };
  };
  "conversations.members": {
    input: { channel: string; cursor?: string; limit: number };
    output: { members: string[]; response_metadata?: { next_cursor?: string } };
  };
  "conversations.history": {
    input: {
      channel: string;
      oldest: string;
      latest?: string;
      inclusive?: boolean;
      cursor?: string;
      limit: number;
      include_all_metadata: boolean;
    };
    output: { messages: SlackHistoryMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
  };
  "conversations.replies": {
    input: {
      channel: string;
      ts: string;
      oldest: string;
      latest?: string;
      inclusive?: boolean;
      cursor?: string;
      limit: number;
      include_all_metadata: boolean;
    };
    output: { messages: SlackHistoryMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
  };
  "chat.update": {
    input: { channel: string; ts: string; text: string; blocks: unknown[] };
    output: { channel: string; ts: string };
  };
  "chat.postEphemeral": {
    input: { channel: string; user: string; text: string; thread_ts?: string };
    output: { message_ts: string };
  };
  "users.info": { input: { user: string }; output: { user: SlackUser } };
  "auth.revoke": { input: Record<string, never>; output: { revoked?: boolean } };
  "chat.postMessage": {
    input: {
      channel: string;
      text: string;
      blocks?: unknown[];
      thread_ts?: string;
      metadata?: { event_type: string; event_payload: { delivery_id: string } };
      unfurl_links?: boolean;
      unfurl_media?: boolean;
      parse?: "none";
    };
    output: { channel: string; ts: string; message?: { ts?: string } };
  };
  "chat.unfurl": {
    input: { channel: string; ts: string; unfurls: Record<string, unknown> };
    output: Record<string, never>;
  };
  "views.open": {
    input: { trigger_id: string; view: Record<string, unknown> };
    output: { view: { id: string; hash?: string } };
  };
  "views.update": {
    input: { view_id: string; view: Record<string, unknown>; hash?: string };
    output: { view: { id: string; hash?: string } };
  };
  "views.publish": {
    input: { user_id: string; view: Record<string, unknown>; hash?: string };
    output: { view: { id: string; hash?: string } };
  };
};

export type SlackHistoryMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  metadata?: { event_type?: string; event_payload?: { delivery_id?: string } };
  reactions?: Array<{ name?: string; count?: number }>;
  files?: Array<{ name?: string; title?: string; permalink?: string; url_private?: string }>;
  attachments?: Array<{ title?: string; title_link?: string }>;
};

export type SlackApiMethod = keyof SlackApiContracts;
const SLACK_READ_METHODS = new Set<SlackApiMethod>([
  "chat.getPermalink",
  "conversations.info",
  "conversations.list",
  "conversations.members",
  "conversations.history",
  "conversations.replies",
  "users.info",
]);

function normalizeScopes(scopes: string | readonly string[]) {
  return [
    ...new Set((typeof scopes === "string" ? scopes.split(",") : scopes).map((scope) => scope.trim()).filter(Boolean)),
  ].sort();
}

export function slackScopeHealth(scopes: string | readonly string[]) {
  const granted = normalizeScopes(scopes);
  const grantedSet = new Set(granted);
  const required = [...SLACK_BOT_SCOPES];
  const missing = required.filter((scope) => !grantedSet.has(scope));
  const capabilities = Object.fromEntries(
    Object.entries(SLACK_CAPABILITY_SCOPES).map(([capability, capabilityScopes]) => {
      const capabilityMissing = capabilityScopes.filter((scope) => !grantedSet.has(scope));
      return [
        capability,
        {
          available: capabilityMissing.length === 0,
          requiredScopes: [...capabilityScopes],
          missingScopes: capabilityMissing,
        } satisfies SlackCapabilityHealth,
      ];
    }),
  ) as Record<SlackCapability, SlackCapabilityHealth>;
  return { required, granted, missing, reauthorizationRequired: missing.length > 0, capabilities };
}

function configured(env: Env) {
  return Boolean(
    env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET && env.SLACK_TOKEN_ENCRYPTION_KEY,
  );
}

export function slackConfigurationStatus(env: Env) {
  return {
    available: configured(env),
    missing: [
      ["SLACK_CLIENT_ID", env.SLACK_CLIENT_ID],
      ["SLACK_CLIENT_SECRET", env.SLACK_CLIENT_SECRET],
      ["SLACK_SIGNING_SECRET", env.SLACK_SIGNING_SECRET],
      ["SLACK_TOKEN_ENCRYPTION_KEY", env.SLACK_TOKEN_ENCRYPTION_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name!),
  };
}

export async function slackIdentityAvailability(env: Env) {
  if (!configured(env)) return false;
  const installation = await env.DB.prepare(
    `SELECT installation.scopes
       FROM install_state state
       JOIN slack_installations installation ON installation.workspace_id = state.workspace_id
      WHERE state.id = 1 AND installation.disconnected_at IS NULL`,
  ).first<{ scopes: string }>();
  return Boolean(installation && slackScopeHealth(installation.scopes).capabilities.identity.available);
}

function requireSlackConfiguration(env: Env) {
  if (!configured(env)) throw new HttpError(503, "slack_unavailable", "Slack is not configured for this installation.");
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hexDigest(value: string) {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(env: Env) {
  requireSlackConfiguration(env);
  return crypto.subtle.importKey("raw", await sha256(env.SLACK_TOKEN_ENCRYPTION_KEY!), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSlackToken(env: Env, token: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await encryptionKey(env),
      new TextEncoder().encode(token),
    ),
  );
  return `${TOKEN_VERSION}.${bytesToBase64Url(nonce)}.${bytesToBase64Url(ciphertext)}`;
}

export async function decryptSlackToken(env: Env, ciphertext: string) {
  const [version, rawNonce, rawCiphertext] = ciphertext.split(".");
  if (version !== TOKEN_VERSION || !rawNonce || !rawCiphertext)
    throw new Error("The Slack token ciphertext is invalid.");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(rawNonce) },
    await encryptionKey(env),
    base64UrlToBytes(rawCiphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function createSlackOAuthUrl(env: Env, member: MemberContext) {
  requireSlackConfiguration(env);
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
  const payload = `${nonce}.${expiresAt}`;
  const state = `${payload}.${bytesToBase64Url(await hmacSha256(env.BETTER_AUTH_SECRET, payload))}`;
  const current = await env.DB.prepare(`SELECT team_id FROM slack_installations WHERE workspace_id = ?`)
    .bind(member.workspace.id)
    .first<{ team_id: string }>();
  await env.DB.prepare(
    `INSERT INTO slack_oauth_states
      (nonce_hash, workspace_id, user_id, expires_at, created_at, expected_team_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(await hexDigest(nonce), member.workspace.id, member.user.id, expiresAt, Date.now(), current?.team_id ?? null)
    .run();
  const redirectUri = `${env.BETTER_AUTH_URL}/api/slack/oauth/callback`;
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", env.SLACK_CLIENT_ID!);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.href;
}

async function consumeOAuthState(env: Env, member: MemberContext, state: string) {
  const pieces = state.split(".");
  if (pieces.length !== 3) throw new HttpError(422, "invalid_slack_state", "Slack authorization state is invalid.");
  const [nonce, rawExpiry, signature] = pieces as [string, string, string];
  const expiresAt = Number(rawExpiry);
  const expected = bytesToBase64Url(await hmacSha256(env.BETTER_AUTH_SECRET, `${nonce}.${rawExpiry}`));
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || !constantTimeEqual(signature, expected)) {
    throw new HttpError(422, "invalid_slack_state", "Slack authorization state is invalid or expired.");
  }
  const consumed = await env.DB.prepare(
    `UPDATE slack_oauth_states SET used_at = ? WHERE nonce_hash = ? AND workspace_id = ? AND user_id = ?
      AND used_at IS NULL AND expires_at >= ? RETURNING expected_team_id`,
  )
    .bind(Date.now(), await hexDigest(nonce), member.workspace.id, member.user.id, Date.now())
    .first<{ expected_team_id: string | null }>();
  if (!consumed) throw new HttpError(409, "slack_state_used", "Slack authorization state was already used.");
  return consumed.expected_team_id;
}

export async function finishSlackOAuth(env: Env, member: MemberContext, code: string, state: string) {
  requireSlackConfiguration(env);
  const expectedTeamId = await consumeOAuthState(env, member, state);
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: `${env.BETTER_AUTH_URL}/api/slack/oauth/callback`,
    }),
    signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
  }).catch((error: unknown) => {
    if (isTimeoutAbort(error)) throw new HttpError(502, "slack_unavailable", "Slack did not respond in time.");
    throw error;
  });
  const result = await response.json<{
    ok?: boolean;
    error?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  }>();
  if (!response.ok || !result.ok || !result.access_token || !result.team?.id || !result.bot_user_id) {
    throw new HttpError(502, "slack_oauth_failed", `Slack authorization failed (${result.error ?? response.status}).`);
  }
  let stored = false;
  try {
    if (expectedTeamId && expectedTeamId !== result.team.id) {
      throw new HttpError(
        409,
        "slack_team_mismatch",
        "This NoteFlare workspace is already bound to a different Slack workspace.",
      );
    }
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO slack_installations
        (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext,
         bot_refresh_token_ciphertext, token_expires_at, scopes,
         installed_by, disconnected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET team_id = excluded.team_id, team_name = excluded.team_name,
         bot_user_id = excluded.bot_user_id, bot_token_ciphertext = excluded.bot_token_ciphertext,
         bot_refresh_token_ciphertext = excluded.bot_refresh_token_ciphertext,
         token_expires_at = excluded.token_expires_at,
         scopes = excluded.scopes, installed_by = excluded.installed_by, disconnected_at = NULL,
         auth_error = NULL, auth_error_at = NULL, file_scope_error_revision=NULL,
         credential_revision = slack_installations.credential_revision + 1,
         auth_paused_ms = slack_installations.auth_paused_ms +
           CASE WHEN slack_installations.auth_error_at IS NULL THEN 0
             ELSE MAX(0, excluded.updated_at - slack_installations.auth_error_at) END,
         updated_at = excluded.updated_at`,
    )
      .bind(
        id,
        member.workspace.id,
        result.team.id,
        result.team.name ?? "Slack workspace",
        result.bot_user_id,
        await encryptSlackToken(env, result.access_token),
        result.refresh_token ? await encryptSlackToken(env, result.refresh_token) : null,
        result.expires_in ? timestamp + result.expires_in * 1000 : null,
        result.scope ?? "",
        member.user.id,
        timestamp,
        timestamp,
      )
      .run();
    stored = true;
    const grantedScopes = JSON.stringify(normalizeScopes(result.scope ?? ""));
    const notificationScopes = (channelType: string | null) =>
      JSON.stringify(
        slackScopeRequirements(
          env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" ? "slack_digest" : "slack_channel",
          undefined,
          [],
          channelType,
        ),
      );
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET notification_blocked_at=NULL,notification_error=NULL
      WHERE installation_id IN (SELECT id FROM slack_installations WHERE workspace_id=? AND disconnected_at IS NULL AND auth_error IS NULL)
      AND (notification_error IN (SELECT value FROM json_each(?)) OR (notification_error='missing_scope' AND ${slackScopesGrantedSql("CASE WHEN mirror_enabled=1 THEN ? ELSE CASE channel_type WHEN 'public_channel' THEN ? WHEN 'private_channel' THEN ? ELSE ? END END", "?")}))`)
      .bind(
        member.workspace.id,
        JSON.stringify([...INSTALLATION_ERRORS]),
        JSON.stringify(SLACK_MIRROR_SCOPES.map((scope) => [scope])),
        notificationScopes("public_channel"),
        notificationScopes("private_channel"),
        notificationScopes(null),
        grantedScopes,
      )
      .run();
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET
      validation_error=CASE WHEN validation_scope_error_revision IS NOT NULL AND validation_error='missing_scope' THEN NULL ELSE validation_error END,
      validated_at=CASE WHEN validation_scope_error_revision IS NOT NULL THEN NULL ELSE validated_at END,
      validation_scope_error_revision=NULL WHERE validation_scope_error_revision IS NOT NULL AND installation_id IN (SELECT id FROM slack_installations WHERE workspace_id=?)`)
      .bind(member.workspace.id)
      .run();
    await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='sending',failure_reason=NULL,updated_at=?
      WHERE state='blocked' AND failure_reason LIKE 'reconciliation_%'
        AND link_id IN (SELECT link.id FROM slack_thread_links link
          JOIN slack_installations installation ON installation.id=link.installation_id
          JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
          WHERE installation.workspace_id=? AND installation.disconnected_at IS NULL
            AND link.state IN ('pending','active') AND mapping.mirror_enabled=1)
        AND NOT EXISTS(SELECT value FROM json_each(?) required WHERE required.value NOT IN (SELECT value FROM json_each(?)))`)
      .bind(timestamp, member.workspace.id, JSON.stringify(SLACK_MIRROR_SCOPES), grantedScopes)
      .run();
    await env.DB.prepare(`UPDATE outbox SET
      attempts=attempts+CASE WHEN ${ROUND2_OUTBOX_SQL} OR topic='slack_share_response' THEN 1 ELSE 0 END,
      slack_scope_paused_ms=slack_scope_paused_ms+MAX(0,?-slack_scope_paused_at),
      slack_scope_paused_at=NULL,slack_scope_required_json=NULL,
      slack_redrive_count=CASE WHEN ${ROUND2_OUTBOX_SQL} OR topic='slack_share_response' THEN slack_redrive_count ELSE 0 END,
      enqueued_at=NULL,available_at=?,slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL
      WHERE workspace_id=? AND slack_scope_paused_at IS NOT NULL
        AND (topic<>'slack_share_response' OR ${PENDING_SHARE_RESPONSE_SQL}) AND ${slackScopesGrantedSql(SLACK_PAUSED_SCOPES_SQL, "?")}`)
      .bind(timestamp, timestamp, member.workspace.id, grantedScopes)
      .run();
    await env.DB.prepare(`UPDATE outbox SET attempts=attempts+CASE WHEN ${ROUND2_OUTBOX_SQL} OR topic='slack_share_response' THEN 1 ELSE 0 END,enqueued_at=NULL,available_at=?,slack_redrive_due_at=NULL
      WHERE workspace_id=? AND slack_scope_paused_at IS NULL AND
        (((topic IN ('slack_thread_reply','slack_inbound_reply','slack_thread_action','slack_workspace_action','slack_unfurl','slack_share_response') OR topic IN (${ROUND2_NON_CHANNEL_TOPICS_SQL}))
          AND (topic<>'slack_share_response' OR ${PENDING_SHARE_RESPONSE_SQL})
          AND (topic='slack_share_response' OR slack_redrive_due_at IS NOT NULL OR id IN
            (SELECT 'outbox:' || d.id FROM slack_thread_deliveries d WHERE d.state='sending')))
        OR (topic='slack_channel' AND EXISTS (SELECT 1 FROM slack_channel_events event
          WHERE event.id=outbox.slack_round2_receipt_id
            AND event.delivered_at IS NULL AND event.suppressed_at IS NULL)))`)
      .bind(timestamp, member.workspace.id)
      .run();
    try {
      await resumeSlackFileCleanup(env, member.workspace.id);
    } catch (error) {
      logger.warn(
        "slack.file_cleanup.resume_failed",
        "slack",
        "Slack credentials saved; cleanup resumption needs retry",
        { workspaceId: member.workspace.id },
        error,
      );
    }
  } finally {
    if (!stored) await revokeRejectedOAuthTokens(result.team.id, result.access_token, result.refresh_token);
  }
}

async function revokeRejectedOAuthTokens(teamId: string, accessToken: string, refreshToken?: string) {
  for (const [kind, token] of [
    ["access", accessToken],
    ["refresh", refreshToken],
  ] as const) {
    if (!token) continue;
    try {
      const response = await fetch("https://slack.com/api/auth.revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
      });
      const result = await response.json<{ ok?: boolean; revoked?: boolean }>();
      if (!response.ok || !result.ok || !result.revoked) throw new Error("Slack did not confirm token revocation.");
    } catch (error) {
      logger.warn(
        "slack.oauth_reject_revoke.failed",
        "slack",
        "Failed to revoke a rejected Slack OAuth token.",
        { teamId, tokenKind: kind },
        error,
      );
    }
  }
}

export async function disconnectSlack(env: Env, member: MemberContext) {
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE workspace_id = ? AND disconnected_at IS NULL`,
  )
    .bind(member.workspace.id)
    .first<SlackInstallation>();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
      (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
      SELECT delivery.id,link.workspace_id,COALESCE(link.subscription_id,'orphan:' || link.id),
        COALESCE(NULLIF(mapping.channel_name,''),link.channel_id),'disconnect_unconfirmed',?
      FROM slack_thread_deliveries delivery JOIN slack_thread_links link ON link.id=delivery.link_id
      LEFT JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
      WHERE link.workspace_id=? AND (delivery.state='sending' OR
        (delivery.state='blocked' AND delivery.failure_reason LIKE 'reconciliation_%'))`).bind(
      Date.now(),
      member.workspace.id,
    ),
    env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',updated_at=?,
      failure_reason=CASE WHEN state IN ('sending','blocked') THEN 'disconnect_unconfirmed' ELSE 'disconnected' END
      WHERE link_id IN (SELECT id FROM slack_thread_links WHERE workspace_id=?)
        AND (state IN ('pending','sending') OR
          (state='blocked' AND failure_reason LIKE 'reconciliation_%'))`).bind(Date.now(), member.workspace.id),
    env.DB.prepare(
      `UPDATE slack_installations SET generation = generation + 1, disconnected_at = ?, updated_at = ? WHERE workspace_id = ? AND disconnected_at IS NULL`,
    ).bind(Date.now(), Date.now(), member.workspace.id),
    env.DB.prepare(
      `UPDATE slack_channel_subscriptions SET mirror_enabled = 0, validation_state = 'unvalidated' WHERE installation_id IN (SELECT id FROM slack_installations WHERE workspace_id = ?)`,
    ).bind(member.workspace.id),
    env.DB.prepare(`UPDATE slack_thread_links SET state = 'retired' WHERE workspace_id = ?`).bind(member.workspace.id),
    env.DB.prepare(
      `DELETE FROM slack_primary_factor_proofs WHERE team_id IN (SELECT team_id FROM slack_installations WHERE workspace_id = ?)`,
    ).bind(member.workspace.id),
    env.DB.prepare(
      `UPDATE slack_user_links SET migration_state = 'legacy', verification_method = 'legacy_command', verified_at = NULL WHERE installation_id IN (SELECT id FROM slack_installations WHERE workspace_id = ?)`,
    ).bind(member.workspace.id),
  ]);
  if (installation) {
    try {
      await slackApi(env, installation, "auth.revoke", {});
    } catch (error) {
      logger.error(
        "slack.token_revoke.failed",
        "slack",
        "Slack token revocation failed during disconnect.",
        { workspaceId: member.workspace.id },
        error,
      );
      recordMetric(env, {
        event: "integration.call",
        component: "slack",
        operation: "token_revoke",
        outcome: "failure",
      });
    }
  }
  await env.DB.prepare(
    `UPDATE slack_installations SET bot_token_ciphertext = '', bot_refresh_token_ciphertext = NULL,
      token_expires_at = NULL, disconnected_at = ?, updated_at = ?
      WHERE workspace_id = ? AND disconnected_at IS NOT NULL`,
  )
    .bind(Date.now(), Date.now(), member.workspace.id)
    .run();
}

export async function slackWorkspaceStatus(env: Env, member: MemberContext) {
  const installation = await env.DB.prepare(
    `SELECT id, team_id, team_name, bot_user_id, scopes, disconnected_at, created_at, updated_at, auth_error, auth_error_at,file_scope_error_revision,
      EXISTS(SELECT 1 FROM outbox work WHERE work.workspace_id=slack_installations.workspace_id
        AND work.slack_scope_paused_at IS NOT NULL) scope_work_paused
       FROM slack_installations WHERE workspace_id = ?`,
  )
    .bind(member.workspace.id)
    .first<{
      id: string;
      team_id: string;
      team_name: string;
      bot_user_id: string;
      scopes: string;
      disconnected_at: number | null;
      created_at: number;
      updated_at: number;
      auth_error: string | null;
      auth_error_at: number | null;
      scope_work_paused: number;
      file_scope_error_revision: number | null;
    }>();
  const link = installation
    ? await env.DB.prepare(
        `SELECT slack_user_id, migration_state, verified_at,
          EXISTS(SELECT 1 FROM slack_authorized_user_links authorized WHERE authorized.installation_id=slack_user_links.installation_id AND authorized.user_id=slack_user_links.user_id) access_authorized
           FROM slack_user_links WHERE installation_id = ? AND user_id = ?`,
      )
        .bind(installation.id, member.user.id)
        .first<{
          slack_user_id: string;
          migration_state: "legacy" | "verified";
          verified_at: number | null;
          access_authorized: number;
        }>()
    : null;
  const scopeHealth = installation ? slackScopeHealth(installation.scopes) : null;
  const connected = installation?.disconnected_at === null;
  const identityState = link?.migration_state ?? "unlinked";
  return {
    ...slackConfigurationStatus(env),
    round2: {
      channels: env.SLACK_CHANNEL_VALIDATION_ENABLED === "true",
      shares: env.SLACK_SHARE_REFRESH_ENABLED === "true",
      richDigests: env.SLACK_RICH_DIGESTS_ENABLED === "true",
      defaultTimezone: env.SLACK_DIGEST_DEFAULT_TIMEZONE ?? null,
    },
    installation: installation
      ? {
          teamId: installation.team_id,
          teamName: installation.team_name,
          botUserId: installation.bot_user_id,
          scopes: scopeHealth!.granted,
          connected,
          createdAt: installation.created_at,
          updatedAt: installation.updated_at,
          authError: installation.auth_error,
          authErrorAt: installation.auth_error_at,
          scopeHealth: {
            required: scopeHealth!.required,
            granted: scopeHealth!.granted,
            missing: scopeHealth!.missing,
            reauthorizationRequired: scopeHealth!.reauthorizationRequired,
          },
          capabilities: Object.fromEntries(
            Object.entries(scopeHealth!.capabilities).map(([name, health]) => [
              name,
              {
                ...health,
                available:
                  connected &&
                  health.available &&
                  (name !== "files" || installation.file_scope_error_revision === null),
              },
            ]),
          ) as Record<SlackCapability, SlackCapabilityHealth>,
        }
      : null,
    linked: Boolean(link),
    identity: {
      state: identityState,
      slackUserId: link?.slack_user_id ?? null,
      verifiedAt: link?.verified_at ?? null,
      accessAuthorized: !!link?.access_authorized,
      reauthorizationRequired: Boolean(link && !link.access_authorized),
    },
    reauthorization: {
      required: Boolean(
        connected &&
        (scopeHealth?.reauthorizationRequired ||
          installation?.auth_error ||
          installation?.scope_work_paused ||
          installation?.file_scope_error_revision !== null),
      ),
      available: configured(env),
    },
  } satisfies SlackStatus;
}

export async function listSlackChannelSubscriptions(
  env: Env,
  member: MemberContext,
): Promise<SlackChannelSubscription[]> {
  const rows = await env.DB.prepare(
    `SELECT subscription.id, subscription.space_id, subscription.page_id, subscription.channel_id,
            subscription.channel_name, subscription.event_types_json, subscription.cadence,
            subscription.digest_time,subscription.digest_timezone,subscription.digest_open_work,subscription.digest_not_before,
            subscription.channel_type, subscription.validation_state, subscription.validated_at,
            subscription.validation_error, subscription.bot_is_member, subscription.mirror_enabled,
            subscription.muted_at, subscription.snoozed_until,
            subscription.notification_blocked_at, subscription.notification_error, subscription.controls_error,
            (SELECT COUNT(*) FROM slack_thread_deliveries d JOIN slack_thread_links l ON l.id=d.link_id
              WHERE l.subscription_id=subscription.id AND l.state IN ('pending','active')
                AND (d.state='blocked' OR (d.state='sending' AND
                  d.attempted_at<=unixepoch('subsec')*1000-60000)))
            + (SELECT count(*) FROM slack_digest_receipts r WHERE r.subscription_id=subscription.id AND (r.state='blocked' OR (r.state='sending' AND r.attempted_at<=unixepoch('subsec')*1000-60000)))
            + (SELECT count(*) FROM slack_channel_events e WHERE e.subscription_id=subscription.id AND (e.round2_state='blocked' OR (e.round2_state='sending' AND e.attempted_at<=unixepoch('subsec')*1000-60000)))
            + (SELECT count(*) FROM slack_share_refreshes r WHERE r.installation_id=installation.id AND r.channel_id=subscription.channel_id AND (r.state='blocked' OR (r.state='sending' AND r.attempted_at<=unixepoch('subsec')*1000-60000)))
            + (SELECT count(*) FROM slack_bulk_receipts r WHERE r.installation_id=installation.id AND r.channel_id=subscription.channel_id AND (r.state='blocked' OR (r.state='sending' AND r.attempted_at<=unixepoch('subsec')*1000-60000))) blocked_deliveries,
            (SELECT COUNT(*) FROM slack_thread_deliveries d JOIN slack_thread_links l ON l.id=d.link_id
              WHERE l.subscription_id=subscription.id AND l.state IN ('pending','active') AND d.state='pending'
                AND EXISTS (SELECT 1 FROM slack_thread_deliveries prior
                  WHERE prior.link_id=d.link_id AND prior.id<>d.id
                    AND prior.state IN ('pending','sending','blocked') AND
                    (prior.operation='root' OR (d.operation='reply' AND prior.operation='reply' AND
                      (prior.created_at<d.created_at OR
                        (prior.created_at=d.created_at AND prior.id<d.id)))))) waiting_deliveries,
            (SELECT COUNT(*) FROM slack_delivery_failures failure WHERE failure.subscription_id=subscription.id
              AND failure.workspace_id=installation.workspace_id AND failure.acknowledged_at IS NULL) failed_deliveries,
            subscription.created_at, subscription.updated_at
       FROM slack_channel_subscriptions subscription
       JOIN slack_installations installation ON installation.id = subscription.installation_id
      WHERE installation.workspace_id = ? AND installation.disconnected_at IS NULL
      ORDER BY lower(subscription.channel_name), subscription.channel_id, subscription.id`,
  )
    .bind(member.workspace.id)
    .all<{
      id: string;
      space_id: string;
      page_id: string | null;
      channel_id: string;
      channel_name: string;
      event_types_json: string;
      cadence: "immediate" | "digest";
      digest_time: string;
      digest_timezone: string | null;
      digest_open_work: number;
      digest_not_before: number;
      channel_type: "public_channel" | "private_channel" | "im" | "mpim" | null;
      validation_state: "unvalidated" | "valid" | "invalid";
      validated_at: number | null;
      validation_error: string | null;
      bot_is_member: number | null;
      mirror_enabled: number;
      blocked_deliveries: number;
      waiting_deliveries: number;
      failed_deliveries: number;
      muted_at: number | null;
      snoozed_until: number | null;
      notification_blocked_at: number | null;
      notification_error: string | null;
      controls_error: string | null;
      created_at: number;
      updated_at: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    pageId: row.page_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    eventTypes: JSON.parse(row.event_types_json) as ChannelEventType[],
    cadence: row.cadence,
    digestTime: row.digest_time,
    digestTimezone: row.digest_timezone,
    digestOpenWork: Boolean(row.digest_open_work),
    nextDigestAt: (() => {
      try {
        return row.cadence === "digest" && row.digest_timezone && !row.muted_at
          ? digestWindow(Math.max(Date.now(), row.snoozed_until ?? 0), row.digest_time, row.digest_timezone).next
          : null;
      } catch {
        return null;
      }
    })(),
    channelType: row.channel_type,
    validationState: row.validation_state,
    validatedAt: row.validated_at,
    validationError: row.validation_error,
    botIsMember: row.bot_is_member === null ? null : Boolean(row.bot_is_member),
    mirrorEnabled: Boolean(row.mirror_enabled),
    blockedDeliveries: row.blocked_deliveries,
    waitingDeliveries: row.waiting_deliveries,
    failedDeliveries: row.failed_deliveries,
    mutedAt: row.muted_at,
    snoozedUntil: row.snoozed_until,
    notificationBlockedAt: row.notification_blocked_at,
    notificationError: row.notification_error,
    controlsError: row.controls_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listSlackDeliveryFailureGroups(env: Env, member: MemberContext) {
  if (member.role !== "owner")
    throw new HttpError(403, "owner_required", "Only an owner can view Slack delivery health.");
  const rows = await env.DB.prepare(`SELECT failure.subscription_id id,
    MAX(failure.channel_name) channel_name,COUNT(*) failures
    FROM slack_delivery_failures failure
    LEFT JOIN slack_channel_subscriptions mapping ON mapping.id=failure.subscription_id
    LEFT JOIN slack_installations installation ON installation.id=mapping.installation_id
    WHERE failure.workspace_id=? AND failure.acknowledged_at IS NULL
      AND (mapping.id IS NULL OR installation.disconnected_at IS NOT NULL)
    GROUP BY failure.subscription_id ORDER BY channel_name,id`)
    .bind(member.workspace.id)
    .all<{ id: string; channel_name: string; failures: number }>();
  return rows.results.map((row) => ({ id: row.id, channelName: row.channel_name, failedDeliveries: row.failures }));
}

export async function acknowledgeSlackDeliveryFailures(env: Env, member: MemberContext, mappingId: string) {
  if (member.role !== "owner")
    throw new HttpError(403, "owner_required", "Only an owner can clear Slack delivery health.");
  await env.DB.prepare(`UPDATE slack_delivery_failures SET acknowledged_at=?
    WHERE workspace_id=? AND subscription_id=? AND acknowledged_at IS NULL
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`)
    .bind(Date.now(), member.workspace.id, mappingId, member.workspace.id, member.user.id)
    .run();
}

export async function upsertSlackChannelSubscription(
  env: Env,
  member: MemberContext,
  input: {
    spaceId: string;
    pageId: string | null;
    channelId: string;
    channelName: string;
    eventTypes: Array<ChannelEventType | NotificationEventType>;
    cadence: "immediate" | "digest";
    mappingId?: string;
    digestTime?: string | undefined;
    digestTimezone?: string | undefined;
    digestOpenWork?: boolean;
  },
) {
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE workspace_id = ? AND disconnected_at IS NULL`,
  )
    .bind(member.workspace.id)
    .first<SlackInstallation>();
  if (!installation) throw new HttpError(409, "slack_not_connected", "Connect Slack before adding a channel.");
  const strict = env.SLACK_CHANNEL_VALIDATION_ENABLED === "true";
  const existing = await env.DB.prepare(
    `SELECT id,channel_id,channel_name,cadence,digest_timezone,digest_time,digest_open_work FROM slack_channel_subscriptions WHERE installation_id=?
      AND ((? IS NOT NULL AND id=?) OR (? IS NULL AND channel_id=? AND space_id=? AND ifnull(page_id,'')=ifnull(?,'')))`,
  )
    .bind(
      installation.id,
      input.mappingId ?? null,
      input.mappingId ?? null,
      input.mappingId ?? null,
      input.channelId,
      input.spaceId,
      input.pageId,
    )
    .first<{
      id: string;
      channel_id: string;
      channel_name: string;
      cadence: string;
      digest_timezone: string | null;
      digest_time: string;
      digest_open_work: number;
    }>();
  const changedDestination = !existing || existing.channel_id !== input.channelId;
  const channel = strict && changedDestination ? await validatedSlackChannel(env, installation, input.channelId) : null;
  const duplicate = await env.DB.prepare(
    `SELECT id FROM slack_channel_subscriptions WHERE installation_id=? AND channel_id=? AND space_id=? AND ifnull(page_id,'')=ifnull(?,'') AND id<>?`,
  )
    .bind(installation.id, input.channelId, input.spaceId, input.pageId, existing?.id ?? input.mappingId ?? "")
    .first();
  if (duplicate)
    throw new HttpError(409, "slack_mapping_exists", "This channel already has a mapping for that destination.");
  if (strict && input.cadence === "digest" && (existing?.cadence !== "digest" || !existing.digest_timezone))
    defaultDigestTimezone(env);
  const zone =
    input.digestTimezone ??
    existing?.digest_timezone ??
    (strict && env.SLACK_DIGEST_DEFAULT_TIMEZONE ? defaultDigestTimezone(env) : null);
  const time = input.digestTime ?? existing?.digest_time ?? "09:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new HttpError(422, "invalid_digest_schedule", "Choose a daily time between 00:00 and 23:59.");
  if (zone) digestWindow(Date.now(), time, zone);
  const id = input.mappingId ?? existing?.id ?? crypto.randomUUID();
  const timestamp = Date.now();
  const saved = await env.DB.prepare(
    `INSERT INTO slack_channel_subscriptions
      (id, installation_id, space_id, page_id, channel_id, channel_name, event_types_json, cadence,
       created_by, created_at, updated_at,digest_time,digest_timezone,digest_open_work,digest_not_before,round2_initialized)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')
       AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)
     ON CONFLICT(id) DO UPDATE SET channel_name = excluded.channel_name,channel_id=excluded.channel_id,
       space_id=excluded.space_id,page_id=excluded.page_id,event_types_json = excluded.event_types_json, cadence = excluded.cadence,
       validation_state=CASE WHEN channel_id<>excluded.channel_id THEN 'unvalidated' ELSE validation_state END,
       validation_error=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE validation_error END,
       validation_scope_error_revision=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE validation_scope_error_revision END,
       notification_error=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE notification_error END,
       notification_blocked_at=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE notification_blocked_at END,
       validated_at=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE validated_at END,
       bot_is_member=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE bot_is_member END,
       channel_type=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE channel_type END,
       controls_error=CASE WHEN channel_id<>excluded.channel_id THEN NULL ELSE controls_error END,
       digest_not_before=CASE WHEN channel_id<>excluded.channel_id OR space_id<>excluded.space_id OR page_id IS NOT excluded.page_id OR digest_timezone IS NOT excluded.digest_timezone OR digest_time<>excluded.digest_time OR cadence<>excluded.cadence THEN excluded.updated_at ELSE digest_not_before END,
       digest_time=excluded.digest_time,digest_timezone=excluded.digest_timezone,digest_open_work=excluded.digest_open_work,updated_at=excluded.updated_at
       WHERE installation_id=excluded.installation_id AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`,
  )
    .bind(
      id,
      installation.id,
      input.spaceId,
      input.pageId,
      input.channelId,
      channel?.name ?? (strict && !changedDestination ? existing!.channel_name : input.channelName),
      JSON.stringify(input.eventTypes),
      input.cadence,
      member.user.id,
      timestamp,
      timestamp,
      time,
      zone,
      input.digestOpenWork === undefined ? (existing?.digest_open_work ?? 1) : input.digestOpenWork ? 1 : 0,
      timestamp,
      strict ? 1 : 0,
      member.workspace.id,
      member.user.id,
      installation.id,
      installation.generation,
      member.workspace.id,
      member.user.id,
    )
    .run()
    .catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed"))
        throw new HttpError(409, "slack_mapping_exists", "This channel already has a mapping for that destination.");
      throw error;
    });
  if (!saved.meta.changes)
    throw new HttpError(403, "owner_required", "Only a current owner can change Slack mappings.");
  if (channel)
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET channel_name=?,channel_type=?,validation_state='valid',validation_error=NULL,
    bot_is_member=1,validated_at=?,notification_blocked_at=NULL,notification_error=NULL WHERE id=? AND installation_id=? AND channel_id=? AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)`)
      .bind(
        channel.name,
        channel.is_private ? "private_channel" : "public_channel",
        Date.now(),
        id,
        installation.id,
        input.channelId,
        installation.id,
        installation.generation,
      )
      .run();
  return (await listSlackChannelSubscriptions(env, member)).find((subscription) => subscription.id === id)!;
}

export async function repairSlackChannelNotifications(env: Env, member: MemberContext, subscriptionId: string) {
  if (member.role !== "owner")
    throw new HttpError(403, "owner_required", "Only an owner can repair Slack notifications.");
  const row =
    await env.DB.prepare(`SELECT mapping.channel_id,mapping.created_by mapping_owner_id,mapping.notification_blocked_at,mapping.notification_error,installation.* FROM slack_channel_subscriptions mapping
    JOIN slack_installations installation ON installation.id=mapping.installation_id
    JOIN workspace_members owner ON owner.workspace_id=installation.workspace_id AND owner.user_id=? AND owner.role='owner'
    WHERE mapping.id=? AND installation.workspace_id=? AND installation.disconnected_at IS NULL`)
      .bind(member.user.id, subscriptionId, member.workspace.id)
      .first<
        SlackInstallation & {
          channel_id: string;
          mapping_owner_id: string;
          notification_blocked_at: number | null;
          notification_error: string | null;
        }
      >();
  if (!row) throw new HttpError(404, "slack_channel_not_found", "Slack channel mapping not found.");
  const { channel } = await slackApi(env, row, "conversations.info", { channel: row.channel_id });
  // One-way notifications can use shared channels even though mirrors cannot.
  if (
    !channel ||
    channel.id !== row.channel_id ||
    (!channel.is_channel && !channel.is_group) ||
    channel.is_im ||
    channel.is_mpim ||
    !channel.is_member ||
    channel.is_archived
  )
    throw new HttpError(403, "slack_channel_unavailable", "The Slack bot needs access to this channel.");
  const now = Date.now();
  const fence = `id=? AND installation_id=? AND channel_id=? AND created_by=? AND notification_blocked_at IS ? AND notification_error IS ? AND EXISTS (
    SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND credential_revision=? AND disconnected_at IS NULL)
    AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`;
  const binds = [
    subscriptionId,
    row.id,
    row.channel_id,
    row.mapping_owner_id,
    row.notification_blocked_at,
    row.notification_error,
    row.id,
    row.generation,
    row.credential_revision,
    member.workspace.id,
    member.user.id,
  ];
  const saved = await env.DB.batch([
    env.DB.prepare(`UPDATE slack_channel_events SET suppressed_at=?
      WHERE subscription_id=? AND delivered_at IS NULL AND suppressed_at IS NULL
      AND EXISTS(SELECT 1 FROM slack_channel_subscriptions WHERE ${fence} AND notification_blocked_at IS NOT NULL)`).bind(
      now,
      subscriptionId,
      ...binds,
    ),
    env.DB.prepare(`UPDATE slack_channel_subscriptions SET notification_blocked_at=NULL,notification_error=NULL,
      validation_scope_error_revision=NULL,validation_error=CASE WHEN validation_error='missing_scope' THEN NULL ELSE validation_error END,
      validated_at=CASE WHEN validation_scope_error_revision IS NOT NULL THEN NULL ELSE validated_at END,updated_at=? WHERE ${fence}`).bind(
      now,
      ...binds,
    ),
  ]);
  if (!saved[1]?.meta.changes)
    throw new HttpError(409, "slack_mapping_changed", "Slack configuration changed. Retry the repair.");
}

export async function deleteSlackChannelSubscription(env: Env, member: MemberContext, id: string) {
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
      (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
      SELECT delivery.id,link.workspace_id,?,COALESCE(NULLIF(mapping.channel_name,''),link.channel_id),
        'mapping_removed_unconfirmed',?
      FROM slack_thread_deliveries delivery JOIN slack_thread_links link ON link.id=delivery.link_id
      JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
      WHERE mapping.id=? AND link.workspace_id=? AND (delivery.state='sending' OR
        (delivery.state='blocked' AND delivery.failure_reason LIKE 'reconciliation_%'))
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`).bind(
      id,
      now,
      id,
      member.workspace.id,
      member.workspace.id,
      member.user.id,
    ),
    env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',updated_at=?,
      failure_reason=CASE WHEN state IN ('sending','blocked') THEN 'mapping_removed_unconfirmed' ELSE 'mapping_removed' END
      WHERE link_id IN (SELECT link.id FROM slack_thread_links link
        WHERE link.subscription_id=? AND link.workspace_id=?)
        AND (state IN ('pending','sending') OR
          (state='blocked' AND failure_reason LIKE 'reconciliation_%'))
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`).bind(
      now,
      id,
      member.workspace.id,
      member.workspace.id,
      member.user.id,
    ),
    env.DB.prepare(`DELETE FROM slack_channel_subscriptions WHERE id = ? AND installation_id IN
      (SELECT id FROM slack_installations WHERE workspace_id = ?)
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='owner')`).bind(
      id,
      member.workspace.id,
      member.workspace.id,
      member.user.id,
    ),
  ]);
  if (!result[2]!.meta.changes) throw new HttpError(404, "slack_channel_not_found", "Slack channel mapping not found.");
}

export function rootControlRefreshStatements(
  env: Env,
  mappingId: string,
  workspaceId: string,
  actorId: string,
  sourceId: string,
  now: number,
  linkId?: string,
) {
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO slack_thread_deliveries
      (id, link_id, operation, source_id, actor_id, created_at, updated_at)
      SELECT link.id || ':refresh:' || ?, link.id, 'refresh', ?, ?,
        MAX(?, COALESCE((SELECT MAX(prior.created_at)+1 FROM slack_thread_deliveries prior
          WHERE prior.link_id=link.id AND prior.operation='refresh'), ?)), ?
        FROM slack_thread_links link
        JOIN slack_channel_subscriptions mapping ON mapping.id = link.subscription_id
        JOIN slack_installations installation ON installation.id = mapping.installation_id
        JOIN pages page ON page.id = link.page_id AND page.archived_at IS NULL
       WHERE mapping.id = ? AND installation.workspace_id = ? AND installation.disconnected_at IS NULL
         AND link.installation_generation = installation.generation AND mapping.mirror_enabled = 1
         AND mapping.validation_state = 'valid' AND link.state = 'active' AND link.root_message_ts IS NOT NULL
         AND (? IS NULL OR link.id = ?)`).bind(
      sourceId,
      sourceId,
      actorId,
      now,
      now,
      now,
      mappingId,
      workspaceId,
      linkId ?? null,
      linkId ?? null,
    ),
    env.DB.prepare(`INSERT OR IGNORE INTO outbox
      (id, workspace_id, topic, payload_json, available_at, created_at)
      SELECT 'outbox:' || delivery.id, ?, 'slack_thread_reply',
        json_object('deliveryId', delivery.id), ?, ?
        FROM slack_thread_deliveries delivery
        JOIN slack_thread_links link ON link.id = delivery.link_id
       WHERE delivery.source_id = ? AND link.subscription_id = ? AND delivery.state = 'pending'`).bind(
      workspaceId,
      now,
      now,
      sourceId,
      mappingId,
    ),
  ];
}

export function slackPauseStatements(
  env: Env,
  mappingId: string,
  workspaceId: string,
  actorId: string,
  generation: number,
  mode: "mute" | "unmute" | "snooze",
  now: number,
  sourceId: string,
  hours?: 1 | 8 | 24,
) {
  const mutedAt = mode === "mute" ? now : null;
  const snoozedUntil = mode === "snooze" ? now + hours! * 3_600_000 : null;
  return [
    env.DB.prepare(`UPDATE slack_channel_subscriptions SET muted_at=?,snoozed_until=?,controls_error=NULL,updated_at=?
      WHERE id=? AND installation_id IN
        (SELECT id FROM slack_installations WHERE workspace_id=? AND generation=? AND disconnected_at IS NULL)`).bind(
      mutedAt,
      snoozedUntil,
      now,
      mappingId,
      workspaceId,
      generation,
    ),
    ...(mode === "unmute"
      ? [round2WakeStatement(env, mappingId, null, generation)]
      : [
          env.DB.prepare(`UPDATE slack_channel_events SET suppressed_at=?
      WHERE subscription_id=? AND delivered_at IS NULL AND suppressed_at IS NULL`).bind(now, mappingId),
        ]),
    ...rootControlRefreshStatements(env, mappingId, workspaceId, actorId, sourceId, now),
    ...(snoozedUntil === null
      ? []
      : [
          env.DB.prepare(`INSERT OR IGNORE INTO outbox
      (id,workspace_id,topic,payload_json,available_at,created_at)
      VALUES (?,?,'slack_controls_expire',?,?,?)`).bind(
            `outbox:slack-controls-expire:${sourceId}`,
            workspaceId,
            JSON.stringify({ mappingId, installationGeneration: generation, snoozedUntil }),
            snoozedUntil,
            now,
          ),
        ]),
  ];
}

export async function setSlackChannelPause(
  env: Env,
  member: MemberContext,
  id: string,
  mode: "mute" | "unmute" | "snooze",
  hours?: 1 | 8 | 24,
) {
  if (member.role !== "owner")
    throw new HttpError(403, "owner_required", "Only an owner can change Slack channel controls.");
  if (mode === "snooze" && hours !== 1 && hours !== 8 && hours !== 24)
    throw new HttpError(422, "invalid_snooze", "Choose 1, 8, or 24 hours.");
  const mapping = await env.DB.prepare(
    `SELECT mapping.id, mapping.muted_at, mapping.snoozed_until, installation.generation FROM slack_channel_subscriptions mapping
       JOIN slack_installations installation ON installation.id = mapping.installation_id
      WHERE mapping.id = ? AND installation.workspace_id = ? AND installation.disconnected_at IS NULL`,
  )
    .bind(id, member.workspace.id)
    .first<{ id: string; generation: number; muted_at: number | null; snoozed_until: number | null }>();
  if (!mapping) throw new HttpError(404, "slack_channel_not_found", "Slack channel mapping not found.");
  const now = Date.now();
  if (mode === "mute" && mapping.muted_at !== null && mapping.snoozed_until === null) return;
  if (mode === "unmute" && mapping.muted_at === null && (mapping.snoozed_until ?? 0) <= now) {
    return;
  }
  const sourceId = `settings:${crypto.randomUUID()}`;
  await env.DB.batch(
    slackPauseStatements(env, id, member.workspace.id, member.user.id, mapping.generation, mode, now, sourceId, hours),
  );
}

export async function deliverSlackControlsExpiry(env: Env, payload: Record<string, unknown>) {
  if (
    typeof payload.mappingId !== "string" ||
    typeof payload.installationGeneration !== "number" ||
    typeof payload.snoozedUntil !== "number"
  )
    return;
  const mapping = await env.DB.prepare(`SELECT installation.workspace_id,
      (SELECT owner.user_id FROM workspace_members owner
        WHERE owner.workspace_id=installation.workspace_id AND owner.role='owner'
        ORDER BY owner.user_id LIMIT 1) owner_id
    FROM slack_channel_subscriptions mapping
    JOIN slack_installations installation ON installation.id = mapping.installation_id
    WHERE mapping.id = ? AND installation.generation = ? AND installation.disconnected_at IS NULL
      AND mapping.snoozed_until = ? AND mapping.snoozed_until <= ?`)
    .bind(payload.mappingId, payload.installationGeneration, payload.snoozedUntil, Date.now())
    .first<{ workspace_id: string; owner_id: string | null }>();
  if (!mapping) return;
  if (!mapping.owner_id) {
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET controls_error='no_authorized_owner',updated_at=?
      WHERE id=? AND snoozed_until=?`)
      .bind(Date.now(), payload.mappingId, payload.snoozedUntil)
      .run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE slack_channel_subscriptions SET controls_error=NULL WHERE id=?`).bind(payload.mappingId),
    round2WakeStatement(env, payload.mappingId, null, payload.installationGeneration),
    ...rootControlRefreshStatements(
      env,
      payload.mappingId,
      mapping.workspace_id,
      mapping.owner_id,
      `expiry:${payload.mappingId}:${payload.snoozedUntil}`,
      Date.now(),
    ),
  ]);
}

export async function verifySlackRequest(env: Env, request: Request, body: string) {
  requireSlackConfiguration(env);
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const seconds = Number(timestamp);
  if (
    !/^v0=[a-f\d]{64}$/i.test(signature) ||
    !Number.isSafeInteger(seconds) ||
    Math.abs(Date.now() / 1000 - seconds) > REQUEST_WINDOW_SECONDS
  ) {
    throw new HttpError(401, "invalid_slack_signature", "Slack request signature is invalid.");
  }
  const expected = `v0=${Array.from(await hmacSha256(env.SLACK_SIGNING_SECRET!, `v0:${timestamp}:${body}`), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  if (!constantTimeEqual(signature.toLowerCase(), expected)) {
    throw new HttpError(401, "invalid_slack_signature", "Slack request signature is invalid.");
  }
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO slack_request_replays (signature, expires_at, created_at) VALUES (?, ?, ?)`,
  )
    .bind(signature.toLowerCase(), Date.now() + REQUEST_WINDOW_SECONDS * 1000, Date.now())
    .run();
  if (!inserted.meta.changes) {
    if (request.headers.has("x-slack-retry-num")) return { duplicate: true };
    throw new HttpError(409, "slack_replay", "This Slack request was already processed.");
  }
  return { duplicate: false };
}

async function activeInstallation(env: Env, teamId: string) {
  return env.DB.prepare(`SELECT * FROM slack_installations WHERE team_id = ? AND disconnected_at IS NULL`)
    .bind(teamId)
    .first<SlackInstallation>();
}

export async function usableBotToken(env: Env, installation: SlackInstallation, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (installation.token_expires_at === null || installation.token_expires_at > Date.now() + 60_000) {
    return decryptSlackToken(env, installation.bot_token_ciphertext);
  }
  if (!Number.isSafeInteger(installation.generation))
    throw new Error("Slack installation generation is unavailable for token refresh.");
  if (!installation.bot_refresh_token_ciphertext) {
    throw new SlackApiError("oauth.v2.access", "invalid_auth", 401, installation.credential_revision);
  }
  const oldCiphertext = installation.bot_token_ciphertext;
  const leaseToken = crypto.randomUUID();
  let claimed = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    signal?.throwIfAborted();
    const now = Date.now();
    const lease = await env.DB.prepare(`UPDATE slack_installations SET refresh_lease_token=?,refresh_lease_until=?
      WHERE id=? AND generation=? AND disconnected_at IS NULL AND bot_token_ciphertext=?
        AND (refresh_lease_token IS NULL OR refresh_lease_until<=?)`)
      .bind(leaseToken, now + 30_000, installation.id, installation.generation, oldCiphertext, now)
      .run();
    if (lease.meta.changes) {
      claimed = true;
      break;
    }
    const current = await env.DB.prepare(`SELECT * FROM slack_installations WHERE id=? AND disconnected_at IS NULL`)
      .bind(installation.id)
      .first<SlackInstallation>();
    if (!current || current.generation !== installation.generation)
      throw new Error("The Slack installation changed during token refresh.");
    if (current.bot_token_ciphertext !== oldCiphertext) {
      Object.assign(installation, current);
      return decryptSlackToken(env, current.bot_token_ciphertext);
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 1_000);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  if (!claimed) throw new Error("Slack token refresh is already in progress.");
  try {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID!,
        client_secret: env.SLACK_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: await decryptSlackToken(env, installation.bot_refresh_token_ciphertext),
      }),
      // Once Slack accepts a refresh token, persist its replacement even if the
      // caller's short acknowledgment deadline expires.
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
    });
    const result = await response.json<{
      ok?: boolean;
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>();
    if (!response.ok || !result.ok || !result.access_token) {
      if (result.error === "invalid_refresh_token") {
        // A worker from the previous deployment may still have won the refresh.
        for (let attempt = 0; attempt < 15; attempt++) {
          const current = await env.DB.prepare(
            `SELECT * FROM slack_installations WHERE id=? AND disconnected_at IS NULL`,
          )
            .bind(installation.id)
            .first<SlackInstallation>();
          if (current?.generation === installation.generation && current.bot_token_ciphertext !== oldCiphertext) {
            Object.assign(installation, current);
            return decryptSlackToken(env, current.bot_token_ciphertext);
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const error = new SlackApiError(
          "oauth.v2.access",
          "invalid_refresh_token",
          response.status,
          installation.credential_revision,
        );
        await recordSlackInstallationError(env, installation.id, error);
        throw error;
      }
      if (typeof result.error === "string" && INSTALLATION_ERRORS.has(result.error))
        throw new SlackApiError("oauth.v2.access", result.error, response.status, installation.credential_revision);
      throw new Error(`Slack token refresh failed (${result.error ?? response.status}).`);
    }
    const updatedAt = Date.now();
    const accessTokenCiphertext = await encryptSlackToken(env, result.access_token);
    const refreshTokenCiphertext = result.refresh_token
      ? await encryptSlackToken(env, result.refresh_token)
      : installation.bot_refresh_token_ciphertext;
    const expiresAt = result.expires_in ? updatedAt + result.expires_in * 1000 : null;
    const [before, updated] = await env.DB.batch([
      env.DB.prepare(
        `SELECT auth_error FROM slack_installations WHERE id=? AND generation=? AND bot_token_ciphertext=?`,
      ).bind(installation.id, installation.generation, oldCiphertext),
      env.DB.prepare(
        `UPDATE slack_installations SET bot_token_ciphertext = ?, bot_refresh_token_ciphertext = ?,
      token_expires_at = ?, updated_at = ?, refresh_lease_token=NULL, refresh_lease_until=NULL,
      auth_error=CASE WHEN auth_error IN ('missing_scope','account_inactive') THEN auth_error ELSE NULL END,
      auth_error_at=CASE WHEN auth_error IN ('missing_scope','account_inactive') THEN auth_error_at ELSE NULL END,
      auth_paused_ms=auth_paused_ms+CASE
        WHEN auth_error IN ('missing_scope','account_inactive') OR auth_error_at IS NULL THEN 0
        ELSE MAX(0,?-auth_error_at) END,
      credential_revision=credential_revision+1
      WHERE id = ? AND generation=? AND disconnected_at IS NULL AND bot_token_ciphertext = ?`,
      ).bind(
        accessTokenCiphertext,
        refreshTokenCiphertext,
        expiresAt,
        updatedAt,
        updatedAt,
        installation.id,
        installation.generation,
        installation.bot_token_ciphertext,
      ),
    ]);
    if (!updated!.meta.changes) {
      const current = await env.DB.prepare(`SELECT * FROM slack_installations WHERE id = ? AND disconnected_at IS NULL`)
        .bind(installation.id)
        .first<SlackInstallation>();
      if (!current || current.generation !== installation.generation)
        throw new Error("The Slack installation changed during token refresh.");
      if (current.bot_token_ciphertext === oldCiphertext) throw new Error("Slack token refresh was not persisted.");
      installation.bot_token_ciphertext = current.bot_token_ciphertext;
      installation.bot_refresh_token_ciphertext = current.bot_refresh_token_ciphertext;
      installation.token_expires_at = current.token_expires_at;
      installation.credential_revision = current.credential_revision;
      return decryptSlackToken(env, current.bot_token_ciphertext);
    }
    installation.bot_token_ciphertext = accessTokenCiphertext;
    installation.bot_refresh_token_ciphertext = refreshTokenCiphertext;
    installation.token_expires_at = expiresAt;
    installation.credential_revision += 1;
    const priorAuth = (before?.results[0] as { auth_error: string | null } | undefined)?.auth_error;
    if (priorAuth && !["missing_scope", "account_inactive"].includes(priorAuth)) {
      try {
        await round2WakeStatement(env, null, installation.id, installation.generation).run();
        await resumeSlackFileCleanup(env, installation.workspace_id);
        // Use the existing sweep message for this credential recovery event.
        await env.DELIVERY_QUEUE.send({ sweep: true });
      } catch (error) {
        logger.warn(
          "slack.auth_recovery.wake_failed",
          "slack",
          "Slack credentials saved; pending work will recover through maintenance",
          { installationId: installation.id },
          error,
        );
      }
    }
    return result.access_token;
  } finally {
    await env.DB.prepare(`UPDATE slack_installations SET refresh_lease_token=NULL,refresh_lease_until=NULL
      WHERE id=? AND refresh_lease_token=?`)
      .bind(installation.id, leaseToken)
      .run();
  }
}

export type SlackApiOptions<Method extends SlackApiMethod> = {
  timeoutMs?: number;
  signal?: AbortSignal;
  preparedToken?: string;
  beforeDispatch?: (() => Promise<void | SlackApiContracts[Method]["input"]>) | undefined;
  onDispatch?: () => void;
};

export async function slackApi<Method extends SlackApiMethod>(
  env: Env,
  installation: SlackInstallation,
  method: Method,
  payload: SlackApiContracts[Method]["input"],
  options: SlackApiOptions<Method> = {},
): Promise<SlackApiContracts[Method]["output"]> {
  const { timeoutMs = SLACK_FETCH_TIMEOUT_MS, signal, preparedToken, beforeDispatch, onDispatch } = options;
  const response = await traced(tracing, "notes.integration.slack", { "notes.operation": method }, async () => {
    const read = SLACK_READ_METHODS.has(method);
    const token =
      method === "auth.revoke"
        ? await decryptSlackToken(env, installation.bot_token_ciphertext)
        : (preparedToken ?? (await usableBotToken(env, installation, signal)));
    signal?.throwIfAborted();
    const dispatchPayload = (beforeDispatch ? await beforeDispatch() : undefined) ?? payload;
    const url = new URL(`https://slack.com/api/${method}`);
    if (read)
      for (const [key, value] of Object.entries(dispatchPayload))
        if (value !== undefined) url.searchParams.set(key, String(value));
    const init: RequestInit = {
      method: read ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(read ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(read ? {} : { body: JSON.stringify(dispatchPayload) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    };
    signal?.throwIfAborted();
    onDispatch?.();
    return fetch(url.toString(), init).catch((error: unknown) => {
      if (isTimeoutAbort(error)) throw new SlackApiError(method, "timeout", 504, installation.credential_revision);
      if (error instanceof TypeError)
        throw new SlackApiError(method, "network_error", 503, installation.credential_revision);
      throw error;
    });
  });
  const credentialRevision = installation.credential_revision;
  if (response.status === 429) {
    const raw = response.headers.get("retry-after")?.trim() ?? "";
    const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    const now = Date.now();
    const date = /^[A-Za-z]{3}, /.test(raw) ? Date.parse(raw) : NaN;
    const retryAt = Number.isFinite(seconds)
      ? now + Math.max(1, seconds) * 1000
      : Number.isFinite(date)
        ? Math.max(now + 1000, date)
        : now + 1000;
    throw new SlackRateLimitError(Math.max(1, Math.min(300, Math.ceil((retryAt - now) / 1000))), method, retryAt);
  }
  let result: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    result = await response.json<typeof result>();
  } catch {
    throw new SlackApiError(method, "invalid_response", response.status, credentialRevision);
  }
  if (!response.ok || !result.ok) {
    throw new SlackApiError(
      method,
      typeof result.error === "string" ? result.error : "http_error",
      response.status,
      credentialRevision,
      typeof result.needed === "string" ? normalizeScopes(result.needed) : [],
    );
  }
  const { ok: _ok, error: _error, ...body } = result;
  return body as SlackApiContracts[Method]["output"];
}

export type VerifiedSlackIdentity = {
  installationGeneration: number;
  installationId: string;
  workspaceId: string;
  teamId: string;
  slackUserId: string;
  accountSubject: string;
};

function slackProfileValue(profile: Record<string, unknown>, key: string) {
  const value = profile[key];
  return typeof value === "string" && value ? value : null;
}

export async function validateSlackIdentity(
  env: Env,
  profile: Record<string, unknown>,
  expected?: { workspaceId?: string; teamId?: string; memberUserId?: string },
): Promise<VerifiedSlackIdentity> {
  const teamId = slackProfileValue(profile, "https://slack.com/team_id");
  const slackUserId = slackProfileValue(profile, "https://slack.com/user_id");
  if (!teamId || !slackUserId || (expected?.teamId && expected.teamId !== teamId)) {
    throw new HttpError(403, "slack_team_mismatch", "Use an account from the connected Slack workspace.");
  }
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations
      WHERE team_id = ? AND disconnected_at IS NULL
        AND (? IS NULL OR workspace_id = ?)`,
  )
    .bind(teamId, expected?.workspaceId ?? null, expected?.workspaceId ?? null)
    .first<SlackInstallation>();
  if (!installation) {
    throw new HttpError(403, "slack_not_connected", "Slack is not connected to this NoteFlare workspace.");
  }
  if (expected?.memberUserId) {
    const membership = await env.DB.prepare(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .bind(installation.workspace_id, expected.memberUserId)
      .first();
    if (!membership) throw new HttpError(403, "slack_team_mismatch", "Use a Slack team connected to your workspace.");
  }
  if (!slackScopeHealth(installation.scopes).capabilities.identity.available) {
    throw new HttpError(403, "slack_scope_missing", "The Slack owner must reauthorize users:read first.");
  }
  let response: SlackApiContracts["users.info"]["output"];
  try {
    response = await slackApi(env, installation, "users.info", { user: slackUserId });
  } catch (error) {
    if (error instanceof SlackApiError && ["user_not_found", "users_not_found"].includes(error.code)) {
      throw new HttpError(403, "slack_member_removed", "This Slack member is no longer active.");
    }
    throw error;
  }
  const user = response.user;
  if (!user || user.id !== slackUserId || user.team_id !== teamId) {
    throw new HttpError(403, "slack_identity_invalid", "Slack could not verify this workspace member.");
  }
  if (user.deleted) throw new HttpError(403, "slack_member_removed", "This Slack member is no longer active.");
  if (user.is_bot || user.is_app_user) {
    throw new HttpError(403, "slack_bot_forbidden", "Slack bot and app identities cannot sign in.");
  }
  if (user.is_restricted || user.is_ultra_restricted) {
    throw new HttpError(403, "slack_guest_forbidden", "Slack guest accounts cannot sign in to NoteFlare.");
  }
  if (user.is_stranger) {
    throw new HttpError(403, "slack_external_forbidden", "Slack Connect members cannot sign in to NoteFlare.");
  }
  return {
    installationId: installation.id,
    installationGeneration: installation.generation,
    workspaceId: installation.workspace_id,
    teamId,
    slackUserId,
    accountSubject: `${teamId}:${slackUserId}`,
  };
}

export { recordVerifiedSlackIdentity, recordSlackPrimaryFactorProof } from "./slack-identity";

async function linkedMember(env: Env, teamId: string, slackUserId: string) {
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, wm.role, w.id workspace_id, w.name workspace_name, w.location_hint
       FROM slack_installations installation
       JOIN slack_authorized_user_links link ON link.installation_id = installation.id
       JOIN user u ON u.id = link.user_id
       JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = installation.workspace_id
       JOIN workspaces w ON w.id = wm.workspace_id
      WHERE installation.team_id = ? AND installation.disconnected_at IS NULL AND link.slack_user_id = ?`,
  )
    .bind(teamId, slackUserId)
    .first<{
      id: string;
      name: string;
      email: string;
      role: MemberContext["role"];
      workspace_id: string;
      workspace_name: string;
      location_hint: string | null;
    }>();
  if (!row) return null;
  return {
    user: { id: row.id, name: row.name, email: row.email },
    session: { id: "slack", expiresAt: new Date(Date.now() + 60_000) },
    workspace: { id: row.workspace_id, name: row.workspace_name, locationHint: row.location_hint },
    role: row.role,
  } satisfies MemberContext;
}

export async function handleSlackCommand(
  env: Env,
  form: URLSearchParams,
  openSearch?: (
    env: Env,
    installation: SlackInstallation,
    userId: string,
    triggerId: string,
    query: string,
    deadlineAt?: number,
    defer?: (work: Promise<void>) => void,
  ) => Promise<{ response_type: string; text: string }>,
  deadlineAt?: number,
  defer?: (work: Promise<void>) => void,
) {
  const teamId = form.get("team_id") ?? "";
  const slackUserId = form.get("user_id") ?? "";
  const query = (form.get("text") ?? "").trim();
  const installation = await activeInstallation(env, teamId);
  if (!installation) return { response_type: "ephemeral", text: "NoteFlare is not connected to this Slack workspace." };
  if (query.toLowerCase() === "link") {
    const rawToken = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    await env.DB.prepare(
      `INSERT INTO slack_link_tokens (token_hash, installation_id, slack_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(await hexDigest(rawToken), installation.id, slackUserId, Date.now() + LINK_TOKEN_TTL_MS, Date.now())
      .run();
    return {
      response_type: "ephemeral",
      text: `Link your NoteFlare account: ${env.BETTER_AUTH_URL}/?view=settings&slackLink=${encodeURIComponent(rawToken)}`,
    };
  }
  if (!openSearch) return { response_type: "ephemeral", text: "Search is unavailable. Try `/notes <query>` again." };
  return openSearch(env, installation, slackUserId, form.get("trigger_id") ?? "", query, deadlineAt, defer);
}

export async function consumeSlackLink(env: Env, member: MemberContext, rawToken: string) {
  const authorization = await freshSecurityAuthorization(env, member.user.id, member.session.id);
  const guard = freshSecurityGuard(authorization);
  if (!rawToken || rawToken.length > 200) throw new HttpError(422, "invalid_slack_link", "Slack link is invalid.");
  const tokenHash = await hexDigest(rawToken);
  const row = await env.DB.prepare(
    `SELECT token.installation_id, token.slack_user_id, installation.workspace_id,installation.generation
       FROM slack_link_tokens token JOIN slack_installations installation ON installation.id = token.installation_id
      WHERE token.token_hash = ? AND token.used_at IS NULL AND token.expires_at >= ? AND installation.disconnected_at IS NULL`,
  )
    .bind(tokenHash, Date.now())
    .first<{ installation_id: string; slack_user_id: string; workspace_id: string; generation: number }>();
  if (!row || row.workspace_id !== member.workspace.id) {
    throw new HttpError(422, "invalid_slack_link", "Slack link is invalid or expired.");
  }
  const linkedToAnotherUser = await env.DB.prepare(
    `SELECT 1 FROM slack_user_links WHERE installation_id = ? AND slack_user_id = ? AND user_id <> ?`,
  )
    .bind(row.installation_id, row.slack_user_id, member.user.id)
    .first();
  if (linkedToAnotherUser) {
    throw new HttpError(409, "slack_user_already_linked", "That Slack account is already linked to another member.");
  }
  const current = await env.DB.prepare(
    `SELECT slack_user_id, migration_state FROM slack_user_links WHERE installation_id = ? AND user_id = ?`,
  )
    .bind(row.installation_id, member.user.id)
    .first<{ slack_user_id: string; migration_state: "legacy" | "verified" }>();
  if (current?.migration_state === "verified" && current.slack_user_id !== row.slack_user_id) {
    throw new HttpError(409, "slack_identity_verified", "Verify a different Slack identity from Settings.");
  }
  const timestamp = Date.now();
  // D1 does not guarantee changes() across batched statements, and the 409 below is
  // thrown after the batch commits, so the insert re-reads the token it just claimed.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?
        AND EXISTS(SELECT 1 FROM workspace_members member JOIN slack_installations installation
          ON installation.workspace_id=member.workspace_id WHERE installation.id=? AND installation.generation=?
          AND installation.disconnected_at IS NULL AND member.user_id=?)
        AND NOT EXISTS (SELECT 1 FROM slack_user_links link
          WHERE link.installation_id = ? AND link.user_id = ? AND link.migration_state = 'verified'
            AND link.slack_user_id <> ?) AND ${guard.sql}`,
    ).bind(
      timestamp,
      tokenHash,
      timestamp,
      row.installation_id,
      row.generation,
      member.user.id,
      row.installation_id,
      member.user.id,
      row.slack_user_id,
      ...guard.binds,
    ),
    env.DB.prepare(
      `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at,security_generation,installation_generation,authorization_started_at)
       SELECT ?, ?, ?, ?,?,?,?
       WHERE EXISTS (SELECT 1 FROM slack_link_tokens WHERE token_hash = ? AND used_at = ?)
         AND ${guard.sql} AND EXISTS(SELECT 1 FROM slack_installations installation JOIN workspace_members member
           ON member.workspace_id=installation.workspace_id WHERE installation.id=? AND installation.generation=?
           AND installation.disconnected_at IS NULL AND member.user_id=?)
       ON CONFLICT(installation_id, user_id) DO UPDATE SET
         authorization_started_at=${slackGrantStartSql(false)},
         slack_user_id = excluded.slack_user_id, linked_at = excluded.linked_at,
         security_generation=excluded.security_generation,installation_generation=excluded.installation_generation
       WHERE slack_user_links.migration_state <> 'verified'
          OR slack_user_links.slack_user_id = excluded.slack_user_id`,
    ).bind(
      row.installation_id,
      member.user.id,
      row.slack_user_id,
      timestamp,
      authorization.generation,
      row.generation,
      timestamp,
      tokenHash,
      timestamp,
      ...guard.binds,
      row.installation_id,
      row.generation,
      member.user.id,
    ),
  ]).catch((error: unknown) => {
    // (installation_id, slack_user_id) is unique, so the check above races with a
    // concurrent claim of the same Slack account rather than guaranteeing exclusivity.
    if (error instanceof Error && /UNIQUE constraint failed: slack_user_links/i.test(error.message)) {
      throw new HttpError(409, "slack_user_already_linked", "That Slack account is already linked to another member.");
    }
    throw error;
  });
  if (!results[0]?.meta.changes) {
    const membership = await env.DB.prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(row.workspace_id, member.user.id)
      .first();
    if (!membership)
      throw new HttpError(409, "slack_link_changed", "Slack authorization changed. Connect Slack again.");
    const verified = await env.DB.prepare(
      `SELECT 1 FROM slack_user_links WHERE installation_id = ? AND user_id = ?
        AND migration_state = 'verified' AND slack_user_id <> ?`,
    )
      .bind(row.installation_id, member.user.id, row.slack_user_id)
      .first();
    if (verified)
      throw new HttpError(409, "slack_identity_verified", "Verify a different Slack identity from Settings.");
    throw new HttpError(409, "slack_link_used", "Slack link was already used.");
  }
  if (!results[1]?.meta.changes)
    throw new HttpError(409, "slack_link_changed", "Slack authorization changed. Connect Slack again.");
}

export function slackChannelFanoutStatements(
  database: D1Database,
  fanout: {
    workspaceId: string;
    spaceId: string;
    pageId: string;
    contentEpoch?: number;
    threadId: string | null;
    actorId: string | null;
    eventType: NotificationEventType;
    sourceId: string;
    createdAt: number;
    // When set, a subscription that already recorded this event type for the page and actor
    // after this timestamp is skipped so continuous editing does not flood the channel.
    coalesceAfter?: number | null;
  },
) {
  const eventId = `${fanout.eventType}:${fanout.sourceId}`;
  const coalesceAfter = fanout.coalesceAfter ?? null;
  const idPrefix = `${eventId}:`;
  return [
    database
      .prepare(
        `INSERT OR IGNORE INTO slack_channel_events
          (id, subscription_id, workspace_id, event_type, actor_id, page_id, thread_id, cadence, created_at)
         SELECT ? || ':' || subscription.id, subscription.id, ?, ?, ?, ?, ?, subscription.cadence, ?
           FROM slack_channel_subscriptions subscription
           JOIN slack_installations installation ON installation.id = subscription.installation_id
          WHERE installation.workspace_id = ? AND installation.disconnected_at IS NULL
            AND installation.auth_error IS NULL
            AND EXISTS (SELECT 1 FROM pages p WHERE p.id = ? AND p.workspace_id = ?
              AND p.is_template=0 AND (? IS NULL OR p.content_epoch = ?))
            AND subscription.space_id = ? AND (subscription.page_id IS NULL OR subscription.page_id = ?)
            AND subscription.notification_blocked_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM round2_runtime WHERE activity_enabled=1 AND subscription.round2_initialized=1)
            AND subscription.muted_at IS NULL AND (subscription.snoozed_until IS NULL OR subscription.snoozed_until <= ?)
            AND NOT EXISTS (SELECT 1 FROM slack_thread_links mirror WHERE mirror.installation_id = installation.id
              AND mirror.thread_id = ? AND mirror.channel_id = subscription.channel_id AND mirror.state IN ('pending', 'active'))
            AND EXISTS (SELECT 1 FROM json_each(subscription.event_types_json) WHERE value = ?)
            AND NOT EXISTS (
              SELECT 1 FROM slack_channel_events recent
               WHERE ? IS NOT NULL AND recent.subscription_id = subscription.id AND recent.page_id = ?
                 AND recent.event_type = ? AND recent.actor_id = ? AND recent.created_at > ?)`,
      )
      .bind(
        eventId,
        fanout.workspaceId,
        fanout.eventType,
        fanout.actorId,
        fanout.pageId,
        fanout.threadId,
        fanout.createdAt,
        fanout.workspaceId,
        fanout.pageId,
        fanout.workspaceId,
        fanout.contentEpoch ?? null,
        fanout.contentEpoch ?? null,
        fanout.spaceId,
        fanout.pageId,
        fanout.createdAt,
        fanout.threadId,
        fanout.eventType,
        coalesceAfter,
        fanout.pageId,
        fanout.eventType,
        fanout.actorId,
        coalesceAfter ?? 0,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO outbox
          (id, workspace_id, topic, payload_json, available_at, created_at, correlation_id)
         SELECT 'outbox:' || event.id, event.workspace_id, 'slack_channel', json_object('eventId', event.id), ?, ?, ?
           FROM slack_channel_events event WHERE event.id >= ? AND event.id < ?
             AND event.cadence = 'immediate'`,
      )
      .bind(
        fanout.createdAt,
        fanout.createdAt,
        currentObservabilityContext()?.correlationId ?? null,
        idPrefix,
        `${eventId};`,
      ),
  ];
}

// Slack posts are not idempotent, so a row is claimed before the call and the claim
// is released back to the pool once it goes stale, matching claimDelivery's contract.
const SLACK_CLAIM_STALE_MS = 60_000;
// Workers apply no per-fetch deadline of their own, so a hung Slack socket would
// otherwise hold a queue consumer or cron tick until the invocation itself is killed.
const SLACK_FETCH_TIMEOUT_MS = 10_000;

function isTimeoutAbort(error: unknown) {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function claimSlackRows(env: Env, table: "slack_channel_events" | "slack_unfurls", ids: readonly string[]) {
  if (!ids.length) return { ids: [] as string[], token: "" };
  const timestamp = Date.now();
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE ${table} SET claimed_at = ?, claim_token = ?
      WHERE id IN (SELECT value FROM json_each(?)) AND delivered_at IS NULL
        ${table === "slack_channel_events" ? "AND suppressed_at IS NULL" : ""}
        AND (claimed_at IS NULL OR claimed_at <= ?)
      RETURNING id`,
  )
    .bind(timestamp, token, JSON.stringify([...ids]), timestamp - SLACK_CLAIM_STALE_MS)
    .all<{ id: string }>();
  return { ids: claimed.results.map((row) => row.id), token };
}

async function releaseSlackClaims(
  env: Env,
  table: "slack_channel_events" | "slack_unfurls",
  ids: readonly string[],
  token: string,
) {
  if (!ids.length) return;
  await env.DB.prepare(
    `UPDATE ${table} SET claimed_at = NULL, claim_token = NULL
      WHERE id IN (SELECT value FROM json_each(?)) AND delivered_at IS NULL AND claim_token = ?`,
  )
    .bind(JSON.stringify([...ids]), token)
    .run();
}

async function channelEvent(env: Env, eventId: string) {
  return env.DB.prepare(
    `SELECT event.id event_id, event.event_type, event.page_id, event.thread_id, page.title page_title,
            actor.name actor_name, subscription.channel_id, subscription.id subscription_id,
            installation.id, installation.workspace_id, installation.team_id, installation.team_name,
            installation.bot_user_id, installation.bot_token_ciphertext,
            installation.bot_refresh_token_ciphertext, installation.token_expires_at, installation.disconnected_at,
            installation.generation, installation.credential_revision, installation.scopes
       FROM slack_channel_events event
       JOIN slack_channel_subscriptions subscription ON subscription.id = event.subscription_id
       JOIN slack_installations installation ON installation.id = subscription.installation_id
       JOIN pages page ON page.id = event.page_id AND page.import_job_id IS NULL AND page.archived_at IS NULL AND page.is_template=0
       LEFT JOIN user actor ON actor.id = event.actor_id
      WHERE event.id = ? AND event.delivered_at IS NULL AND event.suppressed_at IS NULL
        AND installation.disconnected_at IS NULL AND installation.auth_error IS NULL
        AND page.space_id = subscription.space_id AND (subscription.page_id IS NULL OR subscription.page_id = page.id)
        AND subscription.notification_blocked_at IS NULL AND ${channelActorAccessSql}
        AND subscription.muted_at IS NULL AND (subscription.snoozed_until IS NULL OR subscription.snoozed_until <= unixepoch('subsec') * 1000)`,
  )
    .bind(eventId)
    .first<
      SlackInstallation & {
        event_id: string;
        event_type: NotificationEventType;
        page_id: string;
        page_title: string;
        actor_name: string | null;
        channel_id: string;
        subscription_id: string;
      }
    >();
}

async function blockSlackNotifications(env: Env, subscriptionId: string, code: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE slack_channel_subscriptions SET notification_blocked_at=?, notification_error=?, updated_at=?
      WHERE id=? AND notification_blocked_at IS NULL`).bind(now, code, now, subscriptionId),
    env.DB.prepare(`UPDATE slack_channel_events SET suppressed_at=?
      WHERE subscription_id=? AND delivered_at IS NULL AND suppressed_at IS NULL`).bind(now, subscriptionId),
  ]);
}

async function blockSlackInstallationNotifications(env: Env, installationId: string, error: SlackApiError) {
  await recordSlackInstallationError(env, installationId, error);
}

function eventCopy(eventType: ChannelEventType | NotificationEventType, actorName: string | null, pageTitle: string) {
  const actor = actorName ?? "A collaborator";
  if (eventType === "page_created") return `${actor} created ${pageTitle}`;
  if (eventType === "page_moved") return `${actor} moved ${pageTitle}`;
  if (eventType === "page_archived") return `${actor} archived ${pageTitle}`;
  if (eventType === "task_status_changed") return `${actor} changed task status in ${pageTitle}`;
  if (eventType === "mention") return `${actor} mentioned someone in ${pageTitle}`;
  if (eventType === "reply") return `${actor} replied to a comment in ${pageTitle}`;
  if (eventType === "thread_resolved") return `${actor} resolved a comment in ${pageTitle}`;
  if (eventType === "thread_reopened") return `${actor} reopened a comment in ${pageTitle}`;
  return `${actor} edited ${pageTitle}`;
}

function escapeSlackMrkdwn(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "¦");
}

const channelActorAccessSql = `(
  EXISTS (SELECT 1 FROM workspace_members wm JOIN spaces sp ON sp.workspace_id = wm.workspace_id AND sp.id = page.space_id
    JOIN slack_protected_accounts protection ON protection.user_id=wm.user_id
    LEFT JOIN space_members sm ON sm.space_id = sp.id AND sm.user_id = wm.user_id
    WHERE wm.workspace_id = page.workspace_id AND wm.user_id = event.actor_id
      AND (wm.role = 'owner' OR sp.visibility = 'workspace' OR sm.user_id IS NOT NULL))
  OR EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM pages WHERE id = page.id AND workspace_id = page.workspace_id
      UNION ALL SELECT parent.id, parent.parent_id FROM pages parent
        JOIN ancestors child ON parent.id = child.parent_id WHERE parent.workspace_id = page.workspace_id
    )
    SELECT 1 FROM integrations bot JOIN integration_grants grant_row ON grant_row.integration_id = bot.id
      JOIN ancestors ON ancestors.id = grant_row.root_page_id
      JOIN pages grant_page ON grant_page.id = grant_row.root_page_id AND grant_page.archived_at IS NULL
    WHERE bot.workspace_id = page.workspace_id AND bot.bot_user_id = event.actor_id
      AND bot.revoked_at IS NULL AND bot.read_comments = 1 AND bot.insert_comments = 1)
)`;

export const channelActivityActorAccessSql = channelActorAccessSql.replace(
  "bot.read_comments = 1 AND bot.insert_comments = 1",
  `((event.event_type IN ('mention','reply','thread_resolved','thread_reopened') AND bot.read_comments=1 AND bot.insert_comments=1)
    OR (event.event_type IN ('page_created','page_edit','page_moved','page_archived','task_status_changed') AND bot.read_content=1 AND (bot.insert_content=1 OR bot.update_content=1)))`,
);

// A departure may hide page details, but its actor must still hold the original
// workspace authority and the capabilities required for this activity.
export const channelActivityActorAuthoritySql = channelActivityActorAccessSql
  .replace("AND (wm.role = 'owner' OR sp.visibility = 'workspace' OR sm.user_id IS NOT NULL)", "")
  .replace("JOIN pages grant_page ON grant_page.id = grant_row.root_page_id AND grant_page.archived_at IS NULL", "");

export const slackBulkCandidateSql = `e.round2_state='pending' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
  AND installation.generation=r.installation_generation AND installation.disconnected_at IS NULL
  AND m.installation_id=r.installation_id AND m.channel_id=r.channel_id AND e.event_type=r.event_type
  AND page.import_job_id IS NULL AND page.is_template=0
  AND EXISTS(SELECT 1 FROM workspace_members owner WHERE owner.workspace_id=installation.workspace_id AND owner.user_id=m.created_by AND owner.role='owner')
  AND ${channelActivityActorAuthoritySql.replaceAll("event.", "e.")}
  AND (${channelActivityActorAccessSql.replaceAll("event.", "e.")} OR page.archived_at IS NOT NULL OR page.space_id<>m.space_id)
  AND EXISTS(SELECT 1 FROM json_each(m.event_types_json) WHERE value=e.event_type)`;

const legacyChannelEligibilitySql = `page.is_template=0 AND ${channelActorAccessSql}
  AND EXISTS(SELECT 1 FROM workspace_members owner JOIN slack_installations owner_installation
    ON owner_installation.workspace_id=owner.workspace_id AND owner_installation.id=subscription.installation_id
    WHERE owner.user_id=subscription.created_by AND owner.role='owner')`;

function deniedLegacyChannelEventsStatement(env: Env, ids: readonly string[], claimToken: string | null = null) {
  return env.DB.prepare(`UPDATE slack_channel_events SET suppressed_at=?,claim_token=NULL,claimed_at=NULL
    WHERE delivered_at IS NULL AND suppressed_at IS NULL AND claim_token IS ?
      AND id IN (SELECT event.id FROM slack_channel_events event JOIN pages page ON page.id=event.page_id
        JOIN slack_channel_subscriptions subscription ON subscription.id=event.subscription_id
        WHERE NOT (${legacyChannelEligibilitySql})
          AND event.id IN (SELECT value FROM json_each(?))
          AND subscription.round2_initialized=0 AND event.id NOT LIKE 'activity:%')`).bind(
    Date.now(),
    claimToken,
    JSON.stringify(ids),
  );
}

class SlackChannelDispatchUnavailable extends Error {}

async function authorizedClaimedChannelEvents(
  env: Env,
  ids: readonly string[],
  token: string,
  installation: SlackInstallation,
  channelId: string,
) {
  const [, rows] = await env.DB.batch<{ id: string }>([
    deniedLegacyChannelEventsStatement(env, ids, token),
    env.DB.prepare(`SELECT event.id FROM slack_channel_events event
    JOIN slack_channel_subscriptions subscription ON subscription.id=event.subscription_id
    JOIN slack_installations installation ON installation.id=subscription.installation_id
    JOIN pages page ON page.id=event.page_id
    WHERE event.id IN (SELECT value FROM json_each(?)) AND event.claim_token=?
      AND event.delivered_at IS NULL AND event.suppressed_at IS NULL
      AND installation.id=? AND installation.generation=? AND installation.disconnected_at IS NULL
      AND installation.auth_error IS NULL AND subscription.channel_id=?
      AND EXISTS(SELECT 1 FROM workspace_members owner WHERE owner.workspace_id=installation.workspace_id AND owner.user_id=subscription.created_by AND owner.role='owner')
      AND page.archived_at IS NULL AND page.import_job_id IS NULL AND page.is_template=0
      AND page.space_id=subscription.space_id AND (subscription.page_id IS NULL OR subscription.page_id=page.id)
      AND subscription.notification_blocked_at IS NULL AND subscription.muted_at IS NULL
      AND (subscription.snoozed_until IS NULL OR subscription.snoozed_until<=unixepoch('subsec')*1000)
      AND ${channelActorAccessSql}`).bind(
      JSON.stringify(ids),
      token,
      installation.id,
      installation.generation,
      channelId,
    ),
  ]);
  if (!rows!.results.length) throw new SlackChannelDispatchUnavailable();
  return new Set(rows!.results.map((event) => event.id));
}

export async function deliverSlackChannelEvent(env: Env, eventId: string) {
  const claim = await claimSlackRows(env, "slack_channel_events", [eventId]);
  if (!claim.ids.length) return;
  const row = await channelEvent(env, eventId);
  if (!row) {
    await deniedLegacyChannelEventsStatement(env, [eventId], claim.token).run();
    await releaseSlackClaims(env, "slack_channel_events", [eventId], claim.token);
    return;
  }
  const copy = escapeSlackMrkdwn(eventCopy(row.event_type, row.actor_name, row.page_title));
  try {
    await slackApi(
      env,
      row,
      "chat.postMessage",
      {
        channel: row.channel_id,
        text: copy,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${copy}\n<${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(row.page_id)}|Open in NoteFlare>`,
            },
          },
        ],
      },
      {
        beforeDispatch: async () => {
          await authorizedClaimedChannelEvents(env, [eventId], claim.token, row, row.channel_id);
        },
      },
    );
  } catch (error) {
    await releaseSlackClaims(env, "slack_channel_events", [eventId], claim.token);
    if (error instanceof SlackChannelDispatchUnavailable) return;
    if (error instanceof SlackApiError && slackChannelError(error)) {
      await blockSlackNotifications(env, row.subscription_id, error.code);
      return;
    }
    if (slackMissingScope(error)) {
      await blockSlackNotifications(env, row.subscription_id, error.code);
      return;
    }
    if (error instanceof SlackApiError && slackInstallationError(error)) {
      await blockSlackInstallationNotifications(env, row.id, error);
      throw error;
    }
    throw error;
  }
  await env.DB.prepare(
    `UPDATE slack_channel_events SET delivered_at = ?
      WHERE id = ? AND delivered_at IS NULL AND claim_token = ?`,
  )
    .bind(Date.now(), eventId, claim.token)
    .run();
}

export async function sendPersonalSlackNotification(
  env: Env,
  userId: string,
  workspaceId: string,
  text: string,
  pageId: string,
) {
  // A user linked in several workspaces must only hear about a workspace through that workspace's installation.
  const row = await env.DB.prepare(
    `SELECT link.slack_user_id,link.linked_at linkedAt,link.verified_at verifiedAt,link.better_auth_account_id accountId,link.security_generation securityGeneration, installation.* FROM slack_authorized_user_links link
       JOIN slack_installations installation ON installation.id = link.installation_id
      WHERE link.user_id = ? AND installation.workspace_id = ? AND installation.disconnected_at IS NULL`,
  )
    .bind(userId, workspaceId)
    .first<
      SlackInstallation & {
        slack_user_id: string;
        linkedAt: number;
        verifiedAt: number | null;
        accountId: string | null;
        securityGeneration: number;
      }
    >();
  if (!row) return false;
  const safeText = escapeSlackMrkdwn(text);
  await slackApi(
    env,
    row,
    "chat.postMessage",
    {
      channel: row.slack_user_id,
      text: safeText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${safeText}\n<${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(pageId)}|Open in NoteFlare>`,
          },
        },
      ],
    },
    {
      beforeDispatch: slackAccessAuthorization(env, row, {
        userId,
        slackUserId: row.slack_user_id,
        accountId: row.accountId,
        verifiedAt: row.verifiedAt,
        linkedAt: row.linkedAt,
        securityGeneration: row.securityGeneration,
      }),
    },
  );
  return true;
}

export async function handleSlackEvent(env: Env, payload: SlackEventPayload) {
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return { challenge: payload.challenge };
  }
  if (
    payload.type === "event_callback" &&
    payload.event?.type === "app_home_opened" &&
    typeof payload.event_id === "string" &&
    typeof payload.team_id === "string" &&
    typeof payload.event.user === "string"
  ) {
    const installation = await activeInstallation(env, payload.team_id);
    if (!installation) return { ok: true };
    const timestamp = Date.now();
    const outboxId = `outbox:slack-home:${payload.event_id}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO outbox
        (id, workspace_id, topic, payload_json, available_at, created_at, correlation_id)
       VALUES (?, ?, 'slack_home_publish', json_object('installationId', ?, 'generation', ?, 'userId', ?, 'reset', json('true')), ?, ?, ?)`,
    )
      .bind(
        outboxId,
        installation.workspace_id,
        installation.id,
        installation.generation,
        payload.event.user,
        timestamp,
        timestamp,
        currentObservabilityContext()?.correlationId ?? null,
      )
      .run();
    try {
      const correlationId = currentObservabilityContext()?.correlationId;
      await env.DELIVERY_QUEUE.send({ outboxId, ...(correlationId ? { correlationId } : {}) });
      await env.DB.prepare(`UPDATE outbox SET enqueued_at = ? WHERE id = ? AND enqueued_at IS NULL`)
        .bind(Date.now(), outboxId)
        .run();
    } catch {
      // The scheduled outbox sweep recovers a split D1/Queue write.
    }
    return { ok: true };
  }
  if (
    payload.type !== "event_callback" ||
    payload.event?.type !== "link_shared" ||
    typeof payload.team_id !== "string" ||
    typeof payload.event.user !== "string" ||
    typeof payload.event.channel !== "string" ||
    typeof payload.event.message_ts !== "string"
  ) {
    return { ok: true };
  }
  const member = await linkedMember(env, payload.team_id, payload.event.user);
  const installation = await activeInstallation(env, payload.team_id);
  if (!member || !installation) return { ok: true };
  const unfurls: Record<string, unknown> = {};
  const shareReferences: D1PreparedStatement[] = [];
  const notesOrigin = new URL(env.BETTER_AUTH_URL).origin;
  for (const link of payload.event.links ?? []) {
    if (typeof link.url !== "string") continue;
    let pageId: string | null;
    let pinnedShare: { id: string; root_page_id: string; revoked_at: number | null } | null = null;
    try {
      const pageUrl = new URL(link.url);
      if (pageUrl.origin !== notesOrigin) continue;
      pageId = pageUrl.searchParams.get("page");
      if (env.SLACK_SHARE_REFRESH_ENABLED === "true" && /^\/share\/[^/]+\/?$/.test(pageUrl.pathname)) {
        const key = decodeURIComponent(pageUrl.pathname.split("/")[2]!);
        pinnedShare = await env.DB.prepare(
          `SELECT id,root_page_id,revoked_at FROM share_links WHERE url_key=? AND workspace_id=?`,
        )
          .bind(key, installation.workspace_id)
          .first();
        pageId = pinnedShare?.root_page_id ?? null;
      }
    } catch {
      continue;
    }
    if (!pageId) continue;
    const page = await env.DB.prepare(
      `SELECT p.id, p.title, p.kind, p.plain_text, p.space_id, s.name space_name, s.visibility,
              (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL) accessible,
              EXISTS (SELECT 1 FROM slack_channel_subscriptions subscription
                WHERE subscription.installation_id = ? AND subscription.channel_id = ?
                  AND subscription.space_id = p.space_id AND (subscription.page_id IS NULL OR subscription.page_id = p.id)) mapped,
              EXISTS (SELECT 1 FROM slack_channel_subscriptions subscription
                WHERE subscription.installation_id = ? AND subscription.channel_id = ?
                  AND subscription.validation_state = 'valid' AND subscription.space_id = p.space_id
                  AND (subscription.page_id IS NULL OR subscription.page_id = p.id)) actionable
         FROM pages p JOIN spaces s ON s.id = p.space_id
         LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE p.id = ? AND p.workspace_id = ? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0`,
    )
      .bind(
        member.role,
        installation.id,
        payload.event.channel,
        installation.id,
        payload.event.channel,
        member.user.id,
        pageId,
        member.workspace.id,
      )
      .first<{
        id: string;
        title: string;
        kind: string;
        plain_text: string;
        space_id: string;
        space_name: string;
        visibility: string;
        accessible: number;
        mapped: number;
        actionable: number;
      }>();
    if (!page?.accessible || (page.visibility === "private" && !payload.event.channel.startsWith("D") && !page.mapped))
      continue;
    if (
      env.SLACK_SHARE_REFRESH_ENABLED !== "true" ||
      !page.actionable ||
      !/^[CG][A-Z0-9]+$/.test(payload.event.channel)
    ) {
      unfurls[link.url] = {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              verbatim: true,
              text: `*${safeSlackText(page.title, 200)}*\n${safeSlackText(page.plain_text || `A page in ${page.space_name}`, 240)}`,
            },
          },
        ],
      };
      continue;
    }
    const existingReference = await env.DB.prepare(
      `SELECT id FROM slack_share_references WHERE installation_id = ? AND channel_id = ? AND message_ts = ? AND url = ?`,
    )
      .bind(installation.id, payload.event.channel, payload.event.message_ts, link.url)
      .first<{ id: string }>();
    const referenceId = existingReference?.id ?? crypto.randomUUID();
    const activeShare = await env.DB.prepare(
      `SELECT id FROM share_links WHERE root_page_id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    )
      .bind(page.id, installation.workspace_id)
      .first<{ id: string }>();
    shareReferences.push(
      env.DB.prepare(
        `INSERT INTO slack_share_references
        (id, installation_id, installation_generation, share_link_id, page_id, channel_id, message_ts, url, created_at, updated_at,observed_user_id,reference_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?)
       ON CONFLICT(installation_id, channel_id, message_ts, url) DO UPDATE SET
         installation_generation = excluded.installation_generation,
         share_link_id = excluded.share_link_id, page_id = excluded.page_id,
         observed_user_id=excluded.observed_user_id,reference_kind=excluded.reference_kind,rendered_hash=NULL,state = 'observed', updated_at = excluded.updated_at`,
      ).bind(
        referenceId,
        installation.id,
        installation.generation,
        pinnedShare?.id ?? activeShare?.id ?? null,
        page.id,
        payload.event.channel,
        payload.event.message_ts,
        link.url,
        Date.now(),
        Date.now(),
        member.user.id,
        pinnedShare ? "share" : "page",
      ),
    );
    unfurls[link.url] = {
      blocks: unfurlBlocks({
        title: page.title,
        excerpt: page.plain_text || `A page in ${page.space_name}`,
        referenceId,
        shareActive: pinnedShare ? pinnedShare.revoked_at === null : Boolean(activeShare),
      }),
    };
    if (pinnedShare?.revoked_at !== null && pinnedShare)
      unfurls[link.url] = {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              verbatim: true,
              text: `*${safeSlackText(page.title, 200)}*\nPublic access was revoked.`,
            },
          },
        ],
      };
  }
  if (Object.keys(unfurls).length) {
    const id = typeof payload.event_id === "string" && payload.event_id ? payload.event_id : crypto.randomUUID();
    const outboxId = `outbox:slack-unfurl:${id}`;
    const timestamp = Date.now();
    await env.DB.batch([
      ...shareReferences,
      ...(env.SLACK_SHARE_REFRESH_ENABLED === "true"
        ? [
            env.DB.prepare(`UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1
        WHERE installation_id=? AND channel_id=? AND message_ts=? AND url IN (SELECT key FROM json_each(?))`).bind(
              installation.id,
              payload.event.channel,
              payload.event.message_ts,
              JSON.stringify(unfurls),
            ),
          ]
        : []),
      env.DB.prepare(
        `INSERT OR IGNORE INTO slack_unfurls
          (id, installation_id, installation_generation, workspace_id, user_id, channel_id, message_ts, unfurls_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        installation.id,
        installation.generation,
        installation.workspace_id,
        member.user.id,
        payload.event.channel,
        payload.event.message_ts,
        JSON.stringify(unfurls),
        timestamp,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO outbox
          (id, workspace_id, topic, payload_json, available_at, created_at, correlation_id)
         VALUES (?, ?, 'slack_unfurl', json_object('unfurlId', ?), ?, ?, ?)`,
      ).bind(
        outboxId,
        installation.workspace_id,
        id,
        timestamp,
        timestamp,
        currentObservabilityContext()?.correlationId ?? null,
      ),
    ]);
    try {
      const correlationId = currentObservabilityContext()?.correlationId;
      await env.DELIVERY_QUEUE.send({ outboxId, ...(correlationId ? { correlationId } : {}) });
      const queuedAt = Date.now();
      await env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?
        WHERE id=? AND enqueued_at IS NULL`)
        .bind(queuedAt, queuedAt + SLACK_REDRIVE_STALE_MS, outboxId)
        .run();
    } catch {
      // The scheduled outbox sweep recovers this enqueue after a D1/Queue split failure.
    }
  }
  return { ok: true };
}

async function retireSlackUnfurl(
  env: Env,
  unfurlId: string,
  reason: "missing_message_ts" | "slack_identity_revoked",
  outboxId: string,
) {
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_unfurls SET retired_at = ?, retirement_reason = ?
        WHERE id = ? AND delivered_at IS NULL AND retired_at IS NULL`,
    ).bind(timestamp, reason, unfurlId),
    env.DB.prepare(`UPDATE outbox SET last_error = ? WHERE id = ?`).bind(`slack_unfurl_${reason}`, outboxId),
  ]);
}

export async function deliverSlackUnfurl(env: Env, unfurlId: string, outboxId: string) {
  const row = await env.DB.prepare(
    `SELECT unfurl.id unfurl_id, unfurl.user_id, unfurl.channel_id, unfurl.message_ts, unfurl.unfurls_json, unfurl.created_at,
            installation.id, installation.generation, installation.workspace_id, installation.team_id, installation.team_name,
            installation.bot_user_id, installation.bot_token_ciphertext,
            installation.bot_refresh_token_ciphertext, installation.token_expires_at, installation.disconnected_at,
            installation.credential_revision
       FROM slack_unfurls unfurl
       JOIN slack_installations installation ON installation.id = unfurl.installation_id
         AND installation.generation = unfurl.installation_generation
      WHERE unfurl.id = ? AND unfurl.delivered_at IS NULL AND unfurl.retired_at IS NULL
        AND installation.disconnected_at IS NULL`,
  )
    .bind(unfurlId)
    .first<
      SlackInstallation & {
        unfurl_id: string;
        user_id: string;
        channel_id: string;
        message_ts: string | null;
        unfurls_json: string;
        created_at: number;
      }
    >();
  if (!row) return;
  if (!row.message_ts) {
    await retireSlackUnfurl(env, unfurlId, "missing_message_ts", outboxId);
    return;
  }
  const authorized =
    await env.DB.prepare(`SELECT 1 FROM slack_authorized_user_links link JOIN slack_unfurls unfurl ON unfurl.user_id=link.user_id AND unfurl.installation_id=link.installation_id
    WHERE unfurl.id=? AND link.authorization_started_at<=unfurl.created_at`)
      .bind(unfurlId)
      .first();
  if (!authorized) {
    await retireSlackUnfurl(env, unfurlId, "slack_identity_revoked", outboxId);
    return;
  }
  const stored = JSON.parse(row.unfurls_json) as Record<string, unknown>;
  const unfurls: Record<string, unknown> = {};
  for (const [url, value] of Object.entries(stored)) {
    if (env.SLACK_SHARE_REFRESH_ENABLED === "true") {
      // Tracked attachments are rendered and serialized through the refresh queue.
      // Never replay captured blocks after a newer lifecycle transition.
      const tracked = await env.DB.prepare(
        `SELECT 1 FROM slack_share_references WHERE installation_id=? AND channel_id=? AND message_ts=? AND url=? AND lifecycle_revision>0`,
      )
        .bind(row.id, row.channel_id, row.message_ts, url)
        .first();
      if (tracked) continue;
    }
    let pageId: string | null = null;
    try {
      pageId = new URL(url).searchParams.get("page");
    } catch {
      // Ignore a malformed stored URL rather than allowing one bad link to block the event.
    }
    if (!pageId) continue;
    const access = await env.DB.prepare(
      `SELECT s.visibility,
              (wm.role = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL) accessible,
              EXISTS (SELECT 1 FROM slack_channel_subscriptions subscription
                WHERE subscription.installation_id = ? AND subscription.channel_id = ?
                  AND subscription.space_id = p.space_id
                  AND (subscription.page_id IS NULL OR subscription.page_id = p.id)) mapped
         FROM pages p
         JOIN spaces s ON s.id = p.space_id
         JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
         LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = wm.user_id
        WHERE p.id = ? AND p.workspace_id = ? AND p.archived_at IS NULL
          AND p.import_job_id IS NULL AND p.is_template = 0`,
    )
      .bind(row.id, row.channel_id, row.user_id, pageId, row.workspace_id)
      .first<{ visibility: "workspace" | "private"; accessible: number; mapped: number }>();
    if (!access?.accessible || (access.visibility === "private" && !row.channel_id.startsWith("D") && !access.mapped)) {
      continue;
    }
    unfurls[url] = value;
  }
  if (Object.keys(unfurls).length) {
    const claim = await claimSlackRows(env, "slack_unfurls", [unfurlId]);
    if (!claim.ids.length) {
      const live = await env.DB.prepare(
        "SELECT 1 FROM slack_unfurls WHERE id=? AND delivered_at IS NULL AND retired_at IS NULL",
      )
        .bind(unfurlId)
        .first();
      if (live) throw new DeliveryInProgressError();
      return;
    }
    try {
      await slackApi(
        env,
        row,
        "chat.unfurl",
        { channel: row.channel_id, ts: row.message_ts, unfurls },
        { beforeDispatch: slackAccessAuthorization(env, row, { userId: row.user_id }, row.created_at) },
      );
    } catch (error) {
      await releaseSlackClaims(env, "slack_unfurls", [unfurlId], claim.token);
      if (error instanceof SlackApiError && slackInstallationError(error))
        await recordSlackInstallationError(env, row.id, error);
      throw error;
    }
    await env.DB.prepare(
      `UPDATE slack_unfurls SET delivered_at = ?
        WHERE id = ? AND delivered_at IS NULL AND claim_token = ?`,
    )
      .bind(Date.now(), unfurlId, claim.token)
      .run();
    return;
  }
  await env.DB.prepare(`UPDATE slack_unfurls SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`)
    .bind(Date.now(), unfurlId)
    .run();
}

export async function sendDueSlackChannelDigests(env: Env, timestamp = Date.now()) {
  const date = new Date(timestamp);
  if (date.getUTCHours() < 9) return;
  const cutoff = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 9);
  const denied = await env.DB.prepare(`SELECT event.id FROM slack_channel_events event
    JOIN pages page ON page.id=event.page_id JOIN slack_channel_subscriptions subscription ON subscription.id=event.subscription_id
    WHERE event.cadence='digest' AND event.delivered_at IS NULL AND event.suppressed_at IS NULL AND event.claim_token IS NULL
      AND event.created_at<? AND subscription.round2_initialized=0 AND event.id NOT LIKE 'activity:%'
      AND NOT (${legacyChannelEligibilitySql}) ORDER BY event.created_at,event.id LIMIT 200`)
    .bind(cutoff)
    .all<{ id: string }>();
  if (denied.results.length)
    await deniedLegacyChannelEventsStatement(
      env,
      denied.results.map((event) => event.id),
    ).run();
  const subscriptions = await env.DB.prepare(
    `SELECT event.subscription_id, subscription.installation_id
       FROM slack_channel_events event
       JOIN slack_channel_subscriptions subscription ON subscription.id = event.subscription_id
       JOIN slack_installations installation ON installation.id = subscription.installation_id
       JOIN pages page ON page.id = event.page_id
      WHERE event.cadence = 'digest' AND event.delivered_at IS NULL AND event.suppressed_at IS NULL
        AND event.created_at < ? AND installation.disconnected_at IS NULL AND installation.auth_error IS NULL
        AND subscription.notification_blocked_at IS NULL
        AND subscription.round2_initialized=0 AND event.id NOT LIKE 'activity:%'
        AND subscription.muted_at IS NULL
        AND (subscription.snoozed_until IS NULL OR subscription.snoozed_until <= ?)
        AND page.archived_at IS NULL AND page.import_job_id IS NULL
        AND ${legacyChannelEligibilitySql}
        AND page.space_id = subscription.space_id
        AND (subscription.page_id IS NULL OR subscription.page_id = page.id)
      GROUP BY event.subscription_id, subscription.installation_id
      ORDER BY MIN(event.created_at), event.subscription_id LIMIT 50`,
  )
    .bind(cutoff, timestamp)
    .all<{ subscription_id: string; installation_id: string }>();
  const rateLimitedInstallations = new Set<string>();
  for (const { subscription_id: subscriptionId, installation_id: installationId } of subscriptions.results) {
    if (rateLimitedInstallations.has(installationId)) continue;
    try {
      const events = await env.DB.prepare(
        `SELECT event.id, event.event_type, event.page_id, page.title page_title, actor.name actor_name,
              subscription.channel_id,
              installation.id installation_id, installation.generation, installation.workspace_id, installation.team_id,
              installation.team_name, installation.bot_user_id, installation.bot_token_ciphertext,
              installation.bot_refresh_token_ciphertext, installation.token_expires_at,
              installation.disconnected_at, installation.credential_revision
         FROM slack_channel_events event
         JOIN slack_channel_subscriptions subscription ON subscription.id = event.subscription_id
         JOIN slack_installations installation ON installation.id = subscription.installation_id
         JOIN pages page ON page.id = event.page_id AND page.archived_at IS NULL
           AND page.import_job_id IS NULL
         LEFT JOIN user actor ON actor.id = event.actor_id
        WHERE event.subscription_id = ? AND event.cadence = 'digest'
          AND subscription.round2_initialized=0 AND event.id NOT LIKE 'activity:%'
          AND event.delivered_at IS NULL AND event.suppressed_at IS NULL
          AND event.created_at < ? AND installation.disconnected_at IS NULL
          AND ${legacyChannelEligibilitySql}
          AND page.space_id = subscription.space_id AND (subscription.page_id IS NULL OR subscription.page_id = page.id)
          AND subscription.notification_blocked_at IS NULL AND installation.auth_error IS NULL
          AND subscription.muted_at IS NULL AND (subscription.snoozed_until IS NULL OR subscription.snoozed_until <= unixepoch('subsec') * 1000)
        ORDER BY event.created_at LIMIT 40`,
      )
        .bind(subscriptionId, cutoff)
        .all<
          SlackInstallation & {
            id: string;
            event_type: NotificationEventType;
            page_id: string;
            page_title: string;
            actor_name: string | null;
            channel_id: string;
            installation_id: string;
          }
        >();
      const [first] = events.results;
      if (!first) continue;
      await deniedLegacyChannelEventsStatement(
        env,
        events.results.map((event) => event.id),
      ).run();
      const claim = await claimSlackRows(
        env,
        "slack_channel_events",
        events.results.map((event) => event.id),
      );
      if (!claim.ids.length) continue;
      const installation: SlackInstallation = { ...first, id: first.installation_id };
      let dispatched: typeof events.results = [];
      const payload: SlackApiContracts["chat.postMessage"]["input"] = {
        channel: first.channel_id,
        text: "",
        blocks: [],
      };
      try {
        await slackApi(env, installation, "chat.postMessage", payload, {
          beforeDispatch: async () => {
            const allowed = await authorizedClaimedChannelEvents(
              env,
              claim.ids,
              claim.token,
              installation,
              first.channel_id,
            );
            dispatched = events.results.filter((event) => allowed.has(event.id));
            const lines = dispatched.map(
              (event) =>
                `• ${escapeSlackMrkdwn(eventCopy(event.event_type, event.actor_name, event.page_title))} — <${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(event.page_id)}|open>`,
            );
            return {
              channel: first.channel_id,
              text: `${dispatched.length} NoteFlare update${dispatched.length === 1 ? "" : "s"}`,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*Your NoteFlare digest*\n${lines.join("\n")}` } },
              ],
            };
          },
        });
      } catch (error) {
        await releaseSlackClaims(env, "slack_channel_events", claim.ids, claim.token);
        if (error instanceof SlackChannelDispatchUnavailable) continue;
        if (error instanceof SlackApiError && slackChannelError(error)) {
          await blockSlackNotifications(env, subscriptionId, error.code);
          continue;
        }
        if (slackMissingScope(error)) {
          await blockSlackNotifications(env, subscriptionId, error.code);
          continue;
        }
        if (error instanceof SlackApiError && slackInstallationError(error)) {
          await blockSlackInstallationNotifications(env, installationId, error);
          continue;
        }
        throw error;
      }
      await env.DB.prepare(
        `UPDATE slack_channel_events SET delivered_at = ?
          WHERE id IN (SELECT value FROM json_each(?)) AND claim_token = ?`,
      )
        .bind(timestamp, JSON.stringify(dispatched.map((event) => event.id)), claim.token)
        .run();
      const sentIds = new Set(dispatched.map((event) => event.id));
      await releaseSlackClaims(
        env,
        "slack_channel_events",
        claim.ids.filter((id) => !sentIds.has(id)),
        claim.token,
      );
    } catch (error) {
      if (error instanceof SlackRateLimitError) rateLimitedInstallations.add(installationId);
      // One unreachable channel must not starve the digests queued behind it.
      logger.error("slack.channel_digest.failed", "slack", "Slack channel digest failed.", { subscriptionId }, error);
      recordMetric(env, {
        event: "integration.call",
        component: "slack",
        operation: "channel_digest",
        outcome: "failure",
      });
    }
  }
}

export async function pruneSlackSecurityRecords(env: Env, timestamp = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM slack_oauth_states WHERE expires_at < ?`).bind(timestamp),
    env.DB.prepare(`DELETE FROM slack_link_tokens WHERE expires_at < ?`).bind(timestamp),
    env.DB.prepare(`DELETE FROM slack_request_replays WHERE expires_at < ?`).bind(timestamp),
    env.DB.prepare(`DELETE FROM slack_primary_factor_proofs WHERE expires_at < ?`).bind(timestamp),
  ]);
}

export async function validatedSlackChannel(env: Env, installation: SlackInstallation, channelId: string) {
  const { channel } = await slackApi(env, installation, "conversations.info", { channel: channelId });
  const reason = channel?.id !== channelId ? "channel_not_found" : channelInvalidReason(channel);
  if (reason) throw new HttpError(422, reason, `Slack channel unavailable: ${reason.replaceAll("_", " ")}.`);
  return channel;
}
