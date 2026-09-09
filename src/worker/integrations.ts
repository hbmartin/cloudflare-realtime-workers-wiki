import { sha256Hex } from "../shared/import-integrity";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";

export type IntegrationCapabilities = {
  readContent: boolean;
  insertContent: boolean;
  updateContent: boolean;
  readComments: boolean;
  insertComments: boolean;
  userInformation: "none" | "basic" | "email";
};

export type IntegrationPrincipal = IntegrationCapabilities & {
  integrationId: string;
  workspaceId: string;
  workspaceName: string;
  botUserId: string;
  botName: string;
};

type IntegrationRow = {
  id: string;
  workspace_id: string;
  bot_user_id: string;
  name: string;
  read_content: number;
  insert_content: number;
  update_content: number;
  read_comments: number;
  insert_comments: number;
  user_information: IntegrationCapabilities["userInformation"];
  created_by: string;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
  token_prefix?: string | null;
  token_last_four?: string | null;
  grant_count?: number;
};

export type IntegrationPage = {
  id: string;
  workspace_id: string;
  space_id: string;
  parent_id: string | null;
  kind: "document" | "table" | "diagram";
  position: string;
  title: string;
  icon: string | null;
  content_epoch: number;
  plain_text: string;
  archived_at: number | null;
  created_by: string;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
};

export class IntegrationAuthError extends Error {
  override name = "IntegrationAuthError";
}

function integrationJson(row: IntegrationRow) {
  return {
    id: row.id,
    name: row.name,
    botUserId: row.bot_user_id,
    capabilities: {
      readContent: Boolean(row.read_content),
      insertContent: Boolean(row.insert_content),
      updateContent: Boolean(row.update_content),
      readComments: Boolean(row.read_comments),
      insertComments: Boolean(row.insert_comments),
      userInformation: row.user_information,
    },
    token: row.token_prefix ? { prefix: row.token_prefix, lastFour: row.token_last_four } : null,
    grantCount: row.grant_count ?? 0,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function secret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

async function tokenRecord(integrationId: string, timestamp: number) {
  const value = secret("crn_");
  return {
    id: crypto.randomUUID(),
    value,
    hash: await sha256Hex(value),
    prefix: value.slice(0, 12),
    lastFour: value.slice(-4),
    integrationId,
    timestamp,
  };
}

export async function listIntegrations(env: Env, member: MemberContext) {
  const rows = await env.DB.prepare(
    `SELECT integration.*, token.token_prefix, token.token_last_four,
            (SELECT COUNT(*) FROM integration_grants grant_row WHERE grant_row.integration_id = integration.id) grant_count
       FROM integrations integration
       LEFT JOIN integration_tokens token ON token.integration_id = integration.id AND token.revoked_at IS NULL
      WHERE integration.workspace_id = ? ORDER BY integration.created_at DESC`,
  )
    .bind(member.workspace.id)
    .all<IntegrationRow>();
  return rows.results.map(integrationJson);
}

export async function createIntegration(env: Env, member: MemberContext, name: string) {
  const timestamp = Date.now();
  const integrationId = crypto.randomUUID();
  const botUserId = crypto.randomUUID();
  const token = await tokenRecord(integrationId, timestamp);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, account_type)
       VALUES (?, ?, ?, 1, ?, ?, 'bot')`,
    ).bind(botUserId, name, `${botUserId}@integrations.invalid`, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO integrations
        (id, workspace_id, bot_user_id, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(integrationId, member.workspace.id, botUserId, name, member.user.id, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO integration_tokens
        (id, integration_id, token_hash, token_prefix, token_last_four, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(token.id, integrationId, token.hash, token.prefix, token.lastFour, timestamp),
  ]);
  const row = await env.DB.prepare(
    `SELECT integration.*, token.token_prefix, token.token_last_four, 0 grant_count
       FROM integrations integration JOIN integration_tokens token ON token.integration_id = integration.id
      WHERE integration.id = ?`,
  )
    .bind(integrationId)
    .first<IntegrationRow>();
  if (!row) throw new Error("Created integration could not be read.");
  return { integration: integrationJson(row), token: token.value };
}

async function ownedIntegration(env: Env, member: MemberContext, integrationId: string) {
  const row = await env.DB.prepare(`SELECT * FROM integrations WHERE id = ? AND workspace_id = ?`)
    .bind(integrationId, member.workspace.id)
    .first<IntegrationRow>();
  if (!row) throw new HttpError(404, "integration_not_found", "Integration not found.");
  return row;
}

export async function updateIntegration(
  env: Env,
  member: MemberContext,
  integrationId: string,
  input: Partial<IntegrationCapabilities & { name: string; revoked: boolean }>,
) {
  const existing = await ownedIntegration(env, member, integrationId);
  if (existing.revoked_at) throw new HttpError(409, "integration_revoked", "This integration is revoked.");
  const information = input.userInformation ?? existing.user_information;
  if (!(["none", "basic", "email"] as const).includes(information)) {
    throw new HttpError(422, "invalid_capability", "Choose none, basic, or email user information.");
  }
  const timestamp = Date.now();
  await env.DB.prepare(
    `UPDATE integrations SET name = ?, read_content = ?, insert_content = ?, update_content = ?,
       read_comments = ?, insert_comments = ?, user_information = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      input.name?.trim() || existing.name,
      (input.readContent ?? Boolean(existing.read_content)) ? 1 : 0,
      (input.insertContent ?? Boolean(existing.insert_content)) ? 1 : 0,
      (input.updateContent ?? Boolean(existing.update_content)) ? 1 : 0,
      (input.readComments ?? Boolean(existing.read_comments)) ? 1 : 0,
      (input.insertComments ?? Boolean(existing.insert_comments)) ? 1 : 0,
      information,
      timestamp,
      integrationId,
    )
    .run();
}

