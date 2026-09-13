import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enrollAccount, otpFromUri, responseCookies, securityRequest as request } from "../../tests/helpers/security";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

function bootstrap() {
  return request("", "/api/install/bootstrap", {
    bootstrapToken: "worker-bootstrap-token",
    workspaceName: "Security",
    name: "Owner",
    email: "owner@example.test",
    password: "password123",
  });
}

describe("mandatory account protection", () => {
  it("keeps registration closed even when the raw auth path is encoded", async () => {
    for (const path of ["/api/auth/sign-up/email", "/api/auth/%73ign-up/email", "/api/auth/sign-up/email/"]) {
      const response = await request("", path, {
        name: "Bypass",
        email: "bypass@example.test",
        password: "password123",
      });
      expect(response.ok).toBe(false);
    }
    expect(await env.DB.prepare("SELECT id FROM user").first()).toBeNull();
  });
  it("blocks private APIs and enrollment bypasses until a real factor and recovery codes are saved", async () => {
    const response = await bootstrap();
    expect(response.status).toBe(200);
    const cookie = responseCookies(response);
    expect((await request(cookie, "/api/security/status")).status).toBe(200);
    for (const path of [
      "/api/me",
      "/api/pages/tree",
      "/api/members",
      "/api/search?q=test",
      "/parties/workspace-events/test",
    ]) {
      expect((await request(cookie, path)).status).toBe(401);
    }
    expect((await request(cookie, "/api/auth/two-factor/disable", { password: "password123" })).status).toBe(403);
    expect((await request(cookie, "/api/auth/update-user", { name: "Attacker" })).status).toBe(403);
    const verified = await enrollAccount(response);
    expect((await request(verified, "/api/me")).status).toBe(200);
    expect(await (await request(verified, "/api/security/status")).json()).toMatchObject({
      state: "ready",
      totp: true,
      fresh: true,
    });
  });

  it("requires a code after password sign-in and rejects replay and arbitrary assurance fields", async () => {
    const enrolled = await enrollAccount(await bootstrap());
    const signIn = await request("", "/api/auth/sign-in/email", {
      email: "owner@example.test",
      password: "password123",
      verified: true,
    });
    expect(await signIn.clone().json()).toMatchObject({ twoFactorRedirect: true });
    const pending = responseCookies(signIn);
    expect((await request(pending, "/api/me")).status).toBe(401);
    expect((await request(pending, "/api/auth/two-factor/verify-totp", { code: "invalid" })).ok).toBe(false);
    expect((await request(pending, "/api/me")).status).toBe(401);
    expect((await request(pending, "/api/security/setup-totp", { password: "password123" })).status).toBe(403);
    expect((await request(enrolled, "/api/security/remove-factor", { kind: "totp" })).status).toBe(403);
    const factor = await env.DB.prepare("SELECT secret FROM twoFactor").first<{ secret: string }>();
    const { symmetricDecrypt } = await import("better-auth/crypto");
    const { createOTP } = await import("@better-auth/utils/otp");
    const secret = await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: factor!.secret });
    const code = await createOTP(secret).hotp(Math.floor(Date.now() / 30_000) + 1);
    const verified = await request(pending, "/api/auth/two-factor/verify-totp", { code });
    expect(verified.status).toBe(200);
    expect((await request(responseCookies(verified, pending), "/api/me")).status).toBe(200);
    expect((await request(pending, "/api/auth/two-factor/verify-totp", { code })).status).not.toBe(200);
  });

  it("rejects acknowledgment of superseded recovery codes", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const first = await (await request(cookie, "/api/security/recovery-codes", {})).json<{ receipt: string }>();
    const second = await (await request(cookie, "/api/security/recovery-codes", {})).json<{ receipt: string }>();
    expect((await request(cookie, "/api/security/acknowledge-codes", { receipt: first.receipt })).status).toBe(403);
    expect((await request(cookie, "/api/me")).status).toBe(200);
    expect((await request(cookie, "/api/security/acknowledge-codes", { receipt: second.receipt })).status).toBe(200);
    expect((await request(cookie, "/api/me")).status).toBe(200);
  });

  it("enforces a persistent account attempt budget for recovery", async () => {
    const cookie = await enrollAccount(await bootstrap());
    for (let i = 0; i < 10; i++)
      expect((await request(cookie, "/api/security/recover", { password: "incorrect", code: "invalid" })).status).toBe(
        403,
      );
    expect((await request(cookie, "/api/security/recover", { password: "password123", code: "invalid" })).status).toBe(
      429,
    );
    expect(
      (await env.DB.prepare("SELECT locked_until FROM account_security").first<{ locked_until: number }>())!
        .locked_until,
    ).toBeGreaterThan(Date.now());
  });

  it("does not activate cancelled or invalid authenticator replacement", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const original = await env.DB.prepare("SELECT secret FROM twoFactor").first();
    const setup = await request(cookie, "/api/security/setup-totp", { password: "password123" });
    expect(setup.status).toBe(200);
    expect(await env.DB.prepare("SELECT secret FROM twoFactor").first()).toEqual(original);
    expect((await request(cookie, "/api/security/confirm-totp", { code: "invalid" })).status).toBe(403);
    const { totpURI } = await setup.json<{ totpURI: string }>();
    const changed = await request(cookie, "/api/security/confirm-totp", { code: await otpFromUri(totpURI) });
    expect(changed.status).toBe(200);
    expect(await env.DB.prepare("SELECT secret FROM twoFactor").first()).not.toEqual(original);
  });

  it("keeps browser trust at a fixed deadline and rejects expired or revoked trust", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const trusted = await request(cookie, "/api/security/trust", {});
    expect(trusted.status).toBe(200);
    const browserCookie = responseCookies(trusted);
    const original = await env.DB.prepare("SELECT expires_at FROM trusted_browsers").first();
    let trustedSession = "";
    for (let i = 0; i < 2; i++) {
      const login = await request(browserCookie, "/api/auth/sign-in/email", {
        email: "owner@example.test",
        password: "password123",
      });
      const pending = responseCookies(login, browserCookie);
      const completed = await request(pending, "/api/security/complete-trust", {});
      expect(completed.status).toBe(200);
      const full = responseCookies(completed, pending);
      trustedSession = full;
      expect((await request(full, "/api/auth/get-session")).status).toBe(200);
      expect((await request(full, "/api/me")).status).toBe(200);
      expect(await (await request(full, "/api/security/status")).json()).toMatchObject({ fresh: false });
      expect((await request(full, "/api/security/recovery-codes", {})).status).toBe(403);
      expect(await env.DB.prepare("SELECT expires_at FROM trusted_browsers").first()).toEqual(original);
    }
    const record = await env.DB.prepare("SELECT id FROM trusted_browsers").first<{ id: string }>();
    expect((await request(cookie, "/api/security/revoke-trust", { id: record!.id })).status).toBe(200);
    expect((await request(trustedSession, "/api/me")).status).toBe(401);
    const renewed = await request(cookie, "/api/security/trust", {});
    expect(renewed.status).toBe(200);
    await env.DB.prepare("UPDATE trusted_browsers SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const expiredCookie = responseCookies(renewed);
    const login = await request(expiredCookie, "/api/auth/sign-in/email", {
      email: "owner@example.test",
      password: "password123",
    });
    expect((await request(responseCookies(login, expiredCookie), "/api/security/complete-trust", {})).status).toBe(403);
  });

  it("rejects a trusted-browser token belonging to another account", async () => {
    const owner = await enrollAccount(await bootstrap());
    const trust = responseCookies(await request(owner, "/api/security/trust", {}));
    const { invite } = await (
      await request(owner, "/api/invites", { role: "viewer" })
    ).json<{ invite: { token: string } }>();
    const signup = await request("", "/api/invites/accept", {
      token: invite.token,
      name: "Guest",
      email: "guest@example.test",
      password: "password123",
    });
    await enrollAccount(signup, invite.token);
    const login = await request(trust, "/api/auth/sign-in/email", {
      email: "guest@example.test",
      password: "password123",
    });
    const pending = responseCookies(login, trust);
    expect((await request(pending, "/api/security/complete-trust", {})).status).toBe(403);
    expect((await request(pending, "/api/me")).status).toBe(401);
  });

  it("atomically consumes recovery codes and requires replacement enrollment", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const { codes, receipt } = await (
      await request(cookie, "/api/security/recovery-codes", {})
    ).json<{ codes: string[]; receipt: string }>();
    await request(cookie, "/api/security/acknowledge-codes", { receipt });
    const login = await request("", "/api/auth/sign-in/email", {
      email: "owner@example.test",
      password: "password123",
    });
    const pending = responseCookies(login);
    const attempts = await Promise.all(
      [0, 1].map(() => request(pending, "/api/security/recover", { password: "password123", code: codes[0] })),
    );
    expect(attempts.filter((response) => response.ok)).toHaveLength(1);
    const recovered = responseCookies(attempts.find((response) => response.ok)!);
    expect((await request(cookie, "/api/me")).status).toBe(401);
    expect((await request(recovered, "/api/me")).status).toBe(401);
    expect(await (await request(recovered, "/api/security/status")).json()).toMatchObject({
      state: "recovery_required",
    });
    expect((await request(recovered, "/api/security/trust", {})).status).toBe(403);
    const setup = await request(recovered, "/api/security/setup-totp", { password: "password123" });
    expect(setup.status).toBe(200);
    const { totpURI } = await setup.json<{ totpURI: string }>();
    const confirmation = await request(recovered, "/api/security/confirm-totp", { code: await otpFromUri(totpURI) });
    expect(confirmation.status).toBe(200);
    const fresh = responseCookies(confirmation, recovered);
    expect((await request(fresh, "/api/me")).status).toBe(401);
    const replacement = await (await request(fresh, "/api/security/recovery-codes", {})).json<{ receipt: string }>();
    await request(fresh, "/api/security/acknowledge-codes", { receipt: replacement.receipt });
    expect((await request(fresh, "/api/me")).status).toBe(200);
  });

  it("operator reset revokes factors atomically and an expired reset cannot enroll", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const { sha256 } = await import("./http");
    const user = await env.DB.prepare("SELECT id FROM user").first<{ id: string }>();
    await env.DB.prepare("INSERT INTO security_resets(token_hash,user_id,expires_at) VALUES (?,?,?)")
      .bind(await sha256("operator-token"), user!.id, Date.now() - 1)
      .run();
    expect((await request(cookie, "/api/me")).status).toBe(401);
    expect(await env.DB.prepare("SELECT id FROM twoFactor").first()).toBeNull();
    const login = await request("", "/api/auth/sign-in/email", {
      email: "owner@example.test",
      password: "password123",
    });
    const pending = responseCookies(login);
    expect((await request(pending, "/api/security/setup-totp", { password: "password123" })).status).toBe(403);
    expect(
      (
        await request(pending, "/api/security/recover", {
          password: "password123",
          code: "operator-token",
          reset: true,
        })
      ).status,
    ).toBe(403);
    await env.DB.prepare("UPDATE security_resets SET expires_at = ?")
      .bind(Date.now() + 60_000)
      .run();
    const recovered = await request(pending, "/api/security/recover", {
      password: "password123",
      code: "operator-token",
      reset: true,
    });
    expect(recovered.status).toBe(200);
    expect(
      (await request(responseCookies(recovered), "/api/security/setup-totp", { password: "password123" })).status,
    ).toBe(200);
  });

  it("does not consume invitations until enrolled and rejects competing acceptance", async () => {
    const owner = await enrollAccount(await bootstrap());
    const { invite } = await (
      await request(owner, "/api/invites", { role: "viewer" })
    ).json<{ invite: { token: string } }>();
    const signup = await request("", "/api/invites/accept", {
      token: invite.token,
      name: "Guest",
      email: "guest@example.test",
      password: "password123",
    });
    expect((await request(responseCookies(signup), "/api/invites/complete", { token: invite.token })).status).toBe(401);
    expect(await env.DB.prepare("SELECT used_at FROM invites").first()).toMatchObject({ used_at: null });
    const enrolled = await enrollAccount(signup);
    const completions = await Promise.all([
      request(enrolled, "/api/invites/complete", { token: invite.token }),
      request(owner, "/api/invites/complete", { token: invite.token }),
    ]);
    expect(completions.filter((response) => response.ok)).toHaveLength(1);
  });
});
