import { applyD1Migrations, env, reset } from "cloudflare:test";
import { betterAuth } from "better-auth";
import { beforeEach, describe, expect, it } from "vitest";
import { enrollAccount, responseCookies, securityRequest as request } from "../../tests/helpers/security";

beforeEach(() => reset());

async function legacyAccount() {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0028"),
  );
  const auth = betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
  });
  const registered = await auth.api.signUpEmail({
    body: { name: "Legacy diagnostic", email: "legacy-diagnostic@example.test", password: "password123" },
    asResponse: true,
  });
  expect(registered.status).toBe(200);
  const { user } = await registered.clone().json<{ user: { id: string } }>();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES ('legacy-workspace','Legacy',?)").bind(
      Date.now(),
    ),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES ('legacy-workspace',?,'owner',?)",
    ).bind(user.id, Date.now()),
    env.DB.prepare("INSERT INTO install_state(id,workspace_id,initialized_at) VALUES (1,'legacy-workspace',?)").bind(
      Date.now(),
    ),
  ]);
  return { userId: user.id, cookie: responseCookies(registered) };
}

async function signIn() {
  const response = await request("", "/api/auth/sign-in/email", {
    email: "legacy-diagnostic@example.test",
    password: "password123",
  });
  expect(response.status).toBe(200);
  return response;
}

describe("first login after mandatory protection rollout", () => {
  it("migrates a real password account through enrollment and restores its existing workspace", async () => {
    const legacy = await legacyAccount();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect((await request(legacy.cookie, "/api/me")).status).toBe(401);
    const signedIn = await signIn();
    const cookie = responseCookies(signedIn);
    expect(await (await request(cookie, "/api/security/status")).json()).toMatchObject({
      state: "enrollment_required",
      totp: false,
      codesSaved: false,
    });
    expect((await request(cookie, "/api/me")).status).toBe(401);
    const enrolled = await enrollAccount(signedIn);
    expect(await (await request(enrolled, "/api/security/status")).json()).toMatchObject({ state: "ready" });
    const workspace = await request(enrolled, "/api/me");
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      user: { id: legacy.userId },
      workspace: { id: "legacy-workspace" },
      role: "owner",
    });
  });

  it("demonstrates that missing 0029 breaks authenticated status while anonymous status still succeeds", async () => {
    await legacyAccount();
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0029"),
    );
    expect(await (await request("", "/api/security/status")).json()).toMatchObject({ state: "signed_out" });
    const signedIn = await signIn();
    const status = await request(responseCookies(signedIn), "/api/security/status");
    expect(status.status).toBe(500);
    expect(await status.text()).toBe("");
  });

  it("detects an absent security row and rejects that account without granting workspace access", async () => {
    const legacy = await legacyAccount();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await env.DB.prepare("DELETE FROM account_security WHERE user_id=?").bind(legacy.userId).run();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS missing FROM user u LEFT JOIN account_security a ON a.user_id=u.id WHERE a.user_id IS NULL",
      ).first(),
    ).toEqual({ missing: 1 });
    const signedIn = await signIn();
    const status = await request(responseCookies(signedIn), "/api/security/status");
    expect(status.status).toBe(403);
    expect(await status.json()).toMatchObject({ code: "SECURITY_REQUIRED", message: "Sign in again." });
    expect((await request(responseCookies(signedIn), "/api/me")).ok).toBe(false);
  });
});
