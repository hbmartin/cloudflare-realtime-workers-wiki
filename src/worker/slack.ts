import type {
  NotificationEventType,
  SearchResponse,
  SlackCapability,
  SlackCapabilityHealth,
  SlackStatus,
} from "../shared/types";
import { tracing } from "cloudflare:workers";
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, hmacSha256 } from "../shared/security";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { parseSearchRequest, searchPages } from "./search";
import { currentObservabilityContext, logger, recordMetric, traced } from "./observability";

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

type SlackInstallation = {
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
    links?: Array<{ url?: unknown }>;
  };
};

export type SlackInteractionPayload = {
  type?: unknown;
  callback_id?: unknown;
  trigger_id?: unknown;
  action_ts?: unknown;
  team?: { id?: unknown };
  user?: { id?: unknown };
};

export class SlackRateLimitError extends Error {
  constructor(
    readonly retryAfter: number,
    readonly method = "unknown",
  ) {
    super("Slack rate limit reached.");
    this.name = "SlackRateLimitError";
  }
}

class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(`Slack ${method} failed.`);
    this.name = "SlackApiError";
  }
}

type SlackUser = {
  id: string;
  team_id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
};

type SlackApiContracts = {
  "users.info": { input: { user: string }; output: { user: SlackUser } };
  "auth.revoke": { input: Record<string, never>; output: { revoked?: boolean } };
  "chat.postMessage": {
    input: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string };
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
  "views.publish": {
    input: { user_id: string; view: Record<string, unknown>; hash?: string };
    output: { view: { id: string; hash?: string } };
  };
};

type SlackApiMethod = keyof SlackApiContracts;

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
}

export async function disconnectSlack(env: Env, member: MemberContext) {
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE workspace_id = ? AND disconnected_at IS NULL`,
  )
    .bind(member.workspace.id)
    .first<SlackInstallation>();
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
      WHERE workspace_id = ?`,
  )
    .bind(Date.now(), Date.now(), member.workspace.id)
    .run();
}

