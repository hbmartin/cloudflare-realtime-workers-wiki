import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  env,
  reset,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./auth";
import {
  cleanupFailedPasskeyRegistration,
  passkeyRegistrationRevokedResponse,
  requireSecurity,
  upsertPasskeyRegistrationPermit,
} from "./security";
import { sha256 } from "./http";
import worker from "./index";
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

function requestFromIp(ip: string, path: string, body: object, cookie = "") {
  return SELF.fetch(`http://example.test${path}`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": ip,
      cookie,
      "content-type": "application/json",
      origin: "http://example.test",
    },
    body: JSON.stringify(body),
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

  it("requires acknowledgment of the current recovery-code batch after replacement", async () => {
    const cookie = await enrollAccount(await bootstrap());
    expect((await request(cookie, "/api/me")).status).toBe(200);
    const active = (await env.DB.prepare("SELECT code_hash FROM recovery_codes ORDER BY code_hash").all()).results;
    const first = await (await request(cookie, "/api/security/recovery-codes", {})).json<{ receipt: string }>();
    expect(await (await request(cookie, "/api/security/status")).json()).toMatchObject({
      state: "ready",
      codesSaved: true,
    });
    expect((await request(cookie, "/api/me")).status).toBe(200);
    expect((await env.DB.prepare("SELECT code_hash FROM recovery_codes ORDER BY code_hash").all()).results).toEqual(
      active,
    );
    const second = await (await request(cookie, "/api/security/recovery-codes", {})).json<{ receipt: string }>();
    expect((await request(cookie, "/api/security/acknowledge-codes", { receipt: first.receipt })).status).toBe(403);
    expect(await (await request(cookie, "/api/security/status")).json()).toMatchObject({
      state: "ready",
      codesSaved: true,
    });
    expect((await request(cookie, "/api/me")).status).toBe(200);
    expect((await request(cookie, "/api/security/acknowledge-codes", { receipt: second.receipt })).status).toBe(200);
    expect(await (await request(cookie, "/api/security/status")).json()).toMatchObject({
      state: "ready",
      codesSaved: true,
    });
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
    await request(cookie, "/api/security/recovery-codes", {});
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM pending_recovery_codes").first()).toEqual({ count: 10 });
    const login = await request("", "/api/auth/sign-in/email", {
      email: "owner@example.test",
      password: "password123",
    });
    const pending = responseCookies(login);
    const attempts = await Promise.all(
      [0, 1].map(() => request(pending, "/api/security/recover", { password: "password123", code: codes[0] })),
    );
    expect(attempts.filter((response) => response.ok)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT 1 FROM pending_recovery_codes").first()).toBeNull();
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
    await request(cookie, "/api/security/recovery-codes", {});
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM pending_recovery_codes").first()).toEqual({ count: 10 });
    const user = await env.DB.prepare("SELECT id FROM user").first<{ id: string }>();
    await env.DB.prepare("INSERT INTO security_resets(token_hash,user_id,expires_at) VALUES (?,?,?)")
      .bind(await sha256("operator-token"), user!.id, Date.now() - 1)
      .run();
    expect((await request(cookie, "/api/me")).status).toBe(401);
    expect(await env.DB.prepare("SELECT 1 FROM pending_recovery_codes").first()).toBeNull();
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

  it("keeps invitations pending until enrollment and makes existing-member completion harmless", async () => {
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
    expect(completions.every((response) => response.ok)).toBe(true);
    expect((await request(enrolled, "/api/me")).status).toBe(200);
  });
});

// Inject an actual database state change after authorization, immediately before
// the endpoint's transaction. The endpoint still executes real D1 SQL.
function beforeBatch(change: () => Promise<unknown>) {
  return createAuth({
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await change();
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
}
function authRequest(cookie: string, path: string, body: object) {
  return new Request(`http://example.test/api/auth/security/${path}`, {
    method: "POST",
    headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function invitation(owner: string) {
  return (await (await request(owner, "/api/invites", { role: "viewer" })).json<{ invite: { token: string } }>()).invite
    .token;
}
function accept(token: string, email = "guest@example.test") {
  return request("", "/api/invites/accept", { token, name: "Guest", email, password: "password123" });
}

describe("security lifecycle regressions", () => {
  it("does not let a stale recovery replacement delete a newer generation batch", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const user = await env.DB.prepare("SELECT id FROM user").first<{ id: string }>();
    const auth = beforeBatch(async () => {
      await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?").bind(user!.id).run();
      await env.DB.batch(
        Array.from({ length: 10 }, (_, index) =>
          env.DB.prepare(
            "INSERT INTO pending_recovery_codes(code_hash,batch_id,user_id,generation,expires_at) VALUES (?,?,?,?,?)",
          ).bind(`new-code-${index}`, "new-batch", user!.id, 2, Date.now() + 60_000),
        ),
      );
    });

    expect((await auth.handler(authRequest(cookie, "recovery-codes", {}))).status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM pending_recovery_codes WHERE user_id=? AND batch_id='new-batch' AND generation=2",
      )
        .bind(user!.id)
        .first(),
    ).toEqual({ count: 10 });
  });

  it("reserves one email before concurrent signup and keeps pending enrollment on the server", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);
    const responses = await Promise.all([accept(token), accept(token, "rival@example.test")]);
    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(responses.find((response) => !response.ok)?.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM user").first()).toEqual({ count: 2 });
    const cookie = await enrollAccount(responses.find((response) => response.ok)!);
    expect(await (await request(cookie, "/api/security/status")).json()).toMatchObject({
      state: "ready",
      pendingInvite: true,
    });
    expect((await request(cookie, "/api/invites/complete", {})).status).toBe(200);
    expect((await request(cookie, "/api/me")).status).toBe(200);
  });

  it("releases the exact reservation after failed signup and rebinds it to the next account", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);
    expect(
      (
        await request("", "/api/invites/accept", {
          token,
          name: "Guest",
          email: "guest@example.test",
          password: "short",
        })
      ).ok,
    ).toBe(false);
    expect((await accept(token, "rival@example.test")).status).toBe(200);
    expect((await accept(token)).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM user").first()).toEqual({ count: 2 });
  });

  it("releases a temporary invite reservation when signup throws after creating the account", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);
    const originalClone = Response.prototype.clone;
    let injected = false;
    const clone = vi.spyOn(Response.prototype, "clone").mockImplementation(function (this: Response) {
      if (!injected && this.ok && this.headers.has("set-cookie")) {
        injected = true;
        throw new Error("signup response became unreadable");
      }
      return originalClone.call(this);
    });
    const failed = await accept(token);
    clone.mockRestore();

    expect(injected).toBe(true);
    expect(failed.status).toBe(500);
    expect(await env.DB.prepare("SELECT id FROM user WHERE email='guest@example.test'").first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT claimed_email,claim_token,claim_expires_at FROM invites").first()).toEqual({
      claimed_email: null,
      claim_token: null,
      claim_expires_at: null,
    });
    expect((await accept(token)).status).toBe(200);
  });

  it("authenticates an existing account before claiming its invitation", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);

    expect(
      (
        await request("", "/api/invites/accept", {
          token,
          email: "owner@example.test",
          password: "incorrect",
        })
      ).status,
    ).toBe(401);
    expect(await env.DB.prepare("SELECT claimed_email,claimed_by,claim_token FROM invites").first()).toEqual({
      claimed_email: null,
      claimed_by: null,
      claim_token: null,
    });
  });

  it("supersedes an account's older pending claim in the same workspace", async () => {
    const owner = await enrollAccount(await bootstrap());
    const first = await invitation(owner);
    const second = await invitation(owner);
    expect((await accept(first)).status).toBe(200);
    expect(
      (
        await request("", "/api/invites/accept", {
          token: second,
          email: "guest@example.test",
          password: "password123",
        })
      ).status,
    ).toBe(200);
    const user = await env.DB.prepare("SELECT id FROM user WHERE email='guest@example.test'").first<{ id: string }>();
    expect(
      await env.DB.prepare("SELECT token_hash FROM invites WHERE claimed_by=? AND used_at IS NULL")
        .bind(user!.id)
        .all(),
    ).toMatchObject({ results: [{ token_hash: await sha256(second) }] });
  });

  it("does not burn an existing member's invitation or restore a removed recipient on replay", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);
    expect((await request(owner, "/api/invites/complete", { token })).status).toBe(200);
    expect(await env.DB.prepare("SELECT used_at,claimed_by FROM invites").first()).toEqual({
      used_at: null,
      claimed_by: null,
    });
    const guest = await enrollAccount(await accept(token), token);
    expect((await request(guest, "/api/invites/complete", { token })).status).toBe(200);
    const member = await (await request(guest, "/api/me")).json<{ user: { id: string }; workspace: { id: string } }>();
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(member.workspace.id, member.user.id)
      .run();
    expect((await request(guest, "/api/invites/complete", { token })).status).toBe(409);
    expect((await request(guest, "/api/me")).status).toBe(401);
    expect(
      await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(member.user.id).first(),
    ).toBeNull();
  });

  it("deletes a removed member's unused claims before a later completion can restore access", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);
    const guest = await enrollAccount(await accept(token), token);
    const member = await (await request(guest, "/api/me")).json<{ user: { id: string }; workspace: { id: string } }>();
    const leftoverToken = "leftover-claim";
    await env.DB.prepare(`INSERT INTO invites
      (id,workspace_id,token_hash,role,expires_at,created_by,created_at,claimed_email,claimed_by,claim_expires_at)
      VALUES ('leftover',?,?, 'viewer',?,?,?,'guest@example.test',?,?)`)
      .bind(
        member.workspace.id,
        await sha256(leftoverToken),
        Date.now() + 60_000,
        member.user.id,
        Date.now(),
        member.user.id,
        Date.now() + 60_000,
      )
      .run();

    const removed = await SELF.fetch(`http://example.test/api/members/${member.user.id}`, {
      method: "DELETE",
      headers: { cookie: owner, origin: "http://example.test" },
    });
    expect(removed.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM invites WHERE id='leftover'").first()).toBeNull();
    expect((await request(guest, "/api/invites/complete", { token: leftoverToken })).status).toBe(409);
    expect(
      await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(member.user.id).first(),
    ).toBeNull();
  });

  it("rejects direct invite completion that does not match the claimed account", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);
    const signup = await accept(token);
    const guest = await env.DB.prepare("SELECT id FROM user WHERE email='guest@example.test'").first<{ id: string }>();
    const ownerId = await env.DB.prepare("SELECT id FROM user WHERE email='owner@example.test'").first<{
      id: string;
    }>();
    await expect(
      env.DB.prepare("UPDATE invites SET used_by=?,used_at=? WHERE claimed_by=?")
        .bind(ownerId!.id, Date.now(), guest!.id)
        .run(),
    ).rejects.toThrow("invite_completion_invalid");
    expect(await env.DB.prepare("SELECT used_at FROM invites").first()).toEqual({ used_at: null });
    expect((await request(responseCookies(signup), "/api/invites/complete", { token })).status).toBe(401);
  });

  it("clears the pending password challenge on signout, including its server record", async () => {
    await enrollAccount(await bootstrap());
    const login = await request("", "/api/auth/sign-in/email", {
      email: "owner@example.test",
      password: "password123",
    });
    const pending = responseCookies(login);
    const signedOut = await request(pending, "/api/auth/sign-out", {});
    expect(signedOut.status).toBe(200);
    expect(await (await request(responseCookies(signedOut, pending), "/api/security/status")).json()).toMatchObject({
      state: "signed_out",
    });
    // A saved copy of the old cookie must also fail.
    expect(await (await request(pending, "/api/security/status")).json()).toMatchObject({ state: "signed_out" });
    expect(await env.DB.prepare("SELECT 1 FROM verification WHERE identifier LIKE '2fa-%'").first()).toBeNull();
  });

  it("does not let unverified passkey IDs lock out an account or successful setup accumulate attempts", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const user = await env.DB.prepare("SELECT id FROM user").first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO pending_passkeys(credential_id,user_id,session_id,generation)
      SELECT 'known-id',s.userId,s.id,a.generation FROM session s JOIN account_security a ON a.user_id=s.userId LIMIT 1`).run();
    await env.DB.prepare(
      "INSERT INTO passkey(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES ('key','unused',?,'known-id',0,'singleDevice',0)",
    )
      .bind(user!.id)
      .run();
    for (let i = 0; i < 12; i++) {
      expect((await request("", "/api/auth/passkey/verify-authentication", { response: { id: "known-id" } })).ok).toBe(
        false,
      );
      expect((await request(cookie, "/api/security/setup-totp", { password: "password123" })).status).toBe(200);
    }
    expect(await env.DB.prepare("SELECT failed_attempts,locked_until FROM account_security").first()).toEqual({
      failed_attempts: 0,
      locked_until: 0,
    });
  });

  it("resumes expired recovery only with the original session, password, generation and absolute deadline", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const { codes, receipt } = await (
      await request(cookie, "/api/security/recovery-codes", {})
    ).json<{ codes: string[]; receipt: string }>();
    expect((await request(cookie, "/api/security/acknowledge-codes", { receipt })).status).toBe(200);
    const recovery = responseCookies(
      await request(cookie, "/api/security/recover", { password: "password123", code: codes[0] }),
    );
    await env.DB.prepare("UPDATE session_security SET expires_at=? WHERE method='recovery'")
      .bind(Date.now() - 1)
      .run();
    expect((await request(recovery, "/api/security/setup-totp", { password: "password123" })).status).toBe(403);
    const freshPassword = responseCookies(
      await request("", "/api/auth/sign-in/email", { email: "owner@example.test", password: "password123" }),
    );
    expect((await request(freshPassword, "/api/security/resume-recovery", { password: "password123" })).status).toBe(
      403,
    );
    expect((await request(recovery, "/api/security/resume-recovery", { password: "incorrect" })).status).toBe(403);
    expect((await request(recovery, "/api/security/resume-recovery", { password: "password123" })).status).toBe(200);
    expect((await request(recovery, "/api/me")).status).toBe(401);
    expect((await request(recovery, "/api/security/setup-totp", { password: "password123" })).status).toBe(200);
    const original = Date.now() - 24 * 60 * 60_000 + 60_000;
    await env.DB.prepare("UPDATE session_security SET verified_at=? WHERE method='recovery'").bind(original).run();
    expect((await request(recovery, "/api/security/resume-recovery", { password: "password123" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT expires_at FROM session_security WHERE method='recovery'").first()).toEqual({
      expires_at: original + 24 * 60 * 60_000,
    });
    await env.DB.prepare("UPDATE session_security SET verified_at=? WHERE method='recovery'")
      .bind(Date.now() - 25 * 60 * 60_000)
      .run();
    expect((await request(recovery, "/api/security/resume-recovery", { password: "password123" })).status).toBe(403);
    await env.DB.prepare("UPDATE session_security SET verified_at=? WHERE method='recovery'").bind(Date.now()).run();
    await env.DB.prepare("UPDATE account_security SET generation=generation+1").run();
    expect((await request(recovery, "/api/security/resume-recovery", { password: "password123" })).status).toBe(403);
  });

  it("does not burn recovery credentials when a challenge expires between authorization and consumption", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const { codes, receipt } = await (
      await request(cookie, "/api/security/recovery-codes", {})
    ).json<{ codes: string[]; receipt: string }>();
    expect((await request(cookie, "/api/security/acknowledge-codes", { receipt })).status).toBe(200);
    const pending = responseCookies(
      await request("", "/api/auth/sign-in/email", { email: "owner@example.test", password: "password123" }),
    );
    const auth = beforeBatch(() =>
      env.DB.prepare("UPDATE verification SET expiresAt=? WHERE identifier LIKE '2fa-%'")
        .bind(new Date(0).toISOString())
        .run(),
    );
    expect(
      (await auth.handler(authRequest(pending, "recover", { password: "password123", code: codes[0] }))).status,
    ).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM recovery_codes").first()).toEqual({ count: 10 });
    expect((await request(cookie, "/api/me")).status).toBe(200);
  });

  it("preserves an operator reset that races with authenticator confirmation", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const { totpURI } = await (
      await request(cookie, "/api/security/setup-totp", { password: "password123" })
    ).json<{ totpURI: string }>();
    const user = await env.DB.prepare("SELECT id FROM user").first<{ id: string }>();
    const hash = await sha256("reset-token");
    const auth = beforeBatch(() =>
      env.DB.prepare("INSERT INTO security_resets(token_hash,user_id,expires_at) VALUES (?,?,?)")
        .bind(hash, user!.id, Date.now() + 60_000)
        .run(),
    );
    expect((await auth.handler(authRequest(cookie, "confirm-totp", { code: await otpFromUri(totpURI) }))).status).toBe(
      403,
    );
    expect(await env.DB.prepare("SELECT twoFactorEnabled FROM user").first()).toEqual({ twoFactorEnabled: 0 });
    expect(await env.DB.prepare("SELECT 1 FROM twoFactor").first()).toBeNull();
    expect(await env.DB.prepare("SELECT recovery_required FROM account_security").first()).toEqual({
      recovery_required: 1,
    });
  });

  it("reads a single security snapshot and rejects expired grants with 401", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const session = await (
      await request(cookie, "/api/auth/get-session")
    ).json<{ session: { id: string }; user: { id: string } }>();
    const statements: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(requireSecurity({ ...env, DB: db }, session.user.id, session.session.id)).resolves.toBeGreaterThan(
      Date.now(),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("FROM invites");
    await env.DB.prepare("UPDATE session_security SET expires_at=?")
      .bind(Date.now() - 1)
      .run();
    await expect(requireSecurity(env, session.user.id, session.session.id)).rejects.toMatchObject({ status: 401 });
  });

  it("restores the strict three-per-ten-second password limit for one source", async () => {
    await enrollAccount(await bootstrap());
    for (let i = 0; i < 3; i++)
      expect(
        (await request("", "/api/auth/sign-in/email", { email: "owner@example.test", password: "password123" })).status,
      ).toBe(200);
    expect(
      (await request("", "/api/auth/sign-in/email", { email: "owner@example.test", password: "password123" })).status,
    ).toBe(429);
  });

  it("restores the strict three-per-ten-second two-factor limit for one source", async () => {
    await enrollAccount(await bootstrap());
    const pending = responseCookies(
      await requestFromIp("192.0.2.10", "/api/auth/sign-in/email", {
        email: "owner@example.test",
        password: "password123",
      }),
    );
    for (let i = 0; i < 3; i++) {
      expect(
        (await requestFromIp("192.0.2.10", "/api/auth/two-factor/verify-totp", { code: "invalid" }, pending)).status,
      ).not.toBe(429);
    }
    expect(
      (await requestFromIp("192.0.2.10", "/api/auth/two-factor/verify-totp", { code: "invalid" }, pending)).status,
    ).toBe(429);
  });

  it("limits normalized password attempts within one source without locking another source", async () => {
    const owner = await enrollAccount(await bootstrap());
    const token = await invitation(owner);
    const clock = vi.spyOn(Date, "now");
    try {
      const start = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
      for (let i = 0; i < 10; i++) {
        clock.mockReturnValue(start + i * 11_000);
        expect(
          (
            await requestFromIp("192.0.2.10", "/api/auth/sign-in/email", {
              email: i % 2 ? "OWNER@EXAMPLE.TEST" : "owner@example.test",
              password: "incorrect",
            })
          ).status,
        ).toBe(401);
      }
      clock.mockReturnValue(start + 110_000);
      const blocked = await requestFromIp("192.0.2.10", "/api/auth/sign-in/email", {
        email: "owner@example.test",
        password: "password123",
      });
      expect(blocked.status).toBe(429);
      await expect(blocked.json()).resolves.toMatchObject({ code: "PASSWORD_RATE_LIMITED" });
      expect(
        (
          await requestFromIp("198.51.100.1", "/api/auth/sign-in/email", {
            email: "owner@example.test",
            password: "password123",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await requestFromIp("203.0.113.1", "/api/invites/accept", {
            token,
            email: "owner@example.test",
            password: "password123",
          })
        ).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps password budgets separate across rotating sources", async () => {
    await enrollAccount(await bootstrap());
    for (let i = 0; i < 10; i++)
      expect(
        (
          await requestFromIp(`192.0.2.${i + 1}`, "/api/auth/sign-in/email", {
            email: i % 2 ? "OWNER@EXAMPLE.TEST" : "owner@example.test",
            password: "incorrect",
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await requestFromIp("198.51.100.1", "/api/auth/sign-in/email", {
          email: "owner@example.test",
          password: "password123",
        })
      ).status,
    ).toBe(200);
  });

  it("applies the same source-scoped password budget to unknown addresses", async () => {
    await bootstrap();
    const clock = vi.spyOn(Date, "now");
    try {
      const start = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
      for (let i = 0; i < 10; i++) {
        clock.mockReturnValue(start + i * 11_000);
        expect(
          (
            await requestFromIp("192.0.2.20", "/api/auth/sign-in/email", {
              email: i % 2 ? "MISSING@EXAMPLE.TEST" : "missing@example.test",
              password: "incorrect",
            })
          ).status,
        ).toBe(401);
      }
      clock.mockReturnValue(start + 110_000);
      expect(
        (
          await requestFromIp("192.0.2.20", "/api/auth/sign-in/email", {
            email: "missing@example.test",
            password: "incorrect",
          })
        ).status,
      ).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });

  it("clears only the successful source's password budget", async () => {
    await enrollAccount(await bootstrap());
    for (const ip of ["192.0.2.1", "192.0.2.2"])
      expect(
        (
          await requestFromIp(ip, "/api/auth/sign-in/email", {
            email: "owner@example.test",
            password: "incorrect",
          })
        ).status,
      ).toBe(401);
    expect(
      await env.DB.prepare("SELECT COUNT(*) count FROM rateLimit WHERE key LIKE 'password-account-v2:%'").first(),
    ).toEqual({ count: 2 });
    expect(
      (
        await requestFromIp("192.0.2.1", "/api/auth/sign-in/email", {
          email: "OWNER@EXAMPLE.TEST",
          password: "password123",
        })
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT COUNT(*) count FROM rateLimit WHERE key LIKE 'password-account-v2:%'").first(),
    ).toEqual({ count: 1 });
  });

  it("canonicalizes equivalent IPv6 sources and groups absent or malformed sources", async () => {
    await bootstrap();
    expect(
      (
        await requestFromIp("2001:0db8:0:0:0:0:0:1", "/api/auth/sign-in/email", {
          email: "missing@example.test",
          password: "incorrect",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await requestFromIp("2001:db8::1", "/api/auth/sign-in/email", {
          email: "missing@example.test",
          password: "incorrect",
        })
      ).status,
    ).toBe(401);
    expect(
      await env.DB.prepare("SELECT count FROM rateLimit WHERE key LIKE 'password-account-v2:%'").all(),
    ).toMatchObject({ results: [{ count: 2 }] });

    await request("", "/api/auth/sign-in/email", { email: "fallback@example.test", password: "incorrect" });
    await requestFromIp("not-an-ip", "/api/auth/sign-in/email", {
      email: "fallback@example.test",
      password: "incorrect",
    });
    expect(
      await env.DB.prepare("SELECT count FROM rateLimit WHERE key LIKE 'password-account-v2:%' ORDER BY count").all(),
    ).toMatchObject({ results: [{ count: 2 }, { count: 2 }] });
  });
  it("guards the vendor passkey insert against reset, revoked session and obsolete generation", async () => {
    await enrollAccount(await bootstrap());
    const user = await env.DB.prepare("SELECT id FROM user").first<{ id: string }>();
    const permit = (credential: string) =>
      env.DB.prepare(`INSERT INTO pending_passkeys(credential_id,user_id,session_id,generation)
      SELECT ?,s.userId,s.id,a.generation FROM session s JOIN account_security a ON a.user_id=s.userId LIMIT 1`)
        .bind(credential)
        .run();
    const insert = (credential: string) =>
      env.DB.prepare(
        "INSERT INTO passkey(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES (?, 'verified-public-key', ?, ?, 0, 'singleDevice', 0)",
      )
        .bind(credential, user!.id, credential)
        .run();
    await permit("legitimate");
    await insert("legitimate");
    expect(await env.DB.prepare("SELECT 1 FROM pending_passkeys").first()).toBeNull();
    await permit("old-generation");
    await env.DB.prepare("UPDATE account_security SET generation=generation+1").run();
    await expect(insert("old-generation")).rejects.toThrow("passkey_registration_revoked");
    await permit("reset-race");
    await env.DB.prepare("INSERT INTO security_resets(token_hash,user_id,expires_at) VALUES (?,?,?)")
      .bind(await sha256("passkey-reset"), user!.id, Date.now() + 60_000)
      .run();
    await expect(insert("reset-race")).rejects.toThrow("passkey_registration_revoked");
    expect(await env.DB.prepare("SELECT 1 FROM passkey").first()).toBeNull();
  });

  it("upserts retry permits, cleans failed registrations, and identifies revoked races", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const session = await (
      await request(cookie, "/api/auth/get-session")
    ).json<{ session: { id: string }; user: { id: string } }>();
    const account = await env.DB.prepare("SELECT generation FROM account_security WHERE user_id=?")
      .bind(session.user.id)
      .first<{ generation: number }>();
    const permit = {
      credentialId: "retry-credential",
      userId: session.user.id,
      sessionId: session.session.id,
      generation: account!.generation,
    };

    expect(await upsertPasskeyRegistrationPermit(env, permit)).toBe(true);
    expect(await upsertPasskeyRegistrationPermit(env, permit)).toBe(true);
    expect(await cleanupFailedPasskeyRegistration(env, permit)).toEqual({ revoked: false });
    expect(await env.DB.prepare("SELECT 1 FROM pending_passkeys").first()).toBeNull();

    expect(await upsertPasskeyRegistrationPermit(env, permit)).toBe(true);
    await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?")
      .bind(session.user.id)
      .run();
    expect(await cleanupFailedPasskeyRegistration(env, permit)).toEqual({ revoked: true });
    expect(await env.DB.prepare("SELECT 1 FROM pending_passkeys").first()).toBeNull();

    const revoked = passkeyRegistrationRevokedResponse();
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ code: "SECURITY_REQUIRED" });
  });

  it("resets rate limits on fixed windows during continuous NAT traffic and enforces concurrent bursts", async () => {
    const auth = createAuth(env);
    const consume = (await auth.$context).options.rateLimit!.customStorage!.consume!;
    const clock = vi.spyOn(Date, "now");
    try {
      const start = Math.floor(Date.now() / 60_000) * 60_000;
      for (let i = 0; i < 61; i++) {
        clock.mockReturnValue(start + i * 20_000);
        expect(await consume("steady-nat", { window: 60, max: 60 })).toMatchObject({ allowed: true });
      }
      clock.mockReturnValue(start + 1_300_000);
      const burst = await Promise.all(Array.from({ length: 12 }, () => consume("burst", { window: 60, max: 10 })));
      expect(burst.filter((result) => result.allowed)).toHaveLength(10);
      expect(burst.filter((result) => !result.allowed).every((result) => result.retryAfter! > 0)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("never lets a stale-window write move a rate bucket backward", async () => {
    const consume = (await createAuth(env).$context).options.rateLimit!.customStorage!.consume!;
    const clock = vi.spyOn(Date, "now");
    try {
      const start = Math.floor(Date.now() / 60_000) * 60_000;
      clock.mockReturnValue(start + 60_001);
      expect(await consume("monotonic", { window: 60, max: 2 })).toMatchObject({ allowed: true });
      clock.mockReturnValue(start + 1);
      expect(await consume("monotonic", { window: 60, max: 2 })).toMatchObject({ allowed: false });
      expect(await env.DB.prepare("SELECT count,lastRequest FROM rateLimit WHERE key='monotonic'").first()).toEqual({
        count: 1,
        lastRequest: Math.floor((start + 60_001) / 60_000) * 60_000,
      });
      clock.mockReturnValue(start + 60_002);
      expect(await consume("monotonic", { window: 60, max: 2 })).toMatchObject({ allowed: true });
      expect(await consume("monotonic", { window: 60, max: 2 })).toMatchObject({ allowed: false });
    } finally {
      clock.mockRestore();
    }
  });

  it("prunes stale rate buckets and expired staged recovery codes from the scheduled task", async () => {
    await enrollAccount(await bootstrap());
    const user = await env.DB.prepare("SELECT id FROM user").first<{ id: string }>();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rateLimit(id,key,count,lastRequest) VALUES ('stale','stale',1,?)").bind(
        Date.now() - 25 * 60 * 60_000,
      ),
      env.DB.prepare(
        "INSERT INTO pending_recovery_codes(code_hash,batch_id,user_id,generation,expires_at) VALUES ('expired','batch',?,1,?)",
      ).bind(user!.id, Date.now() - 1),
    ]);
    const context = createExecutionContext();
    await worker.scheduled!(createScheduledController(), env, context);
    await waitOnExecutionContext(context);
    expect(await env.DB.prepare("SELECT id FROM rateLimit WHERE id='stale'").first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT code_hash FROM pending_recovery_codes WHERE code_hash='expired'").first(),
    ).toBeNull();
  });

  it("retires one stale bucket whenever a new distinct rate-limit bucket is inserted", async () => {
    const timestamp = Date.now();
    const staleIds = Array.from({ length: 600 }, (_, index) => `stale-${index}`);
    await env.DB.prepare(`INSERT INTO rateLimit(id,key,count,lastRequest)
      SELECT value,value,1,? FROM json_each(?)`)
      .bind(timestamp - 25 * 60 * 60_000, JSON.stringify(staleIds))
      .run();
    const consume = (await createAuth(env).$context).options.rateLimit!.customStorage!.consume!;
    for (let index = 0; index < 50; index++) {
      expect(await consume(`current-${index}`, { window: 60, max: 2 })).toMatchObject({ allowed: true });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM rateLimit").first()).toEqual({ count: 600 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) count FROM rateLimit WHERE lastRequest<?")
        .bind(timestamp - 24 * 60 * 60_000)
        .first(),
    ).toEqual({ count: 550 });
    expect(await env.DB.prepare("SELECT count FROM rateLimit WHERE key='current-0'").first()).toEqual({ count: 1 });
  });
});
