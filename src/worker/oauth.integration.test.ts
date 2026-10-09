import {
  applyD1Migrations,
  createExecutionContext,
  env,
  reset,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { enrollAccount } from "../../tests/helpers/security";
import {
  authorizeOAuthGet,
  authorizeOAuthPost,
  mcpAccess,
  oauthToken,
  pruneOAuthSecurityRecords,
  registerOAuthClient,
} from "./oauth";
import { mcpRequest, pruneStagedMcpPages } from "./mcp";
import { sha256 } from "./http";
import { sourceRateLimitKey } from "./source-rate-limit";
import type { Env } from "./env";
import { protectedCommentBlockIds } from "./comments";
import type { DocumentContentEnvelope, ProseMirrorJson } from "../shared/types";
import { documentResultSchema, pagesResultSchema, spacesResultSchema, PLUGIN_UI_URI } from "../shared/plugin-contracts";

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
    .bind(crypto.randomUUID(), key, count, (Math.floor(Date.now() / 60_000) + 1) * 60_000)
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

async function issueCode(cookie: string) {
  const clientId = await register();
  const verifier = "v".repeat(43);
  const params = new URLSearchParams(authorizationParams(clientId));
  params.set("code_challenge", await challenge(verifier));
  params.set("decision", "approve");
  const approval = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const code = new URL(approval.headers.get("location")!).searchParams.get("code");
  expect(code).toBeTruthy();
  return {
    clientId,
    codeHash: await sha256(code!),
    tokenRequest: {
      grant_type: "authorization_code",
      client_id: clientId,
      code: code!,
      redirect_uri: "http://127.0.0.1:3800/callback",
      resource: RESOURCE,
      code_verifier: verifier,
    },
  };
}

function exchangeTokens(request: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(request),
  });
}

