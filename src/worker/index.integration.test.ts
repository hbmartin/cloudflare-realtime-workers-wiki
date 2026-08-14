import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("Worker integration", () => {
  it("reports a healthy empty installation", async () => {
    const [health, install] = await Promise.all([
      SELF.fetch("http://example.test/api/health"),
      SELF.fetch("http://example.test/api/install"),
    ]);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "0.1.0" });
    expect(await install.json()).toEqual({ initialized: false });
  });

  it("blocks the raw Better Auth registration endpoint", async () => {
    const response = await SELF.fetch("http://example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "Bypass", email: "bypass@example.test", password: "password123" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "registration_closed", message: "Use the bootstrap screen or an invite to register." },
    });
    const count = await env.DB.prepare(`SELECT COUNT(*) count FROM user`).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("uses the shared JSON envelope for missing API routes", async () => {
    const response = await SELF.fetch("http://example.test/api/not-real");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "API route not found." } });
  });
});