export async function slackWorkspaceStatus(env: Env, member: MemberContext) {
  const installation = await env.DB.prepare(
    `SELECT id, team_id, team_name, bot_user_id, scopes, disconnected_at, created_at, updated_at
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
    }>();
  const link = installation
    ? await env.DB.prepare(
        `SELECT slack_user_id, migration_state, verified_at
           FROM slack_user_links WHERE installation_id = ? AND user_id = ?`,
      )
        .bind(installation.id, member.user.id)
        .first<{ slack_user_id: string; migration_state: "legacy" | "verified"; verified_at: number | null }>()
    : null;
  const scopeHealth = installation ? slackScopeHealth(installation.scopes) : null;
  const connected = installation?.disconnected_at === null;
  const identityState = link?.migration_state ?? "unlinked";
  return {
    ...slackConfigurationStatus(env),
    installation: installation
      ? {
          teamId: installation.team_id,
          teamName: installation.team_name,
          botUserId: installation.bot_user_id,
          scopes: scopeHealth!.granted,
          connected,
          createdAt: installation.created_at,
          updatedAt: installation.updated_at,
          scopeHealth: {
            required: scopeHealth!.required,
            granted: scopeHealth!.granted,
            missing: scopeHealth!.missing,
            reauthorizationRequired: scopeHealth!.reauthorizationRequired,
          },
          capabilities: Object.fromEntries(
            Object.entries(scopeHealth!.capabilities).map(([name, health]) => [
              name,
              { ...health, available: connected && health.available },
            ]),
          ) as Record<SlackCapability, SlackCapabilityHealth>,
        }
      : null,
    linked: Boolean(link),
    identity: {
      state: identityState,
      slackUserId: link?.slack_user_id ?? null,
      verifiedAt: link?.verified_at ?? null,
    },
    reauthorization: {
      required: Boolean(connected && scopeHealth?.reauthorizationRequired),
      available: configured(env),
    },
  } satisfies SlackStatus;
}

export async function listSlackChannelSubscriptions(env: Env, member: MemberContext) {
  const rows = await env.DB.prepare(
    `SELECT subscription.id, subscription.space_id, subscription.page_id, subscription.channel_id,
            subscription.channel_name, subscription.event_types_json, subscription.cadence,
            subscription.channel_type, subscription.validation_state, subscription.validated_at,
            subscription.validation_error, subscription.bot_is_member, subscription.mirror_enabled,
            subscription.muted_at, subscription.snoozed_until,
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
      channel_type: "public_channel" | "private_channel" | "im" | "mpim" | null;
      validation_state: "unvalidated" | "valid" | "invalid";
      validated_at: number | null;
      validation_error: string | null;
      bot_is_member: number | null;
      mirror_enabled: number;
      muted_at: number | null;
      snoozed_until: number | null;
      created_at: number;
      updated_at: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    pageId: row.page_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    eventTypes: JSON.parse(row.event_types_json) as NotificationEventType[],
    cadence: row.cadence,
    channelType: row.channel_type,
    validationState: row.validation_state,
    validatedAt: row.validated_at,
    validationError: row.validation_error,
    botIsMember: row.bot_is_member === null ? null : Boolean(row.bot_is_member),
    mirrorEnabled: Boolean(row.mirror_enabled),
    mutedAt: row.muted_at,
    snoozedUntil: row.snoozed_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function upsertSlackChannelSubscription(
  env: Env,
  member: MemberContext,
  input: {
    spaceId: string;
    pageId: string | null;
    channelId: string;
    channelName: string;
    eventTypes: NotificationEventType[];
    cadence: "immediate" | "digest";
  },
) {
  const installation = await env.DB.prepare(
    `SELECT id FROM slack_installations WHERE workspace_id = ? AND disconnected_at IS NULL`,
  )
    .bind(member.workspace.id)
    .first<{ id: string }>();
  if (!installation) throw new HttpError(409, "slack_not_connected", "Connect Slack before adding a channel.");
  const existing = await env.DB.prepare(
    `SELECT id FROM slack_channel_subscriptions WHERE installation_id = ? AND channel_id = ?
      AND space_id = ? AND ifnull(page_id, '') = ifnull(?, '')`,
  )
    .bind(installation.id, input.channelId, input.spaceId, input.pageId)
    .first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT INTO slack_channel_subscriptions
      (id, installation_id, space_id, page_id, channel_id, channel_name, event_types_json, cadence,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET channel_name = excluded.channel_name,
       event_types_json = excluded.event_types_json, cadence = excluded.cadence, updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      installation.id,
      input.spaceId,
      input.pageId,
      input.channelId,
      input.channelName,
      JSON.stringify(input.eventTypes),
      input.cadence,
      member.user.id,
      timestamp,
      timestamp,
    )
    .run();
  return (await listSlackChannelSubscriptions(env, member)).find((subscription) => subscription.id === id)!;
}

export async function deleteSlackChannelSubscription(env: Env, member: MemberContext, id: string) {
  const deleted = await env.DB.prepare(
    `DELETE FROM slack_channel_subscriptions WHERE id = ? AND installation_id IN
      (SELECT id FROM slack_installations WHERE workspace_id = ?)`,
  )
    .bind(id, member.workspace.id)
    .run();
  if (!deleted.meta.changes) throw new HttpError(404, "slack_channel_not_found", "Slack channel mapping not found.");
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

async function usableBotToken(env: Env, installation: SlackInstallation) {
  if (installation.token_expires_at === null || installation.token_expires_at > Date.now() + 60_000) {
    return decryptSlackToken(env, installation.bot_token_ciphertext);
  }
  if (!installation.bot_refresh_token_ciphertext) {
    throw new Error("The Slack access token expired and cannot be refreshed.");
  }
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: await decryptSlackToken(env, installation.bot_refresh_token_ciphertext),
    }),
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
    throw new Error(`Slack token refresh failed (${result.error ?? response.status}).`);
  }
  const updatedAt = Date.now();
  const accessTokenCiphertext = await encryptSlackToken(env, result.access_token);
  const refreshTokenCiphertext = result.refresh_token
    ? await encryptSlackToken(env, result.refresh_token)
    : installation.bot_refresh_token_ciphertext;
  const expiresAt = result.expires_in ? updatedAt + result.expires_in * 1000 : null;
  const updated = await env.DB.prepare(
    `UPDATE slack_installations SET bot_token_ciphertext = ?, bot_refresh_token_ciphertext = ?,
      token_expires_at = ?, updated_at = ? WHERE id = ? AND bot_token_ciphertext = ?`,
  )
    .bind(
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt,
      updatedAt,
      installation.id,
      installation.bot_token_ciphertext,
    )
    .run();
  if (!updated.meta.changes) {
    const current = await env.DB.prepare(`SELECT * FROM slack_installations WHERE id = ? AND disconnected_at IS NULL`)
      .bind(installation.id)
      .first<SlackInstallation>();
    if (!current) throw new Error("The Slack installation was disconnected.");
    return decryptSlackToken(env, current.bot_token_ciphertext);
  }
  installation.bot_token_ciphertext = accessTokenCiphertext;
  installation.bot_refresh_token_ciphertext = refreshTokenCiphertext;
  installation.token_expires_at = expiresAt;
  return result.access_token;
}