function toggleMcp(cookie: string, enabled: boolean) {
  return SELF.fetch(`${ORIGIN}/api/oauth/workspace`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
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
      _meta?: Record<string, unknown>;
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

function afterDatabaseRead(match: string, action: () => Promise<void>): Env {
  let intercepted = false;
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(stmt, method) {
                  if (method === "bind") return (...values: unknown[]) => wrap(stmt.bind(...values));
                  if (method === "first")
                    return async (...args: []) => {
                      const result = await stmt.first(...args);
                      if (!intercepted && sql.includes(match)) {
                        intercepted = true;
                        await action();
                      }
                      return result;
                    };
                  const value = Reflect.get(stmt, method);
                  return typeof value === "function" ? value.bind(stmt) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

async function seedCommentBlocks(connection: Awaited<ReturnType<typeof connect>>) {
  const nativeId = crypto.randomUUID();
  const nestedId = crypto.randomUUID();
  const block = (id: string, text: string): ProseMirrorJson => ({
    type: "blockContainer",
    attrs: { id },
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const container = block(nativeId, "Parent");
  container.content!.push({ type: "blockGroup", content: [block(nestedId, "Nested")] });
  const room = env.DOCUMENT.getByName(`${connection.page.id}~1`);
  expect(
    (
      await room.fetch(
        new Request("https://document.internal/api-mutate", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, "content-type": "application/json" },
          body: JSON.stringify({
            actorId: connection.user.id,
            operations: [{ type: "append_children", children: [container] }],
          }),
        }),
      )
    ).status,
  ).toBe(200);
  const snapshot = await (
    await room.fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    )
  ).json<DocumentContentEnvelope>();
  const alias = (await env.DB.prepare("SELECT id FROM api_blocks WHERE page_id=? AND internal_id=?")
    .bind(connection.page.id, nativeId)
    .first<{ id: string }>())!.id;
  return { nativeId, nestedId, alias, snapshot, room };
}

describe("OAuth MCP foundation", () => {
  it("rejects an unknown comment block without creating a thread or operation receipt", async () => {
    const cookie = await bootstrap();
    const connection = await connect(cookie);
    const response = await toolCall(connection.token, "create_comment", {
      page_id: connection.page.id,
      block_id: crypto.randomUUID(),
      body: "Unknown block",
      operation_id: "unknown-block",
    });
    expect(response.result).toMatchObject({ isError: true, structuredContent: { error: { code: "block_not_found" } } });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM comment_threads").first()).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT operation_id FROM oauth_operation_receipts WHERE operation_id='unknown-block'",
      ).first(),
    ).toBeNull();
  });

  it("rolls back a failed token issuance so the same authorization code can be retried", async () => {
    const cookie = await bootstrap();
    const issued = await issueCode(cookie);
    await env.DB.prepare(`CREATE TRIGGER reject_test_token BEFORE INSERT ON oauth_refresh_tokens
      BEGIN SELECT RAISE(ABORT,'Injected token failure'); END`).run();
    expect((await exchangeTokens(issued.tokenRequest)).status).toBe(500);
    for (const table of ["oauth_grants", "oauth_access_tokens", "oauth_refresh_tokens"])
      expect(await env.DB.prepare(`SELECT COUNT(*) count FROM ${table}`).first()).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT consumed_at FROM oauth_authorization_codes WHERE code_hash=?")
        .bind(issued.codeHash)
        .first(),
    ).toEqual({ consumed_at: null });
    await env.DB.prepare("DROP TRIGGER reject_test_token").run();
    expect((await exchangeTokens(issued.tokenRequest)).status).toBe(200);
    expect((await exchangeTokens(issued.tokenRequest)).status).toBe(400);
  });

  it("keeps grants and pending authorization codes revoked across disable and re-enable", async () => {
    const cookie = await bootstrap();
    const issued = await issueCode(cookie);
    const tokenResponse = await exchangeTokens(issued.tokenRequest);
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json<{ access_token: string; refresh_token: string }>();
    const pending = await issueCode(cookie);
    expect((await toggleMcp(cookie, false)).status).toBe(200);
    expect((await toggleMcp(cookie, true)).status).toBe(200);
    expect(
      await mcpAccess(new Request(RESOURCE, { headers: { authorization: `Bearer ${tokens.access_token}` } }), env),
    ).toBeNull();
    expect(
      (
        await exchangeTokens({
          grant_type: "refresh_token",
          client_id: issued.clientId,
          refresh_token: tokens.refresh_token,
          resource: RESOURCE,
        })
      ).status,
    ).toBe(400);
    expect((await exchangeTokens(pending.tokenRequest)).status).toBe(400);
    const next = await issueCode(cookie);
    expect((await exchangeTokens(next.tokenRequest)).status).toBe(200);
  });

  it("accepts live public and native comment IDs, including nested blocks, and replays after deletion", async () => {
    const connection = await connect(await bootstrap());
    const blocks = await seedCommentBlocks(connection);
    const responses = [];
    for (const id of [blocks.alias, blocks.nativeId, blocks.nestedId]) {
      const response = await toolCall(connection.token, "create_comment", {
        page_id: connection.page.id,
        body: "Valid comment",
        block_id: id,
        operation_id: `comment:${id}`,
      });
      expect(response.result.isError).not.toBe(true);
      responses.push(response);
    }
    const blockedEdit = await toolCall(connection.token, "update_page", {
      page_id: connection.page.id,
      operation_id: "protect-native-comment",
      command: { type: "replace_content", replace_content: { new_str: "Replacement", allow_deleting_content: true } },
    });
    expect(blockedEdit.result.isError).toBe(true);
    expect(JSON.stringify(blockedEdit)).toContain("comments or comment anchors");
    expect(
      (
        await blocks.room.fetch(
          new Request("https://document.internal/api-mutate", {
            method: "POST",
            headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, "content-type": "application/json" },
            body: JSON.stringify({
              actorId: connection.user.id,
              operations: [{ type: "delete_block", internalId: blocks.nativeId }],
            }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      await toolCall(connection.token, "create_comment", {
        page_id: connection.page.id,
        body: "Valid comment",
        block_id: blocks.alias,
        operation_id: `comment:${blocks.alias}`,
      }),
    ).toEqual(responses[0]);
    const rejected = await toolCall(connection.token, "create_comment", {
      page_id: connection.page.id,
      body: "Deleted target",
      block_id: blocks.alias,
      operation_id: "deleted-target",
    });
    expect(rejected.result.structuredContent?.error.code).toBe("block_not_found");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM comment_threads").first()).toEqual({ count: 3 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM oauth_operation_receipts WHERE tool_name='create_comment'",
      ).first(),
    ).toEqual({ count: 3 });
  });

  it("rejects a foreign public ID even when it matches a live native ID and ignores poisoned protection IDs", async () => {
    const connection = await connect(await bootstrap());
    const blocks = await seedCommentBlocks(connection);
    await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
      SELECT 'foreign-page',workspace_id,space_id,kind,'z9','Other page',created_by,created_at,updated_at FROM pages WHERE id=?`)
      .bind(connection.page.id)
      .run();
    await env.DB.prepare(`INSERT INTO api_blocks(id,page_id,internal_id,content_hash,created_at,updated_at)
      VALUES (?,'foreign-page','foreign-native','hash',1,1)`)
      .bind(blocks.nativeId)
      .run();
    const rejected = await toolCall(connection.token, "create_comment", {
      page_id: connection.page.id,
      body: "Foreign target",
      block_id: blocks.nativeId,
      operation_id: "foreign-target",
    });
    expect(rejected.result.structuredContent?.error.code).toBe("block_not_found");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM comment_threads").first()).toEqual({ count: 0 });
    for (const id of [blocks.alias, blocks.nestedId, blocks.nativeId, "unmatched-raw-id"]) {
      await env.DB.prepare(`INSERT INTO comment_threads(id,workspace_id,space_id,page_id,created_by,block_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,1,1)`)
        .bind(
          crypto.randomUUID(),
          connection.workspace.id,
          connection.page.spaceId,
          connection.page.id,
          connection.user.id,
          id,
        )
        .run();
    }
    // Native nested IDs remain valid even when the derived API index is missing.
    await env.DB.prepare("DELETE FROM api_blocks WHERE page_id=? AND internal_id=?")
      .bind(connection.page.id, blocks.nestedId)
      .run();
    expect(await protectedCommentBlockIds(env, connection.page.id, blocks.snapshot.document)).toEqual(
      new Set([blocks.nativeId, blocks.nestedId]),
    );
    await env.DB.prepare("UPDATE api_blocks SET deleted_at=1 WHERE id=?").bind(blocks.alias).run();
    expect(await protectedCommentBlockIds(env, connection.page.id, blocks.snapshot.document)).toEqual(
      new Set([blocks.nativeId, blocks.nestedId]),
    );
    await env.DB.prepare("DELETE FROM comment_threads WHERE page_id=?").bind(connection.page.id).run();
    await env.DB.prepare(`INSERT INTO comment_threads(id,workspace_id,space_id,page_id,created_by,block_id,created_at,updated_at)
      VALUES ('poisoned',?,?,?,?,?,1,1)`)
      .bind(connection.workspace.id, connection.page.spaceId, connection.page.id, connection.user.id, blocks.nativeId)
      .run();
    const edited = await toolCall(connection.token, "update_page", {
      page_id: connection.page.id,
      operation_id: "ignore-foreign-comment",
      command: { type: "replace_content", replace_content: { new_str: "Replacement", allow_deleting_content: true } },
    });
    expect(edited.result.isError).not.toBe(true);
  });

  it("keeps live public comment targets usable and protected when their derived index is stale", async () => {
    const connection = await connect(await bootstrap());
    const blocks = await seedCommentBlocks(connection);
    await env.DB.prepare("UPDATE api_blocks SET deleted_at=1 WHERE id=?").bind(blocks.alias).run();
    const commented = await toolCall(connection.token, "create_comment", {
      page_id: connection.page.id,
      block_id: blocks.alias,
      body: "Live target",
      operation_id: "stale-index-comment",
    });
    expect(commented.result.isError).not.toBe(true);
    expect(await protectedCommentBlockIds(env, connection.page.id, blocks.snapshot.document)).toEqual(
      new Set([blocks.nativeId]),
    );
    const edited = await toolCall(connection.token, "update_page", {
      page_id: connection.page.id,
      operation_id: "stale-index-edit",
      command: { type: "replace_content", replace_content: { new_str: "Replacement", allow_deleting_content: true } },
    });
    expect(edited.result.isError).toBe(true);
    expect(JSON.stringify(edited)).toContain("comments or comment anchors");
  });

  it("rejects consent when its browser session is signed out during client resolution", async () => {
    const cookie = await bootstrap();
    const clientId = await register();
    const bindings = afterDatabaseRead(
      "SELECT client_id,name,redirect_uris_json,metadata_url,updated_at FROM oauth_clients WHERE client_id=?",
      async () => {
        const signout = await SELF.fetch(`${ORIGIN}/api/auth/sign-out`, {
          method: "POST",
          headers: { cookie, origin: ORIGIN },
        });
        expect(signout.status).toBe(200);
      },
    );
    const response = await authorizeOAuthPost(
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: `${authorizationParams(clientId)}&decision=approve`,
      }),
      bindings,
    );
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM oauth_authorization_codes").first()).toEqual({ count: 0 });
  });

  it("lets only one concurrent exchange consume a code and leaves the winning grant usable", async () => {
    const issued = await issueCode(await bootstrap());
    const responses = await Promise.all([exchangeTokens(issued.tokenRequest), exchangeTokens(issued.tokenRequest)]);
    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 400]);
    const tokens = await responses.find((response) => response.status === 200)!.json<{ access_token: string }>();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM oauth_grants").first()).toEqual({ count: 1 });
    expect(
      await mcpAccess(new Request(RESOURCE, { headers: { authorization: `Bearer ${tokens.access_token}` } }), env),
    ).not.toBeNull();
  });

  it.each([
    "SELECT mcp_enabled,mcp_generation",
    "SELECT client_id,name,redirect_uris_json,metadata_url,updated_at FROM oauth_clients WHERE client_id=?",
  ])("rejects consent already in progress across a disable and re-enable cycle during %s", async (query) => {
    const cookie = await bootstrap();
    const clientId = await register();
    const bindings = afterDatabaseRead(query, async () => {
      expect((await toggleMcp(cookie, false)).status).toBe(200);
      expect((await toggleMcp(cookie, true)).status).toBe(200);
    });
    const response = await authorizeOAuthPost(
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: `${authorizationParams(clientId)}&decision=approve`,
      }),
      bindings,
    );
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM oauth_authorization_codes").first()).toEqual({ count: 0 });
  });

  it.each(["authorization_code", "refresh_token"])(
    "rejects an in-flight %s exchange after disabling and re-enabling MCP",
    async (grantType) => {
      const cookie = await bootstrap();
      const issued = await issueCode(cookie);
      let values: Record<string, string> = issued.tokenRequest;
      if (grantType === "refresh_token") {
        const tokens = await (await exchangeTokens(issued.tokenRequest)).json<{ refresh_token: string }>();
        values = {
          grant_type: grantType,
          client_id: issued.clientId,
          refresh_token: tokens.refresh_token,
          resource: RESOURCE,
        };
      }
      const bindings = afterDatabaseRead(
        grantType === "authorization_code" ? "SELECT 1 valid FROM workspace_members member" : "SELECT refresh.grant_id",
        async () => {
          expect((await toggleMcp(cookie, false)).status).toBe(200);
          expect((await toggleMcp(cookie, true)).status).toBe(200);
        },
      );
      const response = await oauthToken(
        new Request(`${ORIGIN}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form(values),
        }),
        bindings,
      );
      expect(response.status).toBe(400);
      expect((await response.json<{ error_description: string }>()).error_description).toBe(
        grantType === "refresh_token"
          ? "The refresh token is no longer valid."
          : "The authorization code is invalid or already used.",
      );

      expect(await env.DB.prepare("SELECT COUNT(*) count FROM oauth_grants WHERE revoked_at IS NULL").first()).toEqual({
        count: 0,
      });
      expect(await env.DB.prepare("SELECT COUNT(*) count FROM oauth_access_tokens").first()).toEqual({
        count: grantType === "refresh_token" ? 1 : 0,
      });
    },
  );

  it("revokes all workspace members' grants atomically without changing other workspaces or previous revocation times", async () => {
    const cookie = await bootstrap();
    const connection = await connect(cookie);
    const issued = await issueCode(cookie);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('other-member','Member','member@example.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspace_members VALUES (?, 'other-member','editor',1)").bind(
        connection.workspace.id,
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at,mcp_enabled) VALUES ('other-workspace','Other',1,1)"),
      env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at,revoked_at)
        SELECT 'other-member-grant',client_id,'other-member',workspace_id,scopes,security_generation,created_at,NULL FROM oauth_grants WHERE id=?`).bind(
        connection.grantId,
      ),
      env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at,revoked_at)
        SELECT 'other-workspace-grant',client_id,user_id,'other-workspace',scopes,security_generation,created_at,NULL FROM oauth_grants WHERE id=?`).bind(
        connection.grantId,
      ),
      env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,user_id,workspace_id,scopes,security_generation,created_at,revoked_at)
        SELECT 'already-revoked',client_id,user_id,workspace_id,scopes,security_generation,created_at,123 FROM oauth_grants WHERE id=?`).bind(
        connection.grantId,
      ),
    ]);
    await env.DB.prepare(
      "CREATE TRIGGER reject_test_disable BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT,'Injected disable failure'); END",
    ).run();
    expect((await toggleMcp(cookie, false)).status).toBe(500);
    expect(
      await env.DB.prepare("SELECT mcp_enabled,mcp_generation FROM workspaces WHERE id=?")
        .bind(connection.workspace.id)
        .first(),
    ).toEqual({ mcp_enabled: 1, mcp_generation: 0 });
    expect(
      await env.DB.prepare("SELECT consumed_at FROM oauth_authorization_codes WHERE code_hash=?")
        .bind(issued.codeHash)
        .first(),
    ).toEqual({ consumed_at: null });
    await env.DB.prepare("DROP TRIGGER reject_test_disable").run();
    expect((await toggleMcp(cookie, true)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT revoked_at FROM oauth_grants WHERE id=?").bind(connection.grantId).first(),
    ).toEqual({ revoked_at: null });
    expect((await toggleMcp(cookie, false)).status).toBe(200);
    const rows = (
      await env.DB.prepare("SELECT id,revoked_at FROM oauth_grants ORDER BY id").all<{
        id: string;
        revoked_at: number | null;
      }>()
    ).results;
    expect(rows.find((row) => row.id === "other-workspace-grant")?.revoked_at).toBeNull();
    expect(rows.find((row) => row.id === "already-revoked")?.revoked_at).toBe(123);
    for (const id of [connection.grantId, "other-member-grant"])
      expect(rows.find((row) => row.id === id)?.revoked_at).toBeGreaterThan(123);
    expect(
      await env.DB.prepare("SELECT COUNT(*) count FROM oauth_authorization_codes WHERE code_hash=?")
        .bind(issued.codeHash)
        .first(),
    ).toEqual({ count: 0 });
  });

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

  it.each([false, true])(
    "refreshes known metadata without spending an exhausted registration budget (at capacity: %s)",
    async (atCapacity) => {
      const clientId = "https://client.public.org/client.json";
      const uris = JSON.stringify(["http://127.0.0.1:3800/callback"]);
      await env.DB.prepare("INSERT INTO oauth_clients VALUES (?,'Metadata client',?,?,0,0)")
        .bind(clientId, uris, clientId)
        .run();
      if (atCapacity)
        await env.DB.prepare(`INSERT INTO oauth_clients(client_id,name,redirect_uris_json,metadata_url,created_at,updated_at)
        WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<999)
        SELECT 'client-'||value,'Client',?,NULL,0,0 FROM counter`)
          .bind(uris)
          .run();
      await exhaustRate("oauth-client-registrations", 100);
      const fetcher = vi.fn(async () => Response.json({ client_id: clientId, redirect_uris: JSON.parse(uris) }));
      vi.stubGlobal("fetch", fetcher);
      const request = new Request(`${ORIGIN}/oauth/authorize?${authorizationParams(clientId)}`);
      expect((await authorizeOAuthGet(request, env)).status).toBe(302);
      expect((await authorizeOAuthGet(request, env)).status).toBe(302);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        await env.DB.prepare("SELECT count FROM rateLimit WHERE key='oauth-client-registrations'").first(),
      ).toEqual({ count: 100 });
      await expect(
        authorizeOAuthGet(
          new Request(`${ORIGIN}/oauth/authorize?${authorizationParams("https://new.public.org/client.json")}`),
          env,
        ),
      ).rejects.toMatchObject({ status: 429 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

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
    const fetchedResult = await fetched.json<{
      result: { content: Array<{ text: string }>; structuredContent: unknown };
    }>();
    expect(fetchedResult.result.structuredContent).toEqual(JSON.parse(fetchedResult.result.content[0]!.text));
    const content = fetchedResult.result.content[0]!.text;
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
      client_id_metadata_document_supported: true,
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

async function discoveryCall(token: string, method: string, params: Record<string, unknown> = {}, bindings: Env = env) {
  const context = createExecutionContext();
  const response = await mcpRequest(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "resources/read" ? { "mcp-name": String(params.uri) } : {}),
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
    }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  expect(response.status).toBe(200);
  return response.json<{
    result: {
      tools?: Array<{
        name: string;
        inputSchema: unknown;
        outputSchema: unknown;
        annotations: Record<string, boolean>;
        _meta: Record<string, unknown>;
      }>;
      contents?: Array<{ text: string; mimeType: string; _meta: unknown }>;
    };
  }>();
}

function markdownWriteBindings(flag: "false" | undefined): Env {
  const bindings: Env = { ...env };
  if (flag === undefined) delete bindings.NOTION_MARKDOWN_WRITES_ENABLED;
  else bindings.NOTION_MARKDOWN_WRITES_ENABLED = flag;
  return bindings;
}

describe("MCP durable update input identity", () => {
  it("checks original input and revision when D1 receipts are missing, including disabled writes", async () => {
    const connection = await connect(await bootstrap());
    const before = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    const input = {
      page_id: connection.page.id,
      command: { type: "insert_content", insert_content: { content: "Identity append" } },
      operation_id: "protected-update",
      expected_revision: before.revision,
      expected_content_epoch: before.contentEpoch,
    };
    const updated = await toolCall(connection.token, "update_page", input);
    expect(updated.result.isError).not.toBe(true);
    expect(
      (
        await toolCall(connection.token, "update_page", {
          page_id: connection.page.id,
          command: { type: "insert_content", insert_content: { content: "Later append" } },
          operation_id: "later-update",
        })
      ).result.isError,
    ).not.toBe(true);
    for (const flag of ["true", "false", undefined] as const) {
      await env.DB.prepare("DELETE FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?")
        .bind(connection.grantId, input.operation_id)
        .run();
      const bindings = flag === "true" ? env : markdownWriteBindings(flag);
      for (const changed of [
        { ...input, command: { type: "insert_content", insert_content: { content: "Different append" } } },
        { ...input, expected_revision: before.revision + 1 },
        { ...input, expected_content_epoch: before.contentEpoch + 1 },
      ]) {
        expect((await toolCall(connection.token, "update_page", changed, bindings)).result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "operation_id_reused", retryable: false } },
        });
        expect(
          await env.DB.prepare("SELECT 1 FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?")
            .bind(connection.grantId, input.operation_id)
            .first(),
        ).toBeNull();
      }
      expect(await toolCall(connection.token, "update_page", input, bindings)).toEqual(updated);
    }
    const fetched = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    expect(fetched.markdown.match(/Identity append/g)).toHaveLength(1);
    expect(fetched.markdown.match(/Later append/g)).toHaveLength(1);
    expect(fetched.markdown).not.toContain("Different append");
  });

  it("preserves legacy ID-only receipt replay without creating a v2 identity", async () => {
    const connection = await connect(await bootstrap());
    const input = {
      page_id: connection.page.id,
      command: { type: "insert_content", insert_content: { content: "Requested differently" } },
      operation_id: "legacy-update",
    };
    const room = env.DOCUMENT.getByName(`${connection.page.id}~1`);
    const legacy = await room.fetch(
      new Request("https://document.internal/api-mutate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
        body: JSON.stringify({
          actorId: connection.user.id,
          operationId: `mcp:${connection.grantId}:${input.operation_id}`,
          operations: [
            {
              type: "append_children",
              children: [
                {
                  type: "blockContainer",
                  attrs: { id: "legacy-block" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Legacy append" }] }],
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(legacy.status).toBe(200);
    const { sequence } = await legacy.json<{ sequence: number }>();
    const replay = await toolCall(connection.token, "update_page", input, markdownWriteBindings("false"));
    expect(replay.result.isError).not.toBe(true);
    expect(JSON.parse(replay.result.content[0]!.text)).toMatchObject({ revision: sequence });
    await runInDurableObject(room, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM api_operation_inputs").toArray()).toEqual([]);
    });
    const fetched = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    expect(fetched.markdown.match(/Legacy append/g)).toHaveLength(1);
    expect(fetched.markdown).not.toContain("Requested differently");
  });

  it.each(["identity", "receipt"])("does not fall back to a legacy receipt when a v2 %s is missing", async (lost) => {
    const connection = await connect(await bootstrap());
    const input = {
      page_id: connection.page.id,
      command: { type: "insert_content", insert_content: { content: "Unverifiable append" } },
      operation_id: "unverifiable-update",
    };
    expect((await toolCall(connection.token, "update_page", input)).result.isError).not.toBe(true);
    await env.DB.prepare("DELETE FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?")
      .bind(connection.grantId, input.operation_id)
      .run();
    const room = env.DOCUMENT.getByName(`${connection.page.id}~1`);
    await runInDurableObject(room, async (instance, state) => {
      const instanceRoom = instance as unknown as { document: Y.Doc; compact(): Promise<void> };
      const document = instanceRoom.document;
      if (lost === "identity") state.storage.sql.exec("DELETE FROM api_operation_inputs");
      else document.getMap("api-operation-receipts").delete(`mcp:v2:${connection.grantId}:${input.operation_id}`);
      document.getMap("api-operation-receipts").set(`mcp:${connection.grantId}:${input.operation_id}`, "legacy");
      await instanceRoom.compact();
    });
    for (const bindings of [env, markdownWriteBindings("false")])
      expect((await toolCall(connection.token, "update_page", input, bindings)).result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "operation_receipt_unverifiable", retryable: false } },
      });
    expect(
      await env.DB.prepare("SELECT 1 FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?")
        .bind(connection.grantId, input.operation_id)
        .first(),
    ).toBeNull();
    const fetched = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    expect(fetched.markdown.match(/Unverifiable append/g)).toHaveLength(1);
  });
});

describe("MCP document limits", () => {
  it("rejects an oversized editable draft before commit and accepts a corrected draft with the same version guards", async () => {
    const connection = await connect(await bootstrap());
    const room = env.DOCUMENT.getByName(`${connection.page.id}~1`);
    await room.fetch(
      new Request("https://document.internal/noop", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
    );
    await runInDurableObject(room, async (instance) => {
      const instanceRoom = instance as unknown as { document: Y.Doc; compact(): Promise<void> };
      const block = (id: string, value: string) => {
        const container = new Y.XmlElement("blockContainer");
        container.setAttribute("id", id);
        const paragraph = new Y.XmlElement("paragraph");
        const text = new Y.XmlText();
        text.insert(0, value);
        paragraph.insert(0, [text]);
        container.insert(0, [paragraph]);
        return container;
      };
      // The nested subtree projects as one unknown marker, leaving this 9,999-block document editable without truncation.
      const parent = block("folded-parent", "Folded parent");
      const nested = new Y.XmlElement("blockGroup");
      nested.insert(
        0,
        Array.from({ length: 9_997 }, (_, index) => block(`nested-${index}`, `Nested paragraph ${index}`)),
      );
      parent.insert(1, [nested]);
      const group = new Y.XmlElement("blockGroup");
      group.insert(0, [block("ordinary", "Ordinary paragraph"), parent]);
      instanceRoom.document.transact(() => {
        const fragment = instanceRoom.document.getXmlFragment("document-store");
        if (fragment.length) fragment.delete(0, fragment.length);
        fragment.insert(0, [group]);
      });
      await instanceRoom.compact();
    });
    const fullDocument = async () =>
      (
        await room.fetch(
          new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
        )
      ).json<DocumentContentEnvelope>();
    const originalDocument = await fullDocument();
    const before = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    expect(before.canEdit).toBe(true);
    expect(before.truncated).toBe(false);
    expect(before.markdown.length).toBeLessThan(4_000);
    expect(before.markdown).toContain('<unknown url="notion://blocks/');
    const input = {
      page_id: connection.page.id,
      operation_id: "oversized-draft",
      expected_revision: before.revision,
      expected_content_epoch: before.contentEpoch,
      command: {
        type: "replace_content",
        replace_content: { new_str: `${before.markdown}\nNew A\n\nNew B\n` },
      },
    };
    expect((await toolCall(connection.token, "update_page", input)).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "document_limit", retryable: false } },
    });
    expect(
      documentResultSchema.parse(
        (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
      ),
    ).toEqual(before);
    expect(await fullDocument()).toEqual(originalDocument);
    expect(
      await env.DB.prepare("SELECT 1 FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?")
        .bind(connection.grantId, input.operation_id)
        .first(),
    ).toBeNull();
    await runInDurableObject(room, async (instance, state) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      expect(document.getMap("api-operation-receipts").has(`mcp:v2:${connection.grantId}:${input.operation_id}`)).toBe(
        false,
      );
      expect(state.storage.sql.exec("SELECT * FROM api_operation_inputs").toArray()).toEqual([]);
    });
    const corrected = {
      ...input,
      operation_id: "corrected-draft",
      command: { type: "replace_content", replace_content: { new_str: `${before.markdown}\nNew A\n` } },
    };
    expect((await toolCall(connection.token, "update_page", corrected)).result.isError).not.toBe(true);
    const after = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    expect(after.markdown).toContain("New A");
    expect(after.markdown).not.toContain("New B");
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.contentEpoch).toBe(before.contentEpoch);
    expect(
      await env.DB.prepare("SELECT 1 FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?")
        .bind(connection.grantId, corrected.operation_id)
        .first(),
    ).not.toBeNull();
    await runInDurableObject(room, async (instance, state) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      expect(
        document.getMap("api-operation-receipts").has(`mcp:v2:${connection.grantId}:${corrected.operation_id}`),
      ).toBe(true);
      expect(state.storage.sql.exec("SELECT operation_id FROM api_operation_inputs").toArray()).toEqual([
        { operation_id: `mcp:v2:${connection.grantId}:${corrected.operation_id}` },
      ]);
    });
  });
});

describe("MCP Markdown write gate", () => {
  it.each(["false", undefined] as const)("blocks new creates and updates when the write flag is %s", async (flag) => {
    const connection = await connect(await bootstrap());
    const bindings = markdownWriteBindings(flag);
    const before = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    const pageRows = () => env.DB.prepare("SELECT * FROM pages ORDER BY id").all();
    const receipts = () => env.DB.prepare("SELECT * FROM oauth_operation_receipts ORDER BY operation_id").all();
    const originalPages = (await pageRows()).results;
    const originalReceipts = (await receipts()).results;
    const disabled = {
      isError: true,
      structuredContent: { error: { code: "markdown_writes_disabled", retryable: true } },
    };
    expect(
      (
        await toolCall(
          connection.token,
          "create_page",
          {
            space_id: connection.page.spaceId,
            title: "Disabled create",
            markdown: "Never published",
            operation_id: "disabled-create",
          },
          bindings,
        )
      ).result,
    ).toMatchObject(disabled);
    for (const guarded of [false, true]) {
      expect(
        (
          await toolCall(
            connection.token,
            "update_page",
            {
              page_id: connection.page.id,
              command: { type: "insert_content", insert_content: { content: "Never appended" } },
              operation_id: `disabled-update-${guarded}`,
              ...(guarded ? { expected_revision: before.revision, expected_content_epoch: before.contentEpoch } : {}),
            },
            bindings,
          )
        ).result,
      ).toMatchObject(disabled);
    }
    expect((await pageRows()).results).toEqual(originalPages);
    expect((await receipts()).results).toEqual(originalReceipts);
    expect(
      documentResultSchema.parse(
        (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
      ),
    ).toEqual(before);
  });

  it.each(["false", undefined] as const)(
    "does not resume or publish staged creates when the write flag is %s",
    async (flag) => {
      const connection = await connect(await bootstrap());
      const input = {
        space_id: connection.page.spaceId,
        title: "Staged create",
        markdown: "Pending content",
        operation_id: "staged-gate",
      };
      expect((await toolCall(connection.token, "create_page", input, failingMutations(503))).result.isError).toBe(true);
      await env.DB.prepare("UPDATE pages SET updated_at=1 WHERE title=?").bind(input.title).run();
      const stagedPage = () => env.DB.prepare("SELECT * FROM pages WHERE title=?").bind(input.title).first();
      const stagedReceipt = () =>
        env.DB.prepare("SELECT * FROM oauth_operation_receipts WHERE operation_id=?").bind(input.operation_id).first();
      const beforePage = await stagedPage();
      const beforeReceipt = await stagedReceipt();
      expect(beforePage).toMatchObject({ import_job_id: expect.stringContaining("mcp:create:") });
      expect(
        (await toolCall(connection.token, "create_page", input, markdownWriteBindings(flag))).result,
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "markdown_writes_disabled", retryable: true } },
      });
      expect(await stagedPage()).toEqual(beforePage);
      expect(await stagedReceipt()).toEqual(beforeReceipt);
      expect((await toolCall(connection.token, "create_page", input)).result.isError).not.toBe(true);
    },
  );

  it("returns completed OAuth create and update receipts while writes are disabled", async () => {
    const connection = await connect(await bootstrap());
    const create = {
      space_id: connection.page.spaceId,
      title: "Completed create",
      markdown: "Original",
      operation_id: "completed-create",
    };
    const created = await toolCall(connection.token, "create_page", create);
    const pageId = (JSON.parse(created.result.content[0]!.text) as { id: string }).id;
    const update = {
      page_id: pageId,
      command: { type: "insert_content", insert_content: { content: "One append" } },
      operation_id: "completed-update",
    };
    const updated = await toolCall(connection.token, "update_page", update);
    for (const flag of ["false", undefined] as const) {
      const bindings = markdownWriteBindings(flag);
      expect(await toolCall(connection.token, "create_page", create, bindings)).toEqual(created);
      expect(await toolCall(connection.token, "update_page", update, bindings)).toEqual(updated);
      for (const [tool, input] of [
        ["create_page", { ...create, title: "Different" }],
        ["update_page", { ...update, command: { type: "insert_content", insert_content: { content: "Different" } } }],
      ] as const)
        expect((await toolCall(connection.token, tool, input, bindings)).result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "operation_id_reused", retryable: false } },
        });
    }
    const fetched = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: pageId })).result.structuredContent,
    );
    expect(fetched.markdown.match(/One append/g)).toHaveLength(1);
  });

  it("recovers a completed Durable Object update receipt without another content mutation while writes are disabled", async () => {
    const connection = await connect(await bootstrap());
    const input = {
      page_id: connection.page.id,
      command: { type: "insert_content", insert_content: { content: "Recovered once" } },
      operation_id: "room-completed-update",
    };
    const updated = await toolCall(connection.token, "update_page", input);
    expect(updated.result.isError).not.toBe(true);
    for (const flag of ["false", undefined] as const) {
      await env.DB.prepare("DELETE FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?")
        .bind(connection.grantId, input.operation_id)
        .run();
      expect(await toolCall(connection.token, "update_page", input, markdownWriteBindings(flag))).toEqual(updated);
    }
    const fetched = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    expect(fetched.markdown.match(/Recovered once/g)).toHaveLength(1);
  });

  it("keeps current authorization checks ahead of completed receipts and disabled-write errors", async () => {
    const connection = await connect(await bootstrap());
    const create = {
      space_id: connection.page.spaceId,
      title: "Permission test",
      markdown: "Saved",
      operation_id: "permission-create",
    };
    const created = await toolCall(connection.token, "create_page", create);
    const pageId = (JSON.parse(created.result.content[0]!.text) as { id: string }).id;
    const update = {
      page_id: pageId,
      command: { type: "insert_content", insert_content: { content: "Saved append" } },
      operation_id: "permission-update",
    };
    expect((await toolCall(connection.token, "update_page", update)).result.isError).not.toBe(true);
    const bindings = markdownWriteBindings("false");
    await env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('other-gate-owner','Owner','other-gate-owner@example.test',1,1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES (?,'other-gate-owner','owner',1)",
    )
      .bind(connection.workspace.id)
      .run();
    await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND user_id=?")
      .bind(connection.workspace.id, connection.user.id)
      .run();
    expect((await toolCall(connection.token, "create_page", create, bindings)).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "space_forbidden" } },
    });
    expect((await toolCall(connection.token, "update_page", update, bindings)).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "read_only" } },
    });
    const revokedBindings = {
      ...afterDatabaseRead("SELECT access.grant_id", async () => {
        await env.DB.prepare("UPDATE oauth_grants SET revoked_at=? WHERE id=?")
          .bind(Date.now(), connection.grantId)
          .run();
      }),
      NOTION_MARKDOWN_WRITES_ENABLED: "false",
    } as Env;
    expect((await toolCall(connection.token, "create_page", create, revokedBindings)).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "mcp_access_denied" } },
    });
  });

  it("keeps reads, comments and scope-based tool discovery available while writes are disabled", async () => {
    const connection = await connect(await bootstrap());
    const bindings = markdownWriteBindings("false");
    const listed = await discoveryCall(connection.token, "tools/list", {}, bindings);
    expect(listed.result.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["create_page", "update_page", "create_comment", "fetch_page"]),
    );
    expect((await toolCall(connection.token, "list_spaces", {}, bindings)).result.isError).not.toBe(true);
    expect(
      (await toolCall(connection.token, "list_pages", { space_id: connection.page.spaceId }, bindings)).result.isError,
    ).not.toBe(true);
    expect((await toolCall(connection.token, "search_pages", { query: "Welcome" }, bindings)).result.isError).not.toBe(
      true,
    );
    const fetched = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id }, bindings)).result
        .structuredContent,
    );
    expect(fetched.canEdit).toBe(false);
    expect(
      (
        await toolCall(
          connection.token,
          "create_comment",
          { page_id: connection.page.id, body: "Comments remain available", operation_id: "disabled-flag-comment" },
          bindings,
        )
      ).result.isError,
    ).not.toBe(true);
  });
});

describe("ChatGPT plugin contracts", () => {
  it("opens authorized documents and links other page kinds to NoteFlare", async () => {
    const connection = await connect(await bootstrap());
    const opened = await toolCall(connection.token, "open_noteflare", { page_id: connection.page.id });
    expect(JSON.parse(opened.result.content[0]!.text)).toMatchObject({
      initialPageId: connection.page.id,
      linkedPage: null,
    });
    await env.DB.prepare("UPDATE pages SET kind='diagram' WHERE id=?").bind(connection.page.id).run();
    const linked = await toolCall(connection.token, "open_noteflare", { page_id: connection.page.id });
    expect(JSON.parse(linked.result.content[0]!.text)).toMatchObject({
      initialPageId: null,
      linkedPage: { id: connection.page.id, kind: "diagram", url: `${ORIGIN}/?page=${connection.page.id}` },
    });
    expect((await toolCall(connection.token, "open_noteflare", { page_id: crypto.randomUUID() })).result.isError).toBe(
      true,
    );
  });

  it("returns a tool-level OAuth challenge when the connection is revoked during a request", async () => {
    const connection = await connect(await bootstrap());
    const bindings = afterDatabaseRead("SELECT access.grant_id", async () => {
      await env.DB.prepare("UPDATE oauth_grants SET revoked_at=? WHERE id=?")
        .bind(Date.now(), connection.grantId)
        .run();
    });
    const response = await toolCall(connection.token, "list_spaces", {}, bindings);
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "mcp_access_denied" } },
    });
    expect(response.result["_meta"]?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('error="invalid_token"'),
    ]);
  });

  it("declares output schemas, OAuth scopes, supported commands, and global and thread UI entrypoints", async () => {
    const connection = await connect(await bootstrap());
    const { result } = await discoveryCall(connection.token, "tools/list");
    expect(result.tools?.map((tool) => tool.name).sort()).toEqual([
      "create_comment",
      "create_page",
      "fetch_page",
      "list_pages",
      "list_spaces",
      "open_noteflare",
      "search_pages",
      "update_page",
    ]);
    for (const tool of result.tools!) {
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(tool["_meta"].securitySchemes).toEqual([
        {
          type: "oauth2",
          scopes:
            tool.name === "create_comment"
              ? ["pages:read", "comments:write"]
              : [tool.name === "create_page" || tool.name === "update_page" ? "pages:write" : "pages:read"],
        },
      ]);
      expect(tool.annotations.idempotentHint).toBe(true);
    }
    const open = result.tools!.find((tool) => tool.name === "open_noteflare")!;
    expect(open["_meta"].ui).toMatchObject({ resourceUri: PLUGIN_UI_URI });
    expect(open["_meta"]["openai/ui"]).toEqual({ entrypoints: [{ type: "global" }, { type: "thread" }] });
    const update = result.tools!.find((tool) => tool.name === "update_page")!;
    expect(update.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const type of ["replace_content", "insert_content", "update_content", "replace_content_range"])
      expect(JSON.stringify(update.inputSchema)).toContain(type);
    const spaces = await toolCall(connection.token, "list_spaces", {});
    expect(spaces.result.structuredContent).toEqual(JSON.parse(spaces.result.content[0]!.text));
    expect(spacesResultSchema.parse(spaces.result.structuredContent)).toMatchObject({
      workspace: { id: connection.workspace.id },
      spaces: [{ id: connection.page.spaceId, canEdit: true }],
    });
  });

  it("serves a self-contained UI resource through assets with an empty external resource policy", async () => {
    const connection = await connect(await bootstrap());
    const bindings = {
      ...env,
      ASSETS: {
        fetch: vi.fn().mockResolvedValue(
          new Response('<html><meta name="noteflare-plugin-ui" content="0.1.0"></html>', {
            headers: { "content-type": "text/html" },
          }),
        ),
      },
    } as unknown as Env;
    const resource = await discoveryCall(connection.token, "resources/read", { uri: PLUGIN_UI_URI }, bindings);
    expect(resource.result.contents![0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
      },
    });
    expect(resource.result.contents![0]!.text).toContain('name="noteflare-plugin-ui"');
  });

  it("filters private spaces and hidden navigation pages and applies effective write permissions", async () => {
    const connection = await connect(await bootstrap());
    const privateId = crypto.randomUUID();
    const hiddenId = crypto.randomUUID();
    const replacementOwner = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?,'Other owner','navigation-owner@example.test',1,1)",
      ).bind(replacementOwner),
      env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES (?,?,'owner',1)").bind(
        connection.workspace.id,
        replacementOwner,
      ),
      env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE workspace_id=? AND user_id=?").bind(
        connection.workspace.id,
        connection.user.id,
      ),
      env.DB.prepare(
        "INSERT INTO spaces(id,workspace_id,name,slug,visibility,position,created_at,updated_at) VALUES (?,?,'Secret','secret','private','b0',1,1)",
      ).bind(privateId, connection.workspace.id),
      env.DB.prepare("UPDATE pages SET is_template=1 WHERE id=?").bind(connection.page.id),
      env.DB.prepare(
        "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,updated_by,created_at,updated_at,archived_at) VALUES (?,?,?,'document','a1','Archived',?,?,1,1,2)",
      ).bind(hiddenId, connection.workspace.id, connection.page.spaceId, connection.user.id, connection.user.id),
    ]);
    const spaces = spacesResultSchema.parse(
      (await toolCall(connection.token, "list_spaces", {})).result.structuredContent,
    );
    expect(spaces.spaces.map((space) => space.id)).not.toContain(privateId);
    expect((await toolCall(connection.token, "list_pages", { space_id: privateId })).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "space_not_found" } },
    });
    const listed = pagesResultSchema.parse(
      (await toolCall(connection.token, "list_pages", { space_id: connection.page.spaceId })).result.structuredContent,
    );
    expect(listed.pages.map((page) => page.id)).not.toContain(connection.page.id);
    expect(listed.pages.map((page) => page.id)).not.toContain(hiddenId);
    await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES (?,?,'viewer',1)")
      .bind(privateId, connection.user.id)
      .run();
    const granted = spacesResultSchema.parse(
      (await toolCall(connection.token, "list_spaces", {})).result.structuredContent,
    );
    expect(granted.spaces.find((space) => space.id === privateId)?.canEdit).toBe(false);
    expect(
      (
        await toolCall(connection.token, "create_page", {
          space_id: privateId,
          title: "Denied",
          markdown: "",
          operation_id: "viewer-create",
        })
      ).result.isError,
    ).toBe(true);
  });

  it("paginates roots without duplicates and rejects cursors or parents from another destination", async () => {
    const connection = await connect(await bootstrap());
    await env.DB.prepare(
      "INSERT INTO page_import_sources(page_id,source_path,source_role,created_at) VALUES (NULL,'missing-table-row','table_row_detail',1)",
    ).run();
    const ids = Array.from({ length: 55 }, () => crypto.randomUUID());
    await env.DB.batch(
      ids.map((id, index) =>
        env.DB.prepare(
          "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,'document',?,'Navigation',?,?,1,1)",
        ).bind(
          id,
          connection.workspace.id,
          connection.page.spaceId,
          `b${String(index).padStart(3, "0")}`,
          connection.user.id,
          connection.user.id,
        ),
      ),
    );
    const first = pagesResultSchema.parse(
      (await toolCall(connection.token, "list_pages", { space_id: connection.page.spaceId })).result.structuredContent,
    );
    expect(first.pages).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = pagesResultSchema.parse(
      (await toolCall(connection.token, "list_pages", { space_id: connection.page.spaceId, cursor: first.nextCursor }))
        .result.structuredContent,
    );
    expect(second.nextCursor).toBeNull();
    const all = [...first.pages, ...second.pages].map((page) => page.id);
    expect(new Set(all).size).toBe(all.length);
    expect(ids.every((id) => all.includes(id))).toBe(true);
    expect(
      (
        await toolCall(connection.token, "list_pages", {
          space_id: connection.page.spaceId,
          parent_id: connection.page.id,
          cursor: first.nextCursor,
        })
      ).result,
    ).toMatchObject({ isError: true, structuredContent: { error: { code: "invalid_cursor" } } });
    const otherSpace = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO spaces(id,workspace_id,name,slug,position,created_at,updated_at) VALUES (?,?,'Other','other','c0',1,1)",
    )
      .bind(otherSpace, connection.workspace.id)
      .run();
    expect(
      (await toolCall(connection.token, "list_pages", { space_id: otherSpace, parent_id: connection.page.id })).result
        .isError,
    ).toBe(true);
  });

  it("hides staged pages, table detail pages, and their descendants while returning ordinary children", async () => {
    const connection = await connect(await bootstrap());
    const detail = crypto.randomUUID();
    const descendant = crypto.randomUUID();
    const staged = crypto.randomUUID();
    const child = crypto.randomUUID();
    await env.DB.batch([
      ...[
        { id: detail, parent: null, stage: null },
        { id: descendant, parent: detail, stage: null },
        { id: staged, parent: null, stage: `mcp:create:${staged}` },
        { id: child, parent: connection.page.id, stage: null },
      ].map((row) =>
        env.DB.prepare(
          "INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,import_job_id,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'document','b0','Child',?,?,?,1,1)",
        ).bind(
          row.id,
          connection.workspace.id,
          connection.page.spaceId,
          row.parent,
          row.stage,
          connection.user.id,
          connection.user.id,
        ),
      ),
      env.DB.prepare(
        "INSERT INTO page_import_sources(page_id,source_path,source_role,created_at) VALUES (?,'table-row','table_row_detail',1)",
      ).bind(detail),
      env.DB.prepare(
        "INSERT INTO page_import_sources(page_id,source_path,source_role,created_at) VALUES (NULL,'missing-table-row','table_row_detail',1)",
      ),
    ]);
    const roots = pagesResultSchema.parse(
      (await toolCall(connection.token, "list_pages", { space_id: connection.page.spaceId })).result.structuredContent,
    );
    expect(roots.pages.some((page) => page.id === detail || page.id === staged)).toBe(false);
    expect(roots.pages.map((page) => page.id)).toContain(connection.page.id);
    const hiddenChildren = pagesResultSchema.parse(
      (await toolCall(connection.token, "list_pages", { space_id: connection.page.spaceId, parent_id: detail })).result
        .structuredContent,
    );
    expect(hiddenChildren.pages).toEqual([]);
    const children = pagesResultSchema.parse(
      (
        await toolCall(connection.token, "list_pages", {
          space_id: connection.page.spaceId,
          parent_id: connection.page.id,
        })
      ).result.structuredContent,
    );
    expect(children.pages.map((page) => page.id)).toContain(child);
  });

  it.each(["create_page", "update_page"])(
    "preserves literal checkbox labels and checked states through %s and fetch_page",
    async (tool) => {
      const connection = await connect(await bootstrap());
      const markdown = "- [x] First\n- [ ] [x] = completed\n";
      const written = await toolCall(
        connection.token,
        tool,
        tool === "create_page"
          ? {
              space_id: connection.page.spaceId,
              title: "Literal checkbox labels",
              markdown,
              operation_id: "literal-checkbox-create",
            }
          : {
              page_id: connection.page.id,
              command: { type: "replace_content", replace_content: { new_str: markdown } },
              operation_id: "literal-checkbox-update",
            },
      );
      expect(written.result.isError).not.toBe(true);
      const pageId = (JSON.parse(written.result.content[0]!.text) as { id: string }).id;
      const response = await env.DOCUMENT.getByName(`${pageId}~1`).fetch(
        new Request("https://document.internal/content", {
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      );
      expect(response.status).toBe(200);
      const envelope = await response.json<DocumentContentEnvelope>();
      expect(envelope.document.content?.[0]?.content?.map((block) => block.content?.[0])).toMatchObject([
        {
          type: "checkListItem",
          attrs: { checked: true },
          content: [{ type: "text", text: "First" }],
        },
        {
          type: "checkListItem",
          attrs: { checked: false },
          content: [{ type: "text", text: "[x] = completed" }],
        },
      ]);
      const fetched = documentResultSchema.parse(
        (await toolCall(connection.token, "fetch_page", { page_id: pageId })).result.structuredContent,
      );
      expect(fetched.markdown).toBe("- [x] First\n- [ ] \\[x\\] = completed\n");
      expect(fetched.revision).toBe(envelope.sequence);
    },
  );

  it("rejects stale revisions and epochs before mutation and replays successful writes before version checks", async () => {
    const connection = await connect(await bootstrap());
    const created = await toolCall(connection.token, "create_page", {
      space_id: connection.page.spaceId,
      title: "Conflict test",
      markdown: "Base",
      operation_id: "conflict-create",
    });
    const id = JSON.parse(created.result.content[0]!.text).id as string;
    const before = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: id })).result.structuredContent,
    );
    const input = {
      page_id: id,
      expected_revision: before.revision,
      expected_content_epoch: before.contentEpoch,
      operation_id: "guarded-save",
      command: { type: "replace_content", replace_content: { new_str: "Saved" } },
    };
    const saved = await toolCall(connection.token, "update_page", input);
    expect(saved.result.isError).not.toBe(true);
    expect(saved.result.structuredContent).toEqual(JSON.parse(saved.result.content[0]!.text));
    expect(await toolCall(connection.token, "update_page", input)).toEqual(saved);
    const stale = await toolCall(connection.token, "update_page", { ...input, operation_id: "stale-save" });
    expect(stale.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "page_changed", retryable: false } },
    });
    const current = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: id })).result.structuredContent,
    );
    expect(current.markdown).toContain("Saved");
    await env.DB.prepare("UPDATE pages SET content_epoch=content_epoch+1 WHERE id=?").bind(id).run();
    const restored = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: id })).result.structuredContent,
    );
    const wrongEpoch = await toolCall(connection.token, "update_page", {
      ...input,
      operation_id: "old-epoch",
      expected_revision: restored.revision,
    });
    expect(wrongEpoch.result).toMatchObject({ isError: true, structuredContent: { error: { code: "page_changed" } } });
    // A successful receipt remains authoritative even when a restore has changed the epoch.
    expect(await toolCall(connection.token, "update_page", input)).toEqual(saved);
    expect(
      await env.DB.prepare(
        "SELECT operation_id FROM oauth_operation_receipts WHERE operation_id IN ('stale-save','old-epoch')",
      ).all(),
    ).toMatchObject({ results: [] });
  });

  it("requires paired version guards and explicit command shapes, and reports read-only capabilities", async () => {
    const connection = await connect(await bootstrap());
    expect(
      (
        await toolCall(connection.token, "update_page", {
          page_id: connection.page.id,
          operation_id: "missing-epoch",
          expected_revision: 0,
          command: { type: "replace_content", replace_content: { new_str: "test" } },
        })
      ).result.isError,
    ).toBe(true);
    expect(
      (
        await toolCall(connection.token, "update_page", {
          page_id: connection.page.id,
          operation_id: "invalid-command",
          command: { type: "anything" },
        })
      ).result.isError,
    ).toBe(true);
    await env.DB.prepare("UPDATE oauth_grants SET scopes='pages:read' WHERE id=?").bind(connection.grantId).run();
    const doc = documentResultSchema.parse(
      (await toolCall(connection.token, "fetch_page", { page_id: connection.page.id })).result.structuredContent,
    );
    expect(doc.canEdit).toBe(false);
    expect(
      spacesResultSchema
        .parse((await toolCall(connection.token, "list_spaces", {})).result.structuredContent)
        .spaces.every((space) => !space.canEdit),
    ).toBe(true);
    const listed = await discoveryCall(connection.token, "tools/list");
    expect(listed.result.tools?.some((tool) => tool.name === "update_page")).toBe(false);
  });
});
