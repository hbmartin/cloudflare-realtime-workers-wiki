import { betterAuth } from "better-auth";
import type { GenericEndpointContext } from "@better-auth/core";
import { passkey } from "@better-auth/passkey";
import {
  addOAuthServerContext,
  APIError,
  createAuthMiddleware,
  getOAuthState,
  getSessionFromCtx,
} from "better-auth/api";
import { genericOAuth, twoFactor } from "better-auth/plugins";
import { authorizePasskeyRegistration, mandatorySecurity, requireSecurity } from "./security";
import type { MemberContext } from "./env";
import type { Env } from "./env";
import { HttpError } from "./http";
import { consumeFixedWindow } from "./rate-limit";
import { recordVerifiedSlackIdentity, validateSlackIdentity, type VerifiedSlackIdentity } from "./slack";

type SlackInviteContext = {
  inviteId: string;
  reservationToken: string;
  workspaceId: string;
  teamId: string;
};

type SlackAuthPolicyContext = {
  notesSlackIdentity?: VerifiedSlackIdentity;
  notesSlackInvite?: SlackInviteContext;
  notesSlackInviteClaimed?: boolean;
};

function slackInviteContext(value: unknown): SlackInviteContext | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.inviteId !== "string" ||
    typeof source.reservationToken !== "string" ||
    typeof source.workspaceId !== "string" ||
    typeof source.teamId !== "string"
  ) {
    return null;
  }
  return {
    inviteId: source.inviteId,
    reservationToken: source.reservationToken,
    workspaceId: source.workspaceId,
    teamId: source.teamId,
  };
}

async function trustedSlackInvite() {
  return slackInviteContext((await getOAuthState())?.serverContext?.slackInvite);
}

async function claimSlackInvite(env: Env, userId: string, invite: SlackInviteContext) {
  const user = await env.DB.prepare(`SELECT email FROM user WHERE id = ?`).bind(userId).first<{ email: string }>();
  if (!user) throw new APIError("UNAUTHORIZED", { code: "SLACK_IDENTITY_INVALID", message: "Sign in again." });
  const claimed = await env.DB.prepare(
    `UPDATE invites SET claimed_email = ?, claimed_by = ?, claim_token = NULL, claim_expires_at = expires_at
      WHERE id = ? AND workspace_id = ? AND claim_token = ? AND claimed_by IS NULL
        AND used_at IS NULL AND expires_at > ? AND claim_expires_at > ? RETURNING id`,
  )
    .bind(
      user.email.toLowerCase(),
      userId,
      invite.inviteId,
      invite.workspaceId,
      invite.reservationToken,
      Date.now(),
      Date.now(),
    )
    .first();
  if (!claimed) {
    throw new APIError("CONFLICT", {
      code: "INVITE_RESERVATION_EXPIRED",
      message: "The invitation reservation expired. Open the invitation again.",
    });
  }
  await env.DB.prepare(`DELETE FROM invites WHERE workspace_id = ? AND id <> ? AND claimed_by = ? AND used_at IS NULL`)
    .bind(invite.workspaceId, invite.inviteId, userId)
    .run();
}

async function finishSlackAuthentication(env: Env, ctx: GenericEndpointContext, userId: string, sessionId: string) {
  const policy = ctx.context as typeof ctx.context & SlackAuthPolicyContext;
  const identity = policy.notesSlackIdentity;
  if (!identity) return;
  const account = await env.DB.prepare(
    `SELECT id FROM account WHERE providerId = 'slack' AND accountId = ? AND userId = ?`,
  )
    .bind(identity.accountSubject, userId)
    .first<{ id: string }>();
  if (!account) {
    throw new APIError("UNAUTHORIZED", { code: "SLACK_IDENTITY_INVALID", message: "Slack identity linking failed." });
  }
  await recordVerifiedSlackIdentity(env, userId, sessionId, account.id, identity);
  const invite = policy.notesSlackInvite ?? (await trustedSlackInvite());
  if (invite) {
    await claimSlackInvite(env, userId, invite);
    policy.notesSlackInviteClaimed = true;
  }
}