async function slackApi<Method extends SlackApiMethod>(
  env: Env,
  installation: SlackInstallation,
  method: Method,
  payload: SlackApiContracts[Method]["input"],
): Promise<SlackApiContracts[Method]["output"]> {
  const response = await traced(tracing, "notes.integration.slack", { "notes.operation": method }, async () => {
    return fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await usableBotToken(env, installation)}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
    }).catch((error: unknown) => {
      if (isTimeoutAbort(error)) throw new Error(`Slack ${method} timed out.`);
      throw error;
    });
  });
  if (response.status === 429) {
    // Retry-After may legally be an HTTP date, which Number() turns into NaN and
    // carries all the way into the queue's delaySeconds.
    const header = Number(response.headers.get("retry-after"));
    const retryAfter = Number.isFinite(header) && header > 0 ? Math.max(1, Math.min(300, header)) : 1;
    throw new SlackRateLimitError(retryAfter, method);
  }
  let result: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    result = await response.json<typeof result>();
  } catch {
    throw new SlackApiError(method, "invalid_response", response.status);
  }
  if (!response.ok || !result.ok) {
    throw new SlackApiError(method, typeof result.error === "string" ? result.error : "http_error", response.status);
  }
  const { ok: _ok, error: _error, ...body } = result;
  return body as SlackApiContracts[Method]["output"];
}

export type VerifiedSlackIdentity = {
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
  expected?: { workspaceId?: string; teamId?: string },
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
    workspaceId: installation.workspace_id,
    teamId,
    slackUserId,
    accountSubject: `${teamId}:${slackUserId}`,
  };
}

