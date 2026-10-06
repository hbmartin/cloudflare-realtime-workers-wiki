import * as Y from "yjs";
import { enrollAccount } from "../../tests/helpers/security";
import { Client } from "@notionhq/client";
import {
  applyD1Migrations,
  createExecutionContext,
  env,
  reset,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { recoverNotionMarkdownTasks } from "./notion-api";
import { dateMentionWireProps } from "../shared/date-mentions";

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
  const cookie = await enrollAccount(response);
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
      body: JSON.stringify({
        insertContent: true,
        updateContent: true,
        readComments: true,
        insertComments: true,
        userInformation: "basic",
      }),
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
  it("updates one Markdown block without replacing its neighboring block ID", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    const inserted = await client.blocks.children.append({
      block_id: installed.pageId,
      children: [
        { paragraph: { rich_text: [{ text: { content: "First paragraph" } }] } },
        { paragraph: { rich_text: [{ text: { content: "Second paragraph" } }] } },
      ] as never,
    });
    expect(inserted.results).toHaveLength(2);
    const before = await client.pages.retrieveMarkdown({ page_id: installed.pageId });
    expect(before.markdown).toContain("First paragraph\n\nSecond paragraph");
    const patched = await SELF.fetch(
      notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "update_content",
          update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] },
        }),
      }),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json<{ markdown: string }>()).markdown).toContain("Changed paragraph\n\nSecond paragraph");
    const after = await client.blocks.children.list({ block_id: installed.pageId });
    expect(after.results.map((item) => item.id)).toEqual(inserted.results.map((item) => item.id));
  });

  it("keeps a local image durable when replacing Markdown copied from an earlier GET", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    const attachmentId = crypto.randomUUID();
    const owner = await env.DB.prepare(`SELECT workspace_id, created_by FROM pages WHERE id=?`)
      .bind(installed.pageId)
      .first<{ workspace_id: string; created_by: string }>();
    await env.DB.prepare(
      `INSERT INTO attachments(id,workspace_id,page_id,r2_key,name,mime,size,created_by,created_at)
       VALUES (?,?,?,?,?,'image/png',4,?,?)`,
    )
      .bind(
        attachmentId,
        owner!.workspace_id,
        installed.pageId,
        `test/${attachmentId}`,
        "diagram.png",
        owner!.created_by,
        Date.now(),
      )
      .run();
    await client.blocks.children.append({
      block_id: installed.pageId,
      children: [
        { image: { type: "external", external: { url: `http://example.test/api/attachments/${attachmentId}` } } },
      ] as never,
    });
    const before = await client.pages.retrieveMarkdown({ page_id: installed.pageId });
    expect(before.markdown).toContain(`/v1/files/${attachmentId}?expires=`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await client.pages.updateMarkdown({
      page_id: installed.pageId,
      type: "replace_content",
      replace_content: { new_str: `${before.markdown}\nAdded` },
    });
    expect(updated.markdown).toContain("Added");
    const blocks = await client.blocks.children.list({ block_id: installed.pageId });
    expect(blocks.results[0]).toMatchObject({ type: "image", image: { type: "file" } });
  });

  it("rejects a retried synchronous insert with the same operation key", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const request = () =>
      notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "insert-once" },
        body: JSON.stringify({ type: "insert_content", insert_content: { content: "Once" } }),
      });
    expect((await SELF.fetch(request())).status).toBe(200);
    const retry = await SELF.fetch(request());
    expect(retry.status).toBe(409);
    expect(
      (await notion(createdIntegration.token).pages.retrieveMarkdown({ page_id: installed.pageId })).markdown,
    ).toBe("Once\n");
  });

  it.each(["native", "public", "stale", "foreign"])(
    "verifies %s comment targets before protecting Markdown content",
    async (target) => {
      const installed = await bootstrap();
      const createdIntegration = await integration(installed.cookie, installed.pageId);
      const client = notion(createdIntegration.token);
      await client.blocks.children.append({
        block_id: installed.pageId,
        children: [{ paragraph: { rich_text: [{ text: { content: "Original body" } }] } }] as never,
      });
      const metadata = (await env.DB.prepare(
        "SELECT id,internal_id FROM api_blocks WHERE page_id=? AND deleted_at IS NULL",
      )
        .bind(installed.pageId)
        .first<{ id: string; internal_id: string }>())!;
      if (target === "foreign") {
        await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
        SELECT 'foreign-page',workspace_id,space_id,kind,'z9','Other page',created_by,created_at,updated_at FROM pages WHERE id=?`)
          .bind(installed.pageId)
          .run();
        await env.DB.prepare(`INSERT INTO api_blocks(id,page_id,internal_id,content_hash,created_at,updated_at)
        VALUES (?,'foreign-page','foreign-native','hash',1,1)`)
          .bind(metadata.internal_id)
          .run();
      }
      await env.DB.prepare(`INSERT INTO comment_threads(id,workspace_id,space_id,page_id,created_by,block_id,created_at,updated_at)
      SELECT 'thread',workspace_id,space_id,id,created_by,?,1,1 FROM pages WHERE id=?`)
        .bind(target === "public" || target === "stale" ? metadata.id : metadata.internal_id, installed.pageId)
        .run();
      if (target === "stale")
        await env.DB.prepare("UPDATE api_blocks SET deleted_at=1 WHERE id=?").bind(metadata.id).run();
      const response = await SELF.fetch(
        notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "replace_content",
            replace_content: { new_str: "Replacement", allow_deleting_content: true },
          }),
        }),
      );
      expect(response.status).toBe(target === "foreign" ? 200 : 400);
      expect(await response.json()).toMatchObject(
        target === "foreign" ? { markdown: "Replacement\n" } : { code: "validation_error" },
      );
      expect((await client.pages.retrieveMarkdown({ page_id: installed.pageId })).markdown).toBe(
        target === "foreign" ? "Replacement\n" : "Original body\n",
      );
    },
  );

  it("runs all four Markdown commands through the Notion SDK", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    await client.blocks.children.append({
      block_id: installed.pageId,
      children: [
        { paragraph: { rich_text: [{ text: { content: "First paragraph" } }] } },
        { paragraph: { rich_text: [{ text: { content: "Second paragraph" } }] } },
      ] as never,
    });
    const inserted = await client.pages.updateMarkdown({
      page_id: installed.pageId,
      type: "insert_content",
      insert_content: { content: "Intro\n\n", position: { type: "start" } },
    });
    expect(inserted.markdown).toContain("Intro\n\nFirst paragraph");
    const updated = await client.pages.updateMarkdown({
      page_id: installed.pageId,
      type: "update_content",
      update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] },
    });
    expect(updated.markdown).toContain("Changed paragraph");
    const ranged = await client.pages.updateMarkdown({
      page_id: installed.pageId,
      type: "replace_content_range",
      replace_content_range: { content_range: "Second...paragraph", content: "Last" },
    });
    expect(ranged.markdown).toContain("Last");
    const replaced = await client.pages.updateMarkdown({
      page_id: installed.pageId,
      type: "replace_content",
      replace_content: { new_str: "## Replaced\n\nNew body" },
    });
    expect(replaced.markdown).toBe("## Replaced\n\nNew body\n");
  });

  it("rejects ambiguous and unsafe Markdown without changing the page", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    await client.blocks.children.append({
      block_id: installed.pageId,
      children: [
        { paragraph: { rich_text: [{ text: { content: "First paragraph" } }] } },
        { paragraph: { rich_text: [{ text: { content: "Second paragraph" } }] } },
      ] as never,
    });
    const before = await client.pages.retrieveMarkdown({ page_id: installed.pageId });
    for (const input of [
      { type: "update_content", update_content: { content_updates: [{ old_str: "paragraph", new_str: "text" }] } },
      { type: "replace_content", replace_content: { new_str: "<script>alert(1)</script>" } },
    ]) {
      const response = await SELF.fetch(
        notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ object: "error", code: "validation_error" });
      expect((await client.pages.retrieveMarkdown({ page_id: installed.pageId })).markdown).toBe(before.markdown);
    }
  });

  it.each(["blocks", "pages"])("reports a retired %s mutation as an unknown outcome", async (kind) => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    let mutations = 0;
    const bindings = new Proxy(env, {
      get(target, key, receiver) {
        if (key === "DOCUMENT")
          return {
            getByName(name: string) {
              const stub = env.DOCUMENT.getByName(name);
              return {
                fetch: async (request: Request) => {
                  if (new URL(request.url).pathname === "/api-mutate") {
                    mutations++;
                    return Response.json({ error: "document_retired" }, { status: 410 });
                  }
                  return stub.fetch(request);
                },
              };
            },
          };
        return Reflect.get(target, key, receiver);
      },
    }) as Cloudflare.Env;
    const context = createExecutionContext();
    const children = [{ paragraph: { rich_text: [{ text: { content: "New content" } }] } }];
    const response = await worker.fetch(
      notionRequest(createdIntegration.token, kind === "blocks" ? `/blocks/${installed.pageId}/children` : "/pages", {
        method: kind === "blocks" ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          kind === "blocks"
            ? { children }
            : {
                parent: { type: "page_id", page_id: installed.pageId },
                properties: { title: { title: [{ text: { content: "New page" } }] } },
                children,
              },
        ),
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "conflict_error",
      message: "The mutation outcome is unknown. Fetch the page before retrying.",
    });
    expect(mutations).toBe(1);
  });

  it.each([false, true].flatMap((async) => ["mutation", "receipt"].map((boundary) => ({ async, boundary }))))(
    "reports retirement at $boundary as an unknown outcome in Markdown (async=$async)",
    async ({ async, boundary }) => {
      const installed = await bootstrap();
      const createdIntegration = await integration(installed.cookie, installed.pageId);
      const client = notion(createdIntegration.token);
      await client.blocks.children.append({
        block_id: installed.pageId,
        children: [{ paragraph: { rich_text: [{ text: { content: "Before" } }] } }] as never,
      });
      let mutations = 0;
      const document = {
        getByName(name: string) {
          const stub = env.DOCUMENT.getByName(name);
          return {
            fetch: async (request: Request) => {
              const path = new URL(request.url).pathname;
              if (path === "/api-mutate") mutations++;
              if (
                (boundary === "mutation" && path === "/api-mutate") ||
                (boundary === "receipt" && path === "/api-mutate-receipt")
              )
                return Response.json({ error: "document_retired" }, { status: 410 });
              return stub.fetch(request);
            },
          };
        },
      } as unknown as Cloudflare.Env["DOCUMENT"];
      const bindings = new Proxy(env, {
        get(target, key, receiver) {
          if (key === "DOCUMENT") return document;
          return Reflect.get(target, key, receiver);
        },
      }) as Cloudflare.Env;
      const context = createExecutionContext();
      const response = await worker.fetch(
        notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "idempotency-key": "retirement-test" },
          body: JSON.stringify({
            type: "update_content",
            update_content: { content_updates: [{ old_str: "Before", new_str: "After" }] },
            allow_async: async,
          }),
        }),
        bindings,
        context,
      );
      await waitOnExecutionContext(context);
      const failure = async
        ? (await env.DB.prepare("SELECT status,error_json FROM notion_markdown_tasks").first<{
            status: string;
            error_json: string;
          }>())!
        : null;
      expect(response.status).toBe(async ? 202 : 409);
      expect(failure?.status ?? null).toBe(async ? "failed" : null);
      const outcome = async ? JSON.parse(failure!.error_json) : await response.json();
      expect(outcome).toMatchObject({
        code: "conflict_error",
        message: "The mutation outcome is unknown. Fetch the page before retrying.",
      });
      expect(mutations).toBe(boundary === "mutation" ? 1 : 0);
      if (async) await recoverNotionMarkdownTasks(bindings);
      expect(mutations).toBe(boundary === "mutation" ? 1 : 0);
    },
  );

  it("runs an async Markdown task once and scopes polling to its integration", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const otherIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    await client.blocks.children.append({
      block_id: installed.pageId,
      children: [{ paragraph: { rich_text: [{ text: { content: "Before" } }] } }] as never,
    });
    const context = createExecutionContext();
    const response = await worker.fetch(
      notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "async-once" },
        body: JSON.stringify({
          type: "update_content",
          update_content: { content_updates: [{ old_str: "Before", new_str: "After" }] },
          allow_async: true,
        }),
      }),
      env,
      context,
    );
    expect(response.status).toBe(202);
    const accepted = await response.json<{
      id: string;
      status: string;
      status_url: string;
      operation: { name: string };
    }>();
    expect(accepted).toMatchObject({
      object: "async_task",
      status: "queued",
      operation: { name: "PATCH /v1/pages/:page_id/markdown" },
    });
    expect(accepted.status_url).toContain(`/v1/async_tasks/${accepted.id}`);
    const duplicate = await SELF.fetch(
      notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "async-once" },
        body: JSON.stringify({
          type: "update_content",
          update_content: { content_updates: [{ old_str: "Before", new_str: "After" }] },
          allow_async: true,
        }),
      }),
    );
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json<{ id: string }>()).id).toBe(accepted.id);
    expect((await SELF.fetch(notionRequest(otherIntegration.token, `/async_tasks/${accepted.id}`))).status).toBe(404);
    await waitOnExecutionContext(context);
    const polled = await SELF.fetch(notionRequest(createdIntegration.token, `/async_tasks/${accepted.id}`));
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({
      object: "async_task",
      status: "succeeded",
      result: { object: "page_markdown", markdown: "After\n" },
    });
    expect((await client.pages.retrieveMarkdown({ page_id: installed.pageId })).markdown).toBe("After\n");
    const committedOperation = await env.DB.prepare("SELECT operation_id FROM notion_markdown_tasks WHERE id=?")
      .bind(accepted.id)
      .first<{ operation_id: string }>();
    await env.DB.prepare(
      `UPDATE notion_markdown_tasks SET status='running',attempts=10,lease_token='stale',
         lease_expires_at=?,next_attempt_at=?,result_json=NULL WHERE id=?`,
    )
      .bind(Date.now() - 1, Date.now() - 1, accepted.id)
      .run();
    await recoverNotionMarkdownTasks(env);
    const recovered = await SELF.fetch(notionRequest(createdIntegration.token, `/async_tasks/${accepted.id}`));
    expect((await recovered.json<{ status: string }>()).status).toBe("succeeded");
    await env.DB.prepare(
      `UPDATE notion_markdown_tasks SET status='running',attempts=10,operation_id='markdown:missing-receipt',
         lease_token='stale',lease_expires_at=?,next_attempt_at=?,result_json=NULL WHERE id=?`,
    )
      .bind(Date.now() - 1, Date.now() - 1, accepted.id)
      .run();
    await recoverNotionMarkdownTasks(env);
    expect(
      (
        await (
          await SELF.fetch(notionRequest(createdIntegration.token, `/async_tasks/${accepted.id}`))
        ).json<{ status: string }>()
      ).status,
    ).toBe("failed");
    await env.DB.prepare(
      `UPDATE notion_markdown_tasks SET status='running',attempts=10,operation_id='markdown:missing-receipt',
         error_json=?,lease_token='stale',lease_expires_at=?,next_attempt_at=? WHERE id=?`,
    )
      .bind(
        JSON.stringify({
          object: "error",
          status: 503,
          code: "service_unavailable",
          message: "Earlier write failure.",
        }),
        Date.now() - 1,
        Date.now() - 1,
        accepted.id,
      )
      .run();
    await recoverNotionMarkdownTasks(env);
    expect(
      await (
        await SELF.fetch(notionRequest(createdIntegration.token, `/async_tasks/${accepted.id}`))
      ).json<{ error: { message: string } }>(),
    ).toMatchObject({ status: "failed", error: { message: "Earlier write failure." } });
    await env.DB.prepare(
      `UPDATE notion_markdown_tasks SET status='running',attempts=10,operation_id=?,lease_token='stale',
         lease_expires_at=?,next_attempt_at=?,expires_at=? WHERE id=?`,
    )
      .bind(
        committedOperation!.operation_id,
        Date.now() - 1,
        Date.now() - 1,
        Date.now() - 8 * 24 * 60 * 60_000,
        accepted.id,
      )
      .run();
    await recoverNotionMarkdownTasks(env);
    expect(
      await (
        await SELF.fetch(notionRequest(createdIntegration.token, `/async_tasks/${accepted.id}`))
      ).json<{ status: string }>(),
    ).toMatchObject({ status: "succeeded" });
    const revokeRead = await SELF.fetch(
      authenticated(installed.cookie, `/api/integrations/${createdIntegration.integration.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readContent: false }),
      }),
    );
    expect(revokeRead.status).toBe(200);
    expect((await SELF.fetch(notionRequest(createdIntegration.token, `/async_tasks/${accepted.id}`))).status).toBe(403);
    const restoreRead = await SELF.fetch(
      authenticated(installed.cookie, `/api/integrations/${createdIntegration.integration.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readContent: true }),
      }),
    );
    expect(restoreRead.status).toBe(200);
    await env.DB.prepare(`UPDATE notion_markdown_tasks SET expires_at=? WHERE id=?`)
      .bind(Date.now() - 1, accepted.id)
      .run();
    expect((await SELF.fetch(notionRequest(createdIntegration.token, `/async_tasks/${accepted.id}`))).status).toBe(404);
  });

  it("retrieves Markdown only with a valid read grant", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    const inserted = await client.blocks.children.append({
      block_id: installed.pageId,
      children: [{ heading_2: { rich_text: [{ text: { content: "Plans" } }] } }] as never,
    });
    expect(inserted.results).toHaveLength(1);
    const markdown = await client.pages.retrieveMarkdown({ page_id: installed.pageId });
    expect(markdown).toMatchObject({
      object: "page_markdown",
      markdown: "## Plans\n",
      truncated: false,
      unknown_block_ids: [],
    });
    const child = await client.pages.create({
      parent: { type: "page_id", page_id: installed.pageId },
      properties: { title: { type: "title", title: [{ text: { content: "Child specification" } }] } },
    });
    const withChild = await client.pages.retrieveMarkdown({ page_id: installed.pageId });
    expect(withChild.markdown).toContain("Child specification");
    expect(withChild.markdown).toContain("?page=");
    expect(withChild.unknown_block_ids).toEqual([]);
    await env.DB.prepare(`UPDATE pages SET is_template=1 WHERE id=?`).bind(child.id).run();
    const withoutTemplate = await client.pages.retrieveMarkdown({ page_id: installed.pageId });
    expect(withoutTemplate.markdown).not.toContain("Child specification");
    await env.DB.prepare(`UPDATE pages SET is_template=0,import_job_id='staged' WHERE id=?`).bind(child.id).run();
    const withoutStaged = await client.pages.retrieveMarkdown({ page_id: installed.pageId });
    expect(withoutStaged.markdown).not.toContain("Child specification");
    const missing = await SELF.fetch(notionRequest("invalid", `/pages/${installed.pageId}/markdown`));
    expect(missing.status).toBe(401);
    const deniedCapability = await SELF.fetch(
      authenticated(installed.cookie, `/api/integrations/${createdIntegration.integration.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readContent: false }),
      }),
    );
    expect(deniedCapability.status).toBe(200);
    expect(
      (await SELF.fetch(notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`))).status,
    ).toBe(403);
    expect(
      (
        await SELF.fetch(
          notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "insert_content", insert_content: { content: "" } }),
          }),
        )
      ).status,
    ).toBe(403);
    const restoredCapability = await SELF.fetch(
      authenticated(installed.cookie, `/api/integrations/${createdIntegration.integration.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readContent: true }),
      }),
    );
    expect(restoredCapability.status).toBe(200);
    const removedGrant = await SELF.fetch(
      authenticated(installed.cookie, `/api/integrations/${createdIntegration.integration.id}/grants`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootPageIds: [] }),
      }),
    );
    expect(removedGrant.status).toBe(200);
    expect(
      (await SELF.fetch(notionRequest(createdIntegration.token, `/pages/${installed.pageId}/markdown`))).status,
    ).toBe(404);
  });
  it("preserves an authored date token through block reads and writes", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const me = await (await SELF.fetch(authenticated(installed.cookie, "/api/me"))).json<{ user: { id: string } }>();
    const nextYear = new Date().getUTCFullYear() + 1;
    const mention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: me.user.id,
      kind: "timed" as const,
      value: `${nextYear}-10-01T14:00:00.000Z`,
      timezone: "America/Chicago",
    };
    const inserted = await env.DOCUMENT.getByName(`${installed.pageId}~1`).fetch(
      new Request("https://document.internal/api-mutate", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          actorId: me.user.id,
          operations: [
            {
              type: "append_children",
              children: [
                {
                  type: "blockContainer",
                  attrs: { id: crypto.randomUUID() },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "dateMention", attrs: dateMentionWireProps(mention) }],
                    },
                  ],
                },
              ],
              position: { type: "end" },
            },
          ],
        }),
      }),
    );
    expect(inserted.status).toBe(200);
    const duplicate = await env.DOCUMENT.getByName(`${installed.pageId}~1`).fetch(
      new Request("https://document.internal/api-mutate", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          actorId: me.user.id,
          operations: [
            {
              type: "append_children",
              children: [
                {
                  type: "blockContainer",
                  attrs: { id: crypto.randomUUID() },
                  content: [
                    { type: "paragraph", content: [{ type: "dateMention", attrs: dateMentionWireProps(mention) }] },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(duplicate.status).toBe(409);
    const read = await SELF.fetch(notionRequest(createdIntegration.token, `/blocks/${installed.pageId}/children`));
    const blocks = await read.json<{
      results: Array<{ id: string; paragraph: { rich_text: Array<Record<string, unknown>> } }>;
    }>();
    const block = blocks.results.find((entry) => entry.paragraph?.rich_text?.[0]?.type === "mention");
    expect(block).toBeTruthy();
    const originalRichText = block!.paragraph.rich_text;
    const copiedTarget = await SELF.fetch(
      notionRequest(createdIntegration.token, `/blocks/${installed.pageId}/children`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }] }),
      }),
    );
    expect(copiedTarget.status).toBe(200);
    const targetId = (await copiedTarget.json<{ results: Array<{ id: string }> }>()).results[0]!.id;
    const copy = await SELF.fetch(
      notionRequest(createdIntegration.token, `/blocks/${targetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paragraph: { rich_text: originalRichText } }),
      }),
    );
    expect(copy.status).toBe(200);
    expect(
      (await copy.json<{ paragraph: { rich_text: Array<{ type: string; plain_text: string }> } }>()).paragraph
        .rich_text,
    ).toEqual([expect.objectContaining({ type: "text", plain_text: originalRichText[0]!.plain_text })]);
    const reminder = await SELF.fetch(
      authenticated(installed.cookie, `/api/pages/${installed.pageId}/date-reminders/${mention.tokenId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: mention.revision, choice: "at_time" }),
      }),
    );
    expect(reminder.status).toBe(200);
    const copiedWithReminder = await SELF.fetch(
      notionRequest(createdIntegration.token, `/blocks/${targetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paragraph: { rich_text: originalRichText } }),
      }),
    );
    expect(copiedWithReminder.status).toBe(200);
    expect(
      (await copiedWithReminder.json<{ paragraph: { rich_text: Array<{ type: string }> } }>()).paragraph.rich_text[0]
        ?.type,
    ).toBe("text");
    const patched = await SELF.fetch(
      notionRequest(createdIntegration.token, `/blocks/${block!.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paragraph: { rich_text: originalRichText } }),
      }),
    );
    expect(patched.status).toBe(200);
    const preserved = await patched.json<{
      paragraph: { rich_text: Array<{ mention: { noteFlare: { payload: string } } }> };
    }>();
    expect(JSON.parse(preserved.paragraph.rich_text[0]!.mention.noteFlare.payload)).toMatchObject(mention);
    for (const start of [
      `${nextYear}-10-01T09:00:00-05:00`,
      `${nextYear}-10-01T09:00:00`,
      `${nextYear}-10-01T14:00:00.000000Z`,
    ]) {
      const roundTrip = structuredClone(originalRichText);
      (roundTrip[0]!.mention as { date: { start: string } }).date.start = start;
      const response = await SELF.fetch(
        notionRequest(createdIntegration.token, `/blocks/${block!.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paragraph: { rich_text: roundTrip } }),
        }),
      );
      expect(response.status).toBe(200);
      const normalized = await response.json<{
        paragraph: { rich_text: Array<{ mention: { noteFlare: { payload: string } } }> };
      }>();
      expect(JSON.parse(normalized.paragraph.rich_text[0]!.mention.noteFlare.payload)).toMatchObject(mention);
    }
    const invalidRichText = structuredClone(originalRichText);
    (invalidRichText[0]!.mention as { date: { start: string } }).date.start = `${nextYear}-02-30T09:00:00Z`;
    expect(
      (
        await SELF.fetch(
          notionRequest(createdIntegration.token, `/blocks/${block!.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paragraph: { rich_text: invalidRichText } }),
          }),
        )
      ).status,
    ).toBe(400);
    const editedRichText = structuredClone(originalRichText);
    const editedMention = editedRichText[0]!.mention as { date: { start: string } };
    editedMention.date.start = `${nextYear}-10-05T14:00:00.000Z`;
    const edited = await SELF.fetch(
      notionRequest(createdIntegration.token, `/blocks/${block!.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paragraph: { rich_text: editedRichText } }),
      }),
    );
    expect(edited.status).toBe(200);
    const updated = await edited.json<{
      paragraph: { rich_text: Array<{ mention: { noteFlare: { payload: string } } }> };
    }>();
    expect(JSON.parse(updated.paragraph.rich_text[0]!.mention.noteFlare.payload)).toMatchObject({
      tokenId: mention.tokenId,
      createdBy: mention.createdBy,
      value: `${nextYear}-10-05T14:00:00.000Z`,
    });
    const movedMention = JSON.parse(updated.paragraph.rich_text[0]!.mention.noteFlare.payload) as {
      tokenId: string;
      revision: string;
    };
    const reminderPath = `/api/pages/${installed.pageId}/date-reminders/${mention.tokenId}`;
    expect(
      (
        await SELF.fetch(
          authenticated(installed.cookie, reminderPath, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              revision: movedMention.revision,
              choice: { absolute: new Date(Date.now() + 24 * 60 * 60_000).toISOString() },
            }),
          }),
        )
      ).status,
    ).toBe(200);
    const appended = await SELF.fetch(
      notionRequest(createdIntegration.token, `/blocks/${installed.pageId}/children`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ children: [{ paragraph: { rich_text: [] } }] }),
      }),
    );
    expect(appended.status).toBe(200);
    const target = await appended.json<{ results: Array<{ id: string }> }>();
    expect(
      (await SELF.fetch(notionRequest(createdIntegration.token, `/blocks/${block!.id}`, { method: "DELETE" }))).status,
    ).toBe(200);
    const moved = await SELF.fetch(
      notionRequest(createdIntegration.token, `/blocks/${target.results[0]!.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paragraph: { rich_text: updated.paragraph.rich_text } }),
      }),
    );
    expect(moved.status).toBe(200);
    const movedBlock = await moved.json<{
      paragraph: { rich_text: Array<{ mention: { noteFlare: { payload: string } } }> };
    }>();
    expect(JSON.parse(movedBlock.paragraph.rich_text[0]!.mention.noteFlare.payload)).toMatchObject({
      tokenId: mention.tokenId,
      createdBy: mention.createdBy,
    });
    expect(JSON.parse(movedBlock.paragraph.rich_text[0]!.mention.noteFlare.payload).revision).not.toBe(
      movedMention.revision,
    );
    const afterMove = await (
      await SELF.fetch(authenticated(installed.cookie, reminderPath))
    ).json<{
      reminder: { state: string } | null;
    }>();
    expect(afterMove.reminder?.state).toBe("active");
  });
  it("round-trips expanded embed URLs through /v1 while framing is disabled", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const disabledEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "EXPANDED_EMBEDS_ENABLED" ? "false" : Reflect.get(target, property, receiver);
      },
    });
    const request = async (path: string, init: RequestInit = {}) => {
      const context = createExecutionContext();
      const response = await worker.fetch(notionRequest(createdIntegration.token, path, init), disabledEnv, context);
      await waitOnExecutionContext(context);
      return response;
    };
    const url = "https://www.loom.com/share/be3f4b20127d47be9f884c3fab71d030";
    const appended = await request(`/blocks/${installed.pageId}/children`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ children: [{ embed: { url } }] }),
    });
    expect(appended.status).toBe(200);
    const { results } = await appended.json<{ results: Array<{ id: string; embed: { url: string } }> }>();
    expect(results[0]?.embed.url).toBe(url);
    const read = await request(`/blocks/${installed.pageId}/children`);
    expect((await read.json<{ results: Array<{ embed: { url: string } }> }>()).results[0]?.embed.url).toBe(url);
    const updated = await request(`/blocks/${results[0]!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embed: { url } }),
    });
    expect(updated.status).toBe(200);
  });
  it("uses responding templates for overlapping users and file routes", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const writeDataPoint = vi.fn();
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "OBSERVABILITY") return { writeDataPoint };
        return Reflect.get(target, property, receiver);
      },
    });
    await worker.fetch(notionRequest(createdIntegration.token, "/users/me"), bindings, createExecutionContext());
    await worker.fetch(new Request(await signedFileUrl(installed.pageId)), bindings, createExecutionContext());
    const routes = writeDataPoint.mock.calls
      .map(([point]) => point)
      .filter((point) => point.indexes[0] === "http.request")
      .map((point) => point.blobs[2]);
    expect(routes).toEqual(["/v1/users/me", "/v1/files/:attachmentId"]);
  });

  it("labels early API errors by endpoint and unknown API paths as unmatched", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const writeDataPoint = vi.fn();
    const rateLimited = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    const bindings = (limited: boolean) =>
      new Proxy(env, {
        get(target, property, receiver) {
          if (property === "OBSERVABILITY") return { writeDataPoint };
          if (property === "ASSETS") return { fetch: async () => new Response("Not found", { status: 404 }) };
          if (limited && property === "API_SOURCE_BURST_LIMIT") return rateLimited;
          return Reflect.get(target, property, receiver);
        },
      });
    const pagePath = `/v1/pages/${installed.pageId}`;
    const requests = [
      [new Request(`http://example.test${pagePath}`), 400, false],
      [notionRequest("invalid", `/pages/${installed.pageId}`), 401, false],
      [notionRequest(`crn_${"a".repeat(43)}`, `/pages/${installed.pageId}`), 429, true],
      [notionRequest(createdIntegration.token, "/nope/123"), 404, false],
    ] as const;
    for (const [request, status, limited] of requests) {
      const response = await worker.fetch(request, bindings(limited), createExecutionContext());
      expect(response.status).toBe(status);
    }
    const routes = writeDataPoint.mock.calls
      .map(([point]) => point)
      .filter((point) => point.indexes[0] === "http.request")
      .map((point) => point.blobs[2]);
    expect(routes).toEqual(["/v1/pages/:pageId", "/v1/pages/:pageId", "/v1/pages/:pageId", "/unmatched"]);
  });

  it("returns the updated Notion block when it is deleted during compaction", async () => {
    const installed = await bootstrap();
    const created = await integration(installed.cookie, installed.pageId);
    const appended = await notion(created.token).blocks.children.append({
      block_id: installed.pageId,
      children: [{ paragraph: { rich_text: [{ text: { content: "Before race" } }] } }],
    });
    const blockId = appended.results[0]!.id;
    let deleted = false;
    const bindings = new Proxy(env, {
      get(target, key, receiver) {
        if (key === "DOCUMENT")
          return {
            getByName(name: string) {
              const stub = env.DOCUMENT.getByName(name);
              return {
                async fetch(request: Request) {
                  if (!new URL(request.url).pathname.endsWith("/api-mutate")) return stub.fetch(request);
                  const body = await request.text();
                  return runInDurableObject(stub, async (instance) => {
                    const room = instance as unknown as {
                      document: Y.Doc;
                      compact(force?: boolean): Promise<void>;
                      onRequest(request: Request): Promise<Response>;
                    };
                    const compact = room.compact.bind(room);
                    const spy = vi.spyOn(room, "compact").mockImplementation(async (force) => {
                      const group = room.document.getXmlFragment("document-store").get(0) as Y.XmlElement;
                      group.delete(group.length - 1, 1);
                      deleted = true;
                      await compact(force);
                    });
                    try {
                      return await room.onRequest(
                        new Request(request.url, {
                          method: request.method,
                          headers: request.headers,
                          body,
                        }),
                      );
                    } finally {
                      spy.mockRestore();
                    }
                  });
                },
              };
            },
          };
        return Reflect.get(target, key, receiver);
      },
    }) as Cloudflare.Env;
    const context = createExecutionContext();
    const response = await worker.fetch(
      notionRequest(created.token, `/blocks/${blockId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paragraph: { rich_text: [{ text: { content: "Updated before deletion" } }] } }),
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);
    const responseBody = await response.json();
    expect(response.status).toBe(200);
    expect(deleted).toBe(true);
    expect(JSON.stringify(responseBody)).toContain("Updated before deletion");
  });

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

  it("rejects actual request bodies over 500 KiB without relying on Content-Length", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const oversizedBody = JSON.stringify({ query: "x".repeat(500 * 1024) });
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", "content-length": "1" },
    ]) {
      const response = await SELF.fetch(
        notionRequest(createdIntegration.token, "/search", {
          method: "POST",
          headers,
          body: oversizedBody,
        }),
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ object: "error", code: "validation_error" });
    }
  });

  it("validates page children before writing and removes a staged page when document initialization fails", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const invalid = await SELF.fetch(
      notionRequest(createdIntegration.token, "/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parent: { type: "page_id", page_id: installed.pageId },
          properties: { title: { title: [{ text: { content: "Invalid child page" } }] } },
          children: [{ embed: { url: "https://untrusted.example/embed" } }],
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(env.DB.prepare(`SELECT id FROM pages WHERE title = 'Invalid child page'`).first()).resolves.toBeNull();

    const calls: Array<{ room: string; path: string }> = [];
    const document = {
      getByName(room: string) {
        return {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            calls.push({ room, path });
            return path.endsWith("/purge")
              ? Response.json({ purged: true })
              : Response.json({ error: "injected failure" }, { status: 503 });
          },
        };
      },
    } as unknown as Cloudflare.Env["DOCUMENT"];
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "DOCUMENT") return document;
        return Reflect.get(target, property, receiver);
      },
    }) as Cloudflare.Env;
    const context = createExecutionContext();
    const failed = await worker.fetch(
      notionRequest(createdIntegration.token, "/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parent: { type: "page_id", page_id: installed.pageId },
          properties: { title: { title: [{ text: { content: "Failed staged page" } }] } },
          children: [{ paragraph: { rich_text: [{ text: { content: "Valid child" } }] } }],
        }),
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);

    expect(failed.status).toBe(503);
    expect(calls.map((call) => call.path)).toEqual([
      expect.stringMatching(/\/api-mutate$/),
      expect.stringMatching(/\/purge$/),
    ]);
    await expect(env.DB.prepare(`SELECT id FROM pages WHERE title = 'Failed staged page'`).first()).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        `SELECT event.id FROM webhook_events event
          JOIN pages page ON page.id = event.page_id WHERE page.title = 'Failed staged page'`,
      ).first(),
    ).resolves.toBeNull();
  });

  it("publishes a page with initialized children exactly once", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const context = createExecutionContext();
    const response = await worker.fetch(
      notionRequest(createdIntegration.token, "/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parent: { type: "page_id", page_id: installed.pageId },
          properties: { title: { title: [{ text: { content: "Initialized page" } }] } },
          children: [{ paragraph: { rich_text: [{ text: { content: "Initial content" } }] } }],
        }),
      }),
      env,
      context,
    );
    const created = await response.json<{ id: string }>();
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    await expect(
      env.DB.prepare(`SELECT import_job_id FROM pages WHERE id = ?`).bind(created.id).first(),
    ).resolves.toEqual({ import_job_id: null });
    const events = await env.DB.prepare(`SELECT event_type FROM webhook_events WHERE page_id = ? ORDER BY event_type`)
      .bind(created.id)
      .all<{ event_type: string }>();
    expect(events.results).toEqual([{ event_type: "page.created" }]);
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

    const trashContext = createExecutionContext();
    const trashed = await worker.fetch(
      notionRequest(createdIntegration.token, `/pages/${child.id}/trash`, { method: "POST" }),
      env,
      trashContext,
    );
    await waitOnExecutionContext(trashContext);
    expect(trashed.status).toBe(200);
    await expect(trashed.json()).resolves.toMatchObject({ in_trash: true });
  });

  it("disconnects every collaborative room in an archived subtree", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    const child = await client.pages.create({
      parent: { type: "page_id", page_id: installed.pageId },
      properties: { title: { type: "title", title: [{ text: { content: "Archive child" } }] } },
    });
    const grandchild = await client.pages.create({
      parent: { type: "page_id", page_id: child.id },
      properties: { title: { type: "title", title: [{ text: { content: "Archive grandchild" } }] } },
    });
    const archivedRooms: string[] = [];
    const document = {
      getByName(room: string) {
        return {
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname.endsWith("/archive")) archivedRooms.push(room);
            return Response.json({ archived: true });
          },
        };
      },
    } as unknown as Cloudflare.Env["DOCUMENT"];
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "DOCUMENT") return document;
        return Reflect.get(target, property, receiver);
      },
    }) as Cloudflare.Env;
    const context = createExecutionContext();
    const response = await worker.fetch(
      notionRequest(createdIntegration.token, `/pages/${child.id}/trash`, { method: "POST" }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    expect(new Set(archivedRooms)).toEqual(new Set([`${child.id}~1`, `${grandchild.id}~1`]));
    await expect(
      env.DB.prepare(`SELECT COUNT(*) count FROM archive_disconnect_targets WHERE page_id IN (?, ?)`)
        .bind(child.id, grandchild.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("preserves independently archived descendants across Notion trash and restore", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const client = notion(createdIntegration.token);
    const child = await client.pages.create({
      parent: { type: "page_id", page_id: installed.pageId },
      properties: { title: { type: "title", title: [{ text: { content: "Archive parent" } }] } },
    });
    const grandchild = await client.pages.create({
      parent: { type: "page_id", page_id: child.id },
      properties: { title: { type: "title", title: [{ text: { content: "Independently archived" } }] } },
    });
    const metadata = await env.DB.prepare(`SELECT workspace_id, content_epoch FROM pages WHERE id = ?`)
      .bind(grandchild.id)
      .first<{ workspace_id: string; content_epoch: number }>();
    const grandchildArchivedAt = 123;
    const grandchildArchiveOperationId = "independent-grandchild-archive";
    const targetUpdatedAt = 456;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE pages SET archived_at = ?, archive_operation_id = ?, revision = revision + 1 WHERE id = ?`,
      ).bind(grandchildArchivedAt, grandchildArchiveOperationId, grandchild.id),
      env.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(grandchild.id),
      env.DB.prepare(
        `INSERT INTO archive_disconnect_targets
          (page_id, workspace_id, content_epoch, room, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        grandchild.id,
        metadata!.workspace_id,
        metadata!.content_epoch,
        `${grandchild.id}~${metadata!.content_epoch}`,
        Date.now() + 60_000,
        targetUpdatedAt,
        targetUpdatedAt,
      ),
    ]);

    const trashContext = createExecutionContext();
    const trashed = await worker.fetch(
      notionRequest(createdIntegration.token, `/pages/${child.id}/trash`, { method: "POST" }),
      env,
      trashContext,
    );
    expect(trashed.status).toBe(200);
    await waitOnExecutionContext(trashContext);
    const parentArchive = await env.DB.prepare(`SELECT archived_at FROM pages WHERE id = ?`)
      .bind(child.id)
      .first<{ archived_at: number }>();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`)
      .bind(parentArchive!.archived_at, grandchild.id)
      .run();

    const restoreContext = createExecutionContext();
    const restored = await worker.fetch(
      notionRequest(createdIntegration.token, `/pages/${child.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ in_trash: false }),
      }),
      env,
      restoreContext,
    );
    expect(restored.status).toBe(200);
    await waitOnExecutionContext(restoreContext);

    await expect(env.DB.prepare(`SELECT archived_at FROM pages WHERE id = ?`).bind(child.id).first()).resolves.toEqual({
      archived_at: null,
    });
    await expect(
      env.DB.prepare(`SELECT archived_at, archive_operation_id FROM pages WHERE id = ?`).bind(grandchild.id).first(),
    ).resolves.toEqual({
      archived_at: parentArchive!.archived_at,
      archive_operation_id: grandchildArchiveOperationId,
    });
    await expect(
      env.DB.prepare(`SELECT updated_at FROM archive_disconnect_targets WHERE page_id = ?`).bind(grandchild.id).first(),
    ).resolves.toEqual({ updated_at: targetUpdatedAt });
    await expect(
      env.DB.prepare(`SELECT COUNT(*) count FROM page_search WHERE page_id = ?`).bind(grandchild.id).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("routes API comments through watches, notifications, search, webhooks, and realtime invalidation", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const owner = await env.DB.prepare(`SELECT created_by FROM pages WHERE id = ?`)
      .bind(installed.pageId)
      .first<{ created_by: string }>();
    const bot = await env.DB.prepare(`SELECT bot_user_id FROM integrations WHERE id = ?`)
      .bind(createdIntegration.integration.id)
      .first<{ bot_user_id: string }>();
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
    const response = await worker.fetch(
      notionRequest(createdIntegration.token, "/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parent: { page_id: installed.pageId },
          rich_text: [
            { text: { content: "Review this" }, annotations: { bold: true } },
            {
              type: "mention",
              mention: { type: "user", user: { id: owner!.created_by } },
              plain_text: "Owner",
            },
          ],
        }),
      }),
      bindings,
      context,
    );
    const created = await response.json<{ id: string; discussion_id: string; rich_text: unknown[] }>();
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    expect(created.rich_text).toEqual(
      expect.arrayContaining([expect.objectContaining({ annotations: expect.objectContaining({ bold: true }) })]),
    );
    await expect(
      env.DB.prepare(
        `SELECT 1 watched FROM subscriptions
          WHERE user_id = ? AND resource_type = 'page' AND resource_id = ? AND muted_at IS NULL`,
      )
        .bind(bot!.bot_user_id, installed.pageId)
        .first(),
    ).resolves.toEqual({ watched: 1 });
    await expect(
      env.DB.prepare(
        `SELECT user_id, event_type, json_extract(data_json, '$.commentId') comment_id
           FROM notifications WHERE user_id = ? AND json_extract(data_json, '$.commentId') = ?`,
      )
        .bind(owner!.created_by, created.id)
        .first(),
    ).resolves.toEqual({ user_id: owner!.created_by, event_type: "mention", comment_id: created.id });
    await expect(
      env.DB.prepare(`SELECT comments FROM page_search_v2 WHERE page_id = ?`).bind(installed.pageId).first(),
    ).resolves.toEqual({ comments: expect.stringContaining("Review this") });
    await expect(
      env.DB.prepare(`SELECT event_type FROM webhook_events WHERE entity_id = ?`).bind(created.id).first(),
    ).resolves.toEqual({ event_type: "comment.created" });
    expect(broadcasts).toEqual(
      expect.arrayContaining([
        { type: "comments-invalidated", pageId: installed.pageId },
        { type: "notifications-invalidated" },
      ]),
    );

    const updateContext = createExecutionContext();
    const update = await worker.fetch(
      notionRequest(createdIntegration.token, `/comments/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rich_text: [{ text: { content: "Updated comment" } }] }),
      }),
      env,
      updateContext,
    );
    await waitOnExecutionContext(updateContext);
    expect(update.status).toBe(200);
    await expect(
      env.DB.prepare(
        `SELECT thread.updated_at thread_updated_at, comment.updated_at comment_updated_at
           FROM comment_threads thread JOIN comments comment ON comment.thread_id = thread.id
          WHERE thread.id = ? AND comment.id = ?`,
      )
        .bind(created.discussion_id, created.id)
        .first(),
    ).resolves.toEqual(
      expect.objectContaining({ thread_updated_at: expect.any(Number), comment_updated_at: expect.any(Number) }),
    );
    await expect(
      env.DB.prepare(`SELECT comments FROM page_search_v2 WHERE page_id = ?`).bind(installed.pageId).first(),
    ).resolves.toEqual({ comments: expect.stringContaining("Updated comment") });

    const deleteContext = createExecutionContext();
    const deleted = await worker.fetch(
      notionRequest(createdIntegration.token, `/comments/${created.id}`, { method: "DELETE" }),
      env,
      deleteContext,
    );
    await waitOnExecutionContext(deleteContext);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ rich_text: [] });
    await expect(
      env.DB.prepare(`SELECT comments FROM page_search_v2 WHERE page_id = ?`).bind(installed.pageId).first(),
    ).resolves.toEqual({ comments: expect.not.stringContaining("Updated comment") });
  });

  it("keeps browser editor attribution populated and applies the browser page field bounds to the API", async () => {
    const installed = await bootstrap();
    const createdIntegration = await integration(installed.cookie, installed.pageId);
    const owner = await env.DB.prepare(`SELECT created_by, updated_by FROM pages WHERE id = ?`)
      .bind(installed.pageId)
      .first<{ created_by: string; updated_by: string | null }>();
    expect(owner!.updated_by).toBe(owner!.created_by);

    const createContext = createExecutionContext();
    const browserCreate = await worker.fetch(
      authenticated(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Browser attribution" }),
      }),
      env,
      createContext,
    );
    await waitOnExecutionContext(createContext);
    const browserPage = await browserCreate.json<{ page: { id: string; revision: number } }>();
    await expect(
      env.DB.prepare(`SELECT updated_by FROM pages WHERE id = ?`).bind(browserPage.page.id).first(),
    ).resolves.toEqual({ updated_by: owner!.created_by });
    const patchContext = createExecutionContext();
    await worker.fetch(
      authenticated(installed.cookie, `/api/pages/${browserPage.page.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Browser renamed", revision: browserPage.page.revision }),
      }),
      env,
      patchContext,
    );
    await waitOnExecutionContext(patchContext);
    await expect(
      env.DB.prepare(`SELECT updated_by FROM pages WHERE id = ?`).bind(browserPage.page.id).first(),
    ).resolves.toEqual({ updated_by: owner!.created_by });

    const oversizedTitle = await SELF.fetch(
      notionRequest(createdIntegration.token, "/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parent: { type: "page_id", page_id: installed.pageId },
          properties: {
            title: {
              title: [{ text: { content: "x".repeat(150) } }, { text: { content: "y".repeat(51) } }],
            },
          },
        }),
      }),
    );
    expect(oversizedTitle.status).toBe(400);
    await expect(oversizedTitle.json()).resolves.toMatchObject({ code: "validation_error" });

    const oversizedIcon = await SELF.fetch(
      notionRequest(createdIntegration.token, `/pages/${installed.pageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ icon: { type: "emoji", emoji: "x".repeat(21) } }),
      }),
    );
    expect(oversizedIcon.status).toBe(400);
    await expect(oversizedIcon.json()).resolves.toMatchObject({ code: "validation_error" });
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
