import { applyD1Migrations, env, reset } from "cloudflare:test";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { passwordResetSql } from "../../scripts/security-reset.mjs";
import { otpFromUri, responseCookies, securityRequest as request } from "../../tests/helpers/security";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

async function bootstrap() {
  const response = await request("", "/api/install/bootstrap", {
    bootstrapToken: "worker-bootstrap-token",
    workspaceName: "Password reset",
    name: "Owner",
    email: "owner@example.test",
    password: "password123",
  });
  expect(response.status).toBe(200);
  return responseCookies(response);
}

describe("password-only operator reset", () => {
  it("preserves account protection and existing sessions while requiring a second factor for the new password", async () => {
    let cookie = await bootstrap();
    const setup = await request(cookie, "/api/security/setup-totp", { password: "password123" });
    const { totpURI } = await setup.json<{ totpURI: string }>();
    const confirmed = await request(cookie, "/api/security/confirm-totp", { code: await otpFromUri(totpURI) });
    expect(confirmed.status).toBe(200);
    cookie = responseCookies(confirmed, cookie);
    const { receipt } = await (await request(cookie, "/api/security/recovery-codes", {})).json<{ receipt: string }>();
    expect((await request(cookie, "/api/security/acknowledge-codes", { receipt })).status).toBe(200);
    expect((await request(cookie, "/api/security/trust", {})).status).toBe(200);
    expect((await request(cookie, "/api/security/recovery-codes", {})).status).toBe(200);
    await env.DB.prepare(`INSERT INTO pending_passkeys(credential_id,user_id,session_id,generation)
      SELECT 'reset-test-passkey',s.userId,s.id,a.generation FROM session s
      JOIN account_security a ON a.user_id=s.userId LIMIT 1`).run();
    await env.DB.prepare(`INSERT INTO passkey(id,publicKey,userId,credentialID,counter,deviceType,backedUp)
      SELECT 'reset-test-passkey','verified-public-key',id,'reset-test-passkey',0,'singleDevice',0
      FROM user WHERE email='owner@example.test'`).run();
    await env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
      VALUES ('other','Other','other@example.test',1,1)`).run();
    await env.DB.prepare(`INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt)
      VALUES ('other-credential','other','credential','other','other-password-hash',1,1),
        ('owner-slack','owner-slack','slack',(SELECT id FROM user WHERE email='owner@example.test'),NULL,1,1)`).run();

    const tables = [
      "user",
      "account_security",
      "session",
      "session_security",
      "trusted_browsers",
      "twoFactor",
      "passkey",
      "recovery_codes",
      "pending_recovery_codes",
      "security_resets",
      "verification",
    ];
    const snapshot = () => env.DB.batch(tables.map((table) => env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`)));
    const before = (await snapshot()).map((result) => result.results);
    for (const table of [
      "session",
      "session_security",
      "trusted_browsers",
      "twoFactor",
      "passkey",
      "recovery_codes",
      "pending_recovery_codes",
    ]) {
      expect(before[tables.indexOf(table)]?.length).toBeGreaterThan(0);
    }
    const accountsBefore = (await env.DB.prepare("SELECT * FROM account ORDER BY id").all()).results;
    const newPassword = "random-replacement-password-12345";
    const hash = await hashPassword(newPassword);
    const changed = await env.DB.prepare(passwordResetSql(" OWNER@EXAMPLE.TEST ", hash, Date.now())).run();
    expect(changed.meta.changes).toBe(1);
    expect((await snapshot()).map((result) => result.results)).toEqual(before);
    const accountsAfter = (await env.DB.prepare("SELECT * FROM account ORDER BY id").all()).results;
    expect(accountsAfter.filter((row) => row.id === "other-credential" || row.id === "owner-slack")).toEqual(
      accountsBefore.filter((row) => row.id === "other-credential" || row.id === "owner-slack"),
    );
    const credential = await env.DB.prepare(
      "SELECT password FROM account WHERE providerId='credential' AND userId <> 'other'",
    ).first<{ password: string }>();
    expect(await verifyPassword({ hash: credential!.password, password: newPassword })).toBe(true);
    expect(await verifyPassword({ hash: credential!.password, password: "password123" })).toBe(false);
    expect((await request(cookie, "/api/me")).status).toBe(200);
    expect(
      (await request("", "/api/auth/sign-in/email", { email: "owner@example.test", password: "password123" })).status,
    ).toBe(401);
    const login = await request("", "/api/auth/sign-in/email", { email: "owner@example.test", password: newPassword });
    expect(login.status).toBe(200);
    expect(await login.clone().json()).toMatchObject({ twoFactorRedirect: true });
    const pending = responseCookies(login);
    expect((await request(pending, "/api/me")).status).toBe(401);
    const verified = await request(pending, "/api/auth/two-factor/verify-totp", { code: await otpFromUri(totpURI, 1) });
    expect(verified.status).toBe(200);
    expect((await request(responseCookies(verified, pending), "/api/me")).status).toBe(200);
  });

  it.each(["missing", "slack-only", "ambiguous"])("makes no changes for a %s account", async (kind) => {
    await bootstrap();
    if (kind === "slack-only") {
      await env.DB.prepare("UPDATE account SET providerId='slack' WHERE providerId='credential'").run();
    }
    if (kind === "ambiguous") {
      await env.DB.prepare(`INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt)
        SELECT 'duplicate','duplicate','credential',id,'duplicate-hash',1,1 FROM user`).run();
    }
    const before = (await env.DB.prepare("SELECT * FROM account ORDER BY id").all()).results;
    const result = await env.DB.prepare(
      passwordResetSql(
        kind === "missing" ? "missing@example.test" : "owner@example.test",
        "replacement-hash",
        Date.now(),
      ),
    ).run();
    expect(result.meta.changes).toBe(0);
    expect((await env.DB.prepare("SELECT * FROM account ORDER BY id").all()).results).toEqual(before);
    expect(await env.DB.prepare("SELECT * FROM security_resets").first()).toBeNull();
  });
});
