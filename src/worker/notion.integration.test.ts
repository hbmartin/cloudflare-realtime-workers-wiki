import { Client } from "@notionhq/client";
import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

function authenticated(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Notion API Test",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const tree = await (
    await SELF.fetch(authenticated(cookie, "/api/pages/tree"))
  ).json<{ pages: Array<{ id: string }> }>();
  return { cookie, pageId: tree.pages[0]!.id };
}

async function integration(cookie: string, pageId: string) {
  const created = await SELF.fetch(
    authenticated(cookie, "/api/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Contract test" }),
    }),
  );
  expect(created.status).toBe(201);
  const result = await created.json<{ integration: { id: string }; token: string }>();
  const capabilities = await SELF.fetch(
    authenticated(cookie, `/api/integrations/${result.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ insertContent: true, updateContent: true, userInformation: "basic" }),
    }),
  );
  expect(capabilities.status).toBe(200);
  const grants = await SELF.fetch(
    authenticated(cookie, `/api/integrations/${result.integration.id}/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPageIds: [pageId] }),
    }),
  );
  expect(grants.status).toBe(200);
  return result;
}

function notion(token: string) {
  return new Client({
    auth: token,
    baseUrl: "http://example.test",
    notionVersion: "2026-03-11",
    retry: false,
    fetch: (url, init) => SELF.fetch(new Request(url, init as RequestInit)),
  });
}

function notionRequest(token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("notion-version", "2026-03-11");
  return new Request(`http://example.test/v1${path}`, { ...init, headers });
}

