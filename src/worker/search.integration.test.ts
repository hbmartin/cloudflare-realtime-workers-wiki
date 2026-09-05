import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Page, SearchResponse, SearchTitleSuggestion, Space, Tag } from "../shared/types";

function request(cookie: string, path: string, init: RequestInit = {}) {
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
      workspaceName: "Search Notes",
      name: "Owner",
      email: "search-owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const member = await (
    await SELF.fetch(request(cookie, "/api/me"))
  ).json<{ user: { id: string }; workspace: { id: string } }>();
  const spaces = await (await SELF.fetch(request(cookie, "/api/spaces"))).json<{ spaces: Space[] }>();
  return { cookie, userId: member.user.id, workspaceId: member.workspace.id, generalId: spaces.spaces[0]!.id };
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
  const accepted = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({ token, name: "Viewer", email: "search-viewer@example.test", password: "password123" }),
  });
  expect(accepted.status).toBe(200);
  return accepted.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function createPage(cookie: string, title: string, spaceId: string, kind: "document" | "table" = "document") {
  const response = await SELF.fetch(
    request(cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, spaceId, kind, parentId: null }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json<{ page: Page }>()).page;
}

async function replaceSearchBody(page: Page, body: string) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE pages SET plain_text = ? WHERE id = ?`).bind(body, page.id),
    env.DB.prepare(`DELETE FROM page_search_v2 WHERE page_id = ?`).bind(page.id),
    env.DB.prepare(
      `INSERT INTO page_search_v2
        (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
       VALUES (?, ?, ?, ?, '', ?, '', '')`,
    ).bind(page.id, page.workspaceId, page.spaceId, page.title, body),
  ]);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("search v2", () => {
  it("ranks titles, reports snippet sources, filters rows, and paginates deterministically", async () => {
    const installed = await bootstrap();
    const exact = await createPage(installed.cookie, "Mars", installed.generalId);
    const prefix = await createPage(installed.cookie, "Mars mission", installed.generalId);
    const body = await createPage(installed.cookie, "Red plan", installed.generalId);
    await replaceSearchBody(body, "A detailed Mars launch checklist");

    const first = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=Mars&limit=2"))
    ).json<SearchResponse>();
    expect(first.results.map((result) => result.page.id)).toEqual([exact.id, prefix.id]);
    expect(first.results.map((result) => result.snippet.source)).toEqual(["title", "title"]);
    expect(first).toMatchObject({ limit: 2, offset: 0, hasMore: true });

    const second = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=Mars&limit=2&offset=2"))
    ).json<SearchResponse>();
    expect(second.results.map((result) => result.page.id)).toEqual([body.id]);
    expect(second.results[0]!.snippet).toMatchObject({ source: "body" });
    expect(second.hasMore).toBe(false);

    const tagResponse = await SELF.fetch(
      request(installed.cookie, "/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Planet", color: "purple" }),
      }),
    );
    const tag = (await tagResponse.json<{ tag: Tag }>()).tag;
    await SELF.fetch(request(installed.cookie, `/api/pages/${exact.id}/tags/${tag.id}`, { method: "PUT" }));
    const tagged = await (
      await SELF.fetch(request(installed.cookie, `/api/search?q=Mars&tag=${tag.id}`))
    ).json<SearchResponse>();
    expect(tagged.results.map((result) => result.page.id)).toEqual([exact.id]);

    const creatorFiltered = await (
      await SELF.fetch(
        request(
          installed.cookie,
          `/api/search?q=Mars&creator=${installed.userId}&kind=document&space=${installed.generalId}&updatedFrom=0&hasComments=false`,
        ),
      )
    ).json<SearchResponse>();
    expect(creatorFiltered.results.map((result) => result.page.id)).toEqual([exact.id, prefix.id, body.id]);
    expect((await SELF.fetch(request(installed.cookie, "/api/search?q=Mars&updatedFrom=20&updatedTo=10"))).status).toBe(
      422,
    );
  });

  it("searches archived pages only when requested and never leaks private-space metadata", async () => {
    const installed = await bootstrap();
    const viewerCookie = await inviteViewer(installed.cookie);
    const privateSpaceResponse = await SELF.fetch(
      request(installed.cookie, "/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Secret", visibility: "private" }),
      }),
    );
    const privateSpace = (await privateSpaceResponse.json<{ space: Space }>()).space;
    const secret = await createPage(installed.cookie, "Orchid launch", privateSpace.id);
    const archived = await createPage(installed.cookie, "Orchid archive", installed.generalId);
    expect(
      (await SELF.fetch(request(installed.cookie, `/api/pages/${archived.id}`, { method: "DELETE" }))).status,
    ).toBe(200);

    const viewerSearch = await (
      await SELF.fetch(request(viewerCookie, "/api/search?q=Orchid&archive=all"))
    ).json<SearchResponse>();
    expect(viewerSearch.results.map((result) => result.page.id)).toEqual([archived.id]);
    expect(JSON.stringify(viewerSearch)).not.toContain(privateSpace.name);
    expect(JSON.stringify(viewerSearch)).not.toContain(secret.title);

    const active = await (await SELF.fetch(request(installed.cookie, "/api/search?q=Orchid"))).json<SearchResponse>();
    expect(active.results.map((result) => result.page.id)).toEqual([secret.id]);
    const archivedOnly = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=Orchid&archive=archived"))
    ).json<SearchResponse>();
    expect(archivedOnly.results.map((result) => result.page.id)).toEqual([archived.id]);

    const ownerTitles = await (
      await SELF.fetch(request(installed.cookie, "/api/search/titles?q=Orchid"))
    ).json<{ suggestions: SearchTitleSuggestion[] }>();
    expect(ownerTitles.suggestions.map((item) => item.page.id)).toEqual([secret.id]);
    const viewerTitles = await (
      await SELF.fetch(request(viewerCookie, "/api/search/titles?q=Orchid"))
    ).json<{ suggestions: SearchTitleSuggestion[] }>();
    expect(viewerTitles.suggestions).toEqual([]);
  });
});
