import type { Env, MemberContext } from "./env";
import { requireMember, requireOwner } from "./auth";
import { HttpError, sha256 } from "./http";
import { consumeFixedWindow } from "./rate-limit";
import { sourceRateLimitKey } from "./source-rate-limit";

const MCP_SCOPES = ["pages:read", "pages:write", "comments:write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
const SCOPE_SET = new Set<string>(MCP_SCOPES);
const CODE_TTL = 5 * 60_000;
const ACCESS_TTL = 15 * 60_000;
const REFRESH_TTL = 30 * 24 * 60 * 60_000;
const MAX_CLIENT_DOCUMENT = 32 * 1024;
const CLIENT_CACHE_TTL = 5 * 60_000;
const ABANDONED_CLIENT_TTL = 7 * 24 * 60 * 60_000;
const CLIENT_ACTIVITY_INTERVAL = 60 * 60_000;
const MAX_CLIENTS = 1_000;

function clientRegistrationRate(env: Env) {
  return consumeFixedWindow(env, "oauth-client-registrations", { window: 60, max: 100 });
}

async function limitAuthorization(request: Request, env: Env) {
  const rate = await consumeFixedWindow(env, `oauth-authorize:${await sourceRateLimitKey(request)}`, {
    window: 60,
    max: 30,
  });
  if (!rate.allowed)
    throw new HttpError(429, "slow_down", "Authorization requests are temporarily rate limited.", {
      retryAfter: rate.retryAfter,
    });
}

type OAuthClient = {
  client_id: string;
  name: string;
  redirect_uris_json: string;
  metadata_url: string | null;
};

type AccessRow = {
  grant_id: string;
  client_id: string;
  user_id: string;
  workspace_id: string;
  scopes: string;
  resource: string;
  expires_at: number;
  revoked_at: number | null;
  mcp_enabled: number;
  security_generation: number;
  current_security_generation: number;
  recovery_required: number;
  codes_saved: number;
  role: MemberContext["role"] | null;
  workspace_name: string;
  location_hint: string | null;
  user_name: string;
  user_email: string;
};

export type McpAccess = {
  grantId: string;
  clientId: string;
  scopes: Set<McpScope>;
  member: MemberContext;
};

function origin(env: Env) {
  return new URL(env.BETTER_AUTH_URL).origin;
}

function mcpResource(env: Env) {
  return `${origin(env)}/mcp`;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function oauthError(code: string, description: string, status = 400, retryAfter: number | null = 60) {
  return Response.json(
    { error: code, error_description: description },
    {
      status,
      headers: { "cache-control": "no-store", ...(status === 429 ? { "retry-after": String(retryAfter ?? 60) } : {}) },
    },
  );
}

export function oauthAuthorizationMetadata(env: Env) {
  const base = origin(env);
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: MCP_SCOPES,
  });
}

export function oauthProtectedResourceMetadata(env: Env) {
  const base = origin(env);
  return json({
    resource: mcpResource(env),
    authorization_servers: [base],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
  });
}

export function mcpBearerChallenge(env: Env, scope?: string) {
  const metadata = `${origin(env)}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer resource_metadata="${metadata}"${scope ? `, scope="${scope}"` : ""}`;
}

export async function mcpAccess(request: Request, env: Env, required: readonly McpScope[] = []) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/i.exec(authorization);
  if (!match) return null;
  const tokenHash = await sha256(match[1]!);
  const row = await env.DB.prepare(
    `SELECT access.grant_id, grant.client_id, grant.user_id, grant.workspace_id,
            grant.scopes, grant.revoked_at, grant.security_generation, access.resource, access.expires_at,
            workspace.mcp_enabled, workspace.name workspace_name, workspace.location_hint,
            security.generation current_security_generation,security.recovery_required,security.codes_saved,
            member.role, user.name user_name, user.email user_email
       FROM oauth_access_tokens access
       JOIN oauth_grants grant ON grant.id=access.grant_id
       JOIN workspaces workspace ON workspace.id=grant.workspace_id
       JOIN user ON user.id=grant.user_id
       JOIN account_security security ON security.user_id=grant.user_id
       LEFT JOIN workspace_members member ON member.workspace_id=grant.workspace_id AND member.user_id=grant.user_id
      WHERE access.token_hash=?`,
  )
    .bind(tokenHash)
    .first<AccessRow>();
  if (
    !row ||
    row.revoked_at !== null ||
    row.expires_at <= Date.now() ||
    row.resource !== mcpResource(env) ||
    row.mcp_enabled !== 1 ||
    row.security_generation !== row.current_security_generation ||
    row.recovery_required !== 0 ||
    row.codes_saved !== 1 ||
    !row.role
  )
    return null;
  const scopes = new Set(row.scopes.split(" ").filter((scope): scope is McpScope => SCOPE_SET.has(scope)));
  if (required.some((scope) => !scopes.has(scope))) return null;
  return {
    grantId: row.grant_id,
    clientId: row.client_id,
    scopes,
    member: {
      user: { id: row.user_id, name: row.user_name, email: row.user_email },
      session: { id: row.grant_id, expiresAt: new Date(row.expires_at) },
      workspace: { id: row.workspace_id, name: row.workspace_name, locationHint: row.location_hint },
      role: row.role,
    },
  } satisfies McpAccess;
}

function publicClientUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_client", "Use a public HTTPS client metadata URL.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.href.length > 2048 ||
    !host.includes(".") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-")) ||
    /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) ||
    /^\d+(?:\.\d+){3}$/.test(host) ||
    host.includes(":")
  )
    throw new HttpError(400, "invalid_client", "Use a public HTTPS client metadata URL.");
  return url;
}

function redirectUris(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    throw new HttpError(400, "invalid_client_metadata", "The client must register redirect URIs.");
  const redirects = value.map((item) => {
    if (typeof item !== "string" || item.length > 2048)
      throw new HttpError(400, "invalid_client_metadata", "A redirect URI is invalid.");
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new HttpError(400, "invalid_client_metadata", "A redirect URI is invalid.");
    }
    const host = url.hostname.toLowerCase();
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(host);
    const safeHost =
      loopback ||
      (/^[a-z0-9.-]+$/.test(host) &&
        host.split(".").every((part) => part && !part.startsWith("-") && !part.endsWith("-")));
    if (
      !safeHost ||
      url.username ||
      url.password ||
      url.hash ||
      (url.hostname.startsWith("[") && !loopback) ||
      ["code", "error", "state", "iss"].some((key) => url.searchParams.has(key)) ||
      !((url.protocol === "https:" && !loopback) || (url.protocol === "http:" && loopback))
    )
      throw new HttpError(400, "invalid_client_metadata", "A redirect URI is invalid.");
    return item;
  });
  if (new Set(redirects).size !== redirects.length)
    throw new HttpError(400, "invalid_client_metadata", "Redirect URIs must be unique.");
  return redirects;
}

async function boundedJson(response: Response) {
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_CLIENT_DOCUMENT)
    throw new HttpError(400, "invalid_client_metadata", "Client metadata could not be loaded.");
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_client_metadata", "Client metadata is empty.");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CLIENT_DOCUMENT)
        throw new HttpError(400, "invalid_client_metadata", "Client metadata is too large.");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "invalid_client_metadata", "Client metadata is not valid JSON.");
  }
}