async function signedFileUrl(attachmentId: string) {
  const expires = Date.now() + 60_000;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = [
    ...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${attachmentId}:${expires}`))),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `http://example.test/v1/files/${attachmentId}?expires=${expires}&signature=${signature}`;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("Notion-compatible API", () => {
  it("runs page, block, search, user, position, and in_trash calls through the official SDK", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);

    await expect(client.users.me({})).resolves.toMatchObject({ object: "user", type: "bot" });
    await expect(client.pages.retrieve({ page_id: installed.pageId })).resolves.toMatchObject({
      object: "page",
      id: installed.pageId,
      in_trash: false,
    });

    const appended = await client.blocks.children.append({
      block_id: installed.pageId,
      position: { type: "start" },
      children: [{ paragraph: { rich_text: [{ text: { content: "Created by SDK" } }] } }],
    });
    expect(appended.results).toHaveLength(1);
    const blockId = appended.results[0]!.id;
    await expect(client.blocks.retrieve({ block_id: blockId })).resolves.toMatchObject({
      object: "block",
      type: "paragraph",
      in_trash: false,
    });
    await expect(
      client.blocks.update({
        block_id: blockId,
        paragraph: { rich_text: [{ text: { content: "Updated by SDK" } }] },
      }),
    ).resolves.toMatchObject({ type: "paragraph" });

    const child = await client.pages.create({
      parent: { type: "page_id", page_id: installed.pageId },
      properties: { title: { type: "title", title: [{ text: { content: "SDK child" } }] } },
    });
    expect(child).toMatchObject({ object: "page", parent: { type: "page_id", page_id: installed.pageId } });
    const search = await client.search({ query: "SDK child", page_size: 10 });
    expect(search.results.map((result) => result.id)).toContain(child.id);

    await expect(client.pages.update({ page_id: child.id, in_trash: true })).resolves.toMatchObject({
      in_trash: true,
    });
    await expect(client.blocks.delete({ block_id: blockId })).resolves.toMatchObject({ in_trash: true });
  });

  it("uses Notion error envelopes and immediately invalidates rotated tokens", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const missingVersion = await SELF.fetch(`http://example.test/v1/pages/${installed.pageId}`, {
      headers: { authorization: `Bearer ${createdIntegration.token}` },
    });
    expect(missingVersion.status).toBe(400);
    await expect(missingVersion.json()).resolves.toMatchObject({ object: "error", code: "missing_version" });

    await SELF.fetch(
      authenticated(installed.cookie, `/api/integrations/${createdIntegration.integration.id}/rotate`, {
        method: "POST",
      }),
    );
    const rejected = await SELF.fetch(`http://example.test/v1/users/me`, {
      headers: {
        authorization: `Bearer ${createdIntegration.token}`,
        "notion-version": "2026-03-11",
      },
    });
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toMatchObject({ object: "error", code: "unauthorized" });
  });

  it("accepts mixed-case Bearer schemes but keeps the crn_ prefix case-sensitive", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const mixedScheme = notionRequest(createdIntegration.token, "/users/me");
    mixedScheme.headers.set("authorization", `bEaReR ${createdIntegration.token}`);

    expect((await SELF.fetch(mixedScheme)).status).toBe(200);

    const upperPrefix = notionRequest(createdIntegration.token, "/users/me");
    upperPrefix.headers.set("authorization", `Bearer ${createdIntegration.token.replace(/^crn_/, "CRN_")}`);
    expect((await SELF.fetch(upperPrefix)).status).toBe(401);
  });

  it("uses resource-specific metadata in list envelopes", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const users = await SELF.fetch(notionRequest(createdIntegration.token, "/users"));
    const blocks = await SELF.fetch(notionRequest(createdIntegration.token, `/blocks/${installed.pageId}/children`));
    const search = await SELF.fetch(
      notionRequest(createdIntegration.token, "/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    await expect(users.json()).resolves.toMatchObject({ object: "list", type: "user", user: {} });
    await expect(blocks.json()).resolves.toMatchObject({ object: "list", type: "block", block: {} });
    await expect(search.json()).resolves.toMatchObject({
      object: "list",
      type: "page_or_database",
      page_or_database: {},
    });
  });

  it("limits a well-shaped invalid token before authentication reaches D1", async () => {
    const sourceLimit = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    const prepare = vi.fn(() => env.DB.prepare("SELECT 1"));
    const database = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") return prepare;
        return Reflect.get(target, property, receiver);
      },
    });
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "API_SOURCE_BURST_LIMIT") return sourceLimit;
        if (property === "DB") return database;
        return Reflect.get(target, property, receiver);
      },
    }) as Cloudflare.Env;
    const malformedContext = createExecutionContext();
    const malformed = await worker.fetch(
      notionRequest("not-a-token", "/users/me", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      bindings,
      malformedContext,
    );
    await waitOnExecutionContext(malformedContext);
    expect(malformed.status).toBe(401);
    expect(sourceLimit.limit).not.toHaveBeenCalled();

    const context = createExecutionContext();
    const response = await worker.fetch(
      notionRequest(`crn_${"a".repeat(43)}`, "/users/me", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ object: "error", code: "rate_limited" });
    expect(sourceLimit.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const firstKey = vi.mocked(sourceLimit.limit).mock.calls[0]![0].key;

    const rotatedContext = createExecutionContext();
    const rotated = await worker.fetch(
      notionRequest(`crn_${"b".repeat(43)}`, "/users/me", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      bindings,
      rotatedContext,
    );
    await waitOnExecutionContext(rotatedContext);
    expect(rotated.status).toBe(429);
    expect(vi.mocked(sourceLimit.limit).mock.calls[1]![0].key).toBe(firstKey);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps cross-zone Worker callers in separate source buckets", async () => {
    const limit = vi.fn(async (_input: { key: string }) => ({ success: false }));
    const sourceLimit = { limit } as unknown as RateLimit;
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "API_SOURCE_BURST_LIMIT") return sourceLimit;
        return Reflect.get(target, property, receiver);
      },
    }) as Cloudflare.Env;
    const request = async (workerZone: string) => {
      const context = createExecutionContext();
      const response = await worker.fetch(
        notionRequest(`crn_${"a".repeat(43)}`, "/users/me", {
          headers: {
            "cf-connecting-ip": "2a06:98c0:3600::103",
            "cf-worker": workerZone,
          },
        }),
        bindings,
        context,
      );
      await waitOnExecutionContext(context);
      expect(response.status).toBe(429);
    };

    await request("client-a.example");
    await request("client-b.example");
    await request("client-a.example");
    const keys = limit.mock.calls.map(([input]) => input.key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
  });

  it("updates only the requested page, refreshes browser search, and accepts an empty trash body", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    const child = await client.pages.create({
      parent: { type: "page_id", page_id: installed.pageId },
      properties: { title: { type: "title", title: [{ text: { content: "API child" } }] } },
    });
    const grandchild = await client.pages.create({
      parent: { type: "page_id", page_id: child.id },
      properties: { title: { type: "title", title: [{ text: { content: "Keep grandchild" } }] } },
    });
    const destination = await client.pages.create({
      parent: { type: "page_id", page_id: installed.pageId },
      properties: { title: { type: "title", title: [{ text: { content: "Move destination" } }] } },
    });
    const grandchildMetadata = await env.DB.prepare(`SELECT updated_by, updated_at FROM pages WHERE id = ?`)
      .bind(grandchild.id)
      .first<{ updated_by: string; updated_at: number }>();
    const moved = await SELF.fetch(
      notionRequest(createdIntegration.token, `/pages/${child.id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: { type: "page_id", page_id: destination.id } }),
      }),
    );
    expect(moved.status).toBe(200);
    await expect(
      env.DB.prepare(`SELECT updated_by, updated_at FROM pages WHERE id = ?`).bind(grandchild.id).first(),
    ).resolves.toEqual(grandchildMetadata);

    const broadcasts: unknown[] = [];
    const workspaceEvents = {
      getByName() {
        return {
          fetch: async (request: Request) => {
            broadcasts.push(await request.json());
            return Response.json({ delivered: true });
          },
        };
      },
    } as unknown as Cloudflare.Env["WORKSPACE_EVENTS"];
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "WORKSPACE_EVENTS") return workspaceEvents;
        return Reflect.get(target, property, receiver);
      },
    }) as Cloudflare.Env;
    const context = createExecutionContext();
    const renamed = await worker.fetch(
      notionRequest(createdIntegration.token, `/pages/${child.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          properties: { title: { title: [{ type: "text", text: { content: "Renamed API child" } }] } },
          icon: { type: "emoji", emoji: "🧭" },
        }),
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);
    expect(renamed.status).toBe(200);
    await expect(client.pages.retrieve({ page_id: grandchild.id })).resolves.toMatchObject({
      properties: { title: { title: [{ plain_text: "Keep grandchild" }] } },
    });

    const internalChild = await env.DB.prepare(`SELECT id FROM pages WHERE title = 'Renamed API child'`).first<{
      id: string;
    }>();
    expect(broadcasts).toContainEqual({
      type: "pages-upserted",
      pages: [expect.objectContaining({ id: internalChild!.id, title: "Renamed API child" })],
    });
    await expect(
      env.DB.prepare(`SELECT title FROM page_search_v2 WHERE page_id = ?`).bind(internalChild!.id).first(),
    ).resolves.toEqual({ title: "Renamed API child" });
    const browserSearch = await SELF.fetch(authenticated(installed.cookie, "/api/search?q=Renamed%20API%20child"));
    expect(browserSearch.status).toBe(200);
    expect(
      (await browserSearch.json<{ results: Array<{ page: { id: string } }> }>()).results.map(
        (result) => result.page.id,
      ),
    ).toContain(internalChild!.id);

    const trashed = await SELF.fetch(
      notionRequest(createdIntegration.token, `/pages/${child.id}/trash`, { method: "POST" }),
    );
    expect(trashed.status).toBe(200);
    await expect(trashed.json()).resolves.toMatchObject({ in_trash: true });
  });

  it("returns validation_error for malformed rich text instead of a 500", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const response = await SELF.fetch(
      notionRequest(createdIntegration.token, "/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parent: { type: "page_id", page_id: installed.pageId },
          properties: { title: { title: { type: "text", text: { content: "not an array" } } } },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ object: "error", code: "validation_error" });
  });

  it("serves non-inline Notion files as normalized attachments", async () => {
    const installed = await bootstrap();
    const attachmentId = crypto.randomUUID();
    const r2Key = `notion-test/${attachmentId}`;
    const owner = await env.DB.prepare(`SELECT workspace_id, created_by FROM pages WHERE id = ?`)
      .bind(installed.pageId)
      .first<{ workspace_id: string; created_by: string }>();
    await env.BUCKET.put(r2Key, "download body");
    await env.DB.prepare(
      `INSERT INTO attachments (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'application/octet-stream', 13, ?, ?)`,
    )
      .bind(
        attachmentId,
        owner!.workspace_id,
        installed.pageId,
        r2Key,
        'unsafe"/name.bin',
        owner!.created_by,
        Date.now(),
      )
      .run();

    const response = await SELF.fetch(await signedFileUrl(attachmentId));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="unsafe__name\.bin"; filename\*=UTF-8''unsafe__name\.bin$/,
    );
  });
});
