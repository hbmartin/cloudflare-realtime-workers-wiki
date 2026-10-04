import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enrollAccount, responseCookies, securityRequest } from "../../tests/helpers/security";
import { bytesToBase64Url } from "../shared/security";
import worker from "./index";
import type { Env } from "./env";
import { encryptSlackToken } from "./slack";

const configured = () =>
  ({
    ...env,
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "slack-secret",
    SLACK_SIGNING_SECRET: "slack-signing-secret",
    SLACK_TOKEN_ENCRYPTION_KEY: "slack-encryption-test-secret",
  }) as unknown as Env;
let key: CryptoKeyPair,
  jwk: JsonWebKey,
  nonce: string | null,
  slackUser: string,
  team: string,
  userFlags: Record<string, unknown>;
beforeAll(async () => {
  key = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
});
async function token() {
  const encode = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", kid: "slack-test-key", typ: "JWT" })}.${encode({
    iss: "https://slack.com",
    aud: "123.456",
    sub: slackUser,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...(nonce ? { nonce } : {}),
    email: `${slackUser.toLowerCase()}@example.test`,
    email_verified: true,
    name: "Slack member",
    "https://slack.com/team_id": team,
    "https://slack.com/user_id": slackUser,
  })}`;
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(unsigned))))}`;
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  nonce = null;
  slackUser = "UOWNER";
  team = "T123";
  userFlags = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://slack.com",
          jwks_uri: "https://slack.com/openid/connect/keys",
          authorization_endpoint: "https://slack.com/openid/connect/authorize",
          token_endpoint: "https://slack.com/api/openid.connect.token",
          userinfo_endpoint: "https://slack.com/api/openid.connect.userInfo",
          id_token_signing_alg_values_supported: ["RS256"],
        });
      if (url.pathname.endsWith("/keys"))
        return Response.json({ keys: [{ ...jwk, kid: "slack-test-key", alg: "RS256", use: "sig" }] });
      if (url.pathname.endsWith("openid.connect.token"))
        return Response.json({
          ok: true,
          access_token: "xoxp-test",
          token_type: "Bearer",
          expires_in: 600,
          id_token: await token(),
          scope: "openid profile email",
        });
      if (url.pathname.endsWith("openid.connect.userInfo"))
        return Response.json({
          ok: true,
          sub: slackUser,
          name: "Slack member",
          email: `${slackUser.toLowerCase()}@example.test`,
          "https://slack.com/team_id": team,
          "https://slack.com/user_id": slackUser,
        });
      if (url.pathname.endsWith("users.info"))
        return Response.json({ ok: true, user: { id: slackUser, team_id: team, ...userFlags } });
      throw new Error(`Unexpected Slack request ${url.pathname}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function account(protectedAccount = true) {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Slack Notes",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = protectedAccount ? await enrollAccount(response) : responseCookies(response);
  const user = (await env.DB.prepare("SELECT id FROM user").first<{ id: string }>())!.id;
  const workspace = (await env.DB.prepare("SELECT id FROM workspaces").first<{ id: string }>())!.id;
  await env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at)
    VALUES('installation',?,'T123','Slack','UBOT',?,'users:read,chat:write',?,1,1)`)
    .bind(workspace, await encryptSlackToken(configured(), "xoxb-test"), user)
    .run();
  return { cookie, user, workspace };
}
async function auth(cookie: string, path: string, body?: Record<string, unknown>) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://example.test/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, origin: "http://example.test", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    configured(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
async function start(cookie: string, body: Record<string, unknown> = {}, path = "/link-social") {
  const response = await auth(cookie, path, {
    provider: "slack",
    callbackURL: "/?view=settings&slack=verified",
    errorCallbackURL: "/?view=settings&slackAuth=callback",
    disableRedirect: true,
    ...body,
  });
  expect(response.status).toBe(200);
  const url = new URL((await response.json<{ url: string }>()).url);
  nonce = url.searchParams.get("nonce");
  return { state: url.searchParams.get("state")!, cookie: responseCookies(response, cookie) };
}
const callback = (flow: { state: string; cookie: string }) =>
  auth(flow.cookie, `/callback/slack?state=${encodeURIComponent(flow.state)}&code=test-code`);

