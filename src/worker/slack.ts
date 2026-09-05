import type { NotificationEventType, SearchResponse } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { parseSearchRequest, searchPages } from "./search";

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const LINK_TOKEN_TTL_MS = 10 * 60_000;
const REQUEST_WINDOW_SECONDS = 5 * 60;
const TOKEN_VERSION = "v1";
const SLACK_SCOPES = "commands,chat:write,links:read,links:write";

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
    links?: Array<{ url?: unknown }>;
  };
};

export class SlackRateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super("Slack rate limit reached.");
  }
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
      .map(([name]) => name),
  };
}

function requireSlackConfiguration(env: Env) {
  if (!configured(env)) throw new HttpError(503, "slack_unavailable", "Slack is not configured for this installation.");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hexDigest(value: string) {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
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
  const state = `${payload}.${bytesToBase64Url(await hmac(env.BETTER_AUTH_SECRET, payload))}`;
  await env.DB.prepare(
    `INSERT INTO slack_oauth_states (nonce_hash, workspace_id, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await hexDigest(nonce), member.workspace.id, member.user.id, expiresAt, Date.now())
    .run();
  const redirectUri = `${env.BETTER_AUTH_URL}/api/slack/oauth/callback`;
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", env.SLACK_CLIENT_ID!);
  url.searchParams.set("scope", SLACK_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.href;
}

async function consumeOAuthState(env: Env, member: MemberContext, state: string) {
  const pieces = state.split(".");
  if (pieces.length !== 3) throw new HttpError(422, "invalid_slack_state", "Slack authorization state is invalid.");
  const [nonce, rawExpiry, signature] = pieces as [string, string, string];
  const expiresAt = Number(rawExpiry);
  const expected = bytesToBase64Url(await hmac(env.BETTER_AUTH_SECRET, `${nonce}.${rawExpiry}`));
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || !constantTimeEqual(signature, expected)) {
    throw new HttpError(422, "invalid_slack_state", "Slack authorization state is invalid or expired.");
  }
  const consumed = await env.DB.prepare(
    `UPDATE slack_oauth_states SET used_at = ? WHERE nonce_hash = ? AND workspace_id = ? AND user_id = ?
      AND used_at IS NULL AND expires_at >= ?`,
  )
    .bind(Date.now(), await hexDigest(nonce), member.workspace.id, member.user.id, Date.now())
    .run();
  if (!consumed.meta.changes)
    throw new HttpError(409, "slack_state_used", "Slack authorization state was already used.");
}

export async function finishSlackOAuth(env: Env, member: MemberContext, code: string, state: string) {
  requireSlackConfiguration(env);
  await consumeOAuthState(env, member, state);
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: `${env.BETTER_AUTH_URL}/api/slack/oauth/callback`,
    }),
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
      console.error("Slack token revocation failed during disconnect", {
        workspaceId: member.workspace.id,
        error,
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
  const linked = installation
    ? Boolean(
        await env.DB.prepare(`SELECT 1 FROM slack_user_links WHERE installation_id = ? AND user_id = ?`)
          .bind(installation.id, member.user.id)
          .first(),
      )
    : false;
  return {
    ...slackConfigurationStatus(env),
    installation: installation
      ? {
          teamId: installation.team_id,
          teamName: installation.team_name,
          botUserId: installation.bot_user_id,
          scopes: installation.scopes.split(",").filter(Boolean),
          connected: installation.disconnected_at === null,
          createdAt: installation.created_at,
          updatedAt: installation.updated_at,
        }
      : null,
    linked,
  };
}

export async function listSlackChannelSubscriptions(env: Env, member: MemberContext) {
  const rows = await env.DB.prepare(
    `SELECT subscription.id, subscription.space_id, subscription.page_id, subscription.channel_id,
            subscription.channel_name, subscription.event_types_json, subscription.cadence,
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
  const expected = `v0=${Array.from(await hmac(env.SLACK_SIGNING_SECRET!, `v0:${timestamp}:${body}`), (byte) =>
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

async function slackApi(env: Env, installation: SlackInstallation, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await usableBotToken(env, installation)}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 429) {
    const retryAfter = Math.max(1, Math.min(300, Number(response.headers.get("retry-after") ?? 1)));
    throw new SlackRateLimitError(retryAfter);
  }
  const result = await response.json<{ ok?: boolean; error?: string }>();
  if (!response.ok || !result.ok) throw new Error(`Slack ${method} failed (${result.error ?? response.status}).`);
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
  if (!installation) return { response_type: "ephemeral", text: "Notes is not connected to this Slack workspace." };
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
      text: `Link your Notes account: ${env.BETTER_AUTH_URL}/?view=settings&slackLink=${encodeURIComponent(rawToken)}`,
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
      : `No Notes pages matched “${query.slice(0, 100)}”.`,
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
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?`,
    ).bind(timestamp, tokenHash, timestamp),
    env.DB.prepare(
      `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
       SELECT ?, ?, ?, ? WHERE changes() > 0
       ON CONFLICT(installation_id, user_id) DO UPDATE SET
         slack_user_id = excluded.slack_user_id, linked_at = excluded.linked_at`,
    ).bind(row.installation_id, member.user.id, row.slack_user_id, timestamp),
  ]);
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
  },
) {
  const eventId = `${fanout.eventType}:${fanout.sourceId}`;
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
            AND EXISTS (SELECT 1 FROM json_each(subscription.event_types_json) WHERE value = ?)`,
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
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         SELECT 'outbox:' || event.id, event.workspace_id, 'slack_channel', json_object('eventId', event.id), ?, ?
           FROM slack_channel_events event WHERE substr(event.id, 1, length(?) + 1) = ? || ':'
             AND event.cadence = 'immediate'`,
      )
      .bind(fanout.createdAt, fanout.createdAt, eventId, eventId),
  ];
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
  const copy = escapeSlackMrkdwn(eventCopy(row.event_type, row.actor_name, row.page_title));
  await slackApi(env, row, "chat.postMessage", {
    channel: row.channel_id,
    text: copy,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${copy}\n<${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(row.page_id)}|Open in Notes>`,
        },
      },
    ],
  });
  await env.DB.prepare(`UPDATE slack_channel_events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`)
    .bind(Date.now(), eventId)
    .run();
}

export async function sendPersonalSlackNotification(env: Env, userId: string, text: string, pageId: string) {
  const row = await env.DB.prepare(
    `SELECT link.slack_user_id, installation.* FROM slack_user_links link
       JOIN slack_installations installation ON installation.id = link.installation_id
      WHERE link.user_id = ? AND installation.disconnected_at IS NULL`,
  )
    .bind(userId)
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
          text: `${safeText}\n<${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(pageId)}|Open in Notes>`,
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
    payload.type !== "event_callback" ||
    payload.event?.type !== "link_shared" ||
    typeof payload.team_id !== "string" ||
    typeof payload.event.user !== "string" ||
    typeof payload.event.channel !== "string"
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
          (id, installation_id, workspace_id, user_id, channel_id, unfurls_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        installation.id,
        installation.workspace_id,
        member.user.id,
        payload.event.channel,
        JSON.stringify(unfurls),
        timestamp,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         VALUES (?, ?, 'slack_unfurl', json_object('unfurlId', ?), ?, ?)`,
      ).bind(outboxId, installation.workspace_id, id, timestamp, timestamp),
    ]);
    try {
      await env.DELIVERY_QUEUE.send({ outboxId });
      await env.DB.prepare(`UPDATE outbox SET enqueued_at = ? WHERE id = ? AND enqueued_at IS NULL`)
        .bind(Date.now(), outboxId)
        .run();
    } catch {
      // The scheduled outbox sweep recovers this enqueue after a D1/Queue split failure.
    }
  }
  return { ok: true };
}

