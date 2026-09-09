import { Client } from "@notionhq/client";
import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

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
  await SELF.fetch(
    authenticated(cookie, `/api/integrations/${result.integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ insertContent: true, updateContent: true, userInformation: "basic" }),
    }),
  );
  await SELF.fetch(
    authenticated(cookie, `/api/integrations/${result.integration.id}/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPageIds: [pageId] }),
    }),
  );
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
});
