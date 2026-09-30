import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrollAccount } from "../../tests/helpers/security";
import {
  authorizeOAuthGet,
  authorizeOAuthPost,
  mcpAccess,
  pruneOAuthSecurityRecords,
  registerOAuthClient,
} from "./oauth";
import { mcpRequest, pruneStagedMcpPages } from "./mcp";
import { sha256 } from "./http";
import { sourceRateLimitKey } from "./source-rate-limit";
import type { Env } from "./env";

const ORIGIN = "http://example.test";
const RESOURCE = `${ORIGIN}/mcp`;

function form(values: Record<string, string>) {
  return new URLSearchParams(values).toString();
}

async function bootstrap() {
  const response = await SELF.fetch(`${ORIGIN}/api/install/bootstrap`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "OAuth Notes",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = await enrollAccount(response);
  expect(
    (
      await SELF.fetch(`${ORIGIN}/api/oauth/workspace`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })
    ).status,
  ).toBe(200);
  return cookie;
}

async function register(redirects = ["http://127.0.0.1:3800/callback"]) {
  const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test MCP client", redirect_uris: redirects }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ client_id: string }>()).client_id;
}

async function challenge(verifier: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authorizationParams(clientId: string, redirectUri = "http://127.0.0.1:3800/callback") {
  return form({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: RESOURCE,
    scope: "pages:read",
    state: "client-state",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  });
}

async function exhaustRate(key: string, count: number) {
  await env.DB.prepare("INSERT INTO rateLimit(id,key,count,lastRequest) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), key, count, Math.floor(Date.now() / 60_000) * 60_000)
    .run();
}

async function connect(cookie: string) {
  const clientId = await register();
  const me = await (
    await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie, origin: ORIGIN } })
  ).json<{ user: { id: string }; workspace: { id: string } }>();
  const grantId = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at)
      SELECT ?,?,?,?,?,generation,? FROM account_security WHERE user_id=?`).bind(
      grantId,
      clientId,
      me.user.id,
      me.workspace.id,
      "pages:read pages:write comments:write",
      Date.now(),
      me.user.id,
    ),
    env.DB.prepare("INSERT INTO oauth_access_tokens(token_hash,grant_id,resource,expires_at) VALUES(?,?,?,?)").bind(
      await sha256(token),
      grantId,
      RESOURCE,
      Date.now() + 60_000,
    ),
  ]);
  const tree = await (
    await SELF.fetch(`${ORIGIN}/api/pages/tree`, { headers: { cookie, origin: ORIGIN } })
  ).json<{ pages: Array<{ id: string; spaceId: string }> }>();
  return { clientId, grantId, token, ...me, page: tree.pages[0]! };
}

async function toolCall(token: string, name: string, args: Record<string, unknown>, bindings: Env = env) {
  const context = createExecutionContext();
  const response = await mcpRequest(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  expect(response.status).toBe(200);
  return response.json<{
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: { error: { code: string; retryable: boolean } };
    };
  }>();
}

function failingMutations(status: number, error = "test_rejection"): Env {
  return {
    ...env,
    DOCUMENT: new Proxy(env.DOCUMENT, {
      get(target, property, receiver) {
        if (property === "getByName")
          return (name: string) => {
            const room = target.getByName(name);
            return {
              fetch: (request: Request) =>
                new URL(request.url).pathname === "/api-mutate"
                  ? Promise.resolve(Response.json({ error }, { status }))
                  : room.fetch(request),
            };
          };
        return Reflect.get(target, property, receiver);
      },
    }),
  };
}

describe("OAuth MCP foundation", () => {
  it("rejects malformed registrations before spending the shared client budget", async () => {
    for (const [contentType, body, status] of [
      ["text/plain", "{}", 415],
      ["application/json", "{", 400],
      ["application/json", "[]", 400],
      ["application/json", JSON.stringify({ redirect_uris: ["http://192.168.1.1/callback"] }), 400],
    ] as const) {
      const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(status);
    }
    expect(
      await env.DB.prepare("SELECT count FROM rateLimit WHERE key='oauth-client-registrations'").first(),
    ).toBeNull();
    await register();
    expect(await env.DB.prepare("SELECT count FROM rateLimit WHERE key='oauth-client-registrations'").first()).toEqual({
      count: 1,
    });
  });

  it("reports the remaining authorization and registration rate windows", async () => {
    const request = new Request(`${ORIGIN}/oauth/authorize`);
    const sourceKey = `oauth-authorize:${await sourceRateLimitKey(request)}`;
    const nextWindow = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
    await exhaustRate(sourceKey, 30);
    await exhaustRate("oauth-client-registrations", 100);
    await env.DB.prepare("UPDATE rateLimit SET lastRequest=?").bind(nextWindow).run();
    const source = await SELF.fetch(`${ORIGIN}/oauth/authorize?${authorizationParams("not-registered")}`);
    const registration = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:3800/callback"] }),
    });
    // A future recorded window cannot be reopened by a lagging request.
    // Its retry time exceeds the old hard-coded 60 seconds.
    for (const response of [source, registration]) {
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(60);
      expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(120);
    }
  });

  it("touches registered client activity only when the previous activity is old", async () => {
    const clientId = await register();
    const initial = (await env.DB.prepare("SELECT updated_at FROM oauth_clients WHERE client_id=?")
      .bind(clientId)
      .first<{ updated_at: number }>())!;
    const params = authorizationParams(clientId);
    expect((await authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${params}`), env)).status).toBe(302);
    expect(
      await env.DB.prepare("SELECT updated_at FROM oauth_clients WHERE client_id=?").bind(clientId).first(),
    ).toEqual(initial);
    await env.DB.prepare("UPDATE oauth_clients SET updated_at=? WHERE client_id=?")
      .bind(Date.now() - 2 * 60 * 60_000, clientId)
      .run();
    expect((await authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${params}`), env)).status).toBe(302);
    const touched = (await env.DB.prepare("SELECT updated_at FROM oauth_clients WHERE client_id=?")
      .bind(clientId)
      .first<{ updated_at: number }>())!;
    expect(touched.updated_at).toBeGreaterThan(initial.updated_at - 60_000);
    expect((await authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${params}`), env)).status).toBe(302);
    expect(
      await env.DB.prepare("SELECT updated_at FROM oauth_clients WHERE client_id=?").bind(clientId).first(),
    ).toEqual(touched);
  });

  it("shares an installation limit across anonymous metadata fetches and registrations", async () => {
    await exhaustRate("oauth-client-registrations", 100);
    const fetcher = vi.fn(async (input: URL | string) =>
      Response.json({ client_id: String(input), redirect_uris: ["http://127.0.0.1:3800/callback"] }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      authorizeOAuthGet(
        new Request(`${ORIGIN}/oauth/authorize?${authorizationParams("https://client.public.org/client.json")}`),
        env,
      ),
    ).rejects.toMatchObject({ status: 429 });
    const response = await registerOAuthClient(
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.public.org/callback"] }),
      }),
      env,
    );
    expect(response.status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM oauth_clients").first()).toEqual({ count: 0 });
  });

  it("shares the source authorization budget across GET and POST before metadata resolution", async () => {
    const request = new Request(`${ORIGIN}/oauth/authorize`);
    await exhaustRate(`oauth-authorize:${await sourceRateLimitKey(request)}`, 30);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const params = authorizationParams("https://client.public.org/client.json");
    for (const input of [
      new Request(`${ORIGIN}/oauth/authorize?${params}`),
      new Request(request, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: `${params}&decision=approve`,
      }),
    ])
      await expect(
        input.method === "POST" ? authorizeOAuthPost(input, env) : authorizeOAuthGet(input, env),
      ).rejects.toMatchObject({ status: 429 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("admits only one new client at capacity and permits existing metadata refreshes", async () => {
    const clientId = "https://client.public.org/client.json";
    const uris = JSON.stringify(["http://127.0.0.1:3800/callback"]);
    await env.DB.prepare(`INSERT INTO oauth_clients(client_id,name,redirect_uris_json,metadata_url,created_at,updated_at)
      WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<998)
      SELECT 'client-'||value,'Client',?,NULL,0,0 FROM counter`)
      .bind(uris)
      .run();
    await env.DB.prepare("INSERT INTO oauth_clients VALUES (?,'Metadata client',?,?,0,0)")
      .bind(clientId, uris, clientId)
      .run();
    const requests = [1, 2].map((value) =>
      registerOAuthClient(
        new Request(`${ORIGIN}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${value}` },
          body: JSON.stringify({ redirect_uris: ["https://client.public.org/callback"] }),
        }),
        env,
      ),
    );
    expect(
      (await Promise.all(requests)).map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([201, 503]);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM oauth_clients").first()).toEqual({ count: 1000 });
    const fetcher = vi.fn(async () => Response.json({ client_id: clientId, redirect_uris: JSON.parse(uris) }));
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${authorizationParams(clientId)}`), env)).status,
    ).toBe(302);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      authorizeOAuthGet(
        new Request(`${ORIGIN}/oauth/authorize?${authorizationParams("https://new.public.org/client.json")}`),
        env,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches validated metadata across sign-in and consent, then refreshes it", async () => {
    const cookie = await bootstrap();
    const clientId = "https://client.public.org/client.json";
    let redirect = "http://127.0.0.1/callback";
    const fetcher = vi.fn(async () =>
      Response.json({
        client_id: clientId,
        client_name: "Metadata client",
        redirect_uris: [redirect],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const params = authorizationParams(clientId, "http://127.0.0.1:53211/callback");
    expect((await authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${params}`), env)).status).toBe(302);
    expect(
      (await authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${params}`, { headers: { cookie } }), env))
        .status,
    ).toBe(200);
    expect(
      (
        await authorizeOAuthPost(
          new Request(`${ORIGIN}/oauth/authorize`, {
            method: "POST",
            headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: `${params}&decision=deny`,
          }),
          env,
        )
      ).status,
    ).toBe(302);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await env.DB.prepare("UPDATE oauth_clients SET updated_at=? WHERE client_id=?")
      .bind(Date.now() - 6 * 60_000, clientId)
      .run();
    redirect = "http://127.0.0.1/new-callback";
    await expect(
      authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${params}`, { headers: { cookie } }), env),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await authorizeOAuthGet(
          new Request(
            `${ORIGIN}/oauth/authorize?${authorizationParams(clientId, "http://127.0.0.1:53211/new-callback")}`,
            { headers: { cookie } },
          ),
          env,
        )
      ).status,
    ).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["http://127.0.0.1/callback", "http://127.0.0.1:53211/callback", 200],
    ["http://[::1]/callback", "http://[::1]:53211/callback", 200],
    ["http://localhost:3800/callback", "http://localhost:53211/callback", 400],
    ["http://127.0.0.1/callback", "http://127.0.0.1:53211/other", 400],
    ["http://127.0.0.1/callback?q=one", "http://127.0.0.1:53211/callback?q=two", 400],
    ["http://127.0.0.1/callback", "http://127.0.0.1:99999/callback", 400],
    ["https://client.public.org/callback", "https://client.public.org:53211/callback", 400],
  ])("binds redirect components except loopback IP ports: %s → %s", async (registered, requested, status) => {
    const cookie = await bootstrap();
    const clientId = await register([registered]);
    const consent = await SELF.fetch(`${ORIGIN}/oauth/authorize?${authorizationParams(clientId, requested)}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(consent.status).toBe(status);
  });

  it.each(["private redirect", "mismatched identity", "oversized metadata", "redirect limit"])(
    "rejects unsafe CIMD %s without caching it",
    async (scenario) => {
      const clientId = "https://client.public.org/client.json";
      const fetcher = vi.fn(async () =>
        scenario === "private redirect"
          ? new Response(null, { status: 302, headers: { location: "https://127.0.0.1/internal" } })
          : scenario === "redirect limit"
            ? new Response(null, { status: 302, headers: { location: "/again.json" } })
            : Response.json({
                client_id: scenario === "mismatched identity" ? "https://other.public.org/client.json" : clientId,
                redirect_uris: ["http://127.0.0.1/callback"],
                client_name: scenario === "oversized metadata" ? "x".repeat(33_000) : "Client",
              }),
      );
      vi.stubGlobal("fetch", fetcher);
      await expect(
        authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${authorizationParams(clientId)}`), env),
      ).rejects.toMatchObject({ status: 400 });
      expect(fetcher).toHaveBeenCalledTimes(scenario === "redirect limit" ? 4 : 1);
      expect(await env.DB.prepare("SELECT client_id FROM oauth_clients").first()).toBeNull();
    },
  );

  it("prunes abandoned clients and old grants while preserving codes, tokens, receipts and recently reused clients", async () => {
    const cookie = await bootstrap();
    const connection = await connect(cookie);
    const now = Date.now();
    const oldClient = now - 8 * 24 * 60 * 60_000;
    const oldGrant = now - 31 * 24 * 60 * 60_000;
    const ids = [
      "abandoned",
      "live-code",
      "consumed-code",
      "reused",
      "receipt-client",
      "empty-client",
      "recent-revocation",
    ];
    const uris = JSON.stringify(["http://127.0.0.1:3800/callback"]);
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare("INSERT INTO oauth_clients VALUES (?,'Client',?,NULL,?,?)").bind(id, uris, oldClient, oldClient),
      ),
    );
    for (const [clientId, consumed] of [
      ["live-code", null],
      ["consumed-code", now],
    ] as const) {
      await env.DB.prepare(`INSERT INTO oauth_authorization_codes(code_hash,client_id,user_id,workspace_id,redirect_uri,resource,scopes,code_challenge,security_generation,expires_at,consumed_at)
        SELECT ?,?,?,?,? ,?,'pages:read','challenge',generation,?,? FROM account_security WHERE user_id=?`)
        .bind(
          clientId,
          clientId,
          connection.user.id,
          connection.workspace.id,
          "http://127.0.0.1:3800/callback",
          RESOURCE,
          now + 60_000,
          consumed,
          connection.user.id,
        )
        .run();
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE oauth_grants SET created_at=?,revoked_at=? WHERE id=?").bind(
        oldGrant,
        oldGrant,
        connection.grantId,
      ),
      env.DB.prepare("UPDATE oauth_clients SET updated_at=? WHERE client_id=?").bind(oldClient, connection.clientId),
      ...["receipt-client", "empty-client", "recent-revocation"].map((id) =>
        env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at,revoked_at)
        SELECT ?,?,?,?,'pages:read',generation,?,? FROM account_security WHERE user_id=?`).bind(
          id,
          id,
          connection.user.id,
          connection.workspace.id,
          oldGrant,
          id === "recent-revocation" ? now : oldGrant,
          connection.user.id,
        ),
      ),
      env.DB.prepare(
        "INSERT INTO oauth_operation_receipts VALUES ('receipt-client','retained','create_comment','hash','{}',?,?)",
      ).bind(oldGrant, now + 60_000),
    ]);
    expect(
      (await authorizeOAuthGet(new Request(`${ORIGIN}/oauth/authorize?${authorizationParams("reused")}`), env)).status,
    ).toBe(302);
    const before = await env.DB.prepare("SELECT COUNT(*) count FROM pages").first();
    await pruneOAuthSecurityRecords(env);
    const remaining = await env.DB.prepare("SELECT client_id FROM oauth_clients ORDER BY client_id").all<{
      client_id: string;
    }>();
    expect(remaining.results.map((row) => row.client_id).sort()).toEqual(
      [...ids.filter((id) => !["abandoned", "empty-client"].includes(id)), connection.clientId].sort(),
    );
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM pages").first()).toEqual(before);
    const migration = env.TEST_MIGRATIONS!.find((entry) => entry.name === "0064_oauth_cleanup_indexes.sql")!;
    for (const query of migration.queries) await env.DB.prepare(query).run();
    expect(
      await env.DB.prepare("SELECT operation_id FROM oauth_operation_receipts WHERE grant_id='receipt-client'").first(),
    ).toEqual({ operation_id: "retained" });
  });

  it("keeps active connections visible and paginates older connections through the member settings routes", async () => {
    const cookie = await bootstrap();
    const connection = await connect(cookie);
    const headers = { cookie, origin: ORIGIN };
    expect(await (await SELF.fetch(`${ORIGIN}/api/oauth/workspace`, { headers })).json()).toEqual({ enabled: true });
    await env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at,revoked_at)
      WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<105)
      SELECT 'revoked-'||value,client_id,user_id,workspace_id,scopes,security_generation,created_at+value,created_at+value
      FROM counter CROSS JOIN oauth_grants WHERE id=?`)
      .bind(connection.grantId)
      .run();
    const first = await (
      await SELF.fetch(`${ORIGIN}/api/oauth/connections`, { headers })
    ).json<{ connections: Array<{ id: string }>; nextCursor: string | null }>();
    expect(first.connections).toHaveLength(100);
    expect(first.connections[0]!.id).toBe(connection.grantId);
    expect(first.nextCursor).not.toBeNull();
    const second = await (
      await SELF.fetch(`${ORIGIN}/api/oauth/connections?cursor=${first.nextCursor}`, { headers })
    ).json<typeof first>();
    expect(second.connections).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.connections, ...second.connections].map((row) => row.id)).size).toBe(106);
    expect((await SELF.fetch(`${ORIGIN}/api/oauth/connections?cursor=invalid`, { headers })).status).toBe(400);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/oauth/connections/${connection.grantId}`, {
          method: "DELETE",
          headers: { cookie, origin: "https://foreign.public.org" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await SELF.fetch(`${ORIGIN}/api/oauth/connections/${connection.grantId}`, { method: "DELETE", headers })).status,
    ).toBe(204);
    expect(
      await mcpAccess(new Request(RESOURCE, { headers: { authorization: `Bearer ${connection.token}` } }), env),
    ).toBeNull();
    const otherOwner = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?,'Other owner','other@example.test',1,1)",
      ).bind(otherOwner),
      env.DB.prepare("INSERT INTO workspace_members VALUES (?,?,'owner',1)").bind(connection.workspace.id, otherOwner),
      env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id=?").bind(connection.user.id),
    ]);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/oauth/workspace`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(403);
  });

  it("distinguishes rejected bearer tokens from missing credentials", async () => {
    const cookie = await bootstrap();
    const connection = await connect(cookie);
    await env.DB.prepare("UPDATE oauth_access_tokens SET expires_at=0 WHERE grant_id=?").bind(connection.grantId).run();
    for (const authorization of [undefined, "Basic abc", `Bearer ${connection.token}`, "Bearer malformed"]) {
      const response = await SELF.fetch(RESOURCE, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")!.includes('error="invalid_token"')).toBe(
        authorization?.startsWith("Bearer") ?? false,
      );
    }
  });

  it.each([
    [422, "test_rejection", "invalid_mutation", false],
    [413, "test_rejection", "document_limit", false],
    [404, "block_not_found", "block_not_found", false],
    [410, "test_rejection", "page_not_found", false],
    [409, "revision_changed", "page_changed", false],
    [409, "This document is read-only.", "document_read_only", false],
    [409, "duplicate_date_token", "duplicate_date_token", false],
    [409, "idempotency_key_reused", "idempotency_key_reused", false],
    [409, "test_rejection", "mutation_conflict", false],
    [401, "test_rejection", "document_unavailable", true],
    [403, "test_rejection", "document_unavailable", true],
    [408, "test_rejection", "document_unavailable", true],
    [429, "test_rejection", "document_busy", true],
    [503, "test_rejection", "document_unavailable", true],
  ] as const)(
    "preserves the create and update failure class for DO %s %s",
    async (status, rejection, code, retryable) => {
      const cookie = await bootstrap();
      const connection = await connect(cookie);
      const args = {
        space_id: connection.page.spaceId,
        title: "Rejected page",
        markdown: "Content",
        operation_id: "rejected-create",
      };
      const created = await toolCall(connection.token, "create_page", args, failingMutations(status, rejection));
      expect(created.result).toMatchObject({ isError: true, structuredContent: { error: { code, retryable } } });
      const replay = await toolCall(connection.token, "create_page", args);
      expect(replay.result.isError ?? false).toBe(!retryable);
      expect(replay.result.structuredContent?.error).toEqual(retryable ? undefined : { code, retryable });
      const published = await toolCall(connection.token, "create_page", {
        ...args,
        title: "Update target",
        operation_id: "update-target",
      });
      const pageId = (JSON.parse(published.result.content[0]!.text) as { id: string }).id;
      const updated = await toolCall(
        connection.token,
        "update_page",
        {
          page_id: pageId,
          command: { type: "insert_content", insert_content: { content: "Another line", position: { type: "end" } } },
          operation_id: "rejected-update",
        },
        failingMutations(status, rejection),
      );
      expect(updated.result).toMatchObject({ isError: true, structuredContent: { error: { code, retryable } } });
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(pageId).first()).toEqual({ id: pageId });
    },
  );

  it("serves stateless 2026 discovery and read tools with a member token", async () => {
    const cookie = await bootstrap();
    const clientId = await register();
    const me = await (
      await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie, origin: ORIGIN } })
    ).json<{ user: { id: string }; workspace: { id: string } }>();
    const grantId = crypto.randomUUID();
    const token = "m".repeat(64);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at)
         SELECT ?,?,?,?,?,generation,? FROM account_security WHERE user_id=?`,
      ).bind(
        grantId,
        clientId,
        me.user.id,
        me.workspace.id,
        "pages:read pages:write comments:write",
        Date.now(),
        me.user.id,
      ),
      env.DB.prepare("INSERT INTO oauth_access_tokens(token_hash,grant_id,resource,expires_at) VALUES(?,?,?,?)").bind(
        hash,
        grantId,
        RESOURCE,
        Date.now() + 60_000,
      ),
    ]);
    const call = (method: string, params: Record<string, unknown> = {}) =>
      SELF.fetch(RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
    const discovery = await call("server/discover");
    expect(discovery.status).toBe(200);
    const listed = await call("tools/list");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("search_pages");
    const searched = await call("tools/call", { name: "search_pages", arguments: { query: "Welcome" } });
    expect(searched.status).toBe(200);
    expect(JSON.stringify(await searched.json())).toContain("pages");
    const tree = await (
      await SELF.fetch(`${ORIGIN}/api/pages/tree`, { headers: { cookie, origin: ORIGIN } })
    ).json<{ pages: Array<{ id: string; spaceId: string }> }>();
    const commentArgs = {
      page_id: tree.pages[0]!.id,
      body: "MCP comment",
      operation_id: "same-comment",
    };
    const comment = await call("tools/call", { name: "create_comment", arguments: commentArgs });
    expect(comment.status).toBe(200);
    const firstComment = await comment.json();
    expect(JSON.stringify(firstComment)).toContain("threadId");
    const replay = await call("tools/call", { name: "create_comment", arguments: commentArgs });
    expect(await replay.json()).toEqual(firstComment);
    const threads = await env.DB.prepare("SELECT COUNT(*) count FROM comment_threads WHERE page_id=?")
      .bind(commentArgs.page_id)
      .first<{ count: number }>();
    expect(threads?.count).toBe(1);
    const savedComment = await env.DB.prepare(
      "SELECT body_json FROM comments WHERE thread_id IN (SELECT id FROM comment_threads WHERE page_id=?)",
    )
      .bind(commentArgs.page_id)
      .first<{ body_json: string }>();
    expect(JSON.parse(savedComment!.body_json)).toMatchObject([
      { type: "paragraph", content: [{ type: "text", text: "MCP comment" }] },
    ]);
    const createArgs = {
      space_id: tree.pages[0]!.spaceId,
      title: "MCP created page",
      markdown: "A **created** document.\n",
      operation_id: "same-page",
    };
    const created = await call("tools/call", { name: "create_page", arguments: createArgs });
    expect(created.status).toBe(200);
    const firstCreate = await created.json();
    expect(JSON.stringify(firstCreate)).toContain("MCP created page");
    const retriedCreate = await call("tools/call", { name: "create_page", arguments: createArgs });
    expect(await retriedCreate.json()).toEqual(firstCreate);
    const createdRows = await env.DB.prepare("SELECT id FROM pages WHERE workspace_id=? AND title=?")
      .bind(me.workspace.id, createArgs.title)
      .all<{ id: string }>();
    expect(createdRows.results).toHaveLength(1);
    const createdPageId = createdRows.results[0]!.id;
    const indexed = await env.DB.prepare("SELECT body FROM page_search WHERE page_id=?")
      .bind(createdPageId)
      .first<{ body: string }>();
    expect(indexed?.body).toContain("created");
    const updateArgs = {
      page_id: createdPageId,
      command: { type: "insert_content", insert_content: { content: "Another line", position: { type: "end" } } },
      operation_id: "same-update",
    };
    const updated = await call("tools/call", { name: "update_page", arguments: updateArgs });
    expect(updated.status).toBe(200);
    const firstUpdate = await updated.json();
    expect(JSON.stringify(firstUpdate)).toContain("revision");
    const retriedUpdate = await call("tools/call", { name: "update_page", arguments: updateArgs });
    expect(await retriedUpdate.json()).toEqual(firstUpdate);
    const fetched = await call("tools/call", {
      name: "fetch_page",
      arguments: { page_id: createdPageId },
    });
    const content = JSON.stringify(await fetched.json());
    expect(content).toContain("created");
    expect(content).toContain("Another line");
    expect(content.match(/Another line/g)).toHaveLength(1);
    const replacementOwner = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?,'Other owner','other@example.test',1,1)",
      ).bind(replacementOwner),
      env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES (?,?,'owner',1)").bind(
        me.workspace.id,
        replacementOwner,
      ),
    ]);
    await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND user_id=?")
      .bind(me.workspace.id, me.user.id)
      .run();
    const deniedEdit = await call("tools/call", {
      name: "update_page",
      arguments: { ...updateArgs, operation_id: "viewer-update" },
    });
    expect(JSON.stringify(await deniedEdit.json())).toContain("read-only");
    const legacy = await SELF.fetch(RESOURCE, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
    });
    expect(legacy.status).not.toBe(200);
    await env.DB.prepare("UPDATE oauth_grants SET revoked_at=? WHERE id=?").bind(Date.now(), grantId).run();
    const revoked = await call("tools/call", { name: "fetch_page", arguments: { page_id: createdPageId } });
    expect(revoked.status).toBe(401);
  });

  it("advertises this host as a protected resource and an authorization server", async () => {
    const resource = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    const authorization = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN] });
    expect(await authorization.json()).toMatchObject({
      issuer: ORIGIN,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("requires registered redirects, exact audience, PKCE, and one-use authorization codes", async () => {
    const cookie = await bootstrap();
    const clientId = await register();
    const verifier = "v".repeat(43);
    const params = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:53211/callback",
      resource: RESOURCE,
      scope: "pages:read pages:write",
      state: "opaque-client-state",
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    };
    const consent = await SELF.fetch(`${ORIGIN}/oauth/authorize?${form(params)}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:53211");
    expect(await consent.text()).toContain("Test MCP client");
    const injectedDecision = await SELF.fetch(`${ORIGIN}/oauth/authorize?${form({ ...params, decision: "deny" })}`, {
      headers: { cookie },
    });
    expect(await injectedDecision.text()).not.toContain('type="hidden" name="decision"');
    const signedOut = await SELF.fetch(`${ORIGIN}/oauth/authorize?${form(params)}`, { redirect: "manual" });
    expect(signedOut.status).toBe(302);
    expect(new URL(signedOut.headers.get("location")!).searchParams.get("oauthAuthorize")).toContain(
      "/oauth/authorize?",
    );
    const badRedirect = await SELF.fetch(
      `${ORIGIN}/oauth/authorize?${form({ ...params, redirect_uri: "https://evil.example/callback" })}`,
      { headers: { cookie }, redirect: "manual" },
    );
    expect(badRedirect.status).toBe(400);
    for (const [changes, expectedError] of [
      [{ resource: `${ORIGIN}/other` }, "invalid_target"],
      [{ scope: "" }, "invalid_scope"],
      [{ code_challenge: "short" }, "invalid_request"],
    ] as const) {
      const rejected = await SELF.fetch(`${ORIGIN}/oauth/authorize?${form({ ...params, ...changes })}`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(rejected.status).toBe(302);
      const location = new URL(rejected.headers.get("location")!);
      expect(location.origin).toBe("http://127.0.0.1:53211");
      expect(location.searchParams.get("error")).toBe(expectedError);
      expect(location.searchParams.get("state")).toBe(params.state);
    }
    const deny = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...params, decision: "deny" }),
      redirect: "manual",
    });
    expect(deny.status).toBe(302);
    const denial = new URL(deny.headers.get("location")!);
    expect(denial.searchParams.get("error")).toBe("access_denied");
    expect(denial.searchParams.get("state")).toBe(params.state);
    expect(denial.searchParams.get("iss")).toBe(ORIGIN);
    const invalidDecision = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...params, decision: "other" }),
      redirect: "manual",
    });
    expect(invalidDecision.status).toBe(302);
    expect(new URL(invalidDecision.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const approve = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...params, decision: "approve" }),
      redirect: "manual",
    });
    expect(approve.status).toBe(302);
    const location = new URL(approve.headers.get("location")!);
    expect(location.origin).toBe("http://127.0.0.1:53211");
    expect(location.searchParams.get("state")).toBe(params.state);
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    const code = location.searchParams.get("code")!;
    const tokenRequest = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: params.redirect_uri,
      resource: RESOURCE,
      code_verifier: verifier,
    };
    const wrongPort = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...tokenRequest, redirect_uri: "http://127.0.0.1:3800/callback" }),
    });
    expect(wrongPort.status).toBe(400);
    const wrongVerifier = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...tokenRequest, code_verifier: "x".repeat(43) }),
    });
    expect(wrongVerifier.status).toBe(400);
    const exchange = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(tokenRequest),
    });
    expect(exchange.status).toBe(200);
    const tokens = await exchange.json<{ access_token: string; refresh_token: string }>();
    const access = await mcpAccess(
      new Request(RESOURCE, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
      env,
    );
    expect(access?.scopes).toEqual(new Set(["pages:read", "pages:write"]));
    const refreshRequest = {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource: RESOURCE,
    };
    const refreshed = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(refreshRequest),
    });
    expect(refreshed.status).toBe(200);
    const refreshedTokens = await refreshed.json<{ access_token: string; refresh_token: string }>();
    expect(refreshedTokens.refresh_token).not.toBe(tokens.refresh_token);
    const replay = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(refreshRequest),
    });
    expect(replay.status).toBe(400);
    expect(
      await mcpAccess(
        new Request(RESOURCE, { headers: { authorization: `Bearer ${refreshedTokens.access_token}` } }),
        env,
      ),
    ).toBeNull();
    const reuse = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(tokenRequest),
    });
    expect(reuse.status).toBe(400);
    const revoke = await SELF.fetch(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: clientId, token: refreshedTokens.refresh_token }),
    });
    expect(revoke.status).toBe(200);
    expect(
      await mcpAccess(new Request(RESOURCE, { headers: { authorization: `Bearer ${tokens.access_token}` } }), env),
    ).toBeNull();
  });

  it("rejects local client metadata URLs before fetching", async () => {
    const cookie = await bootstrap();
    const response = await SELF.fetch(
      `${ORIGIN}/oauth/authorize?${form({
        response_type: "code",
        client_id: "https://127.0.0.1/client.json",
        redirect_uri: "http://127.0.0.1:3800/callback",
        resource: RESOURCE,
        scope: "pages:read",
        state: "state",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(400);
  });

  it("invalidates access after an account security generation change", async () => {
    const cookie = await bootstrap();
    const clientId = await register();
    const me = await (
      await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie, origin: ORIGIN } })
    ).json<{ user: { id: string }; workspace: { id: string } }>();
    const grantId = crypto.randomUUID();
    const token = "g".repeat(64);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at)
         SELECT ?,?,?,?,?,generation,? FROM account_security WHERE user_id=?`,
      ).bind(grantId, clientId, me.user.id, me.workspace.id, "pages:read", Date.now(), me.user.id),
      env.DB.prepare("INSERT INTO oauth_access_tokens(token_hash,grant_id,resource,expires_at) VALUES(?,?,?,?)").bind(
        hash,
        grantId,
        RESOURCE,
        Date.now() + 60_000,
      ),
    ]);
    const request = new Request(RESOURCE, { headers: { authorization: `Bearer ${token}` } });
    expect(await mcpAccess(request, env)).not.toBeNull();
    const insufficient = await SELF.fetch(RESOURCE, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_comment", arguments: {} },
      }),
    });
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain('scope="pages:read comments:write"');
    await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?").bind(me.user.id).run();
    expect(await mcpAccess(request, env)).toBeNull();
    const revoked = await env.DB.prepare("SELECT revoked_at FROM oauth_grants WHERE id=?")
      .bind(grantId)
      .first<{ revoked_at: number | null }>();
    expect(revoked?.revoked_at).not.toBeNull();
  });

  it("prunes an abandoned MCP page and its staged receipt", async () => {
    const cookie = await bootstrap();
    const clientId = await register();
    const me = await (
      await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie, origin: ORIGIN } })
    ).json<{ user: { id: string }; workspace: { id: string } }>();
    const tree = await (
      await SELF.fetch(`${ORIGIN}/api/pages/tree`, { headers: { cookie, origin: ORIGIN } })
    ).json<{ pages: Array<{ spaceId: string }> }>();
    const pageId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    const token = "s".repeat(64);
    const args = { space_id: tree.pages[0]!.spaceId, title: "Abandoned", markdown: "", operation_id: "abandoned" };
    const createdAt = Date.now() - 2 * 24 * 60 * 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at)
         SELECT ?,?,?,?,?,generation,? FROM account_security WHERE user_id=?`,
      ).bind(grantId, clientId, me.user.id, me.workspace.id, "pages:write", createdAt, me.user.id),
      env.DB.prepare("INSERT INTO oauth_access_tokens VALUES (?,?,?,?)").bind(
        await sha256(token),
        grantId,
        RESOURCE,
        Date.now() + 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO pages
         (id,workspace_id,space_id,parent_id,kind,position,title,import_job_id,created_by,updated_by,created_at,updated_at)
         VALUES (?,?,?,NULL,'document','z0','Abandoned',?,?,?,?,?)`,
      ).bind(
        pageId,
        me.workspace.id,
        tree.pages[0]!.spaceId,
        `mcp:create:${pageId}`,
        me.user.id,
        me.user.id,
        createdAt,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO oauth_operation_receipts
         (grant_id,operation_id,tool_name,input_hash,result_json,created_at,expires_at)
         VALUES (?,?,'create_page',?,?,?,?)`,
      ).bind(
        grantId,
        "abandoned",
        await sha256(JSON.stringify({ ...args, parent_id: null })),
        JSON.stringify({ status: "staged", pageId, children: [] }),
        createdAt,
        Date.now() + 60_000,
      ),
    ]);
    await env.DB.prepare("UPDATE pages SET import_job_id=?,updated_at=? WHERE id=?")
      .bind(`mcp:cleanup:${pageId}`, Date.now(), pageId)
      .run();
    await pruneStagedMcpPages(env);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(pageId).first()).not.toBeNull();
    await env.DB.prepare("UPDATE pages SET updated_at=? WHERE id=?")
      .bind(Date.now() - 2 * 60_000, pageId)
      .run();
    await pruneStagedMcpPages(env);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(pageId).first()).toBeNull();
    const receipt = await env.DB.prepare("SELECT result_json FROM oauth_operation_receipts WHERE grant_id=?")
      .bind(grantId)
      .first<{ result_json: string }>();
    expect(JSON.parse(receipt!.result_json)).toMatchObject({
      status: "failed",
      error: { code: "page_creation_expired" },
    });
    expect(JSON.parse(receipt!.result_json)).not.toHaveProperty("children");
    expect((await toolCall(token, "create_page", args)).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "page_creation_expired", retryable: false } },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM pages WHERE title='Abandoned'").first()).toEqual({
      count: 0,
    });
  });

  it("bounds registration and token request bodies before parsing", async () => {
    const registration = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x".repeat(33_000), redirect_uris: ["https://client.example/callback"] }),
    });
    expect(registration.status).toBe(413);
    const token = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", token: "x".repeat(9_000) }),
    });
    expect(token.status).toBe(413);
  });

  it("rejects redirect hosts that could alter the consent page CSP", async () => {
    for (const redirect of [
      "https://*.client.example/callback",
      "https://semi;colon.example/callback",
      "https://comma,host.example/callback",
    ]) {
      const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Unsafe redirect", redirect_uris: [redirect] }),
      });
      expect(response.status).toBe(400);
    }
  });
});
