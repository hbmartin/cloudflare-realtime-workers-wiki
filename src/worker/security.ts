import type { GenericEndpointContext } from "@better-auth/core";
import { createOTP } from "@better-auth/utils/otp";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { SecurityStatus } from "../shared/security";
import type { Env } from "./env";
import { HttpError, sha256 } from "./http";
import { clearRateLimit, consumeFixedWindow } from "./rate-limit";
import { logger } from "./observability";

const TRUST_MS = 30 * 24 * 60 * 60_000;
const FRESH_MS = 5 * 60_000;
const RECOVERY_MS = 10 * 60_000;
const RECOVERY_RESUME_MS = 24 * 60 * 60_000;
const PENDING_RECOVERY_MS = 30 * 60_000;
const PASSWORD_ATTEMPT_RULE = { window: 15 * 60, max: 10 };
type SecurityAccount = {
  generation: number;
  recovery_required: number;
  recovery_started_at: number | null;
  recovery_resume_key_hash: string | null;
  recovery_resume_claim_session_id: string | null;
  recovery_pending_key_hash: string | null;
  recovery_pending_session_id: string | null;
  recovery_pending_until: number | null;
  recovery_pending_repair_at: number | null;
  recovery_origin_session_id: string | null;
  codes_saved: number;
  locked_until: number;
};
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
  const account = await env.DB.prepare(
    "SELECT generation,recovery_required,recovery_started_at,recovery_resume_key_hash,recovery_resume_claim_session_id,recovery_pending_key_hash,recovery_pending_session_id,recovery_pending_until,recovery_pending_repair_at,recovery_origin_session_id,codes_saved,locked_until FROM account_security WHERE user_id=?",
  )
    .bind(userId)
    .first<SecurityAccount>();
  if (!account) throw deny("Sign in again.");
  return account;
}

// One database snapshot owns both the status decision and the proof it returns.
// Expired recovery proof is retained only for password-protected resumption.
async function readSecurity(env: Env, userId: string, sessionId: string | null, includePendingInvite = false) {
  const time = Date.now();
  const pendingInvite = includePendingInvite
    ? `EXISTS(SELECT 1 FROM invites invite JOIN user claimant ON claimant.id=a.user_id
        WHERE invite.claimed_by=a.user_id AND lower(invite.claimed_email)=lower(claimant.email)
          AND invite.used_at IS NULL AND invite.expires_at>?
          AND NOT EXISTS(SELECT 1 FROM workspace_members member
            WHERE member.workspace_id=invite.workspace_id AND member.user_id=a.user_id))`
    : "0";
  const row = await env.DB.prepare(`SELECT a.*,
    ${pendingInvite} pending_invite,
    EXISTS(SELECT 1 FROM twoFactor WHERE userId=a.user_id AND verified=1) totp,
    (SELECT COUNT(*) FROM passkey WHERE userId=a.user_id) passkeys,
    s.method,s.verified_at,s.expires_at,
    (SELECT primary_proof.expires_at FROM slack_primary_factor_proofs primary_proof
      WHERE primary_proof.session_id=live.id AND primary_proof.user_id=a.user_id
        AND primary_proof.expires_at>?) slack_primary_expires_at
    FROM account_security a
    LEFT JOIN session live ON live.id=? AND live.userId=a.user_id AND live.expiresAt>?
    LEFT JOIN session_security s ON s.session_id=live.id AND s.user_id=a.user_id AND s.generation=a.generation
      AND (s.method!='trust' OR EXISTS(SELECT 1 FROM trusted_browsers t
        WHERE t.id=s.trust_id AND t.user_id=a.user_id AND t.generation=a.generation AND t.expires_at>?))
    WHERE a.user_id=?`)
    .bind(...(includePendingInvite ? [time] : []), time, sessionId, new Date(time).toISOString(), time, userId)
    .first<
      SecurityAccount & {
        pending_invite: number;
        totp: number;
        passkeys: number;
        method: Grant["method"] | null;
        verified_at: number | null;
        expires_at: number | null;
        slack_primary_expires_at: number | null;
      }
    >();
  if (!row) throw deny("Sign in again.");
  const proof: Grant | null =
    row.method && row.verified_at !== null && row.expires_at !== null && row.expires_at > time
      ? { method: row.method, verified_at: row.verified_at, expires_at: row.expires_at }
      : null;
  let state: SecurityStatus["state"] = "challenge_required";
  if (row.recovery_required) state = "recovery_required";
  else if (!row.totp && !row.passkeys) state = "enrollment_required";
  else if (proof && proof.method !== "recovery") state = row.codes_saved ? "ready" : "enrollment_required";
  const status: SecurityStatus = {
    serverNow: time,
    state,
    totp: !!row.totp,
    passkeys: row.passkeys,
    codesSaved: !!row.codes_saved,
    pendingInvite: !!row.pending_invite,
    fresh: !!proof && (proof.method === "totp" || proof.method === "passkey") && proof.verified_at > time - FRESH_MS,
    ...(state === "recovery_required"
      ? {
          recoveryCanResume:
            row.recovery_started_at !== null &&
            row.recovery_started_at > time - RECOVERY_RESUME_MS &&
            ((sessionId !== null &&
              ((row.recovery_origin_session_id === sessionId &&
                row.method === "recovery" &&
                row.verified_at !== null) ||
                (row.recovery_pending_session_id === sessionId && proof?.method === "recovery"))) ||
              (row.recovery_resume_key_hash !== null && row.recovery_pending_key_hash === null)),
          recoveryResumeRequiresKey: !(
            sessionId !== null &&
            ((row.recovery_origin_session_id === sessionId && row.method === "recovery" && row.verified_at !== null) ||
              (row.recovery_pending_session_id === sessionId && proof?.method === "recovery"))
          ),
          recoveryKeyAcknowledgmentRequired:
            row.recovery_pending_session_id === sessionId && row.recovery_pending_key_hash !== null,
          recoveryEnrollmentAllowed:
            row.recovery_resume_key_hash !== null &&
            row.recovery_pending_key_hash === null &&
            row.recovery_pending_repair_at === null &&
            proof?.method === "recovery",
        }
      : {}),
    ...(row.slack_primary_expires_at
      ? { slackPrimary: { available: true, expiresAt: row.slack_primary_expires_at } }
      : {}),
  };
  return { account: row, proof, status };
}