describe("Slack OAuth authorization boundaries", () => {
  it("completes linking and relinking without creating a primary proof or changing assurance", async () => {
    const { cookie, user } = await account();
    const assurance = await env.DB.prepare("SELECT * FROM session_security").first();
    const flow = await start(cookie);
    const result = await callback(flow);
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("slack=verified");
    expect(
      await env.DB.prepare("SELECT slack_user_id,security_generation FROM slack_authorized_user_links").first(),
    ).toEqual({ slack_user_id: "UOWNER", security_generation: 0 });
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM session_security").first()).toEqual(assurance);
    const relink = await callback(await start(cookie));
    expect(relink.status).toBe(302);
    expect(relink.headers.get("location")).toContain("slack=verified");
    expect(
      await env.DB.prepare("SELECT count(*) count FROM account WHERE userId=? AND providerId='slack'")
        .bind(user)
        .first(),
    ).toEqual({ count: 1 });
    expect((await callback(flow)).headers.get("location")).not.toContain("slack=verified");
  });
  it.each(["unenrolled", "stale proof", "trusted proof", "unsaved codes"])("rejects %s linking", async (mode) => {
    const { cookie } = await account(mode !== "unenrolled");
    if (mode === "stale proof")
      await env.DB.prepare("UPDATE session_security SET verified_at=?")
        .bind(Date.now() - 6 * 60000)
        .run();
    if (mode === "trusted proof") await env.DB.prepare("UPDATE session_security SET method='trust'").run();
    if (mode === "unsaved codes") await env.DB.prepare("UPDATE account_security SET codes_saved=0").run();
    const result = await auth(cookie, "/link-social", { provider: "slack" });
    expect(result.status).toBe(403);
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
  });
  it.each(["idToken", "scopes", "additionalParams"])(
    "rejects the alternate %s linking path before account writes",
    async (field) => {
      const { cookie } = await account();
      const value =
        field === "idToken" ? { token: await token() } : field === "scopes" ? ["admin"] : { team: "TOTHER" };
      const result = await auth(cookie, "/link-social", { provider: "slack", [field]: value });
      expect(result.status).toBe(400);
      expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    },
  );
  it.each(["session revoked", "security reset", "proof expires", "binding replaced"])(
    "rejects completion after %s",
    async (mode) => {
      const { cookie, user } = await account();
      const flow = await start(cookie);
      if (mode === "session revoked") await env.DB.prepare("DELETE FROM session").run();
      if (mode === "security reset") await env.DB.prepare("UPDATE account_security SET generation=generation+1").run();
      if (mode === "proof expires")
        await env.DB.prepare("UPDATE session_security SET verified_at=?")
          .bind(Date.now() - 6 * 60000)
          .run();
      if (mode === "binding replaced")
        await env.DB.prepare(
          "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation) VALUES('installation',?,'UNEWER',1,0)",
        )
          .bind(user)
          .run();
      const result = await callback(flow);
      expect(result.headers.get("location") ?? "").not.toContain("slack=verified");
      expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
      expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    },
  );
  it.each(["wrong team", "guest", "bot", "removed"])("rejects a %s identity at callback", async (mode) => {
    const { cookie } = await account();
    const flow = await start(cookie);
    if (mode === "wrong team") team = "TOTHER";
    if (mode === "guest") userFlags = { is_restricted: true };
    if (mode === "bot") userFlags = { is_bot: true };
    if (mode === "removed") userFlags = { deleted: true };
    const result = await callback(flow);
    expect(result.headers.get("location") ?? "").not.toContain("slack=verified");
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
  });
  it("keeps primary Slack sign-in after access revocation and does not recreate the binding", async () => {
    const { cookie } = await account();
    expect((await callback(await start(cookie))).headers.get("location")).toContain("slack=verified");
    const context = createExecutionContext();
    const disconnected = await worker.fetch(
      new Request("http://example.test/api/slack/identity", {
        method: "DELETE",
        headers: { cookie, origin: "http://example.test" },
      }),
      configured(),
      context,
    );
    await waitOnExecutionContext(context);
    expect(disconnected.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    const result = await callback(await start("", {}, "/sign-in/social"));
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("slack=verified");
    expect(await env.DB.prepare("SELECT authentication_source FROM slack_primary_factor_proofs").first()).toEqual({
      authentication_source: "sign_in",
    });
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect((await securityRequest(responseCookies(result), "/api/me")).status).toBe(401);
  });
  it("requires the original session even when another session has fresh protection", async () => {
    const { cookie, user } = await account();
    const flow = await start(cookie);
    const live = (await env.DB.prepare("SELECT * FROM session WHERE userId=? LIMIT 1")
      .bind(user)
      .first<{ id: string; token: string }>())!;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session WHERE id=?").bind(live.id),
      env.DB.prepare(
        "INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES('replacement-session',?,?,'2099-01-01T00:00:00.000Z',1,1)",
      ).bind(user, live.token),
      env.DB.prepare(
        "INSERT INTO session_security(session_id,user_id,generation,method,verified_at,expires_at) VALUES('replacement-session',?,0,'totp',?,?)",
      ).bind(user, Date.now(), Date.now() + 600000),
    ]);
    const result = await callback(flow);
    expect(result.headers.get("location") ?? "").not.toContain("slack=verified");
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
  });
  it("rejects a reset while Slack membership is being checked", async () => {
    const { cookie } = await account();
    const flow = await start(cookie);
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const response = await remote(input, init);
      if (String(input).includes("users.info"))
        await env.DB.prepare("UPDATE account_security SET generation=generation+1").run();
      return response;
    });
    expect((await callback(flow)).headers.get("location") ?? "").not.toContain("slack=verified");
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
  });
  it("revokes Slack access and proofs during recovery while preserving primary login", async () => {
    const { cookie } = await account();
    await callback(await start(cookie));
    const codesResponse = await securityRequest(cookie, "/api/security/recovery-codes", {});
    const { codes, receipt } = await codesResponse.json<{ codes: string[]; receipt: string }>();
    await securityRequest(cookie, "/api/security/acknowledge-codes", { receipt });
    const recovered = await securityRequest(cookie, "/api/security/recover", {
      password: "password123",
      code: codes[0],
    });
    expect(recovered.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).not.toBeNull();
    const signin = await callback(await start("", {}, "/sign-in/social"));
    expect(signin.status).toBe(302);
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT security_generation,authentication_source FROM slack_primary_factor_proofs").first(),
    ).toEqual({ security_generation: 1, authentication_source: "sign_in" });
  });
  it("allows invited Slack signup to enroll protection without creating a private access grant", async () => {
    const { cookie } = await account();
    const invitation = await securityRequest(cookie, "/api/invites", { role: "editor" });
    const { invite } = await invitation.json<{ invite: { token: string } }>();
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.test/api/slack/identity/invite/start", {
        method: "POST",
        headers: { origin: "http://example.test", "content-type": "application/json" },
        body: JSON.stringify({ token: invite.token }),
      }),
      configured(),
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    const url = new URL((await response.json<{ url: string }>()).url);
    nonce = url.searchParams.get("nonce");
    slackUser = "UINVITED";
    const result = await callback({ state: url.searchParams.get("state")!, cookie: responseCookies(response) });
    expect(result.status).toBe(302);
    expect(await env.DB.prepare("SELECT authentication_source FROM slack_primary_factor_proofs").first()).toEqual({
      authentication_source: "sign_up",
    });
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    const setup = await securityRequest(responseCookies(result), "/api/security/setup-totp", {});
    expect(setup.status).toBe(200);
  });
});
