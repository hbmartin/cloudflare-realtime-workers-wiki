import { enrollAccount } from "../../tests/helpers/security";
import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Page, SearchResponse, SearchTitleSuggestion, Space, Tag } from "../shared/types";
import { refreshPageSearchV2Statements } from "./search-index";
import { normalizeQueuedTitles } from "./search";
import { acceptPageDeletion, processDeletionJob } from "./cleanup";
import type { Env } from "./env";

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
  const cookie = await enrollAccount(response);
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
  return await enrollAccount(accepted, token);
}

async function createPage(
  cookie: string,
  title: string,
  spaceId: string,
  kind: "document" | "table" | "diagram" = "document",
  parentId: string | null = null,
) {
  const response = await SELF.fetch(
    request(cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, spaceId, kind, parentId }),
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
  it.each(["rows", "cleanup"] as const)(
    "hides accepted %s deletions from archived listings while retaining staging and unrelated pages",
    async (phase) => {
      const installed = await bootstrap();
      const root = await createPage(installed.cookie, "Architecture pending root", installed.generalId);
      const child = await createPage(
        installed.cookie,
        "Architecture pending child",
        installed.generalId,
        "document",
        root.id,
      );
      const unrelated = await createPage(installed.cookie, "Architecture retained", installed.generalId);
      const staged = await createPage(installed.cookie, "Architecture staged", installed.generalId);
      await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id IN (?,?,?,?)")
        .bind(root.id, child.id, unrelated.id, staged.id)
        .run();
      const accepted = await acceptPageDeletion(env, installed.workspaceId, installed.userId, root.id);
      const failingDb = new Proxy(env.DB, {
        get(target, key) {
          if (key === "batch")
            return async () => {
              throw new Error("metadata cleanup unavailable");
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await processDeletionJob({ ...env, DB: failingDb } as Env, accepted.jobId);
      expect(
        await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first(),
      ).toEqual({ phase: "rows", last_error: "metadata cleanup unavailable" });
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(root.id).first()).not.toBeNull();
      if (phase === "cleanup")
        await env.DB.prepare("UPDATE deletion_jobs SET phase='cleanup' WHERE id=?").bind(accepted.jobId).run();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO deletion_jobs(id,workspace_id,root_page_id,next_attempt_at,created_at,updated_at,phase) VALUES('staged-deletion',?,?,0,1,1,'staging')",
        ).bind(installed.workspaceId, staged.id),
        env.DB.prepare("INSERT INTO deletion_job_pages(job_id,page_id,archived_at) VALUES('staged-deletion',?,1)").bind(
          staged.id,
        ),
        env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('foreign-workspace','Foreign',1)"),
        env.DB.prepare(
          "INSERT INTO deletion_jobs(id,workspace_id,root_page_id,next_attempt_at,created_at,updated_at,phase) VALUES('foreign-deletion','foreign-workspace',?,0,1,1,'rows')",
        ).bind(unrelated.id),
        env.DB.prepare(
          "INSERT INTO deletion_job_pages(job_id,page_id,archived_at) VALUES('foreign-deletion',?,1)",
        ).bind(unrelated.id),
      ]);
      const visibleIds = new Set([unrelated.id, staged.id]);
      const tree = await (
        await SELF.fetch(request(installed.cookie, "/api/pages/tree?archived=true"))
      ).json<{ pages: Page[] }>();
      expect(new Set(tree.pages.map((page) => page.id))).toEqual(visibleIds);
      for (const archive of ["archived", "all"]) {
        const primary = await (
          await SELF.fetch(request(installed.cookie, `/api/search?q=Architecture&archive=${archive}`))
        ).json<SearchResponse>();
        expect(new Set(primary.results.map((result) => result.page.id))).toEqual(visibleIds);
        const fuzzy = await (
          await SELF.fetch(request(installed.cookie, `/api/search?q=architecure&archive=${archive}`))
        ).json<SearchResponse>();
        expect(fuzzy.matchMode).toBe("title-typo");
        expect(new Set(fuzzy.results.map((result) => result.page.id))).toEqual(visibleIds);
        const pagedIds: string[] = [];
        for (const offset of [0, 1, 2]) {
          const page = await (
            await SELF.fetch(
              request(installed.cookie, `/api/search?q=Architecture&archive=${archive}&limit=1&offset=${offset}`),
            )
          ).json<SearchResponse>();
          pagedIds.push(...page.results.map((result) => result.page.id));
          expect(page.hasMore).toBe(offset === 0);
        }
        expect(pagedIds).toHaveLength(2);
        expect(new Set(pagedIds)).toEqual(visibleIds);
      }
    },
  );
  it("migrates existing normalized titles and the queue while preserving the public trigram index", async () => {
    await reset();
    const migration = env.TEST_MIGRATIONS!.find((item) => item.name.startsWith("0090_"))!;
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((item) => item.name < migration.name),
    );
    const installed = await bootstrap();
    const target = await createPage(installed.cookie, "Ａｒｃｈｉｔｅｃｔｕｒｅ", installed.generalId);
    await env.DB.prepare("UPDATE page_title_trigrams SET normalized_title='architecture' WHERE page_id=?")
      .bind(target.id)
      .run();
    const queue = await env.DB.prepare("SELECT page_id FROM page_title_normalization_queue ORDER BY page_id").all();
    await applyD1Migrations(env.DB, [migration]);
    expect(
      (await env.DB.prepare("SELECT page_id FROM page_title_normalization_queue ORDER BY page_id").all()).results,
    ).toEqual(queue.results);
    const content = await env.DB.prepare("SELECT id,normalized_title FROM page_title_titles WHERE page_id=?")
      .bind(target.id)
      .first<{ id: number; normalized_title: string }>();
    expect(content?.normalized_title).toBe("architecture");
    expect(
      (
        await env.DB.prepare(
          "SELECT page_id FROM page_title_trigrams WHERE page_title_trigrams MATCH 'architec' ",
        ).all()
      ).results,
    ).toEqual([{ page_id: target.id }]);
    await normalizeQueuedTitles(env.DB);
    expect(
      await env.DB.prepare("SELECT id,normalized_title FROM page_title_titles WHERE page_id=?").bind(target.id).first(),
    ).toEqual(content);
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN UPDATE page_title_titles SET normalized_title=? WHERE page_id=?",
    )
      .bind("architecture", target.id)
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("USING INDEX") && row.detail.includes("page_id=?"))).toBe(
      true,
    );
    // Exercise the current worker only after completing the forward upgrade.
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((item) => item.name > migration.name),
    );
    const found = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=architecure"))
    ).json<SearchResponse>();
    expect(found.results.map((result) => result.page.id)).toEqual([target.id]);
  });

  it("keeps trigram content synchronized through staging, publication, template changes and deletion", async () => {
    const installed = await bootstrap();
    const target = await createPage(installed.cookie, "Architecture", installed.generalId);
    const matches = async () =>
      (await env.DB.prepare("SELECT page_id FROM page_title_trigrams WHERE page_title_trigrams MATCH 'architec'").all())
        .results;
    expect(await matches()).toEqual([{ page_id: target.id }]);
    await env.DB.prepare("UPDATE pages SET import_job_id='mcp:create:staged' WHERE id=?").bind(target.id).run();
    expect(await matches()).toEqual([]);
    await env.DB.prepare("UPDATE pages SET import_job_id=NULL WHERE id=?").bind(target.id).run();
    expect(await matches()).toEqual([{ page_id: target.id }]);
    await env.DB.prepare("UPDATE pages SET is_template=1 WHERE id=?").bind(target.id).run();
    expect(await matches()).toEqual([]);
    await env.DB.prepare("UPDATE pages SET is_template=0 WHERE id=?").bind(target.id).run();
    expect(await matches()).toEqual([{ page_id: target.id }]);
    await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(target.id).run();
    expect(await matches()).toEqual([]);
    expect(await env.DB.prepare("SELECT id FROM page_title_titles WHERE page_id=?").bind(target.id).first()).toBeNull();
    await env.DB.prepare("INSERT INTO page_title_trigrams(page_title_trigrams,rank) VALUES('integrity-check',1)").run();
  });

  it("normalizes Unicode titles and clears the forward normalization queue without duplicating index rows", async () => {
    const installed = await bootstrap();
    const target = await createPage(installed.cookie, "Ａｒｃｈｉｔｅｃｔｕｒｅ", installed.generalId);
    const found = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=architecure"))
    ).json<SearchResponse>();
    expect(found.results.map((result) => result.page.id)).toEqual([target.id]);
    expect(found.matchMode).toBe("title-typo");
    expect(
      await env.DB.prepare("SELECT count(*) count FROM page_title_trigrams WHERE page_id=?").bind(target.id).first(),
    ).toEqual({ count: 1 });
    const rebuild = await SELF.fetch(request(installed.cookie, "/api/admin/search/rebuild", { method: "POST" }));
    expect(rebuild.status).toBe(200);
    expect(await rebuild.json()).toMatchObject({ complete: true, pending: 0 });
    expect(
      await env.DB.prepare("SELECT count(*) count FROM page_title_trigrams WHERE page_id=?").bind(target.id).first(),
    ).toEqual({ count: 1 });
  });
  it("falls back to overlapping title trigrams under the same permissions and filters", async () => {
    const installed = await bootstrap();
    const target = await createPage(installed.cookie, "Architecture", installed.generalId);
    const first = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=architecure"))
    ).json<SearchResponse>();
    expect(first).toMatchObject({ matchMode: "title-typo" });
    expect(first.results.map((result) => result.page.id)).toEqual([target.id]);
    const later = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=Architecture&offset=20"))
    ).json<SearchResponse>();
    expect(later.results).toEqual([]);
    expect(later.matchMode).not.toBe("title-typo");
    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(target.id).run();
    const active = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=architecure"))
    ).json<SearchResponse>();
    expect(active.results).toEqual([]);
    const archived = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=architecure&archive=archived"))
    ).json<SearchResponse>();
    expect(archived.results.map((result) => result.page.id)).toEqual([target.id]);
    await env.DB.prepare("UPDATE pages SET title='Completely different' WHERE id=?").bind(target.id).run();
    const renamed = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=architecure&archive=all"))
    ).json<SearchResponse>();
    expect(renamed.results).toEqual([]);
  });
  it("filters diagrams in full search and title suggestions", async () => {
    const installed = await bootstrap();
    const diagram = await createPage(installed.cookie, "Service topology", installed.generalId, "diagram");
    await createPage(installed.cookie, "Service notes", installed.generalId);

    const results = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=Service&kind=diagram"))
    ).json<SearchResponse>();
    expect(results.results.map((result) => result.page.id)).toEqual([diagram.id]);

    const titles = await (
      await SELF.fetch(request(installed.cookie, "/api/search/titles?q=Service&kind=diagram"))
    ).json<{ suggestions: SearchTitleSuggestion[] }>();
    expect(titles.suggestions.map((suggestion) => suggestion.page.id)).toEqual([diagram.id]);
  });

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

    // Archiving leaves the index row untouched, so the assertion above passes even when
    // the refresh drops archived pages. A compaction lands after the archive commits
    // whenever the page had unsaved edits, and that is what used to empty this filter.
    await env.DB.batch(refreshPageSearchV2Statements(env.DB, archived.id));
    const afterReindex = await (
      await SELF.fetch(request(installed.cookie, "/api/search?q=Orchid&archive=archived"))
    ).json<SearchResponse>();
    expect(afterReindex.results.map((result) => result.page.id)).toEqual([archived.id]);

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