export async function requireSecurity(env: Env, userId: string, sessionId: string) {
  const { status, proof } = await readSecurity(env, userId, sessionId);
  if (status.state !== "ready" || !proof)
    throw new HttpError(401, status.state, "Complete account protection to continue.");
  return proof.expires_at;
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
  const security = await readSecurity(env, id.userId, id.sessionId);
  if (!security.status.fresh) throw deny("Verify an authenticator code or passkey again to change security settings.");
  return { ...id, security };
}

async function requireEnrollment(ctx: GenericEndpointContext, env: Env) {
  const id = await requireIdentity(ctx);
  if (!id.sessionId) throw deny();
  const security = await readSecurity(env, id.userId, id.sessionId);
  const { status, account, proof } = security;
  if (account.recovery_required) {
    if (!status.recoveryEnrollmentAllowed)
      throw deny(
        "Resume recovery with fresh proof and save your recovery resume key before restoring account protection.",
      );
  } else if ((status.totp || status.passkeys) && !status.fresh) throw deny();
  const session = await getSessionFromCtx(ctx);
  if (!proof && (!session || session.session.createdAt.getTime() < Date.now() - RECOVERY_MS))
    throw deny("Sign in again to finish enrollment.");
  return { ...id, security };
}

async function attempt(env: Env, userId: string) {
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

async function resetAttempts(env: Env, userId: string, generation: number) {
  return env.DB.prepare("UPDATE account_security SET failed_attempts=0,locked_until=0 WHERE user_id=? AND generation=?")
    .bind(userId, generation)
    .run();
}

async function primaryFactor(ctx: GenericEndpointContext, env: Env, id: Identity) {
  const value: unknown = ctx.body?.password;
  if (typeof value !== "string" || !value) {
    const slack = id.sessionId
      ? await env.DB.prepare(
          `SELECT 1 FROM slack_primary_factor_proofs proof
            JOIN session live ON live.id=proof.session_id AND live.userId=proof.user_id
           WHERE proof.session_id=? AND proof.user_id=? AND proof.expires_at>?
             AND live.expiresAt>?`,
        )
          .bind(id.sessionId, id.userId, Date.now(), new Date().toISOString())
          .first()
      : null;
    if (slack) return;
    throw deny("Enter your password or sign in with Slack again.");
  }
  if (value.length > 1000) throw deny("The password or Slack sign-in is invalid.");
  const accounts = await ctx.context.internalAdapter.findAccounts(id.userId);
  const credential = accounts.find((account) => account.providerId === "credential");
  if (!credential?.password || !(await ctx.context.password.verify({ hash: credential.password, password: value }))) {
    throw deny("The password or Slack sign-in is invalid.");
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
  await resetAttempts(env, userId, generation);
  logger.info("account_security.verified", "account-security", "Account security verification succeeded.", {
    method,
  });
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
export type PasskeyPermit = { credentialId: string; userId: string; sessionId: string; generation: number };
type PolicyContext = {
  notesSecurity?: { userId: string; generation: number };
  notesPasswordRateLimitKey?: string;
  notesPasskeyPermit?: PasskeyPermit;
};
function captureSecurity(ctx: GenericEndpointContext, userId: string, generation: number) {
  (ctx.context as typeof ctx.context & PolicyContext).notesSecurity = { userId, generation };
}

export async function upsertPasskeyRegistrationPermit(env: Env, permit: PasskeyPermit) {
  const permitted = await env.DB.prepare(`INSERT INTO pending_passkeys(credential_id,user_id,session_id,generation)
    SELECT ?,a.user_id,s.id,a.generation FROM account_security a JOIN session s ON s.userId=a.user_id
    WHERE a.user_id=? AND a.generation=? AND s.id=? AND s.expiresAt>?
    ON CONFLICT(credential_id) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,
      generation=excluded.generation RETURNING credential_id`)
    .bind(permit.credentialId, permit.userId, permit.generation, permit.sessionId, new Date().toISOString())
    .first();
  return !!permitted;
}

export async function authorizePasskeyRegistration(ctx: GenericEndpointContext, env: Env, credentialId: string) {
  const id = await requireIdentity(ctx);
  const capture = (ctx.context as typeof ctx.context & PolicyContext).notesSecurity;
  if (!id.sessionId || !capture || capture.userId !== id.userId) throw deny();
  const permit = {
    credentialId,
    userId: id.userId,
    sessionId: id.sessionId,
    generation: capture.generation,
  };
  const permitted = await upsertPasskeyRegistrationPermit(env, permit);
  if (!permitted) throw deny("Security settings changed. Sign in again.");
  (ctx.context as typeof ctx.context & PolicyContext).notesPasskeyPermit = permit;
}

export async function cleanupFailedPasskeyRegistration(env: Env, permit: PasskeyPermit) {
  const current = await env.DB.prepare(`SELECT 1 FROM pending_passkeys candidate
    JOIN account_security account
      ON account.user_id=candidate.user_id AND account.generation=candidate.generation
    JOIN session live ON live.id=candidate.session_id AND live.userId=candidate.user_id
    WHERE candidate.credential_id=? AND candidate.user_id=? AND candidate.session_id=?
      AND candidate.generation=? AND live.expiresAt>?`)
    .bind(permit.credentialId, permit.userId, permit.sessionId, permit.generation, new Date().toISOString())
    .first();
  await env.DB.prepare(
    "DELETE FROM pending_passkeys WHERE credential_id=? AND user_id=? AND session_id=? AND generation=?",
  )
    .bind(permit.credentialId, permit.userId, permit.sessionId, permit.generation)
    .run();
  return { revoked: !current };
}

export function passkeyRegistrationRevokedResponse() {
  const error = deny("Security settings changed. Sign in again.");
  return new Response(JSON.stringify(error.body), {
    status: error.statusCode,
    headers: { "content-type": "application/json" },
  });
}

export async function pruneSecurityState(env: Env) {
  const time = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rateLimit WHERE id IN(
      SELECT id FROM rateLimit WHERE lastRequest<? ORDER BY lastRequest LIMIT 500
    )`).bind(time - 24 * 60 * 60_000),
    env.DB.prepare(`DELETE FROM pending_recovery_codes WHERE code_hash IN(
      SELECT code_hash FROM pending_recovery_codes WHERE expires_at<=? ORDER BY expires_at LIMIT 500
    )`).bind(time),
  ]);
  const repairs = await env.DB.prepare(`SELECT repair.session_id,repair.user_id,repair.generation,
      repair.state,account.recovery_pending_session_id,
      EXISTS (SELECT 1 FROM session_security proof WHERE proof.session_id=repair.session_id
        AND proof.user_id=repair.user_id AND proof.generation=repair.generation
        AND proof.method='recovery') has_recovery_proof
    FROM recovery_session_repairs repair LEFT JOIN account_security account
      ON account.user_id=repair.user_id AND account.generation=repair.generation
    WHERE repair.due_at<=? ORDER BY repair.due_at LIMIT 100`)
    .bind(time)
    .all<{
      session_id: string;
      user_id: string;
      generation: number;
      state: string;
      recovery_pending_session_id: string | null;
      has_recovery_proof: number;
    }>();
  for (const repair of repairs.results) {
    if (
      repair.state === "creating" &&
      (repair.recovery_pending_session_id === repair.session_id || !repair.has_recovery_proof)
    ) {
      // Recheck inside one transaction: an acknowledgment may have completed
      // after the due-row read and must keep its proven session.
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM session WHERE id=? AND userId=? AND
          (EXISTS (SELECT 1 FROM account_security account
            WHERE account.user_id=? AND account.generation=? AND account.recovery_pending_session_id=?)
          OR NOT EXISTS (SELECT 1 FROM session_security proof WHERE proof.session_id=?
            AND proof.user_id=? AND proof.generation=? AND proof.method='recovery'))`).bind(
          repair.session_id,
          repair.user_id,
          repair.user_id,
          repair.generation,
          repair.session_id,
          repair.session_id,
          repair.user_id,
          repair.generation,
        ),
        env.DB.prepare(`UPDATE account_security SET recovery_pending_key_hash=NULL,
          recovery_pending_session_id=NULL,recovery_pending_until=NULL,recovery_pending_repair_at=NULL
          WHERE user_id=? AND generation=? AND recovery_pending_session_id=?
            AND recovery_pending_key_hash IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM session WHERE id=?)`).bind(
          repair.user_id,
          repair.generation,
          repair.session_id,
          repair.session_id,
        ),
      ]);
    } else if (repair.recovery_pending_session_id !== repair.session_id) {
      await env.DB.prepare("DELETE FROM recovery_session_repairs WHERE session_id=?").bind(repair.session_id).run();
    }
  }
  const handoffs = await env.DB.prepare(`SELECT user_id,generation,recovery_pending_session_id,
    recovery_origin_session_id FROM account_security
    WHERE recovery_pending_key_hash IS NOT NULL AND
      (recovery_pending_until<=? OR recovery_pending_repair_at<=?) LIMIT 100`)
    .bind(time, time - 2 * 60_000)
    .all<{
      user_id: string;
      generation: number;
      recovery_pending_session_id: string | null;
      recovery_origin_session_id: string | null;
    }>();
  for (const handoff of handoffs.results) {
    const cleared = await env.DB.prepare(`UPDATE account_security SET recovery_pending_key_hash=NULL,
      recovery_pending_session_id=NULL,recovery_pending_until=NULL,recovery_pending_repair_at=NULL
      WHERE user_id=? AND generation=? AND recovery_pending_key_hash IS NOT NULL
        AND recovery_pending_session_id IS ? AND
        (recovery_pending_until<=? OR recovery_pending_repair_at<=?) RETURNING user_id`)
      .bind(handoff.user_id, handoff.generation, handoff.recovery_pending_session_id, time, time - 2 * 60_000)
      .first();
    if (
      cleared &&
      handoff.recovery_pending_session_id &&
      handoff.recovery_pending_session_id !== handoff.recovery_origin_session_id
    )
      await env.DB.prepare("DELETE FROM session WHERE id=? AND userId=?")
        .bind(handoff.recovery_pending_session_id, handoff.user_id)
        .run();
  }
}