export function createAuth(env: Env, allowRegistration = false) {
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    appName: "NoteFlare",
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
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: ["slack"],
        allowDifferentEmails: true,
      },
    },
    user: {
      validateUserInfo: async ({ source }, ctx) => {
        if (source.oauth?.providerId !== "slack") return undefined;
        const profile = source.oauth.profile;
        if (!profile) return { error: "slack_identity_invalid", errorDescription: "Slack identity is unavailable." };
        const state = await getOAuthState();
        const invite = slackInviteContext(state?.serverContext?.slackInvite);
        if (source.action === "create-user" && !invite) {
          return { error: "registration_closed", errorDescription: "Open a valid invitation to create an account." };
        }
        const linkedUserId = typeof state?.link?.userId === "string" ? state.link.userId : null;
        try {
          const identity = await validateSlackIdentity(env, profile, {
            ...(invite ? { workspaceId: invite.workspaceId, teamId: invite.teamId } : {}),
            ...(linkedUserId ? { memberUserId: linkedUserId } : {}),
          });
          const existingLink = await env.DB.prepare(
            `SELECT user_id FROM slack_user_links
              WHERE installation_id = ? AND slack_user_id = ?`,
          )
            .bind(identity.installationId, identity.slackUserId)
            .first<{ user_id: string }>();
          if (
            (source.action === "create-user" && existingLink) ||
            (source.action === "link-account" && existingLink && existingLink.user_id !== linkedUserId)
          ) {
            return {
              error: "account_not_linked",
              errorDescription: "Sign in normally, then connect Slack from Settings.",
            };
          }
          const policy = ctx.context as typeof ctx.context & SlackAuthPolicyContext;
          policy.notesSlackIdentity = identity;
          if (invite) policy.notesSlackInvite = invite;
        } catch (error) {
          if (error instanceof HttpError) return { error: error.code, errorDescription: error.message };
          return {
            error: "slack_unavailable",
            errorDescription: "Slack identity validation is temporarily unavailable.",
          };
        }
        return undefined;
      },
    },
    databaseHooks: {
      account: {
        create: {
          after: async (account, ctx) => {
            if (!ctx || account.providerId !== "slack") return;
            const policy = ctx.context as typeof ctx.context & SlackAuthPolicyContext;
            if (!policy.notesSlackIdentity || account.accountId !== policy.notesSlackIdentity.accountSubject) return;
            const current = await getSessionFromCtx(ctx, { disableRefresh: true });
            if (current?.user.id === account.userId) {
              await finishSlackAuthentication(env, ctx, account.userId, current.session.id);
            }
          },
        },
      },
      session: {
        create: {
          after: async (session, ctx) => {
            if (!ctx) return;
            await finishSlackAuthentication(env, ctx, session.userId, session.id);
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/social" || ctx.body?.provider !== "slack" || ctx.body?.requestSignUp !== true) {
          return;
        }
        const inviteId: unknown = ctx.body?.additionalData?.slackInviteId;
        const reservationToken: unknown = ctx.body?.additionalData?.slackReservationToken;
        if (typeof inviteId !== "string" || typeof reservationToken !== "string") {
          throw new APIError("FORBIDDEN", {
            code: "INVITE_REQUIRED",
            message: "Open a valid invitation to create an account with Slack.",
          });
        }
        const reservation = await env.DB.prepare(
          `SELECT invite.workspace_id, installation.team_id
             FROM invites invite
             JOIN slack_installations installation ON installation.workspace_id = invite.workspace_id
            WHERE invite.id = ? AND invite.claim_token = ? AND invite.claimed_by IS NULL
              AND invite.used_at IS NULL AND invite.expires_at > ? AND invite.claim_expires_at > ?
              AND installation.disconnected_at IS NULL`,
        )
          .bind(inviteId, reservationToken, Date.now(), Date.now())
          .first<{ workspace_id: string; team_id: string }>();
        if (!reservation) {
          throw new APIError("FORBIDDEN", {
            code: "INVITE_RESERVATION_EXPIRED",
            message: "The invitation reservation expired. Open the invitation again.",
          });
        }
        await addOAuthServerContext({
          slackInvite: {
            inviteId,
            reservationToken,
            workspaceId: reservation.workspace_id,
            teamId: reservation.team_id,
          } satisfies SlackInviteContext,
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/callback/slack") return;
        const policy = ctx.context as typeof ctx.context & SlackAuthPolicyContext;
        if (policy.notesSlackInviteClaimed) return;
        const invite = policy.notesSlackInvite ?? (await trustedSlackInvite());
        if (!invite) return;
        await env.DB.prepare(
          `UPDATE invites SET claimed_email = NULL, claim_token = NULL, claim_expires_at = NULL
            WHERE id = ? AND workspace_id = ? AND claim_token = ? AND claimed_by IS NULL AND used_at IS NULL`,
        )
          .bind(invite.inviteId, invite.workspaceId, invite.reservationToken)
          .run();
      }),
    },
    plugins: [
      ...(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET
        ? [
            genericOAuth({
              config: [
                {
                  providerId: "slack",
                  name: "Slack",
                  discoveryUrl: "https://slack.com/.well-known/openid-configuration",
                  requireIdTokenVerification: true,
                  clientId: env.SLACK_CLIENT_ID,
                  clientSecret: env.SLACK_CLIENT_SECRET,
                  scopes: ["openid", "profile", "email"],
                  pkce: true,
                  disableImplicitSignUp: true,
                  disableProviderLogout: true,
                  accountSubject: ({ profile }) => {
                    const teamId = profile["https://slack.com/team_id"];
                    const userId = profile["https://slack.com/user_id"];
                    return typeof teamId === "string" && typeof userId === "string" ? `${teamId}:${userId}` : "";
                  },
                  mapProfileToUser: (profile) => ({
                    name: typeof profile.name === "string" ? profile.name : "Slack member",
                    email: typeof profile.email === "string" ? profile.email : "",
                    emailVerified: profile.email_verified === true,
                    ...(typeof profile.picture === "string" ? { image: profile.picture } : {}),
                  }),
                },
              ],
            }),
          ]
        : []),
      twoFactor(),
      passkey({
        rpID: new URL(env.BETTER_AUTH_URL).hostname,
        rpName: "NoteFlare",
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
