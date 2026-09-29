import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enrollAccount } from "../../tests/helpers/security";
import { mcpAccess } from "./oauth";
import { pruneStagedMcpPages } from "./mcp";

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
  const me = await (
    await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie, origin: ORIGIN } })
  ).json<{ workspace: { id: string } }>();
  await env.DB.prepare("UPDATE workspaces SET mcp_enabled=1 WHERE id=?").bind(me.workspace.id).run();
  return cookie;
}

async function register() {
  const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test MCP client", redirect_uris: ["http://127.0.0.1:3800/callback"] }),
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

describe("OAuth MCP foundation", () => {
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
      redirect_uri: "http://127.0.0.1:3800/callback",
      resource: RESOURCE,
      scope: "pages:read pages:write",
      state: "opaque-client-state",
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    };
    const consent = await SELF.fetch(`${ORIGIN}/oauth/authorize?${form(params)}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:3800");
    expect(await consent.text()).toContain("Test MCP client");
    const signedOut = await SELF.fetch(`${ORIGIN}/oauth/authorize?${form(params)}`, { redirect: "manual" });
    expect(signedOut.status).toBe(302);
    expect(new URL(signedOut.headers.get("location")!).searchParams.get("oauthAuthorize")).toContain(
      "/oauth/authorize?",
    );
    const badRedirect = await SELF.fetch(
      `${ORIGIN}/oauth/authorize?${form({ ...params, redirect_uri: "https://evil.example/callback" })}`,
      { headers: { cookie } },
    );
    expect(badRedirect.status).toBe(400);
    const badAudience = await SELF.fetch(
      `${ORIGIN}/oauth/authorize?${form({ ...params, resource: `${ORIGIN}/other` })}`,
      { headers: { cookie } },
    );
    expect(badAudience.status).toBe(400);
    const approve = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...params, decision: "approve" }),
      redirect: "manual",
    });
    expect(approve.status).toBe(302);
    const location = new URL(approve.headers.get("location")!);
    expect(location.origin).toBe("http://127.0.0.1:3800");
    expect(location.searchParams.get("state")).toBe(params.state);
    const code = location.searchParams.get("code")!;
    const tokenRequest = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: params.redirect_uri,
      resource: RESOURCE,
      code_verifier: verifier,
    };
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
    const createdAt = Date.now() - 2 * 24 * 60 * 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at)
         SELECT ?,?,?,?,?,generation,? FROM account_security WHERE user_id=?`,
      ).bind(grantId, clientId, me.user.id, me.workspace.id, "pages:write", createdAt, me.user.id),
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
        "hash",
        JSON.stringify({ status: "staged", pageId, children: [] }),
        createdAt,
        Date.now() + 60_000,
      ),
    ]);
    await pruneStagedMcpPages(env);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(pageId).first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT operation_id FROM oauth_operation_receipts WHERE grant_id=?").bind(grantId).first(),
    ).toBeNull();
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
});
