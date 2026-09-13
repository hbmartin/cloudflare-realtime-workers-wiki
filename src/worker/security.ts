import type { GenericEndpointContext } from "@better-auth/core";
import { createOTP } from "@better-auth/utils/otp";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { SecurityStatus } from "../shared/security";
import type { Env } from "./env";
import { HttpError, sha256 } from "./http";

const TRUST_MS = 30 * 24 * 60 * 60_000;
const FRESH_MS = 5 * 60_000;
const RECOVERY_MS = 10 * 60_000;
type SecurityAccount = { generation: number; recovery_required: number; codes_saved: number; locked_until: number };
type Grant = { method: "totp" | "passkey" | "trust" | "recovery"; verified_at: number; expires_at: number };
type Identity = { userId: string; sessionId: string | null; challenge: string | null };

function deny(message = "Verify your account protection to continue.") {
  return new APIError("FORBIDDEN", { code: "SECURITY_REQUIRED", message });
}

function field(ctx: GenericEndpointContext, key: string): string {
  const value: unknown = ctx.body?.[key];
  if (typeof value !== "string" || !value || value.length > 1000) {
    throw new APIError("BAD_REQUEST", { code: "INVALID_INPUT", message: `Provide ${key}.` });
  }
  return value;
}

async function securityAccount(env: Env, userId: string): Promise<SecurityAccount> {
  const query = () =>
    env.DB.prepare("SELECT generation,recovery_required,codes_saved,locked_until FROM account_security WHERE user_id=?")
      .bind(userId)
      .first<SecurityAccount>();
  const existing = await query();
  if (existing) return existing;
  await env.DB.prepare("INSERT OR IGNORE INTO account_security(user_id) VALUES (?)").bind(userId).run();
  return (await query())!;
}