export async function rotateIntegrationToken(env: Env, member: MemberContext, integrationId: string) {
  const integration = await ownedIntegration(env, member, integrationId);
  if (integration.revoked_at) throw new HttpError(409, "integration_revoked", "This integration is revoked.");
  const timestamp = Date.now();
  const token = await tokenRecord(integrationId, timestamp);
  await env.DB.batch([
    env.DB.prepare(`UPDATE integration_tokens SET revoked_at = ? WHERE integration_id = ? AND revoked_at IS NULL`).bind(
      timestamp,
      integrationId,
    ),
    env.DB.prepare(
      `INSERT INTO integration_tokens
        (id, integration_id, token_hash, token_prefix, token_last_four, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(token.id, integrationId, token.hash, token.prefix, token.lastFour, timestamp),
    env.DB.prepare(`UPDATE integrations SET updated_at = ? WHERE id = ?`).bind(timestamp, integrationId),
  ]);
  return token.value;
}

export async function revokeIntegration(env: Env, member: MemberContext, integrationId: string) {
  await ownedIntegration(env, member, integrationId);
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE integrations SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(
      timestamp,
      timestamp,
      integrationId,
    ),
    env.DB.prepare(`UPDATE integration_tokens SET revoked_at = ? WHERE integration_id = ? AND revoked_at IS NULL`).bind(
      timestamp,
      integrationId,
    ),
    env.DB.prepare(`DELETE FROM integration_grants WHERE integration_id = ?`).bind(integrationId),
    env.DB.prepare(
      `UPDATE webhook_subscriptions SET status = 'deleted', updated_at = ?
        WHERE integration_id = ? AND status <> 'deleted'`,
    ).bind(timestamp, integrationId),
  ]);
}

export async function integrationGrants(env: Env, member: MemberContext, integrationId: string) {
  await ownedIntegration(env, member, integrationId);
  const rows = await env.DB.prepare(
    `SELECT page.id, page.title FROM integration_grants grant_row
       JOIN pages page ON page.id = grant_row.root_page_id
      WHERE grant_row.integration_id = ? AND page.workspace_id = ? ORDER BY page.title, page.id`,
  )
    .bind(integrationId, member.workspace.id)
    .all<{ id: string; title: string }>();
  return rows.results;
}

export async function replaceIntegrationGrants(
  env: Env,
  member: MemberContext,
  integrationId: string,
  rootPageIds: string[],
) {
  const integration = await ownedIntegration(env, member, integrationId);
  if (integration.revoked_at) throw new HttpError(409, "integration_revoked", "This integration is revoked.");
  if (rootPageIds.length > 100 || new Set(rootPageIds).size !== rootPageIds.length) {
    throw new HttpError(422, "invalid_grants", "Choose up to 100 distinct page roots.");
  }
  if (rootPageIds.length) {
    const valid = await env.DB.prepare(
      `SELECT COUNT(*) count FROM pages
        WHERE workspace_id = ? AND archived_at IS NULL
          AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(member.workspace.id, JSON.stringify(rootPageIds))
      .first<{ count: number }>();
    if (valid?.count !== rootPageIds.length) throw new HttpError(422, "invalid_grants", "A page root is unavailable.");
  }
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM integration_grants WHERE integration_id = ?`).bind(integrationId),
    env.DB.prepare(
      `INSERT INTO integration_grants (integration_id, root_page_id, created_by, created_at)
       SELECT ?, value, ?, ? FROM json_each(?)`,
    ).bind(integrationId, member.user.id, timestamp, JSON.stringify(rootPageIds)),
  ]);
}

export function integrationBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return /^Bearer crn_[A-Za-z0-9_-]{43}$/.test(authorization) ? authorization.slice(7) : null;
}

export async function authenticateIntegration(request: Request, env: Env): Promise<IntegrationPrincipal> {
  const token = integrationBearerToken(request);
  if (!token) throw new IntegrationAuthError();
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT integration.*, workspace.name workspace_name, bot.name bot_name
       FROM integration_tokens token
       JOIN integrations integration ON integration.id = token.integration_id
       JOIN workspaces workspace ON workspace.id = integration.workspace_id
       JOIN user bot ON bot.id = integration.bot_user_id
      WHERE token.token_hash = ? AND token.revoked_at IS NULL AND integration.revoked_at IS NULL`,
  )
    .bind(tokenHash)
    .first<IntegrationRow & { workspace_name: string; bot_name: string }>();
  if (!row) throw new IntegrationAuthError();
  const timestamp = Date.now();
  if (!row.last_used_at || timestamp - row.last_used_at >= 5 * 60_000) {
    await env.DB.prepare(
      `UPDATE integrations SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
    )
      .bind(timestamp, row.id, timestamp - 5 * 60_000)
      .run();
  }
  return {
    integrationId: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    botUserId: row.bot_user_id,
    botName: row.bot_name,
    readContent: Boolean(row.read_content),
    insertContent: Boolean(row.insert_content),
    updateContent: Boolean(row.update_content),
    readComments: Boolean(row.read_comments),
    insertComments: Boolean(row.insert_comments),
    userInformation: row.user_information,
  };
}

export async function pageForIntegration(
  env: Env,
  principal: IntegrationPrincipal,
  pageId: string,
  includeTrash = false,
) {
  const resolved = await internalPageId(env, principal.workspaceId, pageId);
  if (!resolved) return null;
  return env.DB.prepare(
    `WITH RECURSIVE ancestors(id, parent_id) AS (
       SELECT id, parent_id FROM pages WHERE id = ? AND workspace_id = ?
       UNION ALL
       SELECT parent.id, parent.parent_id FROM pages parent
         JOIN ancestors child ON parent.id = child.parent_id WHERE parent.workspace_id = ?
     )
     SELECT page.* FROM pages page WHERE page.id = ? AND page.workspace_id = ?
       AND page.import_job_id IS NULL ${includeTrash ? "" : "AND page.archived_at IS NULL"}
       AND EXISTS (
         SELECT 1 FROM integration_grants grant_row
           JOIN pages grant_page ON grant_page.id = grant_row.root_page_id AND grant_page.archived_at IS NULL
           JOIN ancestors ON ancestors.id = grant_row.root_page_id
          WHERE grant_row.integration_id = ?
       )`,
  )
    .bind(
      resolved,
      principal.workspaceId,
      principal.workspaceId,
      resolved,
      principal.workspaceId,
      principal.integrationId,
    )
    .first<IntegrationPage>();
}

export async function publicPageId(env: Env, pageId: string) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pageId)) {
    return pageId.toLowerCase();
  }
  const existing = await env.DB.prepare(`SELECT id FROM api_page_ids WHERE page_id = ?`)
    .bind(pageId)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO api_page_ids (id, page_id, created_at) VALUES (?, ?, ?)`)
    .bind(id, pageId, Date.now())
    .run();
  return (await env.DB.prepare(`SELECT id FROM api_page_ids WHERE page_id = ?`).bind(pageId).first<{ id: string }>())!
    .id;
}

async function internalPageId(env: Env, workspaceId: string, id: string) {
  const row = await env.DB.prepare(
    `SELECT page.id FROM pages page LEFT JOIN api_page_ids alias ON alias.page_id = page.id
      WHERE page.workspace_id = ? AND (page.id = ? OR alias.id = ?)`,
  )
    .bind(workspaceId, id, id)
    .first<{ id: string }>();
  return row?.id ?? null;
}
