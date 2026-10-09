import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { base64UrlToBytes, bytesToBase64Url } from "../shared/security";
import type { Env, MemberContext } from "./env";
import { HttpError, sha256 } from "./http";

const ISSUER = "https://auth.openai.com";
const REQUIRED_SCOPES = ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const encoder = new TextEncoder();

// Domain and row identity are authenticated too: encrypted values cannot be
// transplanted between members, OAuth states, and pagination cursors.
export async function seal(secret: string, context: string, value: unknown) {
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(data))}`;
}
export async function unseal<T>(secret: string, context: string, value: string): Promise<T> {
  const [iv, data] = value.split(".");
  if (!iv || !data) throw new Error("Invalid encrypted value.");
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: encoder.encode(context) },
    key,
    base64UrlToBytes(data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
export function chatgptConfigured(env: Env) {
  return (
    env.CHATGPT_CONNECTION_ENABLED === "true" &&
    !!env.AI_TOKEN_ENCRYPTION_KEY &&
    (env.CHATGPT_CLIENT_ID ?? "").startsWith("oaiapp_") &&
    (env.CHATGPT_TOKEN_AUTH_METHOD === "none" ||
      (env.CHATGPT_TOKEN_AUTH_METHOD === "client_secret_basic" && !!env.CHATGPT_CLIENT_SECRET)) &&
    REQUIRED_SCOPES.every((scope) => env.CHATGPT_SCOPES?.split(/\s+/).includes(scope))
  );
}
function requireConfiguration(env: Env) {
  if (!chatgptConfigured(env))
    throw new HttpError(
      503,
      "chatgpt_unavailable",
      "The hosted ChatGPT connection has not been configured for this installation.",
    );
}
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
async function discovery() {
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new HttpError(503, "chatgpt_unavailable", "ChatGPT authorization is temporarily unavailable.");
  const value = await response.json<Discovery>();
  if (
    value.issuer !== ISSUER ||
    [value.authorization_endpoint, value.token_endpoint, value.jwks_uri].some((url) => {
      try {
        return new URL(url).origin !== ISSUER;
      } catch {
        return true;
      }
    })
  )
    throw new HttpError(503, "chatgpt_unavailable", "ChatGPT discovery returned an unexpected endpoint.");
  return value;
}
function tokenContext(member: MemberContext) {
  return `ai-tokens:${member.workspace.id}:${member.user.id}`;
}
type Tokens = { access_token: string; refresh_token: string; scope: string };
type TokenResponse = Partial<Tokens> & { id_token?: string; expires_in?: number; token_type?: string };
function validateTokens(value: TokenResponse): value is TokenResponse & Tokens & { expires_in: number } {
  return (
    !!value.access_token &&
    !!value.refresh_token &&
    value.token_type?.toLowerCase() === "bearer" &&
    Number.isFinite(value.expires_in) &&
    value.expires_in! > 0 &&
    REQUIRED_SCOPES.every((scope) => value.scope?.split(/\s+/).includes(scope))
  );
}
async function exchange(env: Env, endpoint: string, params: URLSearchParams) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (env.CHATGPT_TOKEN_AUTH_METHOD === "client_secret_basic")
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(env.CHATGPT_CLIENT_ID!)}:${encodeURIComponent(env.CHATGPT_CLIENT_SECRET!)}`)}`;
  else params.set("client_id", env.CHATGPT_CLIENT_ID!);
  return fetch(endpoint, {
    method: "POST",
    headers,
    body: params,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}
export async function startChatgptConnection(env: Env, member: MemberContext) {
  requireConfiguration(env);
  if (
    await env.DB.prepare("SELECT 1 FROM ai_connections WHERE workspace_id=? AND user_id=?")
      .bind(member.workspace.id, member.user.id)
      .first()
  )
    throw new HttpError(409, "already_connected", "Disconnect your current ChatGPT account before connecting another.");
  const config = await discovery();
  const state = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const browser = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256(state);
  await env.DB.prepare("INSERT INTO ai_oauth_states VALUES (?,?,?,?,?,?,?,?)")
    .bind(
      hash,
      member.workspace.id,
      member.user.id,
      member.session.id,
      await sha256(browser),
      await seal(env.AI_TOKEN_ENCRYPTION_KEY!, `ai-state:${hash}`, verifier),
      nonce,
      Date.now() + 10 * 60_000,
    )
    .run();
  const url = new URL(config.authorization_endpoint);
  const challenge = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  url.search = new URLSearchParams({
    client_id: env.CHATGPT_CLIENT_ID!,
    redirect_uri: `${new URL(env.BETTER_AUTH_URL).origin}/api/ai/chatgpt/callback`,
    response_type: "code",
    scope: env.CHATGPT_SCOPES!,
    resource: "https://api.openai.com/v1",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.href, browser };
}
export async function finishChatgptConnection(
  env: Env,
  member: MemberContext,
  state: string,
  code: string,
  browser: string,
) {
  requireConfiguration(env);
  const hash = await sha256(state);
  // Consuming state is atomic and requires both the authenticated session and a
  // separate browser cookie. Failed callbacks cannot replay a token exchange.
  const record = await env.DB.prepare(
    "DELETE FROM ai_oauth_states WHERE state_hash=? AND workspace_id=? AND user_id=? AND session_id=? AND browser_hash=? AND expires_at>? RETURNING *",
  )
    .bind(hash, member.workspace.id, member.user.id, member.session.id, await sha256(browser), Date.now())
    .first<{ verifier_ciphertext: string; nonce: string }>();
  if (!record)
    throw new HttpError(
      400,
      "invalid_oauth_state",
      "The ChatGPT connection expired or does not belong to this browser. Start again.",
    );
  const config = await discovery();
  const verifier = await unseal<string>(env.AI_TOKEN_ENCRYPTION_KEY!, `ai-state:${hash}`, record.verifier_ciphertext);
  const response = await exchange(
    env,
    config.token_endpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: `${new URL(env.BETTER_AUTH_URL).origin}/api/ai/chatgpt/callback`,
    }),
  );
  if (!response.ok)
    throw new HttpError(400, "chatgpt_connection_failed", "ChatGPT declined the connection. Start again.");
  const value = await response.json<TokenResponse>().catch(() => {
    throw new HttpError(
      502,
      "chatgpt_connection_failed",
      "ChatGPT returned an unreadable token response. Start again.",
    );
  });
  if (!validateTokens(value) || !value.id_token)
    throw new HttpError(
      400,
      "chatgpt_plan_scope_missing",
      "ChatGPT did not grant plan inference and refresh access. Reconnect with the required permissions.",
    );
  const keysResponse = await fetch(config.jwks_uri, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!keysResponse.ok)
    throw new HttpError(503, "chatgpt_unavailable", "ChatGPT signing keys are temporarily unavailable.");
  let identity;
  try {
    const { payload } = await jwtVerify(value.id_token, createLocalJWKSet(await keysResponse.json<JSONWebKeySet>()), {
      issuer: ISSUER,
      audience: env.CHATGPT_CLIENT_ID!,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["sub", "iat", "exp", "nonce"],
      clockTolerance: 30,
    });
    if (
      payload.nonce !== record.nonce ||
      !payload.sub ||
      typeof payload.iat !== "number" ||
      payload.iat > Date.now() / 1000 + 30 ||
      (payload.azp && payload.azp !== env.CHATGPT_CLIENT_ID) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== env.CHATGPT_CLIENT_ID)
    )
      throw new Error("Invalid identity.");
    identity = payload;
  } catch {
    throw new HttpError(400, "invalid_chatgpt_identity", "ChatGPT returned an invalid identity token. Start again.");
  }
  const label = typeof identity.email === "string" ? identity.email : "Connected ChatGPT account";
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO ai_connections(workspace_id,user_id,subject,label,tokens_ciphertext,expires_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      member.workspace.id,
      member.user.id,
      identity.sub!,
      label.slice(0, 320),
      await seal(env.AI_TOKEN_ENCRYPTION_KEY!, tokenContext(member), {
        access_token: value.access_token,
        refresh_token: value.refresh_token,
        scope: value.scope,
      }),
      Date.now() + value.expires_in * 1000,
    )
    .run();
  if (!inserted.meta.changes)
    throw new HttpError(
      409,
      "already_connected",
      "A ChatGPT account is already connected. Disconnect it to replace it.",
    );
}
export async function chatgptAccessToken(env: Env, member: MemberContext) {
  requireConfiguration(env);
  type Connection = {
    tokens_ciphertext: string;
    expires_at: number;
    refresh_lease: string | null;
    refresh_lease_until: number | null;
  };
  const read = () =>
    env.DB.prepare("SELECT * FROM ai_connections WHERE workspace_id=? AND user_id=?")
      .bind(member.workspace.id, member.user.id)
      .first<Connection>();
  let current = await read();
  if (!current) throw new HttpError(424, "chatgpt_reconnect", "Connect your ChatGPT account to use plan funding.");
  if (current.expires_at > Date.now() + 60_000)
    return (await unseal<Tokens>(env.AI_TOKEN_ENCRYPTION_KEY!, tokenContext(member), current.tokens_ciphertext))
      .access_token;
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    "UPDATE ai_connections SET refresh_lease=?,refresh_lease_until=? WHERE workspace_id=? AND user_id=? AND tokens_ciphertext=? AND (refresh_lease_until IS NULL OR refresh_lease_until<?)",
  )
    .bind(lease, Date.now() + 45_000, member.workspace.id, member.user.id, current.tokens_ciphertext, Date.now())
    .run();
  if (!claimed.meta.changes) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await read();
      if (!current) throw new HttpError(424, "chatgpt_reconnect", "Reconnect ChatGPT to continue.");
      if (current.expires_at > Date.now() + 60_000)
        return (await unseal<Tokens>(env.AI_TOKEN_ENCRYPTION_KEY!, tokenContext(member), current.tokens_ciphertext))
          .access_token;
      if (!current.refresh_lease) break;
    }
    throw new HttpError(503, "chatgpt_refresh_pending", "ChatGPT is reconnecting. Retry shortly.");
  }
  try {
    const tokens = await unseal<Tokens>(env.AI_TOKEN_ENCRYPTION_KEY!, tokenContext(member), current.tokens_ciphertext);
    const response = await exchange(
      env,
      (await discovery()).token_endpoint,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    );
    if (!response.ok) {
      if (response.status === 400 || response.status === 401)
        await env.DB.prepare("DELETE FROM ai_connections WHERE workspace_id=? AND user_id=? AND refresh_lease=?")
          .bind(member.workspace.id, member.user.id, lease)
          .run();
      throw new HttpError(
        response.status === 400 || response.status === 401 ? 424 : 503,
        "chatgpt_reconnect",
        "ChatGPT could not renew plan access. Reconnect or explicitly choose workspace API funding.",
      );
    }
    const value = await response.json<TokenResponse>().catch(() => {
      throw new HttpError(502, "chatgpt_reconnect", "ChatGPT returned an unreadable renewal response. Reconnect.");
    });
    // Providers may preserve an existing refresh token and omit unchanged scopes.
    value.refresh_token ??= tokens.refresh_token;
    value.scope ??= tokens.scope;
    if (!validateTokens(value))
      throw new HttpError(424, "chatgpt_reconnect", "ChatGPT returned incomplete plan credentials. Reconnect.");
    const saved = await env.DB.prepare(
      "UPDATE ai_connections SET tokens_ciphertext=?,expires_at=?,refresh_lease=NULL,refresh_lease_until=NULL WHERE workspace_id=? AND user_id=? AND refresh_lease=?",
    )
      .bind(
        await seal(env.AI_TOKEN_ENCRYPTION_KEY!, tokenContext(member), {
          access_token: value.access_token,
          refresh_token: value.refresh_token,
          scope: value.scope,
        }),
        Date.now() + value.expires_in * 1000,
        member.workspace.id,
        member.user.id,
        lease,
      )
      .run();
    if (!saved.meta.changes)
      throw new HttpError(424, "chatgpt_reconnect", "The ChatGPT connection was removed during renewal.");
    return value.access_token;
  } finally {
    await env.DB.prepare(
      "UPDATE ai_connections SET refresh_lease=NULL,refresh_lease_until=NULL WHERE workspace_id=? AND user_id=? AND refresh_lease=?",
    )
      .bind(member.workspace.id, member.user.id, lease)
      .run();
  }
}
