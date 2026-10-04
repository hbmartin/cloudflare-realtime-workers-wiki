import type { Env } from "./env";
import { HttpError } from "./http";
import { freshSecurityAuthorization, freshSecurityGuard, type FreshSecurityAuthorization } from "./security";
import type { VerifiedSlackIdentity } from "./slack";

export type SlackLinkAuthorization = FreshSecurityAuthorization & {
  bindings: {
    installation_id: string;
    slack_user_id: string;
    better_auth_account_id: string | null;
    verified_at: number | null;
    linked_at: number;
    security_generation: number | null;
  }[];
};

export const SLACK_PRODUCT_SESSION_ACCESS_SQL = `EXISTS(SELECT 1 FROM slack_authorized_user_links link
  WHERE link.installation_id=product_session.installation_id AND link.installation_generation=product_session.generation
    AND link.slack_user_id=product_session.slack_user_id AND link.migration_state='verified'
    AND link.verification_method='slack_openid'
    AND link.user_id=json_extract(product_session.identity_json,'$.userId')
    AND link.better_auth_account_id=json_extract(product_session.identity_json,'$.accountId')
    AND link.verified_at=json_extract(product_session.identity_json,'$.verifiedAt'))`;

export function slackCaptureAccessSql(capture: string) {
  return `EXISTS(SELECT 1 FROM slack_product_sessions product_session
    WHERE product_session.capture_id=${capture}.id AND product_session.installation_id=${capture}.installation_id
      AND product_session.generation=${capture}.installation_generation
      AND json_extract(product_session.identity_json,'$.userId')=${capture}.requested_by
      AND product_session.id=(SELECT latest.id FROM slack_product_sessions latest
        WHERE latest.capture_id=${capture}.id AND latest.installation_id=${capture}.installation_id ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)
      AND ${SLACK_PRODUCT_SESSION_ACCESS_SQL})`;
}

// Recheck the captured grant after token preparation, immediately before Slack dispatch.
export function slackAccessAuthorization(
  env: Env,
  installation: { id: string; generation: number },
  identity: {
    userId: string;
    slackUserId?: string;
    accountId?: string | null;
    verifiedAt?: number | null;
    linkedAt?: number;
    securityGeneration?: number;
  },
  createdAt?: number,
) {
  const fields = [
    ["slack_user_id", identity.slackUserId],
    ["better_auth_account_id", identity.accountId],
    ["verified_at", identity.verifiedAt],
    ["linked_at", identity.linkedAt],
    ["security_generation", identity.securityGeneration],
  ] as const;
  const snapshot = fields.filter(([, value]) => value !== undefined);
  return async () => {
    const allowed =
      await env.DB.prepare(`SELECT 1 FROM slack_authorized_user_links link WHERE installation_id=? AND installation_generation=? AND user_id=?
      ${snapshot.map(([field]) => `AND ${field} IS ?`).join(" ")} ${createdAt === undefined ? "" : "AND coalesce(verified_at,linked_at)<=?"}`)
        .bind(
          installation.id,
          installation.generation,
          identity.userId,
          ...snapshot.map(([, value]) => value),
          ...(createdAt === undefined ? [] : [createdAt]),
        )
        .first();
    if (!allowed)
      throw new HttpError(
        403,
        "slack_identity_required",
        "Slack access changed. Verify your account protection and reconnect Slack in Settings.",
      );
  };
}

export async function authorizeSlackLink(env: Env, userId: string, sessionId: string): Promise<SlackLinkAuthorization> {
  const authorization = await freshSecurityAuthorization(env, userId, sessionId);
  const bindings =
    await env.DB.prepare(`SELECT installation_id,slack_user_id,better_auth_account_id,verified_at,linked_at,security_generation
    FROM slack_user_links WHERE user_id=?`)
      .bind(userId)
      .all<SlackLinkAuthorization["bindings"][number]>();
  return { ...authorization, bindings: bindings.results };
}

export async function checkSlackLinkAuthorization(
  env: Env,
  authorization: SlackLinkAuthorization,
  userId: string,
  sessionId: string,
) {
  const current = await freshSecurityAuthorization(env, userId, sessionId);
  if (
    authorization.userId !== userId ||
    authorization.sessionId !== sessionId ||
    authorization.generation !== current.generation ||
    authorization.expiresAt <= Date.now()
  )
    throw new HttpError(
      403,
      "SECURITY_REQUIRED",
      "Slack authorization expired. Verify your account protection and connect Slack again.",
    );
}

