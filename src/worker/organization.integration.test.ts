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
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
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
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("organization APIs", () => {
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
  });
});
