import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { authorizePasskeyRegistration, mandatorySecurity, requireSecurity } from "./security";
import type { MemberContext } from "./env";
import type { Env } from "./env";
import { HttpError } from "./http";

export function createAuth(env: Env, allowRegistration = false) {
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    appName: "Realtime Notes",
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      // Per-source, per-endpoint limits allow a team behind one NAT to sign in.
      // Password-proven TOTP/recovery attempts also have a persistent account budget.
      customStorage: {
        // Fixed buckets: continuous low-volume traffic must not accumulate forever.
        consume: async (key, rule) => {
          const time = Date.now();
          const windowMs = rule.window * 1000;
          const start = Math.floor(time / windowMs) * windowMs;
          const result = await env.DB.prepare(`INSERT INTO rateLimit(id,key,count,lastRequest) VALUES (?,?,1,?)
            ON CONFLICT(key) DO UPDATE SET
              count=CASE WHEN lastRequest!=excluded.lastRequest THEN 1 ELSE count+1 END,
              lastRequest=excluded.lastRequest
            WHERE lastRequest!=excluded.lastRequest OR count<? RETURNING count`)
            .bind(crypto.randomUUID(), key, start, rule.max)
            .first<{ count: number }>();
          if (result?.count === 1)
            await env.DB.prepare("DELETE FROM rateLimit WHERE lastRequest<?")
              .bind(time - 24 * 60 * 60_000)
              .run();
          return {
            allowed: !!result,
            retryAfter: result ? null : Math.max(1, Math.ceil((start + windowMs - time) / 1000)),
          };
        },
      },
      customRules: {
        "/sign-in/*": { window: 60, max: 60 },
        "/sign-up/*": { window: 60, max: 30 },
        "/two-factor/*": { window: 60, max: 60 },
        "/passkey/verify-authentication": { window: 60, max: 60 },
      },
    },
    session: { cookieCache: { enabled: false } },
    plugins: [
      twoFactor(),
      passkey({
        rpID: new URL(env.BETTER_AUTH_URL).hostname,
        rpName: "Realtime Notes",
        origin: new URL(env.BETTER_AUTH_URL).origin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          afterVerification: async ({ ctx, verification }) => {
            if (!verification.registrationInfo?.userVerified) {
              throw new APIError("FORBIDDEN", {
                code: "USER_VERIFICATION_REQUIRED",
                message: "Verify with your device PIN or biometrics.",
              });
            }
            await authorizePasskeyRegistration(ctx, env, verification.registrationInfo.credential.id);
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) {
              throw new APIError("FORBIDDEN", {
                code: "USER_VERIFICATION_REQUIRED",
                message: "Verify with your device PIN or biometrics.",
              });
            }
          },
        },
      }),
      mandatorySecurity(env),
    ],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowRegistration,
      minPasswordLength: 8,
    },
    telemetry: { enabled: false },
  });
}

async function getMember(request: Request, env: Env): Promise<MemberContext | null> {
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) return null;
  const assuranceExpiresAt = await requireSecurity(env, session.user.id, session.session.id);

  const row = await env.DB.prepare(
    `SELECT w.id workspace_id, w.name workspace_name, w.location_hint, wm.role
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      LIMIT 1`,
  )
    .bind(session.user.id)
    .first<{
      workspace_id: string;
      workspace_name: string;
      location_hint: string | null;
      role: MemberContext["role"];
    }>();

  if (!row)
    throw new HttpError(
      401,
      "workspace_required",
      "This account has no workspace access. Open an invite or contact the workspace owner.",
    );
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    session: {
      id: session.session.id,
      expiresAt: new Date(Math.min(session.session.expiresAt.getTime(), assuranceExpiresAt)),
    },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      locationHint: row.location_hint,
    },
    role: row.role,
  };
}

export async function requireMember(request: Request, env: Env) {
  const member = await getMember(request, env);
  if (!member) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  return member;
}

export function requireEditor(member: MemberContext) {
  if (member.role === "viewer") {
    throw new HttpError(403, "read_only", "Your workspace role is read-only.");
  }
}

export function requireOwner(member: MemberContext) {
  if (member.role !== "owner") {
    throw new HttpError(403, "owner_required", "Only a workspace owner can do that.");
  }
}