function passwordSource(headers: Headers | undefined) {
  const raw = headers?.get("cf-connecting-ip")?.trim().toLowerCase();
  if (!raw) return "unknown";
  const ipv4 = raw.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255))
    return ipv4.map(Number).join(".");
  if (!raw.includes(":")) return "unknown";
  try {
    const hostname = new URL(`http://[${raw}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : "unknown";
  } catch {
    return "unknown";
  }
}

async function passwordRateLimitKey(email: string, headers: Headers | undefined) {
  return `password-account-v2:${await sha256(JSON.stringify([email, passwordSource(headers)]))}`;
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
            ? (await readSecurity(env, id.userId, id.sessionId, true)).status
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
        const { account, status } = await readSecurity(env, id.userId, id.sessionId);
        if (account.recovery_required || !account.codes_saved || (!status.totp && !status.passkeys)) throw deny();
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
        const { status, account, proof } = id.security;
        if (status.state !== "ready" || !proof) throw deny();
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
        if ((await readSecurity(env, id.userId, id.sessionId)).status.state !== "ready") throw deny();
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
        await primaryFactor(ctx, env, id);
        const secret = Array.from(
          crypto.getRandomValues(new Uint8Array(32)),
          (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte & 31],
        ).join("");
        const encrypted = await symmetricEncrypt({ key: ctx.context.secretConfig, data: secret });
        await env.DB.prepare(`INSERT INTO pending_totp(session_id,user_id,secret,expires_at) VALUES (?,?,?,?)
          ON CONFLICT(session_id) DO UPDATE SET secret=excluded.secret,expires_at=excluded.expires_at`)
          .bind(id.sessionId, id.userId, encrypted, Date.now() + RECOVERY_MS)
          .run();
        await resetAttempts(env, id.userId, id.security.account.generation);
        const user = await ctx.context.internalAdapter.findUserById(id.userId);
        return ctx.json({ totpURI: createOTP(secret, { digits: 6, period: 30 }).url("NoteFlare", user!.email) });
      }),
      confirmTotp: post("/security/confirm-totp", async (ctx) => {
        const id = await requireEnrollment(ctx, env);
        const account = id.security.account;
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
        // Every write shares the pending setup and generation guard; resetting or
        // revoking this session while verification runs makes the whole batch a no-op.
        const guard = `EXISTS(SELECT 1 FROM pending_totp p JOIN account_security a ON a.user_id=p.user_id
          JOIN session live ON live.id=p.session_id AND live.userId=p.user_id
          WHERE p.session_id=? AND a.generation=? AND p.secret=? AND p.expires_at>? AND live.expiresAt>?)`;
        const guardBinds = [id.sessionId, account.generation, pending.secret, Date.now(), new Date().toISOString()];
        const result = await env.DB.batch([
          env.DB.prepare(`INSERT INTO twoFactor(id,userId,secret,backupCodes,verified)
            SELECT ?,?,?,'[]',1 WHERE ${guard}
            ON CONFLICT(userId) DO UPDATE SET secret=excluded.secret,verified=1 RETURNING userId`).bind(
            crypto.randomUUID(),
            id.userId,
            pending.secret,
            ...guardBinds,
          ),
          env.DB.prepare(`UPDATE user SET twoFactorEnabled=1 WHERE id=? AND ${guard}`).bind(id.userId, ...guardBinds),
          env.DB.prepare(
            `UPDATE account_security SET recovery_required=0,recovery_started_at=NULL,
              recovery_resume_key_hash=NULL,recovery_resume_claim_session_id=NULL WHERE user_id=? AND ${guard}`,
          ).bind(id.userId, ...guardBinds),
          env.DB.prepare(`DELETE FROM trusted_browsers WHERE user_id=? AND ${guard}`).bind(id.userId, ...guardBinds),
          env.DB.prepare(`DELETE FROM session WHERE userId=? AND id!=? AND ${guard}`).bind(
            id.userId,
            id.sessionId,
            ...guardBinds,
          ),
          env.DB.prepare(`DELETE FROM pending_totp WHERE session_id=? AND ${guard}`).bind(id.sessionId, ...guardBinds),
        ]);
        if (!result[0]!.results.length) throw deny("Security settings changed or setup expired. Sign in again.");
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
        const expiresAt = Date.now() + PENDING_RECOVERY_MS;
        const fresh = `EXISTS(SELECT 1 FROM account_security a
          JOIN session live ON live.userId=a.user_id
          JOIN session_security proof ON proof.session_id=live.id AND proof.user_id=a.user_id AND proof.generation=a.generation
          WHERE a.user_id=? AND a.generation=? AND live.id=? AND live.expiresAt>?
            AND proof.method IN ('totp','passkey') AND proof.verified_at>? AND proof.expires_at>?)`;
        const freshBinds = [
          id.userId,
          id.security.account.generation,
          id.sessionId,
          new Date().toISOString(),
          Date.now() - FRESH_MS,
          Date.now(),
        ];
        // A replacement remains pending until the exact displayed batch is
        // acknowledged. Existing active codes and private access stay intact.
        const result = await env.DB.batch([
          env.DB.prepare(`DELETE FROM pending_recovery_codes
              WHERE user_id=? AND generation=? AND ${fresh}`).bind(
            id.userId,
            id.security.account.generation,
            ...freshBinds,
          ),
          ...hashes.map((hash) =>
            env.DB.prepare(`INSERT INTO pending_recovery_codes(code_hash,batch_id,user_id,generation,expires_at)
                SELECT ?,?,?,?,? WHERE ${fresh} RETURNING code_hash`).bind(
              hash,
              receipt,
              id.userId,
              id.security.account.generation,
              expiresAt,
              ...freshBinds,
            ),
          ),
        ]);
        if (!result[1]!.results.length) throw deny("Sign in again before generating recovery codes.");
        return ctx.json({ codes, receipt });
      }),
      acknowledgeRecovery: post("/security/acknowledge-codes", async (ctx) => {
        const id = await requireFresh(ctx, env);
        const receipt = field(ctx, "receipt");
        const time = Date.now();
        const generation = id.security.account.generation;
        const validBatch = `EXISTS(SELECT 1 FROM pending_recovery_codes pending
          WHERE pending.user_id=? AND pending.batch_id=? AND pending.generation=? AND pending.expires_at>?
          GROUP BY pending.user_id,pending.batch_id,pending.generation HAVING COUNT(*)=10)`;
        const fresh = `EXISTS(SELECT 1 FROM session live JOIN session_security proof
          ON proof.session_id=live.id AND proof.user_id=live.userId
          WHERE live.id=? AND live.userId=? AND live.expiresAt>? AND proof.generation=?
            AND proof.method IN ('totp','passkey') AND proof.verified_at>? AND proof.expires_at>?)`;
        const guardBinds = [
          id.userId,
          receipt,
          generation,
          time,
          id.sessionId,
          id.userId,
          new Date(time).toISOString(),
          generation,
          time - FRESH_MS,
          time,
        ];
        const result = await env.DB.batch([
          env.DB.prepare(`DELETE FROM recovery_codes WHERE user_id=? AND ${validBatch} AND ${fresh}`).bind(
            id.userId,
            ...guardBinds,
          ),
          env.DB.prepare(`INSERT INTO recovery_codes(code_hash,user_id)
            SELECT pending.code_hash,pending.user_id FROM pending_recovery_codes pending
            WHERE pending.user_id=? AND pending.batch_id=? AND pending.generation=? AND pending.expires_at>?
              AND ${validBatch} AND ${fresh}`).bind(id.userId, receipt, generation, time, ...guardBinds),
          env.DB.prepare(`UPDATE account_security SET codes_saved=1,codes_batch=NULL
              WHERE user_id=? AND generation=? AND ${validBatch} AND ${fresh} RETURNING user_id`).bind(
            id.userId,
            generation,
            ...guardBinds,
          ),
          env.DB.prepare(`DELETE FROM pending_recovery_codes
            WHERE user_id=? AND batch_id=? AND generation=? AND ${validBatch} AND ${fresh}`).bind(
            id.userId,
            receipt,
            generation,
            ...guardBinds,
          ),
        ]);
        if (!result[2]!.results.length)
          throw deny("Those recovery codes were replaced or expired. Generate a new set.");
        return ctx.json({ success: true });
      }),
      acknowledgeRecoveryResumeKey: post("/security/acknowledge-resume-key", async (ctx) => {
        const id = await requireIdentity(ctx);
        if (!id.sessionId) throw deny("Sign in again before saving this key.");
        const hash = await sha256(field(ctx, "resumeKey"));
        const now = Date.now();
        const account = await securityAccount(env, id.userId);
        const saved = await env.DB.prepare(`UPDATE account_security SET
          recovery_resume_key_hash=recovery_pending_key_hash,
          recovery_pending_key_hash=NULL,recovery_pending_session_id=NULL,
          recovery_pending_until=NULL,recovery_pending_repair_at=NULL,
          recovery_resume_claim_session_id=NULL,failed_attempts=0,locked_until=0
          WHERE user_id=? AND generation=? AND recovery_required=1 AND recovery_started_at>?
            AND recovery_pending_session_id=? AND recovery_pending_key_hash=?
            AND recovery_pending_until>? AND recovery_pending_repair_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM security_resets reset WHERE reset.user_id=account_security.user_id)
            AND EXISTS (SELECT 1 FROM session live JOIN session_security proof ON proof.session_id=live.id
              WHERE live.id=? AND live.userId=? AND live.expiresAt>?
                AND proof.user_id=? AND proof.generation=? AND proof.method='recovery' AND proof.expires_at>?)
          RETURNING user_id`)
          .bind(
            id.userId,
            account.generation,
            now - RECOVERY_RESUME_MS,
            id.sessionId,
            hash,
            now,
            id.sessionId,
            id.userId,
            new Date(now).toISOString(),
            id.userId,
            account.generation,
            now,
          )
          .first();
        if (!saved) {
          const current = await securityAccount(env, id.userId);
          if (
            current.recovery_resume_key_hash !== hash ||
            current.recovery_pending_key_hash !== null ||
            !(await env.DB.prepare(`SELECT 1 FROM session_security WHERE session_id=? AND user_id=?
                AND generation=? AND method='recovery'`)
              .bind(id.sessionId, id.userId, current.generation)
              .first())
          )
            throw deny("This recovery key was replaced or expired. Resume recovery again.");
        }
        await env.DB.prepare("DELETE FROM recovery_session_repairs WHERE session_id=? AND user_id=?")
          .bind(id.sessionId, id.userId)
          .run();
        ctx.responseHeaders.set("Cache-Control", "no-store");
        return ctx.json({ success: true });
      }),
      resumeRecovery: post("/security/resume-recovery", async (ctx) => {
        const id = await requireIdentity(ctx);
        const { account, status } = await readSecurity(env, id.userId, id.sessionId);
        if (!status.recoveryCanResume) throw deny("Use a recovery code or operator reset token first.");
        const time = Date.now();
        const original =
          id.sessionId &&
          (account.recovery_origin_session_id === id.sessionId || account.recovery_pending_session_id === id.sessionId)
            ? await env.DB.prepare(`SELECT 1 FROM session_security proof
              WHERE proof.session_id=? AND proof.user_id=? AND proof.generation=?
                AND proof.method='recovery' AND (?=1 OR proof.expires_at>?)`)
                .bind(
                  id.sessionId,
                  id.userId,
                  account.generation,
                  account.recovery_origin_session_id === id.sessionId ? 1 : 0,
                  time,
                )
                .first()
            : null;
        if (account.recovery_pending_key_hash !== null && !original)
          throw deny("Another recovery key is awaiting acknowledgment. Try again after it expires.");
        await attempt(env, id.userId);
        await primaryFactor(ctx, env, id);
        const suppliedKey = ctx.body?.resumeKey;
        const keyHash =
          typeof suppliedKey === "string" && suppliedKey.length <= 1000 ? await sha256(suppliedKey) : null;
        if (!original) {
          if (!keyHash) throw deny("Enter the recovery resume key saved when recovery started.");
          if (account.recovery_resume_key_hash !== keyHash || account.recovery_resume_claim_session_id !== null)
            throw deny("Recovery key expired, used, or revoked.");
        }
        const nextResumeKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const nextKeyHash = await sha256(nextResumeKey);
        // Password sign-in can still be at Better Auth's two-factor challenge.
        // Create an unassured session, then claim the key and grant it together.
        let replacementSession: Awaited<ReturnType<typeof ctx.context.internalAdapter.createSession>> | null = null;
        let cookieSet = false;
        let grantSessionId: string | null = null;
        try {
          if (!id.sessionId) {
            if (!id.challenge) throw deny("Sign in again.");
            const consumed = await ctx.context.internalAdapter.consumeVerificationValue(id.challenge);
            if (!consumed || consumed.value !== id.userId || consumed.expiresAt.getTime() <= time)
              throw deny("Sign in again.");
            replacementSession = await ctx.context.internalAdapter.createSession(id.userId);
            await env.DB.prepare(`INSERT INTO recovery_session_repairs
              (session_id,user_id,generation,state,due_at,created_at) VALUES (?,?,?,'creating',?,?)`)
              .bind(replacementSession.id, id.userId, account.generation, time + 2 * 60_000, time)
              .run();
          }
          grantSessionId = id.sessionId ?? replacementSession!.id;
          // The account timestamp is the absolute deadline across replacement sessions.
          const authenticated = `EXISTS (SELECT 1 FROM session live WHERE live.id=? AND live.userId=? AND live.expiresAt>?)`;
          const claim = env.DB.prepare(`UPDATE account_security SET recovery_resume_claim_session_id=?
          WHERE user_id=? AND generation=? AND recovery_required=1 AND recovery_started_at>?
            AND recovery_resume_key_hash=? AND recovery_resume_claim_session_id IS NULL
            AND recovery_pending_key_hash IS NULL
            AND NOT EXISTS (SELECT 1 FROM security_resets reset WHERE reset.user_id=account_security.user_id)
            AND ${authenticated} RETURNING user_id`).bind(
            grantSessionId,
            id.userId,
            account.generation,
            time - RECOVERY_RESUME_MS,
            keyHash,
            grantSessionId,
            id.userId,
            new Date(time).toISOString(),
          );
          const grant = env.DB.prepare(`INSERT INTO session_security
          (session_id,user_id,generation,verified_at,expires_at,method,trust_id)
          SELECT live.id,a.user_id,a.generation,a.recovery_started_at,MIN(?,a.recovery_started_at+?),'recovery',NULL
            FROM account_security a JOIN session live ON live.userId=a.user_id AND live.id=? AND live.expiresAt>?
           WHERE a.user_id=? AND a.generation=? AND a.recovery_required=1
             AND a.recovery_started_at>? AND a.recovery_pending_key_hash IS NULL
             AND NOT EXISTS (SELECT 1 FROM security_resets reset WHERE reset.user_id=a.user_id)
             AND (EXISTS (SELECT 1 FROM session_security old WHERE old.session_id=live.id AND old.user_id=a.user_id
                    AND old.generation=a.generation AND old.method='recovery')
               OR a.recovery_resume_claim_session_id=live.id)
          ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,verified_at=excluded.verified_at,
            expires_at=excluded.expires_at,method='recovery',trust_id=NULL RETURNING session_id`).bind(
            time + RECOVERY_MS,
            RECOVERY_RESUME_MS,
            grantSessionId,
            new Date(time).toISOString(),
            id.userId,
            account.generation,
            time - RECOVERY_RESUME_MS,
          );
          const rotate = env.DB.prepare(`UPDATE account_security
            SET recovery_pending_key_hash=?, recovery_pending_session_id=?, recovery_pending_until=?,
              recovery_pending_repair_at=?, recovery_resume_claim_session_id=NULL
            WHERE user_id=? AND generation=? AND recovery_required=1 AND recovery_started_at=?
              AND recovery_started_at>? AND recovery_resume_key_hash IS ?
              AND recovery_pending_key_hash IS NULL
              AND ${original ? "1=1" : "recovery_resume_claim_session_id=?"}
              AND NOT EXISTS (SELECT 1 FROM security_resets reset WHERE reset.user_id=account_security.user_id)
              AND EXISTS (SELECT 1 FROM session_security proof WHERE proof.session_id=? AND proof.user_id=?
                AND proof.generation=? AND proof.method='recovery')`).bind(
            nextKeyHash,
            grantSessionId,
            Math.min(time + RECOVERY_MS, (account.recovery_started_at ?? time) + RECOVERY_RESUME_MS),
            time,
            id.userId,
            account.generation,
            account.recovery_started_at,
            time - RECOVERY_RESUME_MS,
            account.recovery_resume_key_hash,
            ...(!original ? [grantSessionId] : []),
            grantSessionId,
            id.userId,
            account.generation,
          );
          const clearAttempts = env.DB.prepare(`UPDATE account_security SET failed_attempts=0,locked_until=0
            WHERE user_id=? AND generation=? AND recovery_pending_key_hash=?
              AND recovery_pending_session_id=?`).bind(id.userId, account.generation, nextKeyHash, grantSessionId);
          const clearOwnPending =
            original && account.recovery_pending_key_hash !== null
              ? [
                  env.DB.prepare(`UPDATE account_security SET recovery_pending_key_hash=NULL,
                    recovery_pending_session_id=NULL,recovery_pending_until=NULL,recovery_pending_repair_at=NULL
                    WHERE user_id=? AND generation=? AND recovery_pending_key_hash=?
                      AND recovery_pending_session_id=? AND EXISTS
                      (SELECT 1 FROM session_security proof WHERE proof.session_id=? AND proof.user_id=?
                        AND proof.generation=? AND proof.method='recovery' AND (?=1 OR proof.expires_at>?))`).bind(
                    id.userId,
                    account.generation,
                    account.recovery_pending_key_hash,
                    grantSessionId,
                    grantSessionId,
                    id.userId,
                    account.generation,
                    account.recovery_origin_session_id === grantSessionId ? 1 : 0,
                    time,
                  ),
                ]
              : [];
          const offset = clearOwnPending.length;
          const result = await env.DB.batch([
            ...clearOwnPending,
            ...(original ? [] : [claim]),
            grant,
            rotate,
            clearAttempts,
          ]);
          if (!original && !result[offset]!.results.length) {
            throw deny("Recovery key expired, used, or revoked.");
          }
          const resumed = result[offset + (original ? 0 : 1)]!.results[0];
          if (!resumed) {
            throw deny("Recovery expired or was revoked. Use a recovery code or operator reset token.");
          }
          if (!result[offset + (original ? 1 : 2)]!.meta.changes) throw deny("Recovery key expired, used, or revoked.");
          const handoff = await env.DB.batch([
            env.DB.prepare(`UPDATE account_security SET recovery_pending_repair_at=NULL
              WHERE user_id=? AND generation=? AND recovery_pending_key_hash=? AND recovery_pending_session_id=?`).bind(
              id.userId,
              account.generation,
              nextKeyHash,
              grantSessionId,
            ),
            ...(replacementSession
              ? [
                  env.DB.prepare(`UPDATE recovery_session_repairs
              SET state='delivered',due_at=? WHERE session_id=? AND user_id=? AND state='creating'`).bind(
                    time + RECOVERY_MS,
                    replacementSession.id,
                    id.userId,
                  ),
                ]
              : []),
          ]);
          if (!handoff[0]!.meta.changes || (replacementSession && !handoff[1]!.meta.changes))
            throw deny("Recovery key was replaced or expired. Resume recovery again.");
          if (replacementSession) {
            const user = await ctx.context.internalAdapter.findUserById(id.userId);
            if (!user) throw deny("Sign in again.");
            await setSessionCookie(ctx, { user, session: replacementSession });
            cookieSet = true;
            expireCookie(ctx, ctx.context.createAuthCookie("two_factor"));
          }
        } catch (error) {
          if (!original && grantSessionId)
            await env.DB.prepare(`UPDATE account_security SET recovery_resume_claim_session_id=NULL
              WHERE user_id=? AND generation=? AND recovery_resume_key_hash=?
                AND recovery_resume_claim_session_id=? AND recovery_pending_key_hash IS NULL`)
              .bind(id.userId, account.generation, keyHash, grantSessionId)
              .run();
          if (replacementSession && !cookieSet) {
            // Restore only this failed claim. A reset, a new recovery, or an expired
            // window must never regain the old key.
            await env.DB.batch([
              env.DB.prepare(`UPDATE account_security SET recovery_pending_key_hash=NULL,
                recovery_pending_session_id=NULL,recovery_pending_until=NULL,
                recovery_pending_repair_at=NULL,recovery_resume_claim_session_id=NULL
                WHERE user_id=? AND generation=?
                AND recovery_required=1 AND recovery_started_at=? AND recovery_started_at>?
                AND recovery_pending_session_id=? AND recovery_pending_key_hash=?
                AND NOT EXISTS (SELECT 1 FROM security_resets reset WHERE reset.user_id=account_security.user_id)`).bind(
                id.userId,
                account.generation,
                account.recovery_started_at,
                Date.now() - RECOVERY_RESUME_MS,
                replacementSession.id,
                nextKeyHash,
              ),
              env.DB.prepare(
                `DELETE FROM session_security WHERE session_id=? AND user_id=? AND method='recovery'`,
              ).bind(replacementSession.id, id.userId),
              env.DB.prepare("DELETE FROM session WHERE id=?").bind(replacementSession.id),
            ]);
          }
          throw error;
        }
        ctx.responseHeaders.set("Cache-Control", "no-store");
        return ctx.json({ success: true, resumeKey: nextResumeKey });
      }),
      recoverSecurity: post("/security/recover", async (ctx) => {
        const id = await requireIdentity(ctx);
        const account = await securityAccount(env, id.userId);
        await attempt(env, id.userId);
        await primaryFactor(ctx, env, id);
        const hash = await sha256(field(ctx, "code"));
        const reset = ctx.body?.reset === true;
        const receipt = crypto.randomUUID();
        const time = Date.now();
        const resumeKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const resumeKeyHash = await sha256(resumeKey);
        const credential = reset
          ? "EXISTS(SELECT 1 FROM security_resets WHERE token_hash=? AND user_id=? AND expires_at>?)"
          : "EXISTS(SELECT 1 FROM recovery_codes WHERE code_hash=? AND user_id=?)";
        const credentialBinds = reset ? [hash, id.userId, time] : [hash, id.userId];
        // Better Auth stores its dates as ISO text in SQLite. Check the live identity
        // and credential together, then use a unique receipt to guard all batch writes.
        const authenticated = id.challenge
          ? "EXISTS(SELECT 1 FROM verification WHERE identifier=? AND value=? AND expiresAt>?)"
          : "EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?)";
        const guard = "EXISTS(SELECT 1 FROM account_security WHERE user_id=? AND codes_batch=?)";
        const result = await env.DB.batch([
          env.DB.prepare(`UPDATE account_security SET generation=generation+1,recovery_required=1,recovery_started_at=?,
            recovery_resume_key_hash=NULL,recovery_resume_claim_session_id=NULL,
            recovery_pending_key_hash=?,recovery_pending_session_id=NULL,
            recovery_pending_until=?,recovery_pending_repair_at=?,recovery_origin_session_id=NULL,
            codes_saved=0,codes_batch=?
            WHERE user_id=? AND generation=? AND ${credential} AND ${authenticated} RETURNING generation`).bind(
            time,
            resumeKeyHash,
            time + RECOVERY_MS,
            time,
            receipt,
            id.userId,
            account.generation,
            ...credentialBinds,
            id.challenge ?? id.sessionId,
            id.userId,
            new Date(time).toISOString(),
          ),
          env.DB.prepare(`DELETE FROM security_resets WHERE token_hash=? AND user_id=? AND ${guard}`).bind(
            hash,
            id.userId,
            id.userId,
            receipt,
          ),
          env.DB.prepare(`DELETE FROM session WHERE userId=? AND ${guard}`).bind(id.userId, id.userId, receipt),
          env.DB.prepare(`DELETE FROM trusted_browsers WHERE user_id=? AND ${guard}`).bind(
            id.userId,
            id.userId,
            receipt,
          ),
          env.DB.prepare(`DELETE FROM pending_recovery_codes WHERE user_id=? AND ${guard}`).bind(
            id.userId,
            id.userId,
            receipt,
          ),
          env.DB.prepare(`DELETE FROM recovery_codes WHERE user_id=? AND ${guard}`).bind(id.userId, id.userId, receipt),
          env.DB.prepare(`DELETE FROM verification WHERE (value=? OR identifier=?) AND ${guard}`).bind(
            id.userId,
            `2fa-attempts-${id.challenge}`,
            id.userId,
            receipt,
          ),
        ]);
        const recovered = result[0]!.results[0] as { generation: number } | undefined;
        if (!recovered)
          throw deny("The recovery credential or sign-in expired, was already used, or was revoked. Sign in again.");
        const originSessionId = await issueSession(
          ctx,
          env,
          { ...id, sessionId: null, challenge: null },
          "recovery",
          recovered.generation,
          time + RECOVERY_MS,
        );
        const handoff = await env.DB.prepare(`UPDATE account_security SET recovery_origin_session_id=?,
          recovery_pending_session_id=?,recovery_pending_repair_at=NULL
          WHERE user_id=? AND generation=? AND recovery_pending_key_hash=? AND recovery_pending_until>?`)
          .bind(originSessionId, originSessionId, id.userId, recovered.generation, resumeKeyHash, Date.now())
          .run();
        if (!handoff.meta.changes) throw deny("Recovery changed while the key was issued. Start recovery again.");
        expireCookie(ctx, ctx.context.createAuthCookie("two_factor"));
        expireCookie(ctx, trustCookie(ctx));
        logger.warn("account_security.recovery.completed", "account-security", "Account recovery completed.", {
          operatorInitiated: reset,
        });
        ctx.responseHeaders.set("Cache-Control", "no-store");
        return ctx.json({ success: true, resumeKey });
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
              // Unverified credential IDs must not consume another account's budget.
              // Public passkey traffic is limited per source by Better Auth.
              captureSecurity(ctx, key.userId, account.generation);
              const current = await identity(ctx);
              if (current && current.userId !== key.userId) throw deny("Use a passkey belonging to this account.");
              return;
            }
            if (ctx.path === "/sign-out") {
              const cookie = ctx.context.createAuthCookie("two_factor");
              const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
              if (challenge)
                await env.DB.prepare("DELETE FROM verification WHERE identifier IN (?,?)")
                  .bind(challenge, `2fa-attempts-${challenge}`)
                  .run();
              expireCookie(ctx, cookie);
            }
            if (ctx.path === "/sign-in/email") {
              const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : null;
              if (email) {
                const key = await passwordRateLimitKey(email, ctx.headers);
                const limit = await consumeFixedWindow(env, key, PASSWORD_ATTEMPT_RULE);
                if (!limit.allowed)
                  throw new APIError("TOO_MANY_REQUESTS", {
                    code: "PASSWORD_RATE_LIMITED",
                    message: "Too many password attempts. Try again in 15 minutes.",
                  });
                (ctx.context as typeof ctx.context & PolicyContext).notesPasswordRateLimitKey = key;
              }
              return;
            }
            const publicPaths = new Set([
              "/sign-up/email",
              "/sign-out",
              "/get-session",
              "/security/status",
              "/passkey/generate-authenticate-options",
              "/passkey/verify-authentication",
              "/sign-in/social",
              "/callback/slack",
            ]);
            if (publicPaths.has(ctx.path)) return;
            const pendingIdentity = await identity(ctx);
            if (pendingIdentity?.sessionId) {
              const account = await securityAccount(env, pendingIdentity.userId);
              if (
                account.recovery_pending_key_hash &&
                account.recovery_pending_session_id === pendingIdentity.sessionId &&
                !["/security/acknowledge-resume-key", "/security/resume-recovery"].includes(ctx.path)
              )
                throw deny("Save your recovery resume key before continuing.");
            }
            if (ctx.path.startsWith("/security/")) return;
            if (ctx.path === "/two-factor/verify-totp") {
              const id = await requireIdentity(ctx);
              const account = await securityAccount(env, id.userId);
              captureSecurity(ctx, id.userId, account.generation);
              await attempt(env, id.userId);
              return;
            }
            if (ctx.path === "/passkey/generate-register-options" || ctx.path === "/passkey/verify-registration") {
              const id = await requireEnrollment(ctx, env);
              captureSecurity(ctx, id.userId, id.security.account.generation);
              return;
            }
            // All other account changes require recent factor proof; sign-in recency alone is insufficient.
            await requireFresh(ctx, env);
          }),
        },
      ],
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const policy = ctx.context as typeof ctx.context & PolicyContext;
            const permit = policy.notesPasskeyPermit;
            if (ctx.context.returned instanceof APIError) {
              if (permit) {
                const { revoked } = await cleanupFailedPasskeyRegistration(env, permit);
                delete policy.notesPasskeyPermit;
                if (ctx.context.returned.statusCode === 500 && revoked) return passkeyRegistrationRevokedResponse();
              }
              return undefined;
            }
            delete policy.notesPasskeyPermit;
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
              await env.DB.prepare(
                `UPDATE account_security SET recovery_required=0,recovery_started_at=NULL,
                  recovery_resume_key_hash=NULL,recovery_resume_claim_session_id=NULL,
                  recovery_pending_key_hash=NULL,recovery_pending_session_id=NULL,
                  recovery_pending_until=NULL,recovery_pending_repair_at=NULL,
                  recovery_origin_session_id=NULL WHERE user_id=? AND generation=?`,
              )
                .bind(id.userId, capture.generation)
                .run();
            }
            if (ctx.path === "/sign-in/email" || ctx.path === "/sign-up/email") {
              const rateLimitKey = policy.notesPasswordRateLimitKey;
              if (rateLimitKey) await clearRateLimit(env, rateLimitKey);
              delete policy.notesPasswordRateLimitKey;
              logger.info(
                "account_security.password_authenticated",
                "account-security",
                "Password accepted; additional verification is required.",
                { outcome: "verification-required" },
              );
            }
            return undefined;
          }),
        },
      ],
    },
  };
}