async function boundedRequestText(request: Request, max: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max)
    throw new HttpError(413, "invalid_request", "OAuth request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new HttpError(413, "invalid_request", "OAuth request is too large.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw new HttpError(400, "invalid_request", "OAuth request is not UTF-8.");
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function metadataClient(env: Env, clientId: string) {
  let current = publicClientUrl(clientId);
  const rate = await clientRegistrationRate(env);
  if (!rate.allowed)
    throw new HttpError(429, "slow_down", "Client metadata requests are temporarily rate limited.", {
      retryAfter: rate.retryAfter,
    });
  const capacity = await env.DB.prepare(
    "SELECT 1 available WHERE EXISTS (SELECT 1 FROM oauth_clients WHERE client_id=?) OR (SELECT COUNT(*) FROM oauth_clients)<?",
  )
    .bind(clientId, MAX_CLIENTS)
    .first();
  if (!capacity) throw new HttpError(503, "temporarily_unavailable", "OAuth client registration is at capacity.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === 3)
          throw new HttpError(400, "invalid_client_metadata", "Client metadata redirected too many times.");
        const location = response.headers.get("location");
        if (!location) throw new HttpError(400, "invalid_client_metadata", "Client metadata redirect is invalid.");
        current = publicClientUrl(new URL(location, current).href);
        await response.body?.cancel();
        continue;
      }
      const value = await boundedJson(response);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new HttpError(400, "invalid_client_metadata", "Client metadata is invalid.");
      const document = value as Record<string, unknown>;
      if (document.client_id !== clientId)
        throw new HttpError(400, "invalid_client_metadata", "Client metadata ID does not match its URL.");
      const uris = redirectUris(document.redirect_uris);
      const name = typeof document.client_name === "string" ? document.client_name.trim().slice(0, 100) : "MCP client";
      const now = Date.now();
      const saved = await env.DB.prepare(
        `INSERT INTO oauth_clients(client_id,name,redirect_uris_json,metadata_url,created_at,updated_at)
         SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM oauth_clients WHERE client_id=?)
           OR (SELECT COUNT(*) FROM oauth_clients)<?
         ON CONFLICT(client_id) DO UPDATE SET name=excluded.name,
         redirect_uris_json=excluded.redirect_uris_json, metadata_url=excluded.metadata_url,
         updated_at=excluded.updated_at`,
      )
        .bind(clientId, name, JSON.stringify(uris), clientId, now, now, clientId, MAX_CLIENTS)
        .run();
      if (!saved.meta.changes)
        throw new HttpError(503, "temporarily_unavailable", "OAuth client registration is at capacity.");
      return {
        client_id: clientId,
        name,
        redirect_uris_json: JSON.stringify(uris),
        metadata_url: clientId,
      } satisfies OAuthClient;
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new HttpError(400, "invalid_client_metadata", "Client metadata could not be loaded.");
}

async function resolveClient(env: Env, clientId: string) {
  if (clientId.startsWith("https://")) {
    const cached = await env.DB.prepare(
      "SELECT client_id,name,redirect_uris_json,metadata_url FROM oauth_clients WHERE client_id=? AND metadata_url=? AND updated_at>?",
    )
      .bind(clientId, clientId, Date.now() - CLIENT_CACHE_TTL)
      .first<OAuthClient>();
    return cached ?? metadataClient(env, clientId);
  }
  let client = await env.DB.prepare(
    "SELECT client_id,name,redirect_uris_json,metadata_url,updated_at FROM oauth_clients WHERE client_id=?",
  )
    .bind(clientId)
    .first<OAuthClient & { updated_at: number }>();
  const timestamp = Date.now();
  if (client && client.updated_at <= timestamp - CLIENT_ACTIVITY_INTERVAL)
    client = await env.DB.prepare(
      "UPDATE oauth_clients SET updated_at=MAX(updated_at,?) WHERE client_id=? RETURNING client_id,name,redirect_uris_json,metadata_url,updated_at",
    )
      .bind(timestamp, clientId)
      .first<OAuthClient & { updated_at: number }>();
  if (!client) throw new HttpError(400, "invalid_client", "This client is not registered.");
  return client;
}

export async function registerOAuthClient(request: Request, env: Env) {
  const rate = await consumeFixedWindow(env, `oauth-register:${await sourceRateLimitKey(request)}`, {
    window: 60,
    max: 10,
  });
  if (!rate.allowed)
    return oauthError("slow_down", "Client registration is temporarily rate limited.", 429, rate.retryAfter);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return oauthError("invalid_client_metadata", "Send JSON client metadata.", 415);
  const source = await boundedRequestText(request, MAX_CLIENT_DOCUMENT);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return oauthError("invalid_client_metadata", "Client metadata is invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return oauthError("invalid_client_metadata", "Client metadata is invalid.");
  const document = value as Record<string, unknown>;
  const redirects = redirectUris(document.redirect_uris);
  const registrationRate = await clientRegistrationRate(env);
  if (!registrationRate.allowed)
    return oauthError(
      "slow_down",
      "Client registration is temporarily rate limited.",
      429,
      registrationRate.retryAfter,
    );
  const clientId = `urn:noteflare:oauth-client:${crypto.randomUUID()}`;
  const name = typeof document.client_name === "string" ? document.client_name.trim().slice(0, 100) : "MCP client";
  const now = Date.now();
  const saved = await env.DB.prepare(
    "INSERT INTO oauth_clients(client_id,name,redirect_uris_json,metadata_url,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_clients)<?",
  )
    .bind(clientId, name, JSON.stringify(redirects), null, now, now, MAX_CLIENTS)
    .run();
  if (!saved.meta.changes)
    return oauthError("temporarily_unavailable", "OAuth client registration is at capacity.", 503);
  return json(
    { client_id: clientId, client_name: name, redirect_uris: redirects, token_endpoint_auth_method: "none" },
    201,
  );
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function scopeList(value: string | null) {
  const scopes = value?.split(/\s+/).filter(Boolean) ?? [];
  if (
    !scopes.length ||
    scopes.length > MCP_SCOPES.length ||
    scopes.some((scope) => !SCOPE_SET.has(scope)) ||
    new Set(scopes).size !== scopes.length
  )
    throw new HttpError(400, "invalid_scope", "Select one or more supported scopes.");
  return scopes as McpScope[];
}

function singleton(params: URLSearchParams, key: string) {
  const values = params.getAll(key);
  if (values.length !== 1) throw new HttpError(400, "invalid_request", `Expected one ${key} parameter.`);
  return values[0]!;
}

type AuthorizationRequest = {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  scopes: McpScope[];
  challenge: string;
  resource: string;
};

function registeredRedirect(registered: string[], requested: string) {
  if (registered.includes(requested)) return true;
  try {
    if (new URL(requested).protocol !== "http:") return false;
  } catch {
    return false;
  }
  // RFC 8252 permits an ephemeral port on HTTP loopback IP redirects only.
  // Keep every other character, including the path and query, exact.
  const loopback = /^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::[0-9]+)?(?=[/?]|$)/;
  if (!loopback.test(requested)) return false;
  const withoutPort = requested.replace(loopback, "$1");
  return registered.some((uri) => loopback.test(uri) && uri.replace(loopback, "$1") === withoutPort);
}

async function authorizationRequest(params: URLSearchParams, env: Env): Promise<AuthorizationRequest | Response> {
  const clientId = singleton(params, "client_id");
  if (clientId.length > 2048) throw new HttpError(400, "invalid_client", "Client ID is too long.");
  const client = await resolveClient(env, clientId);
  const redirectUri = singleton(params, "redirect_uri");
  if (!registeredRedirect(JSON.parse(client.redirect_uris_json) as string[], redirectUri))
    throw new HttpError(400, "invalid_request", "The redirect URI is not registered for this client.");
  const providedState = params.getAll("state");
  try {
    if (singleton(params, "response_type") !== "code")
      throw new HttpError(400, "unsupported_response_type", "Only authorization code is supported.");
    const state = singleton(params, "state");
    if (!state || state.length > 512) throw new HttpError(400, "invalid_request", "State is invalid.");
    const challenge = singleton(params, "code_challenge");
    if (singleton(params, "code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw new HttpError(400, "invalid_request", "A valid S256 PKCE challenge is required.");
    const resource = singleton(params, "resource");
    if (resource !== mcpResource(env))
      throw new HttpError(400, "invalid_target", "The MCP resource must match this host.");
    const scopes = scopeList(singleton(params, "scope"));
    return { client, redirectUri, state, scopes, challenge, resource };
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 400) throw error;
    const stateValue = providedState[0];
    const state = providedState.length === 1 && stateValue !== undefined && stateValue.length <= 512 ? stateValue : "";
    return authorizationRedirect({ redirectUri, state }, { error: error.code, error_description: error.message }, env);
  }
}

async function consentMember(request: Request, env: Env) {
  const member = await requireMember(request, env);
  const row = await env.DB.prepare("SELECT mcp_enabled,mcp_generation FROM workspaces WHERE id=?")
    .bind(member.workspace.id)
    .first<{ mcp_enabled: number; mcp_generation: number }>();
  if (row?.mcp_enabled !== 1) throw new HttpError(403, "mcp_disabled", "MCP is not enabled for this workspace.");
  return { ...member, mcpGeneration: row.mcp_generation };
}

function authorizationRedirect(
  request: Pick<AuthorizationRequest, "redirectUri" | "state">,
  params: Record<string, string>,
  env: Env,
) {
  const redirect = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(params)) redirect.searchParams.set(key, value);
  if (request.state) redirect.searchParams.set("state", request.state);
  redirect.searchParams.set("iss", origin(env));
  return Response.redirect(redirect, 302);
}

export async function authorizeOAuthGet(request: Request, env: Env) {
  await limitAuthorization(request, env);
  const source = new URL(request.url).searchParams;
  const input = await authorizationRequest(source, env);
  if (input instanceof Response) return input;
  let member: MemberContext;
  try {
    member = await consentMember(request, env);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 403) return authorizationRedirect(input, { error: "access_denied" }, env);
    if (error.status !== 401) throw error;
    const authorize = new URL(request.url);
    const signin = new URL("/", env.BETTER_AUTH_URL);
    signin.searchParams.set("oauthAuthorize", `${authorize.pathname}${authorize.search}`);
    return Response.redirect(signin, 302);
  }
  const controls = [...source.entries()]
    .filter(([key]) => key !== "decision")
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect MCP client</title>
<main style="max-width:34rem;margin:4rem auto;font:1rem system-ui;line-height:1.5;padding:1rem"><h1>Connect ${escapeHtml(input.client.name)}</h1>
<p>This client will use your access to <strong>${escapeHtml(member.workspace.name)}</strong> as ${escapeHtml(member.user.email)}.</p>
<p>Client ID: <code>${escapeHtml(input.client.client_id)}</code><br>Return address: <code>${escapeHtml(input.redirectUri)}</code></p>
<p>Requested permissions: ${input.scopes.map(escapeHtml).join(", ")}</p>
<p>You can revoke this connection from workspace settings.</p>
<form method="post" action="/oauth/authorize">${controls}<button name="decision" value="approve">Allow access</button>
<button name="decision" value="deny">Deny</button></form></main></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(input.redirectUri).hostname === "[::1]" ? "http:" : new URL(input.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

async function formParams(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded"))
    throw new HttpError(400, "invalid_request", "Send form-encoded OAuth parameters.");
  const text = await boundedRequestText(request, 8192);
  return new URLSearchParams(text);
}

function checkBrowserOrigin(request: Request, env: Env) {
  if (request.headers.get("origin") !== origin(env))
    throw new HttpError(403, "invalid_origin", "The consent request must come from this site.");
}

function randomCredential() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function authorizeOAuthPost(request: Request, env: Env) {
  checkBrowserOrigin(request, env);
  await limitAuthorization(request, env);
  const params = await formParams(request);
  // Capture consent before resolving remote client metadata, which may stall
  // while an owner disables and re-enables MCP.
  let member: Awaited<ReturnType<typeof consentMember>> | null = null;
  try {
    member = await consentMember(request, env);
  } catch (error) {
    if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error;
  }
  const input = await authorizationRequest(params, env);
  if (input instanceof Response) return input;
  if (!member) return authorizationRedirect(input, { error: "access_denied" }, env);
  let decision: string;
  try {
    decision = singleton(params, "decision");
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return authorizationRedirect(input, { error: "invalid_request" }, env);
  }
  if (decision === "deny") return authorizationRedirect(input, { error: "access_denied" }, env);
  if (decision !== "approve")
    return authorizationRedirect(input, { error: "invalid_request", error_description: "Choose Allow or Deny." }, env);
  const code = randomCredential();
  const issued = await env.DB.prepare(
    `INSERT INTO oauth_authorization_codes
      (code_hash,client_id,user_id,workspace_id,redirect_uri,resource,scopes,code_challenge,security_generation,expires_at)
     SELECT ?,?,?,?,?,?,?,?,security.generation,? FROM account_security security
       JOIN workspace_members member ON member.user_id=security.user_id
       JOIN workspaces workspace ON workspace.id=member.workspace_id
      WHERE security.user_id=? AND security.recovery_required=0 AND security.codes_saved=1
        AND workspace.id=? AND workspace.mcp_enabled=1 AND workspace.mcp_generation=?`,
  )
    .bind(
      await sha256(code),
      input.client.client_id,
      member.user.id,
      member.workspace.id,
      input.redirectUri,
      input.resource,
      input.scopes.join(" "),
      input.challenge,
      Date.now() + CODE_TTL,
      member.user.id,
      member.workspace.id,
      member.mcpGeneration,
    )
    .run();
  if (!issued.meta.changes)
    return authorizationRedirect(
      input,
      { error: "access_denied", error_description: "Workspace access or account protection changed. Try again." },
      env,
    );
  return authorizationRedirect(input, { code }, env);
}

async function pkceChallenge(verifier: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return null;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function issueTokens(env: Env, codeHash: string, code: CodeRow) {
  const grantId = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const accessToken = randomCredential();
  const refreshToken = randomCredential();
  const now = Date.now();
  const issued = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at)
       SELECT ?,code.client_id,code.user_id,code.workspace_id,code.scopes,code.security_generation,?
         FROM oauth_authorization_codes code
         JOIN workspaces workspace ON workspace.id=code.workspace_id
         JOIN workspace_members member ON member.workspace_id=code.workspace_id AND member.user_id=code.user_id
         JOIN account_security security ON security.user_id=code.user_id
        WHERE code.code_hash=? AND code.client_id=? AND code.redirect_uri=? AND code.resource=?
          AND code.code_challenge=? AND code.consumed_at IS NULL AND code.expires_at>?
          AND workspace.mcp_enabled=1 AND security.generation=code.security_generation
          AND security.recovery_required=0 AND security.codes_saved=1`,
    ).bind(grantId, now, codeHash, code.client_id, code.redirect_uri, code.resource, code.code_challenge, now),
    // The unique grant identifies this transaction's winning exchange. A failed
    // token insert rolls back both this consumption and the grant creation.
    env.DB.prepare(
      `UPDATE oauth_authorization_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL
        AND EXISTS (SELECT 1 FROM oauth_grants WHERE id=?)`,
    ).bind(now, codeHash, grantId),
    env.DB.prepare(
      `INSERT INTO oauth_access_tokens(token_hash,grant_id,resource,expires_at)
       SELECT ?,id,?,? FROM oauth_grants WHERE id=?`,
    ).bind(await sha256(accessToken), code.resource, now + ACCESS_TTL, grantId),
    env.DB.prepare(
      `INSERT INTO oauth_refresh_tokens(token_hash,grant_id,family_id,expires_at)
       SELECT ?,id,?,? FROM oauth_grants WHERE id=?`,
    ).bind(await sha256(refreshToken), familyId, now + REFRESH_TTL, grantId),
  ]);
  if (issued.some((result) => result.meta.changes !== 1))
    return oauthError("invalid_grant", "The authorization code is invalid or already used.");
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL / 1000,
    refresh_token: refreshToken,
    scope: code.scopes,
    resource: code.resource,
  });
}

type CodeRow = {
  client_id: string;
  user_id: string;
  workspace_id: string;
  redirect_uri: string;
  resource: string;
  scopes: string;
  code_challenge: string;
  security_generation: number;
};

async function exchangeCode(params: URLSearchParams, env: Env) {
  const clientId = singleton(params, "client_id");
  const code = singleton(params, "code");
  const redirectUri = singleton(params, "redirect_uri");
  const resource = singleton(params, "resource");
  const challenge = await pkceChallenge(singleton(params, "code_verifier"));
  if (!challenge || resource !== mcpResource(env))
    return oauthError("invalid_grant", "The authorization code is invalid.");
  const codeHash = await sha256(code);
  const credentialRate = await consumeFixedWindow(env, `oauth-code:${codeHash}`, { window: 60, max: 60 });
  if (!credentialRate.allowed) return oauthError("slow_down", "Authorization code requests are rate limited.", 429);
  const row = await env.DB.prepare(
    `SELECT client_id,user_id,workspace_id,redirect_uri,resource,scopes,code_challenge,security_generation
      FROM oauth_authorization_codes WHERE code_hash=? AND client_id=?
      AND redirect_uri=? AND resource=? AND code_challenge=? AND consumed_at IS NULL AND expires_at>?
    `,
  )
    .bind(codeHash, clientId, redirectUri, resource, challenge, Date.now())
    .first<CodeRow>();
  if (!row) return oauthError("invalid_grant", "The authorization code is invalid or already used.");
  const enabled = await env.DB.prepare(
    `SELECT 1 valid FROM workspace_members member JOIN workspaces workspace ON workspace.id=member.workspace_id
       JOIN account_security security ON security.user_id=member.user_id
      WHERE member.user_id=? AND member.workspace_id=? AND workspace.mcp_enabled=1
        AND security.generation=? AND security.recovery_required=0 AND security.codes_saved=1`,
  )
    .bind(row.user_id, row.workspace_id, row.security_generation)
    .first();
  if (!enabled) return oauthError("access_denied", "Workspace access is no longer available.", 403);
  return issueTokens(env, codeHash, row);
}

type RefreshRow = {
  grant_id: string;
  family_id: string;
  expires_at: number;
  consumed_at: number | null;
  client_id: string;
  scopes: string;
  revoked_at: number | null;
  mcp_enabled: number;
  member_role: string | null;
  security_generation: number;
  current_security_generation: number;
  recovery_required: number;
  codes_saved: number;
};

async function refreshGrant(params: URLSearchParams, env: Env) {
  const clientId = singleton(params, "client_id");
  const tokenHash = await sha256(singleton(params, "refresh_token"));
  const resource = singleton(params, "resource");
  if (resource !== mcpResource(env)) return oauthError("invalid_target", "The MCP resource must match this host.");
  const row = await env.DB.prepare(
    `SELECT refresh.grant_id,refresh.family_id,refresh.expires_at,refresh.consumed_at,
            grant.client_id,grant.scopes,grant.revoked_at,grant.security_generation,
            workspace.mcp_enabled,member.role member_role,
            security.generation current_security_generation,security.recovery_required,security.codes_saved
       FROM oauth_refresh_tokens refresh JOIN oauth_grants grant ON grant.id=refresh.grant_id
       JOIN workspaces workspace ON workspace.id=grant.workspace_id
       JOIN account_security security ON security.user_id=grant.user_id
       LEFT JOIN workspace_members member ON member.workspace_id=grant.workspace_id AND member.user_id=grant.user_id
      WHERE refresh.token_hash=?`,
  )
    .bind(tokenHash)
    .first<RefreshRow>();
  if (
    !row ||
    row.client_id !== clientId ||
    row.expires_at <= Date.now() ||
    row.revoked_at !== null ||
    row.mcp_enabled !== 1 ||
    row.security_generation !== row.current_security_generation ||
    row.recovery_required !== 0 ||
    row.codes_saved !== 1 ||
    !row.member_role
  )
    return oauthError("invalid_grant", "The refresh token is invalid.");
  if (row.consumed_at !== null) {
    await env.DB.prepare("UPDATE oauth_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .bind(Date.now(), row.grant_id)
      .run();
    return oauthError("invalid_grant", "The refresh token was already used.");
  }
  const rotatedAt = Date.now();
  const rotationId = crypto.randomUUID();
  const accessToken = randomCredential();
  const refreshToken = randomCredential();
  const issued = await env.DB.batch([
    env.DB.prepare(
      `UPDATE oauth_refresh_tokens SET consumed_at=?,rotation_id=? WHERE token_hash=?
         AND consumed_at IS NULL AND expires_at>?
         AND EXISTS (SELECT 1 FROM oauth_grants grant JOIN account_security security
           ON security.user_id=grant.user_id
           JOIN workspaces workspace ON workspace.id=grant.workspace_id
           JOIN workspace_members member ON member.workspace_id=grant.workspace_id AND member.user_id=grant.user_id
           WHERE grant.id=oauth_refresh_tokens.grant_id AND grant.revoked_at IS NULL
             AND workspace.mcp_enabled=1
             AND grant.security_generation=security.generation
             AND security.recovery_required=0 AND security.codes_saved=1)`,
    ).bind(rotatedAt, rotationId, tokenHash, rotatedAt),
    env.DB.prepare(
      `INSERT INTO oauth_access_tokens(token_hash,grant_id,resource,expires_at)
         SELECT ?,grant_id,?,? FROM oauth_refresh_tokens WHERE token_hash=? AND rotation_id=?`,
    ).bind(await sha256(accessToken), resource, rotatedAt + ACCESS_TTL, tokenHash, rotationId),
    env.DB.prepare(
      `INSERT INTO oauth_refresh_tokens(token_hash,grant_id,family_id,expires_at)
         SELECT ?,grant_id,family_id,? FROM oauth_refresh_tokens WHERE token_hash=? AND rotation_id=?`,
    ).bind(await sha256(refreshToken), rotatedAt + REFRESH_TTL, tokenHash, rotationId),
  ]);
  if (issued[0]?.meta.changes !== 1 || issued[1]?.meta.changes !== 1 || issued[2]?.meta.changes !== 1) {
    await env.DB.prepare("UPDATE oauth_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .bind(Date.now(), row.grant_id)
      .run();
    return oauthError("invalid_grant", "The refresh token was already used.");
  }
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL / 1000,
    refresh_token: refreshToken,
    scope: row.scopes,
    resource,
  });
}

export async function pruneOAuthSecurityRecords(env: Env) {
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM oauth_authorization_codes WHERE code_hash IN (SELECT code_hash FROM oauth_authorization_codes WHERE expires_at<=? ORDER BY expires_at LIMIT 100)",
    ).bind(timestamp),
    env.DB.prepare(
      "DELETE FROM oauth_access_tokens WHERE token_hash IN (SELECT token_hash FROM oauth_access_tokens WHERE expires_at<=? ORDER BY expires_at LIMIT 100)",
    ).bind(timestamp),
    env.DB.prepare(
      "DELETE FROM oauth_refresh_tokens WHERE token_hash IN (SELECT token_hash FROM oauth_refresh_tokens WHERE expires_at<=? ORDER BY expires_at LIMIT 100)",
    ).bind(timestamp),
    env.DB.prepare(
      "DELETE FROM oauth_operation_receipts WHERE (grant_id,operation_id) IN (SELECT grant_id,operation_id FROM oauth_operation_receipts WHERE expires_at<=? ORDER BY expires_at LIMIT 100)",
    ).bind(timestamp),
    env.DB.prepare(
      `DELETE FROM oauth_grants WHERE id IN (
        SELECT grant.id FROM oauth_grants grant WHERE grant.created_at<?
          AND (grant.revoked_at IS NULL OR grant.revoked_at<?)
          AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens WHERE grant_id=grant.id)
          AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE grant_id=grant.id)
          AND NOT EXISTS (SELECT 1 FROM oauth_operation_receipts WHERE grant_id=grant.id)
        ORDER BY grant.created_at LIMIT 100)`,
    ).bind(timestamp - REFRESH_TTL, timestamp - REFRESH_TTL),
    env.DB.prepare(
      `DELETE FROM oauth_clients WHERE client_id IN (
        SELECT client.client_id FROM oauth_clients client WHERE client.updated_at<?
          AND NOT EXISTS (SELECT 1 FROM oauth_grants WHERE client_id=client.client_id)
          AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes WHERE client_id=client.client_id AND expires_at>?)
        ORDER BY client.updated_at LIMIT 100)`,
    ).bind(timestamp - ABANDONED_CLIENT_TTL, timestamp),
  ]);
}

export async function oauthToken(request: Request, env: Env) {
  const params = await formParams(request);
  const grantType = singleton(params, "grant_type");
  const sourceRate = await consumeFixedWindow(env, `oauth-token-source:${await sourceRateLimitKey(request)}`, {
    window: 60,
    max: 600,
  });
  if (!sourceRate.allowed) return oauthError("slow_down", "Token requests are temporarily rate limited.", 429);
  if (grantType === "authorization_code") return exchangeCode(params, env);
  if (grantType === "refresh_token") return refreshGrant(params, env);
  return oauthError("unsupported_grant_type", "Only authorization code and refresh token are supported.");
}

export async function oauthRevoke(request: Request, env: Env) {
  const params = await formParams(request);
  const sourceRate = await consumeFixedWindow(env, `oauth-revoke-source:${await sourceRateLimitKey(request)}`, {
    window: 60,
    max: 600,
  });
  if (!sourceRate.allowed) return oauthError("slow_down", "Revocation requests are temporarily rate limited.", 429);
  const clientId = singleton(params, "client_id");
  const hash = await sha256(singleton(params, "token"));
  await env.DB.prepare(
    `UPDATE oauth_grants SET revoked_at=? WHERE id IN (
      SELECT grant.id FROM oauth_grants grant JOIN oauth_access_tokens access ON access.grant_id=grant.id
        WHERE access.token_hash=? AND grant.client_id=?
      UNION SELECT grant.id FROM oauth_grants grant JOIN oauth_refresh_tokens refresh ON refresh.grant_id=grant.id
        WHERE refresh.token_hash=? AND grant.client_id=?
    ) AND revoked_at IS NULL`,
  )
    .bind(Date.now(), hash, clientId, hash, clientId)
    .run();
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

export async function listOAuthConnections(request: Request, env: Env) {
  const member = await requireMember(request, env);
  const cursor = new URL(request.url).searchParams.get("cursor");
  let after: { active: boolean; createdAt: number; id: string } | null = null;
  if (cursor) {
    try {
      if (cursor.length > 512) throw new Error("Invalid cursor");
      const parsed = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
      if (
        !parsed ||
        typeof parsed.active !== "boolean" ||
        !Number.isSafeInteger(parsed.createdAt) ||
        Number(parsed.createdAt) < 0 ||
        typeof parsed.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.id)
      )
        throw new Error("Invalid cursor");
      after = { active: parsed.active, createdAt: Number(parsed.createdAt), id: parsed.id };
    } catch {
      throw new HttpError(400, "invalid_cursor", "The connections cursor is invalid.");
    }
  }
  const rows = await env.DB.prepare(
    `SELECT grant.id,grant.scopes,grant.created_at,grant.revoked_at,client.client_id,client.name
       FROM oauth_grants grant JOIN oauth_clients client ON client.client_id=grant.client_id
      WHERE grant.user_id=? AND grant.workspace_id=?
        ${after ? "AND (grant.revoked_at IS NULL,grant.created_at,grant.id)<(?,?,?)" : ""}
      ORDER BY (grant.revoked_at IS NULL) DESC,grant.created_at DESC,grant.id DESC LIMIT 101`,
  )
    .bind(member.user.id, member.workspace.id, ...(after ? [after.active ? 1 : 0, after.createdAt, after.id] : []))
    .all<{
      id: string;
      scopes: string;
      created_at: number;
      revoked_at: number | null;
      client_id: string;
      name: string;
    }>();
  const connections = rows.results.slice(0, 100);
  const last = connections.at(-1);
  return json({
    nextCursor:
      rows.results.length > 100 && last
        ? btoa(JSON.stringify({ active: last.revoked_at === null, createdAt: last.created_at, id: last.id }))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "")
        : null,
    connections: connections.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      name: row.name,
      scopes: row.scopes.split(" "),
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    })),
  });
}

export async function revokeOAuthConnection(request: Request, env: Env, id: string) {
  checkBrowserOrigin(request, env);
  const member = await requireMember(request, env);
  const updated = await env.DB.prepare(
    "UPDATE oauth_grants SET revoked_at=? WHERE id=? AND user_id=? AND workspace_id=? AND revoked_at IS NULL RETURNING id",
  )
    .bind(Date.now(), id, member.user.id, member.workspace.id)
    .first();
  if (!updated) throw new HttpError(404, "connection_not_found", "Connection not found.");
  return new Response(null, { status: 204 });
}

export async function setWorkspaceMcpEnabled(request: Request, env: Env) {
  checkBrowserOrigin(request, env);
  const member = await requireMember(request, env);
  requireOwner(member);
  const source = (await request.json().catch(() => null)) as unknown;
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    typeof (source as Record<string, unknown>).enabled !== "boolean"
  )
    throw new HttpError(400, "invalid_input", "enabled must be a boolean.");
  const enabled = (source as { enabled: boolean }).enabled;
  const statements = [
    env.DB.prepare("UPDATE workspaces SET mcp_enabled=?,mcp_generation=mcp_generation+? WHERE id=?").bind(
      enabled ? 1 : 0,
      enabled ? 0 : 1,
      member.workspace.id,
    ),
  ];
  if (!enabled) {
    statements.push(
      env.DB.prepare("UPDATE oauth_grants SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL").bind(
        Date.now(),
        member.workspace.id,
      ),
      env.DB.prepare("DELETE FROM oauth_authorization_codes WHERE workspace_id=? AND consumed_at IS NULL").bind(
        member.workspace.id,
      ),
    );
  }
  await env.DB.batch(statements);
  return json({ enabled });
}

export async function workspaceMcpSettings(request: Request, env: Env) {
  const member = await requireMember(request, env);
  const row = await env.DB.prepare("SELECT mcp_enabled FROM workspaces WHERE id=?")
    .bind(member.workspace.id)
    .first<{ mcp_enabled: number }>();
  return json({ enabled: row?.mcp_enabled === 1 });
}