export async function recordVerifiedSlackIdentity(
  env: Env,
  userId: string,
  sessionId: string,
  accountId: string,
  identity: VerifiedSlackIdentity,
) {
  const timestamp = Date.now();
  const proofExpiresAt = timestamp + 10 * 60_000;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_user_links
        (installation_id, user_id, slack_user_id, linked_at, better_auth_account_id,
         verification_method, verified_at, migration_state)
       VALUES (?, ?, ?, ?, ?, 'slack_openid', ?, 'verified')
       ON CONFLICT(installation_id, user_id) DO UPDATE SET
         slack_user_id = excluded.slack_user_id,
         better_auth_account_id = excluded.better_auth_account_id,
         verification_method = 'slack_openid', verified_at = excluded.verified_at,
         migration_state = 'verified', linked_at = excluded.linked_at`,
    ).bind(identity.installationId, userId, identity.slackUserId, timestamp, accountId, timestamp),
    env.DB.prepare(
      `INSERT INTO slack_primary_factor_proofs
        (session_id, user_id, account_id, team_id, slack_user_id, verified_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS(SELECT 1 FROM session WHERE id = ? AND userId = ? AND expiresAt > ?)
       ON CONFLICT(session_id) DO UPDATE SET account_id = excluded.account_id,
         team_id = excluded.team_id, slack_user_id = excluded.slack_user_id,
         verified_at = excluded.verified_at, expires_at = excluded.expires_at`,
    ).bind(
      sessionId,
      userId,
      accountId,
      identity.teamId,
      identity.slackUserId,
      timestamp,
      proofExpiresAt,
      sessionId,
      userId,
      new Date(timestamp).toISOString(),
    ),
  ]);
  return { expiresAt: proofExpiresAt };
}

async function linkedMember(env: Env, teamId: string, slackUserId: string) {
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, wm.role, w.id workspace_id, w.name workspace_name, w.location_hint
       FROM slack_installations installation
       JOIN slack_user_links link ON link.installation_id = installation.id
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

export async function handleSlackCommand(env: Env, form: URLSearchParams) {
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
  const member = await linkedMember(env, teamId, slackUserId);
  if (!member) return { response_type: "ephemeral", text: "Link your account first with `/notes link`." };
  if (!query)
    return {
      response_type: "ephemeral",
      text: "Use `/notes <query>` to search or `/notes link` to link your account.",
    };
  const url = new URL("https://notes.invalid/api/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  const result: SearchResponse = await searchPages(env.DB, member, parseSearchRequest(url.href));
  return {
    response_type: "ephemeral",
    text: result.results.length
      ? result.results
          .map(
            (item) =>
              `• <${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(item.page.id)}|${escapeSlackMrkdwn(item.page.title)}> — ${escapeSlackMrkdwn(item.space.name)}`,
          )
          .join("\n")
      : `No NoteFlare pages matched “${query.slice(0, 100)}”.`,
  };
}

export async function consumeSlackLink(env: Env, member: MemberContext, rawToken: string) {
  if (!rawToken || rawToken.length > 200) throw new HttpError(422, "invalid_slack_link", "Slack link is invalid.");
  const tokenHash = await hexDigest(rawToken);
  const row = await env.DB.prepare(
    `SELECT token.installation_id, token.slack_user_id, installation.workspace_id
       FROM slack_link_tokens token JOIN slack_installations installation ON installation.id = token.installation_id
      WHERE token.token_hash = ? AND token.used_at IS NULL AND token.expires_at >= ? AND installation.disconnected_at IS NULL`,
  )
    .bind(tokenHash, Date.now())
    .first<{ installation_id: string; slack_user_id: string; workspace_id: string }>();
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
  const timestamp = Date.now();
  // D1 does not guarantee changes() across batched statements, and the 409 below is
  // thrown after the batch commits, so the insert re-reads the token it just claimed.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?`,
    ).bind(timestamp, tokenHash, timestamp),
    env.DB.prepare(
      `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
       SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM slack_link_tokens WHERE token_hash = ? AND used_at = ?)
       ON CONFLICT(installation_id, user_id) DO UPDATE SET
         slack_user_id = excluded.slack_user_id, linked_at = excluded.linked_at`,
    ).bind(row.installation_id, member.user.id, row.slack_user_id, timestamp, tokenHash, timestamp),
  ]).catch((error: unknown) => {
    // (installation_id, slack_user_id) is unique, so the check above races with a
    // concurrent claim of the same Slack account rather than guaranteeing exclusivity.
    if (error instanceof Error && /UNIQUE constraint failed: slack_user_links/i.test(error.message)) {
      throw new HttpError(409, "slack_user_already_linked", "That Slack account is already linked to another member.");
    }
    throw error;
  });
  if (!results[0]?.meta.changes) throw new HttpError(409, "slack_link_used", "Slack link was already used.");
}

