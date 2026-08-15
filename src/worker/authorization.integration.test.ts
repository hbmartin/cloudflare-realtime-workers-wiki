import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

type Role = "owner" | "editor" | "viewer";
type InstalledWorkspace = { cookie: string; pageId: string; userId: string };

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

async function bootstrap(): Promise<InstalledWorkspace> {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Authorization Notes",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const me = await (await SELF.fetch(request(cookie, "/api/me"))).json<{ user: { id: string } }>();
  const tree = await (await SELF.fetch(request(cookie, "/api/pages/tree"))).json<{ pages: Array<{ id: string }> }>();
  return { cookie, userId: me.user.id, pageId: tree.pages[0]!.id };
}

async function invite(ownerCookie: string, role: Exclude<Role, "owner">) {
  const inviteResponse = await SELF.fetch(
    request(ownerCookie, "/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),
  );
  expect(inviteResponse.status).toBe(201);
  const { invite: created } = await inviteResponse.json<{ invite: { token: string } }>();
  const response = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      token: created.token,
      name: role,
      email: `${role}@example.test`,
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("authorization matrix", () => {
  it("requires a session for every private API family", async () => {
    for (const path of ["/api/me", "/api/members", "/api/pages/tree", "/api/search?q=notes", "/api/mentions"]) {
      const response = await SELF.fetch(request("", path));
      expect(response.status).toBe(401);
    }
  });

  it.each(["owner", "editor", "viewer"] as const)("allows %s to read workspace data", async (role) => {
    const installed = await bootstrap();
    const cookie = role === "owner" ? installed.cookie : await invite(installed.cookie, role);
    for (const path of ["/api/me", "/api/members", "/api/pages/tree", `/api/pages/${installed.pageId}`]) {
      const response = await SELF.fetch(request(cookie, path));
      expect(response.status).toBe(200);
    }
  });

  it.each(["owner", "editor"] as const)("allows %s to mutate pages", async (role) => {
    const installed = await bootstrap();
    const cookie = role === "owner" ? installed.cookie : await invite(installed.cookie, role);
    const response = await SELF.fetch(
      request(cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "document", parentId: null }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it("blocks viewers from every representative mutation family", async () => {
    const installed = await bootstrap();
    const viewerCookie = await invite(installed.cookie, "viewer");
    const mutations: Array<[string, RequestInit]> = [
      ["/api/pages", { method: "POST", body: JSON.stringify({ kind: "document", parentId: null }) }],
      [`/api/pages/${installed.pageId}`, { method: "PATCH", body: JSON.stringify({ title: "No", revision: 1 }) }],
      [`/api/pages/${installed.pageId}`, { method: "DELETE" }],
      [`/api/pages/${installed.pageId}/attachments`, { method: "POST", body: new FormData() }],
      [
        `/api/pages/${installed.pageId}/restore-version`,
        { method: "POST", body: JSON.stringify({ versionId: "missing" }) },
      ],
    ];
    for (const [path, init] of mutations) {
      const response = await SELF.fetch(
        request(viewerCookie, path, {
          ...init,
          ...(init.body instanceof FormData ? {} : { headers: { "content-type": "application/json" } }),
        }),
      );
      expect(response.status, `${init.method} ${path}`).toBe(403);
    }
  });

  it.each(["editor", "viewer"] as const)("blocks %s from owner-only administration", async (role) => {
    const installed = await bootstrap();
    const cookie = await invite(installed.cookie, role);
    const ownerOnly: Array<[string, RequestInit]> = [
      ["/api/invites", { method: "POST", body: JSON.stringify({ role: "viewer" }) }],
      [`/api/members/${installed.userId}`, { method: "PATCH", body: JSON.stringify({ role: "owner" }) }],
      [`/api/members/${installed.userId}`, { method: "DELETE" }],
      [`/api/tables/${installed.pageId}/force-unlock`, { method: "POST" }],
    ];
    for (const [path, init] of ownerOnly) {
      const response = await SELF.fetch(
        request(cookie, path, { ...init, headers: { "content-type": "application/json" } }),
      );
      expect(response.status, `${init.method} ${path}`).toBe(403);
    }
  });
});
