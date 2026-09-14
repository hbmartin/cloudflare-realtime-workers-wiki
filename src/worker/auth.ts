import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { authorizePasskeyRegistration, mandatorySecurity, requireSecurity } from "./security";
import type { MemberContext } from "./env";
import type { Env } from "./env";
import { HttpError } from "./http";
import { consumeFixedWindow } from "./rate-limit";

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
      customStorage: { consume: (key, rule) => consumeFixedWindow(env, key, rule) },
      customRules: {
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