export async function recordVerifiedSlackIdentity(
  env: Env,
  userId: string,
  sessionId: string,
  accountId: string,
  identity: VerifiedSlackIdentity,
  authorization?: SlackLinkAuthorization,
) {
  const permit = authorization ?? (await authorizeSlackLink(env, userId, sessionId));
  if (permit.userId !== userId || permit.sessionId !== sessionId)
    throw new HttpError(403, "SECURITY_REQUIRED", "Sign in again.");
  const guard = freshSecurityGuard(permit);
  const prior = permit.bindings.find((binding) => binding.installation_id === identity.installationId);
  const timestamp = Date.now();
  const result = await env.DB.prepare(`INSERT INTO slack_user_links
    (installation_id,user_id,slack_user_id,linked_at,better_auth_account_id,verification_method,verified_at,migration_state,installation_generation,security_generation)
    SELECT ?,?,?,?,?, 'slack_openid',?,'verified',generation,? FROM slack_installations
    WHERE id=? AND generation=? AND disconnected_at IS NULL AND ${guard.sql}
      AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=slack_installations.workspace_id AND user_id=?)
      AND EXISTS(SELECT 1 FROM account WHERE id=? AND userId=? AND providerId='slack' AND accountId=?)
      AND ((?=0 AND NOT EXISTS(SELECT 1 FROM slack_user_links WHERE installation_id=? AND user_id=?))
        OR EXISTS(SELECT 1 FROM slack_user_links WHERE installation_id=? AND user_id=? AND slack_user_id=?
          AND better_auth_account_id IS ? AND verified_at IS ? AND linked_at=? AND security_generation IS ?))
    ON CONFLICT(installation_id,user_id) DO UPDATE SET
      slack_user_id=excluded.slack_user_id,better_auth_account_id=excluded.better_auth_account_id,
      verification_method='slack_openid',migration_state='verified',linked_at=excluded.linked_at,
      verified_at=CASE WHEN slack_user_links.slack_user_id=excluded.slack_user_id
        AND slack_user_links.better_auth_account_id=excluded.better_auth_account_id
        AND slack_user_links.installation_generation=excluded.installation_generation
        AND slack_user_links.security_generation=excluded.security_generation
        AND slack_user_links.migration_state='verified' THEN slack_user_links.verified_at ELSE excluded.verified_at END,
      installation_generation=excluded.installation_generation,security_generation=excluded.security_generation`)
    .bind(
      identity.installationId,
      userId,
      identity.slackUserId,
      timestamp,
      accountId,
      timestamp,
      permit.generation,
      identity.installationId,
      identity.installationGeneration,
      ...guard.binds,
      userId,
      accountId,
      userId,
      identity.accountSubject,
      prior ? 1 : 0,
      identity.installationId,
      userId,
      identity.installationId,
      userId,
      prior?.slack_user_id ?? "",
      prior?.better_auth_account_id ?? null,
      prior?.verified_at ?? null,
      prior?.linked_at ?? 0,
      prior?.security_generation ?? null,
    )
    .run();
  if (!result.meta.changes)
    throw new HttpError(
      409,
      "slack_link_changed",
      "Slack authorization changed. Verify your account protection and connect Slack again.",
    );
}

export async function recordSlackPrimaryFactorProof(
  env: Env,
  userId: string,
  sessionId: string,
  accountId: string,
  identity: VerifiedSlackIdentity,
  source: "sign_in" | "sign_up",
) {
  const timestamp = Date.now(),
    expiresAt = timestamp + 10 * 60_000;
  const result = await env.DB.prepare(`INSERT INTO slack_primary_factor_proofs
    (session_id,user_id,account_id,team_id,slack_user_id,verified_at,expires_at,security_generation,authentication_source)
    SELECT ?,?,?,?,?,?,?,security.generation,? FROM account_security security
    WHERE security.user_id=? AND EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?)
      AND EXISTS(SELECT 1 FROM account WHERE id=? AND userId=? AND providerId='slack' AND accountId=?)
      AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL)
    ON CONFLICT(session_id) DO UPDATE SET account_id=excluded.account_id,team_id=excluded.team_id,
      slack_user_id=excluded.slack_user_id,verified_at=excluded.verified_at,expires_at=excluded.expires_at,
      security_generation=excluded.security_generation,authentication_source=excluded.authentication_source`)
    .bind(
      sessionId,
      userId,
      accountId,
      identity.teamId,
      identity.slackUserId,
      timestamp,
      expiresAt,
      source,
      userId,
      sessionId,
      userId,
      new Date(timestamp).toISOString(),
      accountId,
      userId,
      identity.accountSubject,
      identity.installationId,
      identity.installationGeneration,
    )
    .run();
  if (!result.meta.changes) throw new HttpError(401, "slack_identity_invalid", "Slack sign-in expired. Sign in again.");
  return { expiresAt };
}

export async function disconnectSlackIdentity(env: Env, userId: string, sessionId: string, workspaceId: string) {
  const permit = await freshSecurityAuthorization(env, userId, sessionId),
    guard = freshSecurityGuard(permit);
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM slack_user_links WHERE user_id=? AND installation_id IN
      (SELECT id FROM slack_installations WHERE workspace_id=?) AND ${guard.sql}`).bind(
      userId,
      workspaceId,
      ...guard.binds,
    ),
    env.DB.prepare(`DELETE FROM slack_primary_factor_proofs WHERE user_id=? AND ${guard.sql}`).bind(
      userId,
      ...guard.binds,
    ),
  ]);
  return results[0]!.meta.changes;
}