async function factors(env: Env, userId: string) {
  const row = await env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM twoFactor WHERE userId = ? AND verified = 1) totp,
    (SELECT COUNT(*) FROM passkey WHERE userId = ?) passkeys`)
    .bind(userId, userId)
    .first<{ totp: number; passkeys: number }>();
  return { totp: !!row?.totp, passkeys: row?.passkeys ?? 0 };
}

async function grant(env: Env, userId: string, sessionId: string | null) {
  if (!sessionId) return null;
  return env.DB.prepare(`SELECT s.method, s.verified_at, s.expires_at FROM session_security s
    JOIN account_security a ON a.user_id = s.user_id AND a.generation = s.generation
    JOIN session ON session.id = s.session_id AND session.userId = s.user_id
    WHERE s.session_id = ? AND s.user_id = ? AND s.expires_at > ?
    AND (s.method != 'trust' OR EXISTS(SELECT 1 FROM trusted_browsers t
      WHERE t.id = s.trust_id AND t.user_id = s.user_id AND t.generation = a.generation AND t.expires_at > ?))`)
    .bind(sessionId, userId, Date.now(), Date.now())
    .first<Grant>();
}

async function securityStatus(env: Env, userId: string, sessionId: string | null): Promise<SecurityStatus> {
  const account = await securityAccount(env, userId);
  const enrolled = await factors(env, userId);
  const verified = await grant(env, userId, sessionId);
  let state: SecurityStatus["state"] = "challenge_required";
  if (account.recovery_required) state = "recovery_required";
  else if (!enrolled.totp && !enrolled.passkeys) state = "enrollment_required";
  else if (verified && verified.method !== "recovery") state = account.codes_saved ? "ready" : "enrollment_required";
  return {
    state,
    ...enrolled,
    codesSaved: !!account.codes_saved,
    fresh:
      !!verified &&
      (verified.method === "totp" || verified.method === "passkey") &&
      verified.verified_at > Date.now() - FRESH_MS,
  };
}

export async function requireSecurity(env: Env, userId: string, sessionId: string) {
  const status = await securityStatus(env, userId, sessionId);
  if (status.state !== "ready") throw new HttpError(401, status.state, "Complete account protection to continue.");
  return (await grant(env, userId, sessionId))!.expires_at;
}

async function identity(ctx: GenericEndpointContext): Promise<Identity | null> {
  const session = await getSessionFromCtx(ctx);
  if (session) return { userId: session.user.id, sessionId: session.session.id, challenge: null };
  const cookie = ctx.context.createAuthCookie("two_factor");
  const key = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!key) return null;
  const pending = await ctx.context.internalAdapter.findVerificationValue(key);
  if (!pending || pending.expiresAt.getTime() <= Date.now()) return null;
  return { userId: pending.value, sessionId: null, challenge: key };
}

async function requireIdentity(ctx: GenericEndpointContext) {
  const id = await identity(ctx);
  if (!id) throw new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Sign in to continue." });
  return id;
}

async function requireFresh(ctx: GenericEndpointContext, env: Env) {
  const id = await requireIdentity(ctx);
  const status = await securityStatus(env, id.userId, id.sessionId);
  if (!status.fresh) throw deny("Verify an authenticator code or passkey again to change security settings.");
  return id;
}

async function requireEnrollment(ctx: GenericEndpointContext, env: Env) {
  const id = await requireIdentity(ctx);
  if (!id.sessionId) throw deny();
  const status = await securityStatus(env, id.userId, id.sessionId);
  const account = await securityAccount(env, id.userId);
  const proof = await grant(env, id.userId, id.sessionId);
  if (account.recovery_required) {
    if (!proof || proof.method !== "recovery") throw deny("Use a recovery code or operator reset token first.");
  } else if ((status.totp || status.passkeys) && !status.fresh) throw deny();
  // Password-only enrollment sessions expire for enrollment purposes after ten minutes.
  const session = await getSessionFromCtx(ctx);
  if (!proof && (!session || session.session.createdAt.getTime() < Date.now() - RECOVERY_MS))
    throw deny("Sign in again to finish enrollment.");
  return id;
}

async function attempt(env: Env, userId: string) {
  await securityAccount(env, userId);
  const time = Date.now();
  const result = await env.DB.prepare(`UPDATE account_security SET
    failed_attempts = CASE WHEN locked_until > 0 THEN 1 ELSE failed_attempts + 1 END,
    locked_until = CASE WHEN locked_until = 0 AND failed_attempts >= 9 THEN ? ELSE 0 END
    WHERE user_id = ? AND locked_until <= ? RETURNING failed_attempts`)
    .bind(time + 15 * 60_000, userId, time)
    .first();
  if (!result)
    throw new APIError("TOO_MANY_REQUESTS", {
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      message: "Too many attempts. Try again in 15 minutes.",
    });
}

async function password(ctx: GenericEndpointContext, userId: string) {
  const value = field(ctx, "password");
  const accounts = await ctx.context.internalAdapter.findAccounts(userId);
  const credential = accounts.find((account) => account.providerId === "credential");
  if (!credential?.password || !(await ctx.context.password.verify({ hash: credential.password, password: value }))) {
    throw deny("The password or recovery credential is invalid.");
  }
}

async function stamp(
  env: Env,
  userId: string,
  sessionId: string,
  method: Grant["method"],
  generation: number,
  expiresAt = Date.now() + TRUST_MS,
  trustId: string | null = null,
) {
  const result =
    await env.DB.prepare(`INSERT INTO session_security(session_id,user_id,generation,verified_at,expires_at,method,trust_id)
    SELECT ?, user_id, generation, ?, ?, ?, ? FROM account_security
    WHERE user_id = ? AND generation = ?
    ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation, verified_at=excluded.verified_at,
      expires_at=excluded.expires_at, method=excluded.method, trust_id=excluded.trust_id RETURNING session_id`)
      .bind(sessionId, Date.now(), expiresAt, method, trustId, userId, generation)
      .first();
  if (!result) throw deny("Security settings changed. Sign in again.");
  await env.DB.prepare("UPDATE account_security SET failed_attempts = 0, locked_until = 0 WHERE user_id = ?")
    .bind(userId)
    .run();
  console.info("account-security", { event: "verified", userId, method });
}

async function issueSession(
  ctx: GenericEndpointContext,
  env: Env,
  id: Identity,
  method: Grant["method"],
  generation: number,
  expiresAt?: number,
  trustId?: string,
) {
  if (id.challenge) {
    const consumed = await ctx.context.internalAdapter.consumeVerificationValue(id.challenge);
    if (!consumed || consumed.value !== id.userId || consumed.expiresAt.getTime() <= Date.now())
      throw deny("Sign in again.");
    expireCookie(ctx, ctx.context.createAuthCookie("two_factor"));
  }
  const user = await ctx.context.internalAdapter.findUserById(id.userId);
  if (!user) throw deny();
  const session = await ctx.context.internalAdapter.createSession(id.userId);
  await stamp(env, id.userId, session.id, method, generation, expiresAt, trustId);
  await setSessionCookie(ctx, { user, session });
  if (id.sessionId) await env.DB.prepare("DELETE FROM session WHERE id = ?").bind(id.sessionId).run();
  return session.id;
}

async function consumeTotp(env: Env, userId: string, code: string) {
  await env.DB.prepare("DELETE FROM used_totp WHERE expires_at <= ?").bind(Date.now()).run();
  const result = await env.DB.prepare("INSERT OR IGNORE INTO used_totp(user_id,code_hash,expires_at) VALUES (?,?,?)")
    .bind(userId, await sha256(code), Date.now() + 90_000)
    .run();
  if (!result.meta.changes) throw deny("That code was already used. Wait for a new code.");
}

function trustCookie(ctx: GenericEndpointContext) {
  return ctx.context.createAuthCookie("notes_trust", { maxAge: TRUST_MS / 1000, sameSite: "strict" });
}

// Session generation is captured before verification, so a concurrent reset cannot
// turn a response from an old ceremony into a grant for the new account generation.
type PolicyContext = { notesSecurity?: { userId: string; generation: number } };
function captureSecurity(ctx: GenericEndpointContext, userId: string, generation: number) {
  (ctx.context as typeof ctx.context & PolicyContext).notesSecurity = { userId, generation };
}

const post = (path: string, handler: (ctx: GenericEndpointContext) => Promise<unknown>) =>
  createAuthEndpoint(path, { method: "POST" }, handler);

export function mandatorySecurity(env: Env): BetterAuthPlugin {
  return {
    id: "mandatory-security",
    endpoints: {
      securityStatus: createAuthEndpoint("/security/status", { method: "GET" }, async (ctx) => {
        const id = await identity(ctx);
        return ctx.json(
          id
            ? await securityStatus(env, id.userId, id.sessionId)
            : ({
                state: "signed_out",
                totp: false,
                passkeys: 0,
                codesSaved: false,
                fresh: false,
              } satisfies SecurityStatus),
        );
      }),
      completeTrust: post("/security/complete-trust", async (ctx) => {
        const id = await requireIdentity(ctx);
        const account = await securityAccount(env, id.userId);
        const enrolled = await factors(env, id.userId);
        if (account.recovery_required || !account.codes_saved || (!enrolled.totp && !enrolled.passkeys)) throw deny();
        const token = ctx.getCookie(trustCookie(ctx).name);
        const record = token
          ? await env.DB.prepare(`SELECT id, expires_at FROM trusted_browsers
          WHERE token_hash = ? AND user_id = ? AND generation = ? AND expires_at > ?`)
              .bind(await sha256(token), id.userId, account.generation, Date.now())
              .first<{ id: string; expires_at: number }>()
          : null;
        if (!record) throw deny("Verify your authenticator or passkey.");
        await issueSession(ctx, env, id, "trust", account.generation, record.expires_at, record.id);
        return ctx.json({ success: true });
      }),
      trustBrowser: post("/security/trust", async (ctx) => {
        const id = await requireFresh(ctx, env);
        const status = await securityStatus(env, id.userId, id.sessionId);
        if (status.state !== "ready") throw deny();
        const account = await securityAccount(env, id.userId);
        const proof = (await grant(env, id.userId, id.sessionId))!;
        const token = generateRandomString(48);
        const cookie = trustCookie(ctx);
        const old = ctx.getCookie(cookie.name);
        if (old)
          await env.DB.prepare("DELETE FROM trusted_browsers WHERE token_hash = ? AND user_id = ?")
            .bind(await sha256(old), id.userId)
            .run();
        await env.DB.prepare(
          "INSERT INTO trusted_browsers(id,token_hash,user_id,generation,created_at,expires_at,name) VALUES (?,?,?,?,?,?,?)",
        )
          .bind(
            crypto.randomUUID(),
            await sha256(token),
            id.userId,
            account.generation,
            proof.verified_at,
            proof.verified_at + TRUST_MS,
            (ctx.headers?.get("user-agent") ?? "Browser").slice(0, 160),
          )
          .run();
        ctx.setCookie(cookie.name, token, cookie.attributes);
        return ctx.json({ success: true });
      }),
      securityMethods: createAuthEndpoint("/security/methods", { method: "GET" }, async (ctx) => {
        const id = await requireIdentity(ctx);
        if ((await securityStatus(env, id.userId, id.sessionId)).state !== "ready") throw deny();
        const keys = await env.DB.prepare("SELECT id, name, createdAt FROM passkey WHERE userId = ?")
          .bind(id.userId)
          .all();
        const browsers = await env.DB.prepare(
          "SELECT id, name, created_at, expires_at FROM trusted_browsers WHERE user_id = ? AND expires_at > ?",
        )
          .bind(id.userId, Date.now())
          .all();
        return ctx.json({ passkeys: keys.results, browsers: browsers.results });
      }),
      revokeTrust: post("/security/revoke-trust", async (ctx) => {
        const id = await requireFresh(ctx, env);
        await env.DB.prepare("DELETE FROM trusted_browsers WHERE user_id = ? AND id = ?")
          .bind(id.userId, field(ctx, "id"))
          .run();
        return ctx.json({ success: true });
      }),
      setupTotp: post("/security/setup-totp", async (ctx) => {
        const id = await requireEnrollment(ctx, env);
        await attempt(env, id.userId);
        await password(ctx, id.userId);
        const secret = Array.from(
          crypto.getRandomValues(new Uint8Array(32)),
          (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte & 31],
        ).join("");
        const encrypted = await symmetricEncrypt({ key: ctx.context.secretConfig, data: secret });
        await env.DB.prepare(`INSERT INTO pending_totp(session_id,user_id,secret,expires_at) VALUES (?,?,?,?)
          ON CONFLICT(session_id) DO UPDATE SET secret=excluded.secret,expires_at=excluded.expires_at`)
          .bind(id.sessionId, id.userId, encrypted, Date.now() + RECOVERY_MS)
          .run();
        const user = await ctx.context.internalAdapter.findUserById(id.userId);
        return ctx.json({ totpURI: createOTP(secret, { digits: 6, period: 30 }).url("Realtime Notes", user!.email) });
      }),
      confirmTotp: post("/security/confirm-totp", async (ctx) => {
        const id = await requireEnrollment(ctx, env);
        const account = await securityAccount(env, id.userId);
        await attempt(env, id.userId);
        const pending = await env.DB.prepare("SELECT secret FROM pending_totp WHERE session_id = ? AND expires_at > ?")
          .bind(id.sessionId, Date.now())
          .first<{ secret: string }>();
        const code = field(ctx, "code");
        if (
          !pending ||
          !(await createOTP(await symmetricDecrypt({ key: ctx.context.secretConfig, data: pending.secret }), {
            digits: 6,
            period: 30,
          }).verify(code))
        )
          throw deny("The code is invalid or setup expired.");
        await consumeTotp(env, id.userId, code);
        // All changes commit together; an old authenticator survives cancelled setup.
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO twoFactor(id,userId,secret,backupCodes,verified) SELECT ?,user_id,?,'[]',1 FROM account_security WHERE user_id=? AND generation=?
            ON CONFLICT(userId) DO UPDATE SET secret=excluded.secret,verified=1`).bind(
            crypto.randomUUID(),
            pending.secret,
            id.userId,
            account.generation,
          ),
          env.DB.prepare("UPDATE user SET twoFactorEnabled = 1 WHERE id = ?").bind(id.userId),
          env.DB.prepare("UPDATE account_security SET recovery_required = 0 WHERE user_id = ? AND generation = ?").bind(
            id.userId,
            account.generation,
          ),
          env.DB.prepare("DELETE FROM pending_totp WHERE session_id = ?").bind(id.sessionId),
          env.DB.prepare("DELETE FROM trusted_browsers WHERE user_id = ?").bind(id.userId),
          env.DB.prepare("DELETE FROM session WHERE userId = ? AND id != ?").bind(id.userId, id.sessionId),
        ]);
        await issueSession(ctx, env, id, "totp", account.generation);
        return ctx.json({ success: true });
      }),
      removeFactor: post("/security/remove-factor", async (ctx) => {
        const id = await requireFresh(ctx, env);
        const kind = field(ctx, "kind");
        // Each conditional deletion checks the other method in the same SQLite statement.
        // D1 serializes competing writes, preventing two requests deleting the last factors.
        const result =
          kind === "totp"
            ? await env.DB.prepare(
                "DELETE FROM twoFactor WHERE userId = ? AND EXISTS(SELECT 1 FROM passkey WHERE userId = ?)",
              )
                .bind(id.userId, id.userId)
                .run()
            : await env.DB.prepare(`DELETE FROM passkey WHERE id = ? AND userId = ? AND
            (EXISTS(SELECT 1 FROM twoFactor WHERE userId = ? AND verified = 1) OR (SELECT COUNT(*) FROM passkey WHERE userId = ?) > 1)`)
                .bind(field(ctx, "id"), id.userId, id.userId, id.userId)
                .run();
        if (!result.meta.changes) throw deny("Keep at least one active authenticator or passkey.");
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE user SET twoFactorEnabled = EXISTS(SELECT 1 FROM twoFactor WHERE userId = user.id AND verified = 1) WHERE id = ?",
          ).bind(id.userId),
          env.DB.prepare("DELETE FROM trusted_browsers WHERE user_id = ?").bind(id.userId),
          env.DB.prepare("DELETE FROM session WHERE userId = ? AND id != ?").bind(id.userId, id.sessionId),
        ]);
        return ctx.json({ success: true });
      }),
      generateRecovery: post("/security/recovery-codes", async (ctx) => {
        const id = await requireFresh(ctx, env);
        const codes = Array.from({ length: 10 }, () => generateRandomString(24));
        const hashes = await Promise.all(codes.map(sha256));
        const receipt = crypto.randomUUID();
        // The batch receipt binds acknowledgment to the codes actually displayed.
        // Every write is also conditional on the issuing session surviving revocation.
        const result = await env.DB.batch([
          env.DB.prepare(
            "UPDATE account_security SET codes_batch=? WHERE user_id=? AND EXISTS(SELECT 1 FROM session WHERE id=?) RETURNING user_id",
          ).bind(receipt, id.userId, id.sessionId),
          env.DB.prepare(
            "DELETE FROM recovery_codes WHERE user_id=? AND EXISTS(SELECT 1 FROM account_security WHERE user_id=? AND codes_batch=?)",
          ).bind(id.userId, id.userId, receipt),
          ...hashes.map((hash) =>
            env.DB.prepare(
              "INSERT INTO recovery_codes(code_hash,user_id) SELECT ?,user_id FROM account_security WHERE user_id=? AND codes_batch=?",
            ).bind(hash, id.userId, receipt),
          ),
        ]);
        if (!result[0]!.results.length) throw deny("Sign in again before generating recovery codes.");
        return ctx.json({ codes, receipt });
      }),
      acknowledgeRecovery: post("/security/acknowledge-codes", async (ctx) => {
        const id = await requireFresh(ctx, env);
        const result = await env.DB.prepare(
          "UPDATE account_security SET codes_saved=1 WHERE user_id=? AND codes_batch=? AND EXISTS(SELECT 1 FROM session WHERE id=?)",
        )
          .bind(id.userId, field(ctx, "receipt"), id.sessionId)
          .run();
        if (!result.meta.changes) throw deny("Those recovery codes were replaced. Generate and save a new set.");
        return ctx.json({ success: true });
      }),
      recoverSecurity: post("/security/recover", async (ctx) => {
        const id = await requireIdentity(ctx);
        await attempt(env, id.userId);
        await password(ctx, id.userId);
        const hash = await sha256(field(ctx, "code"));
        const reset = ctx.body?.reset === true;
        const consumed = reset
          ? await env.DB.prepare(
              "DELETE FROM security_resets WHERE token_hash = ? AND user_id = ? AND expires_at > ? RETURNING user_id",
            )
              .bind(hash, id.userId, Date.now())
              .first()
          : await env.DB.prepare("DELETE FROM recovery_codes WHERE code_hash = ? AND user_id = ? RETURNING user_id")
              .bind(hash, id.userId)
              .first();
        if (!consumed) throw deny("The password or recovery credential is invalid.");
        // Consume the password challenge before invalidating the account's other challenges.
        if (id.challenge) {
          const pending = await ctx.context.internalAdapter.consumeVerificationValue(id.challenge);
          if (!pending || pending.value !== id.userId || pending.expiresAt.getTime() <= Date.now())
            throw deny("Sign in again.");
        }
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE account_security SET generation=generation+1,recovery_required=1,codes_saved=0 WHERE user_id=?",
          ).bind(id.userId),
          env.DB.prepare("DELETE FROM session WHERE userId=?").bind(id.userId),
          env.DB.prepare("DELETE FROM trusted_browsers WHERE user_id=?").bind(id.userId),
          env.DB.prepare("DELETE FROM recovery_codes WHERE user_id=?").bind(id.userId),
          env.DB.prepare("DELETE FROM verification WHERE value=?").bind(id.userId),
        ]);
        const account = await securityAccount(env, id.userId);
        await issueSession(
          ctx,
          env,
          { ...id, sessionId: null, challenge: null },
          "recovery",
          account.generation,
          Date.now() + RECOVERY_MS,
        );
        expireCookie(ctx, ctx.context.createAuthCookie("two_factor"));
        expireCookie(ctx, trustCookie(ctx));
        console.info("account-security", { event: "recovery", userId: id.userId, operator: reset });
        return ctx.json({ success: true });
      }),
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            // Never expose the plugin's optional disable, backup, OTP, or destructive setup APIs.
            if (ctx.path.startsWith("/two-factor/") && ctx.path !== "/two-factor/verify-totp")
              throw deny("Use Security settings to manage account protection.");
            if (ctx.path === "/passkey/delete-passkey") throw deny("Use Security settings to remove a passkey.");
            if (ctx.body && "trustDevice" in ctx.body) ctx.body.trustDevice = false;
            // Strip native rolling trust cookies, including signed variants, on every dispatch.
            const cookies = ctx.headers?.get("cookie");
            if (cookies)
              ctx.headers!.set(
                "cookie",
                cookies
                  .split(";")
                  .filter((part) => !part.trim().split("=")[0]?.endsWith(".trust_device"))
                  .join(";"),
              );
            if (ctx.path === "/passkey/verify-authentication") {
              const credentialId: unknown = ctx.body?.response?.id;
              const key =
                typeof credentialId === "string"
                  ? await env.DB.prepare("SELECT userId FROM passkey WHERE credentialID = ?")
                      .bind(credentialId)
                      .first<{ userId: string }>()
                  : null;
              if (!key) throw deny("The passkey is not recognized.");
              const account = await securityAccount(env, key.userId);
              await attempt(env, key.userId);
              captureSecurity(ctx, key.userId, account.generation);
              const current = await identity(ctx);
              if (current && current.userId !== key.userId) throw deny("Use a passkey belonging to this account.");
              return;
            }
            const publicPaths = new Set([
              "/sign-in/email",
              "/sign-up/email",
              "/sign-out",
              "/get-session",
              "/security/status",
              "/passkey/generate-authenticate-options",
              "/passkey/verify-authentication",
            ]);
            if (publicPaths.has(ctx.path)) return;
            const id = await requireIdentity(ctx);
            const account = await securityAccount(env, id.userId);
            captureSecurity(ctx, id.userId, account.generation);
            if (ctx.path === "/two-factor/verify-totp") {
              await attempt(env, id.userId);
              return;
            }
            if (ctx.path === "/passkey/generate-register-options" || ctx.path === "/passkey/verify-registration") {
              await requireEnrollment(ctx, env);
              return;
            }
            if (ctx.path.startsWith("/security/")) return;
            // All other account changes require recent factor proof; sign-in recency alone is insufficient.
            await requireFresh(ctx, env);
          }),
        },
      ],
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) return undefined;
            if (ctx.path === "/passkey/generate-authenticate-options") {
              const options = ctx.context.returned as Record<string, unknown>;
              return ctx.json({ ...options, userVerification: "required" });
            }
            const next = ctx.context.newSession;
            if (
              ctx.path === "/two-factor/verify-totp" ||
              ctx.path === "/passkey/verify-authentication" ||
              ctx.path === "/passkey/verify-registration"
            ) {
              const id = next ? { userId: next.user.id, sessionId: next.session.id } : await identity(ctx);
              const capture = (ctx.context as typeof ctx.context & PolicyContext).notesSecurity;
              if (!id?.sessionId || !capture || capture.userId !== id.userId) throw deny();
              if (ctx.path === "/two-factor/verify-totp") await consumeTotp(env, id.userId, field(ctx, "code"));
              await stamp(
                env,
                id.userId,
                id.sessionId,
                ctx.path === "/two-factor/verify-totp" ? "totp" : "passkey",
                capture.generation,
              );
              await env.DB.prepare("UPDATE account_security SET recovery_required=0 WHERE user_id=? AND generation=?")
                .bind(id.userId, capture.generation)
                .run();
            }
            if (ctx.path === "/sign-in/email" || ctx.path === "/sign-up/email") {
              console.info("account-security", { event: "password-authenticated", outcome: "verification-required" });
            }
            return undefined;
          }),
        },
      ],
    },
  };
}
