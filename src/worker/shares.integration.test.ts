import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

function authenticated(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return SELF.fetch(new Request(`http://example.test${path}`, { ...init, headers }));
}

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Public Share Test",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const tree = await (await authenticated(cookie, "/api/pages/tree")).json<{ pages: Array<{ id: string }> }>();
  return { cookie, pageId: tree.pages[0]!.id };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("public page shares", () => {
  it("keeps a stable key, resolves descendants dynamically, honors indexing, and revokes immediately", async () => {
    const installed = await bootstrap();
    const childResponse = await authenticated(installed.cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "document", parentId: installed.pageId, title: "Public child" }),
    });
    const child = (await childResponse.json<{ page: { id: string } }>()).page;
    const published = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(published.status).toBe(201);
    const share = (await published.json<{ share: { url: string } }>()).share;
    const key = new URL(share.url).pathname.split("/").at(-1)!;

    const root = await SELF.fetch(`http://example.test/share/${key}`);
    expect(root.status).toBe(200);
    expect(root.headers.get("cache-control")).toBe("no-store");
    expect(await root.text()).toContain("noindex,nofollow");
    expect((await SELF.fetch(`http://example.test/share/${key}/pages/${child.id}`)).status).toBe(404);

    const second = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await second.json<{ share: { url: string } }>()).share.url).toBe(share.url);
    await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeSubpages: true, allowIndexing: true }),
    });
    expect((await SELF.fetch(`http://example.test/share/${key}/pages/${child.id}`)).status).toBe(200);
    const sitemap = await SELF.fetch(`http://example.test/share/${key}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    expect(await sitemap.text()).toContain(child.id);

    await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, { method: "DELETE" });
    expect((await SELF.fetch(`http://example.test/share/${key}`)).status).toBe(404);
  });
});
