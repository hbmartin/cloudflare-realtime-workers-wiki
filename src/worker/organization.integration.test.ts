import { enrollAccount } from "../../tests/helpers/security";
import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Page, Space, Tag } from "../shared/types";

type Installed = { cookie: string; pageId: string };

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

async function bootstrap(): Promise<Installed> {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Organization Notes",
      name: "Owner",
      email: "organization-owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = await enrollAccount(response);
  const pages = await (await SELF.fetch(request(cookie, "/api/pages/tree"))).json<{ pages: Page[] }>();
  return { cookie, pageId: pages.pages[0]!.id };
}

async function inviteViewer(ownerCookie: string) {
  const invitation = await SELF.fetch(
    request(ownerCookie, "/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    }),
  );
  const token = (await invitation.json<{ invite: { token: string } }>()).invite.token;
  const response = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({ token, name: "Viewer", email: "organization-viewer@example.test", password: "password123" }),
  });
  expect(response.status).toBe(200);
  return await enrollAccount(response, token);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("organization APIs", () => {
  it("archives templates in Trash and restores or permanently deletes them", async () => {
    const installed = await bootstrap();
    await env.DB.prepare(`UPDATE pages SET is_template = 1 WHERE id = ?`).bind(installed.pageId).run();

    const templates = () => SELF.fetch(request(installed.cookie, "/api/templates"));
    const trash = () => SELF.fetch(request(installed.cookie, "/api/pages/tree?archived=true"));
    expect((await (await templates()).json<{ templates: Page[] }>()).templates.map((page) => page.id)).toContain(
      installed.pageId,
    );

    const archived = await SELF.fetch(
      request(installed.cookie, `/api/pages/${installed.pageId}`, { method: "DELETE" }),
    );
    expect([200, 202]).toContain(archived.status);
    expect((await (await templates()).json<{ templates: Page[] }>()).templates).toHaveLength(0);
    expect((await (await trash()).json<{ pages: Page[] }>()).pages).toContainEqual(
      expect.objectContaining({ id: installed.pageId, isTemplate: true }),
    );

    const restored = await SELF.fetch(
      request(installed.cookie, `/api/pages/${installed.pageId}/restore`, { method: "POST" }),
    );
    expect(restored.status).toBe(200);
    expect((await (await templates()).json<{ templates: Page[] }>()).templates.map((page) => page.id)).toContain(
      installed.pageId,
    );
    expect(
      (await (await SELF.fetch(request(installed.cookie, "/api/pages/tree"))).json<{ pages: Page[] }>()).pages,
    ).not.toContainEqual(expect.objectContaining({ id: installed.pageId }));

    expect([200, 202]).toContain(
      (await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}`, { method: "DELETE" }))).status,
    );
    const deleted = await SELF.fetch(
      request(installed.cookie, `/api/pages/${installed.pageId}/permanent-delete`, { method: "POST" }),
    );
    expect(deleted.status).toBe(202);
    expect((await (await trash()).json<{ pages: Page[] }>()).pages).toHaveLength(0);
    expect(await env.DB.prepare(`SELECT id FROM pages WHERE id = ?`).bind(installed.pageId).first()).toBeNull();
  });

  it("hides imported row pages and descendants from Trash without hiding ordinary archived pages", async () => {
    const installed = await bootstrap();
    const source = await env.DB.prepare(`SELECT workspace_id,space_id,created_by FROM pages WHERE id = ?`)
      .bind(installed.pageId)
      .first<{ workspace_id: string; space_id: string; created_by: string }>();
    const importedId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const ordinaryId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch(
      [
        [importedId, installed.pageId, "Imported row"],
        [childId, importedId, "Row child"],
        [ordinaryId, installed.pageId, "Ordinary archived"],
      ].map(([id, parentId, title]) =>
        env.DB.prepare(
          `INSERT INTO pages
           (id,workspace_id,space_id,parent_id,kind,position,title,archived_at,created_by,created_at,updated_at)
           VALUES (?,?,?,?,'document','a0',?,?,?,?,?)`,
        ).bind(
          id,
          source!.workspace_id,
          source!.space_id,
          parentId,
          title,
          timestamp,
          source!.created_by,
          timestamp,
          timestamp,
        ),
      ),
    );
    await env.DB.prepare(
      `INSERT INTO page_import_sources (page_id,source_path,source_role,created_at)
       VALUES (?,?,'table_row_detail',?)`,
    )
      .bind(importedId, "Imported row", timestamp)
      .run();

    const archived = await SELF.fetch(request(installed.cookie, "/api/pages/tree?archived=true"));
    expect(archived.status).toBe(200);
    expect((await archived.json<{ pages: Page[] }>()).pages.map((page) => page.id)).toEqual([ordinaryId]);

    await env.DB.prepare(`UPDATE pages SET archived_at = NULL WHERE id IN (?, ?)`).bind(importedId, childId).run();
    const active = await SELF.fetch(request(installed.cookie, "/api/pages/tree"));
    expect(active.status).toBe(200);
    expect((await active.json<{ pages: Page[] }>()).pages.map((page) => page.id)).toEqual([installed.pageId]);
  });

  it("persists personal favorites and space-scoped pins without crossing spaces", async () => {
    const installed = await bootstrap();
    const spaces = await (await SELF.fetch(request(installed.cookie, "/api/spaces"))).json<{ spaces: Space[] }>();
    const general = spaces.spaces[0]!;
    expect(general).toMatchObject({ name: "General", visibility: "workspace" });

    expect(
      (await SELF.fetch(request(installed.cookie, `/api/favorites/${installed.pageId}`, { method: "POST" }))).status,
    ).toBe(201);
    expect(
      (await (await SELF.fetch(request(installed.cookie, "/api/favorites"))).json<{ pages: Page[] }>()).pages.map(
        (page) => page.id,
      ),
    ).toEqual([installed.pageId]);

    expect(
      (
        await SELF.fetch(
          request(installed.cookie, `/api/spaces/${general.id}/pins/${installed.pageId}`, { method: "POST" }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await (await SELF.fetch(request(installed.cookie, `/api/spaces/${general.id}/pins`))).json<{ pages: Page[] }>()
      ).pages.map((page) => page.id),
    ).toEqual([installed.pageId]);

    const other = await SELF.fetch(
      request(installed.cookie, "/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Other" }),
      }),
    );
    const otherId = (await other.json<{ space: Space }>()).space.id;
    expect(
      (
        await SELF.fetch(
          request(installed.cookie, `/api/spaces/${otherId}/pins/${installed.pageId}`, { method: "POST" }),
        )
      ).status,
    ).toBe(422);
  });

  it("assigns workspace tags and updates the weighted search projection", async () => {
    const installed = await bootstrap();
    const created = await SELF.fetch(
      request(installed.cookie, "/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Roadmap", color: "purple" }),
      }),
    );
    expect(created.status).toBe(201);
    const tag = (await created.json<{ tag: Tag }>()).tag;
    expect(tag).toMatchObject({ name: "Roadmap", color: "purple", pageCount: 0 });
    expect(
      (await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/tags/${tag.id}`, { method: "PUT" })))
        .status,
    ).toBe(200);

    const assigned = await (
      await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/tags`))
    ).json<{ tags: Tag[] }>();
    expect(assigned.tags.map(({ id }) => id)).toEqual([tag.id]);
    expect(
      (await (await SELF.fetch(request(installed.cookie, "/api/tags"))).json<{ tags: Tag[] }>()).tags[0]?.pageCount,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(`SELECT tags FROM page_search_v2 WHERE page_id = ?`)
          .bind(installed.pageId)
          .first<{ tags: string }>()
      )?.tags,
    ).toBe("Roadmap");
  });

  it("lets viewers favorite readable pages but not pin or tag them", async () => {
    const installed = await bootstrap();
    const viewer = await inviteViewer(installed.cookie);
    const spaces = await (await SELF.fetch(request(viewer, "/api/spaces"))).json<{ spaces: Space[] }>();
    const general = spaces.spaces[0]!;
    expect((await SELF.fetch(request(viewer, `/api/favorites/${installed.pageId}`, { method: "POST" }))).status).toBe(
      201,
    );
    expect(
      (await SELF.fetch(request(viewer, `/api/spaces/${general.id}/pins/${installed.pageId}`, { method: "POST" })))
        .status,
    ).toBe(403);
    expect((await SELF.fetch(request(viewer, "/api/tags", { method: "POST" }))).status).toBe(403);

    // Creating a tag and assigning one are separate routes with separate guards.
    const created = await SELF.fetch(
      request(installed.cookie, "/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Restricted", color: "blue" }),
      }),
    );
    expect(created.status).toBe(201);
    const tag = (await created.json<{ tag: Tag }>()).tag;
    const assignPath = `/api/pages/${installed.pageId}/tags/${tag.id}`;
    expect((await SELF.fetch(request(viewer, assignPath, { method: "PUT" }))).status).toBe(403);
    expect((await SELF.fetch(request(viewer, assignPath, { method: "DELETE" }))).status).toBe(403);
  });
});