export async function deliverSlackUnfurl(env: Env, unfurlId: string) {
  const row = await env.DB.prepare(
    `SELECT unfurl.id unfurl_id, unfurl.user_id, unfurl.channel_id, unfurl.unfurls_json,
            installation.id, installation.workspace_id, installation.team_id, installation.team_name,
            installation.bot_user_id, installation.bot_token_ciphertext,
            installation.bot_refresh_token_ciphertext, installation.token_expires_at, installation.disconnected_at
       FROM slack_unfurls unfurl
       JOIN slack_installations installation ON installation.id = unfurl.installation_id
      WHERE unfurl.id = ? AND unfurl.delivered_at IS NULL AND installation.disconnected_at IS NULL`,
  )
    .bind(unfurlId)
    .first<SlackInstallation & { unfurl_id: string; user_id: string; channel_id: string; unfurls_json: string }>();
  if (!row) return;
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
  if (Object.keys(unfurls).length) await slackApi(env, row, "chat.unfurl", { channel: row.channel_id, unfurls });
  await env.DB.prepare(`UPDATE slack_unfurls SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`)
    .bind(Date.now(), unfurlId)
    .run();
}

export async function sendDueSlackChannelDigests(env: Env, timestamp = Date.now()) {
  const date = new Date(timestamp);
  if (date.getUTCHours() !== 9 || date.getUTCMinutes() >= 15) return;
  const subscriptions = await env.DB.prepare(
    `SELECT DISTINCT subscription_id FROM slack_channel_events
      WHERE cadence = 'digest' AND delivered_at IS NULL ORDER BY created_at LIMIT 50`,
  ).all<{ subscription_id: string }>();
  for (const { subscription_id: subscriptionId } of subscriptions.results) {
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
          AND event.delivered_at IS NULL AND installation.disconnected_at IS NULL
        ORDER BY event.created_at LIMIT 40`,
    )
      .bind(subscriptionId)
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
    const installation: SlackInstallation = { ...first, id: first.installation_id };
    const lines = events.results.map(
      (event) =>
        `• ${escapeSlackMrkdwn(eventCopy(event.event_type, event.actor_name, event.page_title))} — <${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(event.page_id)}|open>`,
    );
    await slackApi(env, installation, "chat.postMessage", {
      channel: first.channel_id,
      text: `${events.results.length} Notes update${events.results.length === 1 ? "" : "s"}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Your Notes digest*\n${lines.join("\n")}` } }],
    });
    await env.DB.prepare(
      `UPDATE slack_channel_events SET delivered_at = ? WHERE id IN (SELECT value FROM json_each(?))`,
    )
      .bind(timestamp, JSON.stringify(events.results.map((event) => event.id)))
      .run();
  }
}

export async function pruneSlackSecurityRecords(env: Env, timestamp = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM slack_oauth_states WHERE expires_at < ?`).bind(timestamp),
    env.DB.prepare(`DELETE FROM slack_link_tokens WHERE expires_at < ?`).bind(timestamp),
    env.DB.prepare(`DELETE FROM slack_request_replays WHERE expires_at < ?`).bind(timestamp),
  ]);
}