export function slackChannelFanoutStatements(
  database: D1Database,
  fanout: {
    workspaceId: string;
    spaceId: string;
    pageId: string;
    threadId: string | null;
    actorId: string;
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
            AND subscription.space_id = ? AND (subscription.page_id IS NULL OR subscription.page_id = ?)
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
        fanout.spaceId,
        fanout.pageId,
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
            actor.name actor_name, subscription.channel_id,
            installation.id, installation.workspace_id, installation.team_id, installation.team_name,
            installation.bot_user_id, installation.bot_token_ciphertext,
            installation.bot_refresh_token_ciphertext, installation.token_expires_at, installation.disconnected_at
       FROM slack_channel_events event
       JOIN slack_channel_subscriptions subscription ON subscription.id = event.subscription_id
       JOIN slack_installations installation ON installation.id = subscription.installation_id
       JOIN pages page ON page.id = event.page_id AND page.import_job_id IS NULL AND page.archived_at IS NULL
       LEFT JOIN user actor ON actor.id = event.actor_id
      WHERE event.id = ? AND event.delivered_at IS NULL AND installation.disconnected_at IS NULL`,
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
      }
    >();
}

function eventCopy(eventType: NotificationEventType, actorName: string | null, pageTitle: string) {
  const actor = actorName ?? "A collaborator";
  if (eventType === "mention") return `${actor} mentioned someone in ${pageTitle}`;
  if (eventType === "reply") return `${actor} replied to a comment in ${pageTitle}`;
  if (eventType === "thread_resolved") return `${actor} resolved a comment in ${pageTitle}`;
  if (eventType === "thread_reopened") return `${actor} reopened a comment in ${pageTitle}`;
  return `${actor} edited ${pageTitle}`;
}

function escapeSlackMrkdwn(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "¦");
}

export async function deliverSlackChannelEvent(env: Env, eventId: string) {
  const row = await channelEvent(env, eventId);
  if (!row) return;
  const claim = await claimSlackRows(env, "slack_channel_events", [eventId]);
  if (!claim.ids.length) return;
  const copy = escapeSlackMrkdwn(eventCopy(row.event_type, row.actor_name, row.page_title));
  try {
    await slackApi(env, row, "chat.postMessage", {
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
    });
  } catch (error) {
    await releaseSlackClaims(env, "slack_channel_events", [eventId], claim.token);
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
    `SELECT link.slack_user_id, installation.* FROM slack_user_links link
       JOIN slack_installations installation ON installation.id = link.installation_id
      WHERE link.user_id = ? AND installation.workspace_id = ? AND installation.disconnected_at IS NULL`,
  )
    .bind(userId, workspaceId)
    .first<SlackInstallation & { slack_user_id: string }>();
  if (!row) return false;
  const safeText = escapeSlackMrkdwn(text);
  await slackApi(env, row, "chat.postMessage", {
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
  });
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
       VALUES (?, ?, 'slack_home_publish', json_object('installationId', ?, 'userId', ?), ?, ?, ?)`,
    )
      .bind(
        outboxId,
        installation.workspace_id,
        installation.id,
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
  const notesOrigin = new URL(env.BETTER_AUTH_URL).origin;
  for (const link of payload.event.links ?? []) {
    if (typeof link.url !== "string") continue;
    let pageId: string | null;
    try {
      const pageUrl = new URL(link.url);
      if (pageUrl.origin !== notesOrigin) continue;
      pageId = pageUrl.searchParams.get("page");
    } catch {
      continue;
    }
    if (!pageId) continue;
    const page = await env.DB.prepare(
      `SELECT p.id, p.title, p.plain_text, p.space_id, s.name space_name, s.visibility,
              (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL) accessible,
              EXISTS (SELECT 1 FROM slack_channel_subscriptions subscription
                WHERE subscription.installation_id = ? AND subscription.channel_id = ?
                  AND subscription.space_id = p.space_id AND (subscription.page_id IS NULL OR subscription.page_id = p.id)) mapped
         FROM pages p JOIN spaces s ON s.id = p.space_id
         LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE p.id = ? AND p.workspace_id = ? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0`,
    )
      .bind(member.role, installation.id, payload.event.channel, member.user.id, pageId, member.workspace.id)
      .first<{
        id: string;
        title: string;
        plain_text: string;
        space_id: string;
        space_name: string;
        visibility: string;
        accessible: number;
        mapped: number;
      }>();
    if (!page?.accessible || (page.visibility === "private" && !payload.event.channel.startsWith("D") && !page.mapped))
      continue;
    unfurls[link.url] = {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${escapeSlackMrkdwn(page.title)}*\n${escapeSlackMrkdwn(
              page.plain_text.slice(0, 240) || `A page in ${page.space_name}`,
            )}`,
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
      env.DB.prepare(
        `INSERT OR IGNORE INTO slack_unfurls
          (id, installation_id, workspace_id, user_id, channel_id, message_ts, unfurls_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        installation.id,
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
      await env.DB.prepare(`UPDATE outbox SET enqueued_at = ? WHERE id = ? AND enqueued_at IS NULL`)
        .bind(Date.now(), outboxId)
        .run();
    } catch {
      // The scheduled outbox sweep recovers this enqueue after a D1/Queue split failure.
    }
  }
  return { ok: true };
}

const SLACK_SHORTCUT_CALLBACKS = new Set(["noteflare_save_to_notes", "noteflare_new_page_from_thread"]);

export async function handleSlackInteraction(env: Env, payload: SlackInteractionPayload) {
  if (
    payload.type !== "message_action" ||
    typeof payload.callback_id !== "string" ||
    !SLACK_SHORTCUT_CALLBACKS.has(payload.callback_id) ||
    typeof payload.trigger_id !== "string" ||
    typeof payload.team?.id !== "string" ||
    typeof payload.user?.id !== "string"
  ) {
    return;
  }
  const installation = await activeInstallation(env, payload.team.id);
  if (!installation) return;
  const interactionId = `${payload.team.id}:${payload.trigger_id}`;
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO slack_interaction_receipts
      (id, installation_id, interaction_id, callback_id, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), installation.id, interactionId, payload.callback_id, Date.now())
    .run();
  if (!inserted.meta.changes) return;
  await slackApi(env, installation, "views.open", {
    trigger_id: payload.trigger_id,
    view: {
      type: "modal",
      callback_id: "noteflare_milestone_zero_placeholder",
      title: { type: "plain_text", text: "NoteFlare" },
      close: { type: "plain_text", text: "Close" },
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "This Slack action is not available yet." },
        },
      ],
    },
  });
  await env.DB.prepare(`UPDATE slack_interaction_receipts SET processed_at = ? WHERE interaction_id = ?`)
    .bind(Date.now(), interactionId)
    .run();
}

export async function deliverSlackHome(env: Env, installationId: string, userId: string) {
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE id = ? AND disconnected_at IS NULL`,
  )
    .bind(installationId)
    .first<SlackInstallation>();
  if (!installation) return;
  await slackApi(env, installation, "views.publish", {
    user_id: userId,
    view: { type: "home", blocks: [] },
  });
}

async function retireSlackUnfurl(env: Env, unfurlId: string, reason: "missing_message_ts", outboxId: string) {
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
    `SELECT unfurl.id unfurl_id, unfurl.user_id, unfurl.channel_id, unfurl.message_ts, unfurl.unfurls_json,
            installation.id, installation.workspace_id, installation.team_id, installation.team_name,
            installation.bot_user_id, installation.bot_token_ciphertext,
            installation.bot_refresh_token_ciphertext, installation.token_expires_at, installation.disconnected_at
       FROM slack_unfurls unfurl
       JOIN slack_installations installation ON installation.id = unfurl.installation_id
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
      }
    >();
  if (!row) return;
  if (!row.message_ts) {
    await retireSlackUnfurl(env, unfurlId, "missing_message_ts", outboxId);
    return;
  }
  const stored = JSON.parse(row.unfurls_json) as Record<string, unknown>;
  const unfurls: Record<string, unknown> = {};
  for (const [url, value] of Object.entries(stored)) {
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
    if (!claim.ids.length) return;
    try {
      await slackApi(env, row, "chat.unfurl", { channel: row.channel_id, ts: row.message_ts, unfurls });
    } catch (error) {
      await releaseSlackClaims(env, "slack_unfurls", [unfurlId], claim.token);
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
  const subscriptions = await env.DB.prepare(
    `SELECT event.subscription_id, subscription.installation_id
       FROM slack_channel_events event
       JOIN slack_channel_subscriptions subscription ON subscription.id = event.subscription_id
      WHERE event.cadence = 'digest' AND event.delivered_at IS NULL AND event.created_at < ?
      GROUP BY event.subscription_id, subscription.installation_id
      ORDER BY MIN(event.created_at), event.subscription_id LIMIT 50`,
  )
    .bind(cutoff)
    .all<{ subscription_id: string; installation_id: string }>();
  const rateLimitedInstallations = new Set<string>();
  for (const { subscription_id: subscriptionId, installation_id: installationId } of subscriptions.results) {
    if (rateLimitedInstallations.has(installationId)) continue;
    try {
      const events = await env.DB.prepare(
        `SELECT event.id, event.event_type, event.page_id, page.title page_title, actor.name actor_name,
              subscription.channel_id,
              installation.id installation_id, installation.workspace_id, installation.team_id,
              installation.team_name, installation.bot_user_id, installation.bot_token_ciphertext,
              installation.bot_refresh_token_ciphertext, installation.token_expires_at,
              installation.disconnected_at
         FROM slack_channel_events event
         JOIN slack_channel_subscriptions subscription ON subscription.id = event.subscription_id
         JOIN slack_installations installation ON installation.id = subscription.installation_id
         JOIN pages page ON page.id = event.page_id AND page.archived_at IS NULL
           AND page.import_job_id IS NULL AND page.is_template = 0
         LEFT JOIN user actor ON actor.id = event.actor_id
        WHERE event.subscription_id = ? AND event.cadence = 'digest'
          AND event.delivered_at IS NULL AND event.created_at < ? AND installation.disconnected_at IS NULL
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
      const claim = await claimSlackRows(
        env,
        "slack_channel_events",
        events.results.map((event) => event.id),
      );
      const claimedIds = new Set(claim.ids);
      const claimed = events.results.filter((event) => claimedIds.has(event.id));
      if (!claimed.length) continue;
      const installation: SlackInstallation = { ...first, id: first.installation_id };
      const lines = claimed.map(
        (event) =>
          `• ${escapeSlackMrkdwn(eventCopy(event.event_type, event.actor_name, event.page_title))} — <${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(event.page_id)}|open>`,
      );
      try {
        await slackApi(env, installation, "chat.postMessage", {
          channel: first.channel_id,
          text: `${claimed.length} NoteFlare update${claimed.length === 1 ? "" : "s"}`,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Your NoteFlare digest*\n${lines.join("\n")}` } }],
        });
      } catch (error) {
        await releaseSlackClaims(
          env,
          "slack_channel_events",
          claimed.map((event) => event.id),
          claim.token,
        );
        throw error;
      }
      await env.DB.prepare(
        `UPDATE slack_channel_events SET delivered_at = ?
          WHERE id IN (SELECT value FROM json_each(?)) AND claim_token = ?`,
      )
        .bind(timestamp, JSON.stringify(claimed.map((event) => event.id)), claim.token)
        .run();
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
