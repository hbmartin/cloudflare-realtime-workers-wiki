import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import { Hono } from "hono";
import { routePartykitRequest } from "partyserver";
import { createAuth, getMember, requireEditor, requireMember, requireOwner } from "./auth";
import { processDeletionJob, processDueDeletionJobs } from "./cleanup";
import { Document } from "./document";
import type { Env, MemberContext } from "./env";
import {
  HttpError,
  assertSameOrigin,
  attachmentDisposition,
  errorResponse,
  locationHint,
  normalizeFilename,
  now,
  sha256,
} from "./http";
import { columnType, nullableId, object, pageKind, role, text } from "../shared/validation";
import type { Page, WorkspaceEvent } from "../shared/types";
import { compareBinaryText } from "../shared/tree-model";
import { normalizeR2Range } from "./r2";
import { broadcastWorkspaceEvent, WorkspaceEvents } from "./workspace-events";

const app = new Hono<{ Bindings: Env }>();
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DELETION_TARGET_BATCH_SIZE = 50;
const UNSAFE_MIME_TYPES = new Set([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "text/javascript",
]);
const UNSAFE_FILE_EXTENSIONS = new Set([".html", ".htm", ".svg", ".js", ".mjs", ".cjs"]);

type PageRow = {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: "document" | "table";
  position: string;
  title: string;
  icon: string | null;
  revision: number;
  content_epoch: number;
  plain_text: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

function pageJson(row: PageRow): Page {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    kind: row.kind,
    position: row.position,
    title: row.title,
    icon: row.icon,
    revision: row.revision,
    contentEpoch: row.content_epoch,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sendWorkspaceEvent(
  c: { env: Env; executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  workspaceId: string,
  event: WorkspaceEvent,
) {
  c.executionCtx.waitUntil(
    broadcastWorkspaceEvent(c.env, workspaceId, event).catch((error) => {
      console.error("Failed to broadcast workspace event", error);
    }),
  );
}

function defaultLocation(request: Request, override?: string) {
  if (locationHint(override)) return override!;
  const continent = String(request.cf?.continent ?? "");
  const map: Record<string, DurableObjectLocationHint> = {
    AF: "afr", AN: "sam", AS: "apac", EU: "weur", NA: "wnam", OC: "oc", SA: "sam",
  };
  return map[continent] ?? "wnam";
}

async function jsonBody(request: Request) {
  try {
    return object(await request.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Send a valid JSON request body.");
  }
}

async function authEmail(
  env: Env,
  request: Request,
  path: "/api/auth/sign-up/email" | "/api/auth/sign-in/email",
  body: { name?: string; email: string; password: string },
) {
  const url = new URL(path, env.BETTER_AUTH_URL);
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", new URL(env.BETTER_AUTH_URL).origin);
  const response = await createAuth(env).handler(new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
  if (!response.ok) return { response, user: null };
  const payload = await response.clone().json<{ user?: { id: string } }>();
  if (!payload.user) throw new HttpError(500, "signup_failed", "The account was created without a user record.");
  return { response, user: payload.user };
}

async function signUp(env: Env, request: Request, body: { name: string; email: string; password: string }) {
  return authEmail(env, request, "/api/auth/sign-up/email", body);
}

async function pageForMember(env: Env, member: MemberContext, pageId: string, includeArchived = false) {
  const row = await env.DB.prepare(
    `SELECT * FROM pages WHERE id = ? AND workspace_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}`,
  ).bind(pageId, member.workspace.id).first<PageRow>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  return row;
}

function leaseGuards() {
  return `EXISTS (
    SELECT 1 FROM table_state s JOIN table_leases l ON l.page_id = s.page_id
     WHERE s.page_id = ? AND s.revision = ? AND l.token_hash = ?
       AND l.holder_session_id = ? AND l.expires_at > ?
  )`;
}

async function leaseInputs(request: Request, member: MemberContext) {
  const body = await jsonBody(request);
  const leaseToken = text(body.leaseToken, "leaseToken", 200);
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new HttpError(422, "invalid_revision", "expectedRevision must be a positive integer.");
  }
  return { body, expectedRevision, tokenHash: await sha256(leaseToken), sessionId: member.session.id };
}

app.onError((error, c) => errorResponse(c, error));

app.get("/api/install", async (c) => {
  const state = await c.env.DB.prepare(`SELECT 1 initialized FROM install_state WHERE id = 1`).first();
  return c.json({ initialized: Boolean(state) });
});

app.post("/api/install/bootstrap", async (c) => {
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  const existing = await c.env.DB.prepare(`SELECT 1 FROM install_state WHERE id = 1`).first();
  if (existing) throw new HttpError(409, "already_initialized", "This installation already has an owner.");
  const body = await jsonBody(c.req.raw);
  const token = text(body.bootstrapToken, "bootstrapToken", 500);
  if (!constantTimeEqual(await sha256(token), await sha256(c.env.BOOTSTRAP_TOKEN))) {
    throw new HttpError(403, "invalid_bootstrap_token", "The bootstrap token is invalid.");
  }

  const name = text(body.name, "name", 100);
  const email = text(body.email, "email", 320).toLowerCase();
  const password = text(body.password, "password", 200);
  const workspaceName = text(body.workspaceName, "workspaceName", 100);
  const signup = await signUp(c.env, c.req.raw, { name, email, password });
  if (!signup.user) return signup.response;

  const workspaceId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const timestamp = now();
  const hint = defaultLocation(c.req.raw, c.env.DO_LOCATION_HINT);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO workspaces (id, name, location_hint, created_at) VALUES (?, ?, ?, ?)`)
      .bind(workspaceId, workspaceName, hint, timestamp),
    c.env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
      .bind(workspaceId, signup.user.id, timestamp),
    c.env.DB.prepare(`INSERT INTO install_state (id, workspace_id, initialized_at) VALUES (1, ?, ?)`)
      .bind(workspaceId, timestamp),
    c.env.DB.prepare(
      `INSERT INTO pages (id, workspace_id, parent_id, kind, position, title, created_by, created_at, updated_at)
       VALUES (?, ?, NULL, 'document', ?, 'Welcome', ?, ?, ?)`,
    ).bind(pageId, workspaceId, generateJitteredKeyBetween(null, null), signup.user.id, timestamp, timestamp),
    c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, 'Welcome', '')`)
      .bind(pageId, workspaceId),
  ]);
  return signup.response;
});

app.post("/api/invites/accept", async (c) => {
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  const body = await jsonBody(c.req.raw);
  const inviteToken = text(body.token, "token", 500);
  const tokenHash = await sha256(inviteToken);
  const invite = await c.env.DB.prepare(
    `SELECT id, workspace_id, role FROM invites
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  ).bind(tokenHash, now()).first<{ id: string; workspace_id: string; role: "editor" | "viewer" }>();
  if (!invite) throw new HttpError(404, "invite_invalid", "This invite is invalid, expired, or already used.");

  const inviteEmail = text(body.email, "email", 320).toLowerCase();
  const existingUser = await c.env.DB.prepare(`SELECT id FROM user WHERE email = ?`).bind(inviteEmail).first();
  const signup = existingUser
    ? await authEmail(c.env, c.req.raw, "/api/auth/sign-in/email", {
        email: inviteEmail,
        password: text(body.password, "password", 200),
      })
    : await signUp(c.env, c.req.raw, {
        name: text(body.name, "name", 100),
        email: inviteEmail,
        password: text(body.password, "password", 200),
      });
  if (!signup.user) return signup.response;
  const existingMembership = await c.env.DB.prepare(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
  ).bind(invite.workspace_id, signup.user.id).first();
  if (existingMembership) return signup.response;
  const timestamp = now();
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT workspace_id, ?, role, ? FROM invites WHERE id = ? AND used_at IS NULL`,
    ).bind(signup.user.id, timestamp, invite.id),
    c.env.DB.prepare(
      `UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL`,
    ).bind(signup.user.id, timestamp, invite.id),
  ]);
  if (!result[1].meta.changes) throw new HttpError(409, "invite_used", "This invite was used by another request.");
  return signup.response;
});

app.all("/api/auth/*", async (c) => {
  if (new URL(c.req.url).pathname.endsWith("/sign-up/email")) {
    throw new HttpError(403, "registration_closed", "Use the bootstrap screen or an invite to register.");
  }
  return createAuth(c.env).handler(c.req.raw);
});

app.get("/api/me", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  return c.json(member);
});

app.get("/api/health", async (c) => {
  const database = await c.env.DB.prepare(`SELECT 1 ok`).first<{ ok: number }>();
  return c.json({ ok: database?.ok === 1, version: "0.1.0", time: new Date().toISOString() });
});

app.get("/api/members", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, wm.role, wm.created_at createdAt
       FROM workspace_members wm JOIN user u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? ORDER BY u.name, u.id`,
  ).bind(member.workspace.id).all();
  return c.json({ members: rows.results });
});

app.post("/api/invites", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const body = await jsonBody(c.req.raw);
  const inviteRole = role(body.role);
  if (inviteRole === "owner") throw new HttpError(422, "invalid_role", "Invites can grant editor or viewer access.");
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const id = crypto.randomUUID();
  const expiresAt = now() + 7 * 24 * 60 * 60_000;
  await c.env.DB.prepare(
    `INSERT INTO invites (id, workspace_id, token_hash, role, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, member.workspace.id, await sha256(token), inviteRole, expiresAt, member.user.id, now()).run();
  return c.json({ invite: { id, token, role: inviteRole, expiresAt } }, 201);
});

app.patch("/api/members/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const body = await jsonBody(c.req.raw);
  const nextRole = role(body.role);
  const targetId = c.req.param("id");
  if (nextRole !== "owner") {
    const target = await c.env.DB.prepare(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).bind(member.workspace.id, targetId).first<{ role: string }>();
    if (target?.role === "owner") await assertAnotherOwner(c.env, member.workspace.id, targetId);
  }
  const result = await c.env.DB.prepare(
    `UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`,
  ).bind(nextRole, member.workspace.id, targetId).run();
  if (!result.meta.changes) throw new HttpError(404, "member_not_found", "Member not found.");
  return c.json({ ok: true });
});

app.delete("/api/members/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const targetId = c.req.param("id");
  const target = await c.env.DB.prepare(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
  ).bind(member.workspace.id, targetId).first<{ role: string }>();
  if (!target) throw new HttpError(404, "member_not_found", "Member not found.");
  if (target.role === "owner") await assertAnotherOwner(c.env, member.workspace.id, targetId);
  await c.env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .bind(member.workspace.id, targetId).run();
  return c.json({ ok: true });
});

app.get("/api/pages/tree", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const archived = c.req.query("archived") === "true";
  const rows = await c.env.DB.prepare(
    `SELECT * FROM pages WHERE workspace_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY position, id`,
  ).bind(member.workspace.id).all<PageRow>();
  return c.json({ pages: rows.results.map(pageJson) });
});

app.post("/api/pages", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const body = await jsonBody(c.req.raw);
  const parentId = nullableId(body.parentId, "parentId");
  if (parentId) await pageForMember(c.env, member, parentId);
  const last = await c.env.DB.prepare(
    `SELECT position FROM pages WHERE workspace_id = ? AND parent_id IS ? AND archived_at IS NULL ORDER BY position DESC, id DESC LIMIT 1`,
  ).bind(member.workspace.id, parentId).first<{ position: string }>();
  const id = crypto.randomUUID();
  const kind = pageKind(body.kind ?? "document");
  const title = typeof body.title === "string" ? text(body.title, "title", 200) : "Untitled";
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO pages (id, workspace_id, parent_id, kind, position, title, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, member.workspace.id, parentId, kind, generateJitteredKeyBetween(last?.position ?? null, null), title, member.user.id, timestamp, timestamp),
    c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, '')`)
      .bind(id, member.workspace.id, title),
    ...(kind === "table" ? [c.env.DB.prepare(`INSERT INTO table_state (page_id) VALUES (?)`).bind(id)] : []),
  ]);
  const created = pageJson(await pageForMember(c.env, member, id));
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [created] });
  return c.json({ page: created }, 201);
});

app.get("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  return c.json({ page: pageJson(await pageForMember(c.env, member, c.req.param("id"), true)) });
});

app.patch("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const revision = Number(body.revision);
  const titleValue = body.title === undefined ? page.title : text(body.title, "title", 200);
  const iconValue = body.icon === undefined ? page.icon : body.icon === null ? null : text(body.icon, "icon", 20);
  const result = await c.env.DB.prepare(
    `UPDATE pages SET title = ?, icon = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND revision = ?`,
  ).bind(titleValue, iconValue, now(), page.id, member.workspace.id, revision).run();
  if (!result.meta.changes) throw new HttpError(409, "stale_revision", "The page metadata changed. Reload and try again.");
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(page.id),
    c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, ?)`)
      .bind(page.id, member.workspace.id, titleValue, await currentPlainText(c.env, page.id)),
  ]);
  const updated = pageJson(await pageForMember(c.env, member, page.id));
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [updated] });
  return c.json({ page: updated });
});

app.post("/api/pages/:id/move", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const parentId = nullableId(body.parentId, "parentId");
  if (parentId) {
    await pageForMember(c.env, member, parentId);
    const cycle = await c.env.DB.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM pages WHERE id = ?
         UNION ALL SELECT p.id FROM pages p JOIN descendants d ON p.parent_id = d.id
       ) SELECT 1 cycle FROM descendants WHERE id = ? LIMIT 1`,
    ).bind(page.id, parentId).first();
    if (cycle) throw new HttpError(409, "page_cycle", "A page cannot be moved beneath itself or a descendant.");
  }
  const beforeId = nullableId(body.beforeId, "beforeId");
  const afterId = nullableId(body.afterId, "afterId");
  const neighbors = await c.env.DB.prepare(
    `SELECT id, position FROM pages WHERE workspace_id = ? AND parent_id IS ? AND archived_at IS NULL`,
  ).bind(member.workspace.id, parentId).all<{ id: string; position: string }>();
  const before = neighbors.results.find((item) => item.id === beforeId)?.position ?? null;
  const after = neighbors.results.find((item) => item.id === afterId)?.position ?? null;
  if (beforeId && !before) throw new HttpError(422, "invalid_neighbor", "beforeId is not a sibling in the destination.");
  if (afterId && !after) throw new HttpError(422, "invalid_neighbor", "afterId is not a sibling in the destination.");
  const lower = after ?? (before ? null : neighbors.results.sort((a, b) => compareBinaryText(a.position, b.position)).at(-1)?.position ?? null);
  const upper = before;
  if (lower && upper && lower >= upper) throw new HttpError(422, "invalid_order", "afterId must come before beforeId.");
  await c.env.DB.prepare(
    `UPDATE pages SET parent_id = ?, position = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
  ).bind(parentId, generateJitteredKeyBetween(lower, upper), now(), page.id).run();
  const moved = pageJson(await pageForMember(c.env, member, page.id));
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [moved] });
  return c.json({ page: moved });
});

app.delete("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM pages WHERE id = ? AND workspace_id = ?
         UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       ) UPDATE pages SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id IN subtree`,
    ).bind(page.id, member.workspace.id, timestamp, member.user.id, timestamp),
    c.env.DB.prepare(`DELETE FROM page_search WHERE page_id IN (
      WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id)
      SELECT id FROM subtree
    )`).bind(page.id),
  ]);
  const archived = await c.env.DB.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
     ) SELECT id, kind, content_epoch FROM pages WHERE id IN subtree`,
  ).bind(page.id).all<{ id: string; kind: "document" | "table"; content_epoch: number }>();
  const hint = locationHint(member.workspace.locationHint ?? undefined);
  const archiveResponses = await Promise.all(archived.results
    .filter((item) => item.kind === "document")
    .map(async (item) => {
      const room = `${item.id}~${item.content_epoch}`;
      const stub = c.env.DOCUMENT.getByName(room, hint ? { locationHint: hint } : undefined);
      return stub.fetch(new Request("https://document.internal/archive", {
        method: "POST",
        headers: { "x-notes-internal": c.env.BETTER_AUTH_SECRET },
      }));
    }));
  if (archiveResponses.some((response) => !response.ok)) {
    throw new HttpError(503, "archive_incomplete", "The page was archived, but an active editor could not be disconnected. Retry the archive.");
  }
  sendWorkspaceEvent(c, member.workspace.id, {
    type: "pages-removed",
    pageIds: archived.results.map((item) => item.id),
    permanently: false,
  });
  return c.json({ ok: true });
});

app.post("/api/pages/:id/restore", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  await c.env.DB.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM pages WHERE id = ? AND workspace_id = ?
       UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
     ) UPDATE pages SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id IN subtree`,
  ).bind(page.id, member.workspace.id, now()).run();
  const restored = await c.env.DB.prepare(
    `SELECT * FROM pages WHERE id IN (
      WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id)
      SELECT id FROM subtree
    )`,
  ).bind(page.id).all<PageRow>();
  await c.env.DB.batch(restored.results.flatMap((item) => [
    c.env.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(item.id),
    c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, ?)`)
      .bind(item.id, item.workspace_id, item.title, item.plain_text ?? ""),
  ]));
  sendWorkspaceEvent(c, member.workspace.id, {
    type: "pages-upserted",
    pages: restored.results.map(pageJson),
  });
  return c.json({ ok: true });
});

app.post("/api/pages/:id/permanent-delete", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  if (!page.archived_at) throw new HttpError(409, "archive_first", "Archive a page before permanently deleting it.");
  const [subtree, attachments] = await Promise.all([
    c.env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       ) SELECT * FROM pages WHERE id IN subtree`,
    ).bind(page.id).all<PageRow>(),
    c.env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       ) SELECT r2_key FROM attachments WHERE page_id IN subtree`,
    ).bind(page.id).all<{ r2_key: string }>(),
  ]);
  const jobId = crypto.randomUUID();
  const timestamp = now();
  const targets = new Map<string, { kind: "document_do" | "r2_object" | "r2_prefix"; target: string }>();
  for (const item of subtree.results) {
    if (item.kind !== "document") continue;
    targets.set(`r2_prefix:documents/${item.id}/`, { kind: "r2_prefix", target: `documents/${item.id}/` });
    for (let epoch = 1; epoch <= item.content_epoch; epoch++) {
      targets.set(`document_do:${item.id}~${epoch}`, { kind: "document_do", target: `${item.id}~${epoch}` });
    }
  }
  for (const attachment of attachments.results) {
    targets.set(`r2_object:${attachment.r2_key}`, { kind: "r2_object", target: attachment.r2_key });
  }
  const targetValues = [...targets.values()];
  try {
    await c.env.DB.prepare(
      `INSERT INTO deletion_jobs
        (id, workspace_id, root_page_id, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(jobId, member.workspace.id, page.id, Number.MAX_SAFE_INTEGER, timestamp, timestamp).run();
    for (let index = 0; index < targetValues.length; index += DELETION_TARGET_BATCH_SIZE) {
      await c.env.DB.batch(targetValues.slice(index, index + DELETION_TARGET_BATCH_SIZE).map((target) => (
        c.env.DB.prepare(
          `INSERT INTO deletion_targets (job_id, kind, target) VALUES (?, ?, ?)`,
        ).bind(jobId, target.kind, target.target)
      )));
    }
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE deletion_jobs SET next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(timestamp, timestamp, jobId),
      c.env.DB.prepare(
        `DELETE FROM page_search WHERE page_id IN (
           WITH RECURSIVE subtree(id) AS (
             SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
           ) SELECT id FROM subtree
         )`,
      ).bind(page.id),
      c.env.DB.prepare(`DELETE FROM pages WHERE id = ? AND workspace_id = ?`).bind(page.id, member.workspace.id),
    ]);
    if (!results[2]?.meta.changes) throw new Error("Page metadata changed during permanent deletion.");
  } catch (error) {
    try {
      await c.env.DB.prepare(`DELETE FROM deletion_jobs WHERE id = ?`).bind(jobId).run();
    } catch (cleanupError) {
      console.error("Failed to discard staged deletion job", cleanupError);
    }
    throw error;
  }
  const pageIds = subtree.results.map((item) => item.id);
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-removed", pageIds, permanently: true });
  c.executionCtx.waitUntil(processDeletionJob(c.env, jobId).catch((error) => {
    console.error("Immediate deletion cleanup failed", error);
  }));
  return c.json({ ok: true, cleanupPending: true }, 202);
});

app.get("/api/search", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const query = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!query) return c.json({ results: [] });
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
  if (!terms.length) return c.json({ results: [] });
  const match = terms.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" AND ");
  const rows = await c.env.DB.prepare(
    `SELECT p.*, snippet(page_search, 3, '<mark>', '</mark>', '…', 20) snippet
       FROM page_search JOIN pages p ON p.id = page_search.page_id
      WHERE page_search MATCH ? AND page_search.workspace_id = ? AND p.archived_at IS NULL
      ORDER BY bm25(page_search) LIMIT 30`,
  ).bind(match, member.workspace.id).all<PageRow & { snippet: string }>();
  return c.json({ results: rows.results.map((row) => ({ page: pageJson(row), snippet: row.snippet })) });
});

app.get("/api/mentions/suggestions", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const query = (c.req.query("q") ?? "").trim().slice(0, 100);
  const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const [pages, members] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, title, icon FROM pages
        WHERE workspace_id = ? AND archived_at IS NULL AND title LIKE ? ESCAPE '\\'
        ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, title, id LIMIT 10`,
    ).bind(member.workspace.id, pattern, `${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`)
      .all<{ id: string; title: string; icon: string | null }>(),
    c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, wm.role
         FROM workspace_members wm JOIN user u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND (u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
        ORDER BY u.name, u.id LIMIT 10`,
    ).bind(member.workspace.id, pattern, pattern)
      .all<{ id: string; name: string; email: string; role: string }>(),
  ]);
  return c.json({ suggestions: [
    ...pages.results.map((page) => ({
      entityType: "page" as const,
      entityId: page.id,
      label: page.title,
      detail: "Page",
      icon: page.icon,
    })),
    ...members.results.map((item) => ({
      entityType: "user" as const,
      entityId: item.id,
      label: item.name,
      detail: `${item.email} · ${item.role}`,
      icon: null,
    })),
  ] });
});

app.get("/api/pages/:id/preview", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const row = await c.env.DB.prepare(
    `SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
  ).bind(c.req.param("id"), member.workspace.id).first<PageRow>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  return c.json({ preview: { page: pageJson(row), excerpt: (row.plain_text ?? "").slice(0, 280) } });
});

app.get("/api/pages/:id/backlinks", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const rows = await c.env.DB.prepare(
    `SELECT source.*, reference.excerpt
       FROM page_references reference JOIN pages source ON source.id = reference.source_page_id
      WHERE reference.target_page_id = ? AND source.workspace_id = ? AND source.archived_at IS NULL
      ORDER BY source.updated_at DESC, source.id`,
  ).bind(page.id, member.workspace.id).all<PageRow & { excerpt: string }>();
  return c.json({ backlinks: rows.results.map((row) => ({ page: pageJson(row), excerpt: row.excerpt })) });
});

app.get("/api/mentions/unread-count", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT mention.source_page_id) count
       FROM member_mentions mention
       JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ?
        AND mention.first_seen_at > COALESCE(reads.read_at, 0)`,
  ).bind(member.workspace.id, member.user.id).first<{ count: number }>();
  return c.json({ unreadCount: row?.count ?? 0 });
});

app.get("/api/mentions", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  // Use the previous millisecond so a projection committed after this read can
  // never share the cursor timestamp and be marked read without being shown.
  const asOf = now() - 1;
  const rows = await c.env.DB.prepare(
    `SELECT source.*, mention.excerpt, mention.first_seen_at,
            CASE WHEN mention.first_seen_at > COALESCE(reads.read_at, 0) THEN 1 ELSE 0 END unread
       FROM member_mentions mention
       JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ? AND mention.first_seen_at <= ?
      ORDER BY mention.first_seen_at DESC, source.id LIMIT 100`,
  ).bind(member.workspace.id, member.user.id, asOf)
    .all<PageRow & { excerpt: string; first_seen_at: number; unread: number }>();
  return c.json({
    asOf,
    mentions: rows.results.map((row) => ({
      page: pageJson(row),
      excerpt: row.excerpt,
      firstSeenAt: row.first_seen_at,
      unread: Boolean(row.unread),
    })),
  });
});

app.post("/api/mentions/read", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const body = await jsonBody(c.req.raw);
  const through = Number(body.through);
  if (!Number.isInteger(through) || through < 0 || through > now() + 1_000) {
    throw new HttpError(422, "invalid_read_cursor", "through must be a valid server timestamp.");
  }
  await c.env.DB.prepare(
    `INSERT INTO mention_reads (workspace_id, user_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`,
  ).bind(member.workspace.id, member.user.id, through).run();
  const unread = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT mention.source_page_id) count
       FROM member_mentions mention
       JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ?
        AND mention.first_seen_at > COALESCE(reads.read_at, 0)`,
  ).bind(member.workspace.id, member.user.id).first<{ count: number }>();
  return c.json({ unreadCount: unread?.count ?? 0 });
});

app.get("/api/pages/:id/attachments", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  const attachments = await c.env.DB.prepare(
    `SELECT id, page_id pageId, name, mime, size, created_by createdBy, created_at createdAt
       FROM attachments WHERE page_id = ? AND workspace_id = ? ORDER BY created_at DESC`,
  ).bind(page.id, member.workspace.id).all();
  return c.json({ attachments: attachments.results });
});

app.post("/api/pages/:id/attachments", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES + 100_000) throw new HttpError(413, "upload_too_large", "Uploads are limited to 10 MiB.");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(422, "file_required", "Attach one file in the file field.");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "upload_too_large", "Uploads are limited to 10 MiB.");
  const mime = file.type || "application/octet-stream";
  if (isUnsafeMime(mime, file.name)) throw new HttpError(415, "unsafe_file_type", "HTML, SVG, and executable web content cannot be uploaded.");
  const id = crypto.randomUUID();
  const key = `assets/${member.workspace.id}/${crypto.randomUUID()}`;
  await c.env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: mime },
    customMetadata: { attachmentId: id },
  });
  try {
    await c.env.DB.prepare(
      `INSERT INTO attachments (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, member.workspace.id, page.id, key, normalizeFilename(file.name), mime, file.size, member.user.id, now()).run();
  } catch (error) {
    await c.env.BUCKET.delete(key);
    throw error;
  }
  return c.json({ attachment: { id, pageId: page.id, name: normalizeFilename(file.name), mime, size: file.size } }, 201);
});

app.get("/api/attachments/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const attachment = await c.env.DB.prepare(
    `SELECT a.* FROM attachments a JOIN pages p ON p.id = a.page_id
      WHERE a.id = ? AND a.workspace_id = ? AND p.archived_at IS NULL`,
  ).bind(c.req.param("id"), member.workspace.id).first<{
    r2_key: string; name: string; mime: string; size: number;
  }>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found.");
  const rangeRequested = Boolean(c.req.header("range"));
  const object = await c.env.BUCKET.get(attachment.r2_key, {
    ...(rangeRequested ? { range: c.req.raw.headers } : {}),
    onlyIf: c.req.raw.headers,
  });
  if (!object) throw new HttpError(404, "attachment_missing", "The attachment data is missing.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", attachmentDisposition(attachment.name, isInlineMime(attachment.mime)));
  if (!("body" in object)) {
    return new Response(null, {
      status: c.req.header("if-match") ? 412 : c.req.header("if-none-match") ? 304 : 412,
      headers,
    });
  }
  const range = rangeRequested && object.range ? normalizeR2Range(object.range, object.size) : null;
  if (range && range.length > 0) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set("content-length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
});

app.delete("/api/attachments/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const attachment = await c.env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE id = ? AND workspace_id = ?`,
  ).bind(c.req.param("id"), member.workspace.id).first<{ r2_key: string }>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found.");
  await c.env.DB.prepare(`DELETE FROM attachments WHERE id = ?`).bind(c.req.param("id")).run();
  await c.env.BUCKET.delete(attachment.r2_key);
  return c.json({ ok: true });
});

app.get("/api/pages/:id/versions", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  if (page.kind !== "document") throw new HttpError(422, "document_required", "Tables do not have version history in v1.");
  const versions = await c.env.DB.prepare(
    `SELECT id, page_id pageId, epoch, sequence, title, byte_size byteSize,
            last_editor_id lastEditorId, created_at createdAt
       FROM page_versions WHERE page_id = ? ORDER BY created_at DESC`,
  ).bind(page.id).all();
  return c.json({ versions: versions.results });
});

app.get("/api/versions/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const version = await c.env.DB.prepare(
    `SELECT v.*, p.workspace_id FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE v.id = ? AND p.workspace_id = ?`,
  ).bind(c.req.param("id"), member.workspace.id).first<{
    r2_key: string; title: string; epoch: number; sequence: number;
  }>();
  if (!version) throw new HttpError(404, "version_not_found", "Version not found.");
  const snapshot = await c.env.BUCKET.get(version.r2_key);
  if (!snapshot) throw new HttpError(404, "version_missing", "The version snapshot is missing.");
  return new Response(snapshot.body, { headers: {
    "content-type": "application/vnd.yjs",
    "content-length": String(snapshot.size),
    "x-version-title": encodeURIComponent(version.title),
    "x-version-epoch": String(version.epoch),
    "x-version-sequence": String(version.sequence),
    "cache-control": "private, no-store",
  } });
});

app.post("/api/pages/:id/restore-version", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  if (page.kind !== "document") throw new HttpError(422, "document_required", "Only documents can be restored.");
  const body = await jsonBody(c.req.raw);
  const versionId = text(body.versionId, "versionId", 100);
  const hint = locationHint(member.workspace.locationHint ?? undefined);
  const oldRoom = `${page.id}~${page.content_epoch}`;
  const oldStub = c.env.DOCUMENT.getByName(oldRoom, hint ? { locationHint: hint } : undefined);
  const response = await oldStub.fetch(new Request("https://document.internal/restore-version", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-notes-internal": c.env.BETTER_AUTH_SECRET,
    },
    body: JSON.stringify({ versionId, userId: member.user.id }),
  }));
  const result = await response.json<{ pageId?: string; contentEpoch?: number; error?: string }>();
  if (!response.ok || !result.contentEpoch) {
    if (response.status === 404) throw new HttpError(404, "version_not_found", result.error ?? "Version not found.");
    if (response.status === 409) throw new HttpError(409, "stale_epoch", result.error ?? "The page epoch changed during restore.");
    throw new HttpError(503, "restore_failed", result.error ?? "The version could not be restored.");
  }
  const restored = pageJson(await pageForMember(c.env, member, page.id));
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [restored] });
  return c.json({ pageId: page.id, contentEpoch: result.contentEpoch });
});

app.get("/api/tables/:pageId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("pageId"));
  if (page.kind !== "table") throw new HttpError(422, "table_required", "This page is not a table.");
  const state = await c.env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`).bind(page.id).first<{ revision: number }>();
  const columns = await c.env.DB.prepare(`SELECT * FROM table_columns WHERE page_id = ? ORDER BY position, id`).bind(page.id).all<{
    id: string; name: string; type: string; position: number;
  }>();
  const options = await c.env.DB.prepare(
    `SELECT o.* FROM table_select_options o JOIN table_columns c ON c.id = o.column_id WHERE c.page_id = ? ORDER BY o.position, o.id`,
  ).bind(page.id).all<{ id: string; column_id: string; label: string; position: number }>();
  // ponytail: 500 rows are loaded and sorted in the client; graduate to server-side
  // querying and a realtime table Durable Object only when this boundary is exceeded.
  const rows = await c.env.DB.prepare(`SELECT id, position FROM table_rows WHERE page_id = ? ORDER BY position, id LIMIT 501`)
    .bind(page.id).all<{ id: string; position: number }>();
  if (rows.results.length > 500) throw new HttpError(422, "table_row_limit", "This table has exceeded the 500-row v1 limit.");
  const cells = await c.env.DB.prepare(
    `SELECT c.* FROM table_cells c JOIN table_rows r ON r.id = c.row_id WHERE r.page_id = ?`,
  ).bind(page.id).all<Record<string, unknown>>();
  const lease = await c.env.DB.prepare(
    `SELECT l.expires_at, l.holder_session_id, u.name holder_name
       FROM table_leases l JOIN user u ON u.id = l.holder_user_id WHERE l.page_id = ? AND l.expires_at > ?`,
  ).bind(page.id, now()).first<{ expires_at: number; holder_session_id: string; holder_name: string }>();
  const cellMap = new Map<string, Record<string, string | number | boolean | null>>();
  for (const cell of cells.results) {
    const row = cellMap.get(String(cell.row_id)) ?? {};
    row[String(cell.column_id)] = cellValue(cell);
    cellMap.set(String(cell.row_id), row);
  }
  return c.json({ table: {
    pageId: page.id,
    revision: state?.revision ?? 1,
    columns: columns.results.map((column) => ({
      ...column,
      options: options.results.filter((option) => option.column_id === column.id).map((option) => ({
        id: option.id, label: option.label, position: option.position,
      })),
    })),
    rows: rows.results.map((row) => ({ ...row, cells: cellMap.get(row.id) ?? {} })),
    lease: {
      heldByMe: lease?.holder_session_id === member.session.id,
      holderName: lease?.holder_name ?? null,
      expiresAt: lease?.expires_at ?? null,
    },
  } });
});

app.post("/api/tables/:pageId/lease", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("pageId"));
  if (page.kind !== "table") throw new HttpError(422, "table_required", "This page is not a table.");
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const expiresAt = now() + 60_000;
  const result = await c.env.DB.prepare(
    `INSERT INTO table_leases (page_id, token_hash, holder_user_id, holder_session_id, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET token_hash = excluded.token_hash,
       holder_user_id = excluded.holder_user_id, holder_session_id = excluded.holder_session_id,
       expires_at = excluded.expires_at
     WHERE table_leases.expires_at <= ? OR table_leases.holder_session_id = ?`,
  ).bind(page.id, await sha256(token), member.user.id, member.session.id, expiresAt, now(), member.session.id).run();
  if (!result.meta.changes) throw new HttpError(409, "lease_conflict", "Another editor currently holds this table lease.");
  return c.json({ leaseToken: token, expiresAt });
});

app.patch("/api/tables/:pageId/lease", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const body = await jsonBody(c.req.raw);
  const expiresAt = now() + 60_000;
  const result = await c.env.DB.prepare(
    `UPDATE table_leases SET expires_at = ?
      WHERE page_id = ? AND holder_session_id = ? AND token_hash = ? AND expires_at > ?`,
  ).bind(expiresAt, c.req.param("pageId"), member.session.id, await sha256(text(body.leaseToken, "leaseToken", 200)), now()).run();
  if (!result.meta.changes) throw new HttpError(409, "lease_lost", "The table lease has expired or been replaced.");
  return c.json({ expiresAt });
});

app.delete("/api/tables/:pageId/lease", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const body = await jsonBody(c.req.raw);
  await c.env.DB.prepare(
    `DELETE FROM table_leases WHERE page_id = ? AND holder_session_id = ? AND token_hash = ?`,
  ).bind(c.req.param("pageId"), member.session.id, await sha256(text(body.leaseToken, "leaseToken", 200))).run();
  return c.json({ ok: true });
});

app.post("/api/tables/:pageId/force-unlock", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  await c.env.DB.prepare(`DELETE FROM table_leases WHERE page_id = ?`).bind(c.req.param("pageId")).run();
  return c.json({ ok: true });
});

app.post("/api/tables/:pageId/columns", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("pageId"));
  if (page.kind !== "table") throw new HttpError(422, "table_required", "This page is not a table.");
  const input = await leaseInputs(c.req.raw, member);
  const id = crypto.randomUUID();
  const name = text(input.body.name, "name", 100);
  const type = columnType(input.body.type);
  const position = Number(input.body.position);
  if (!Number.isInteger(position) || position < 0) throw new HttpError(422, "invalid_position", "position must be a non-negative integer.");
  const result = await guardedBatch(c.env, page.id, input, [
    c.env.DB.prepare(
      `INSERT INTO table_columns (id, page_id, name, type, position)
       SELECT ?, ?, ?, ?, ? WHERE ${leaseGuards()}`,
    ).bind(id, page.id, name, type, position, page.id, input.expectedRevision, input.tokenHash, input.sessionId, now()),
  ]);
  return c.json({ column: { id, name, type, position }, revision: result }, 201);
});

app.delete("/api/tables/:pageId/columns/:columnId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const input = await leaseInputs(c.req.raw, member);
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, [
    c.env.DB.prepare(
      `DELETE FROM table_columns WHERE id = ? AND page_id = ? AND ${leaseGuards()}`,
    ).bind(c.req.param("columnId"), c.req.param("pageId"), c.req.param("pageId"), input.expectedRevision, input.tokenHash, input.sessionId, now()),
  ]);
  return c.json({ revision });
});

app.post("/api/tables/:pageId/columns/:columnId/options", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const input = await leaseInputs(c.req.raw, member);
  const id = crypto.randomUUID();
  const label = text(input.body.label, "label", 100);
  const position = Number(input.body.position);
  if (!Number.isInteger(position) || position < 0) throw new HttpError(422, "invalid_position", "position must be a non-negative integer.");
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, [
    c.env.DB.prepare(
      `INSERT INTO table_select_options (id, column_id, label, position)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM table_columns WHERE id = ? AND page_id = ? AND type = 'select'
       ) AND ${leaseGuards()}`,
    ).bind(id, c.req.param("columnId"), label, position, c.req.param("columnId"), c.req.param("pageId"),
      c.req.param("pageId"), input.expectedRevision, input.tokenHash, input.sessionId, now()),
  ]);
  return c.json({ option: { id, label, position }, revision }, 201);
});

app.delete("/api/tables/:pageId/columns/:columnId/options/:optionId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const input = await leaseInputs(c.req.raw, member);
  const option = await c.env.DB.prepare(
    `SELECT 1 FROM table_select_options option
      JOIN table_columns column ON column.id = option.column_id
     WHERE option.id = ? AND option.column_id = ? AND column.page_id = ?`,
  ).bind(c.req.param("optionId"), c.req.param("columnId"), c.req.param("pageId")).first();
  if (!option) throw new HttpError(404, "option_not_found", "Option not found.");
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, [
    c.env.DB.prepare(
      `DELETE FROM table_select_options WHERE id = ? AND column_id = ? AND ${leaseGuards()}`,
    ).bind(c.req.param("optionId"), c.req.param("columnId"), c.req.param("pageId"), input.expectedRevision, input.tokenHash, input.sessionId, now()),
  ]);
  return c.json({ revision });
});

app.post("/api/tables/:pageId/rows", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const input = await leaseInputs(c.req.raw, member);
  const count = await c.env.DB.prepare(`SELECT COUNT(*) count FROM table_rows WHERE page_id = ?`).bind(c.req.param("pageId")).first<{ count: number }>();
  if ((count?.count ?? 0) >= 500) throw new HttpError(422, "table_row_limit", "Tables are limited to 500 rows in v1.");
  const id = crypto.randomUUID();
  const position = Number(input.body.position);
  if (!Number.isInteger(position) || position < 0) throw new HttpError(422, "invalid_position", "position must be a non-negative integer.");
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, [
    c.env.DB.prepare(
      `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${leaseGuards()}`,
    ).bind(id, c.req.param("pageId"), position, member.user.id, now(), now(), c.req.param("pageId"), input.expectedRevision, input.tokenHash, input.sessionId, now()),
  ]);
  return c.json({ row: { id, position, cells: {} }, revision }, 201);
});

app.delete("/api/tables/:pageId/rows/:rowId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const input = await leaseInputs(c.req.raw, member);
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, [
    c.env.DB.prepare(`DELETE FROM table_rows WHERE id = ? AND page_id = ? AND ${leaseGuards()}`)
      .bind(c.req.param("rowId"), c.req.param("pageId"), c.req.param("pageId"), input.expectedRevision, input.tokenHash, input.sessionId, now()),
  ]);
  return c.json({ revision });
});

app.put("/api/tables/:pageId/cells/:rowId/:columnId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const input = await leaseInputs(c.req.raw, member);
  const pageId = c.req.param("pageId");
  const column = await c.env.DB.prepare(`SELECT type FROM table_columns WHERE id = ? AND page_id = ?`)
    .bind(c.req.param("columnId"), pageId).first<{ type: string }>();
  if (!column) throw new HttpError(404, "column_not_found", "Column not found.");
  const row = await c.env.DB.prepare(`SELECT 1 FROM table_rows WHERE id = ? AND page_id = ?`)
    .bind(c.req.param("rowId"), pageId).first();
  if (!row) throw new HttpError(404, "row_not_found", "Row not found.");
  if (column.type === "select" && input.body.value !== null && input.body.value !== "") {
    const option = await c.env.DB.prepare(
      `SELECT 1 FROM table_select_options WHERE id = ? AND column_id = ?`,
    ).bind(input.body.value, c.req.param("columnId")).first();
    if (!option) throw new HttpError(422, "invalid_cell", "The selected option does not belong to this column.");
  }
  const values = typedCell(column.type, input.body.value);
  const revision = await guardedBatch(c.env, pageId, input, [
    c.env.DB.prepare(
      `INSERT INTO table_cells
       (row_id, column_id, text_value, number_value, boolean_value, date_value, select_value, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${leaseGuards()}
       ON CONFLICT(row_id, column_id) DO UPDATE SET
         text_value = excluded.text_value, number_value = excluded.number_value,
         boolean_value = excluded.boolean_value, date_value = excluded.date_value,
         select_value = excluded.select_value, updated_at = excluded.updated_at`,
    ).bind(c.req.param("rowId"), c.req.param("columnId"), ...values, now(), pageId, input.expectedRevision, input.tokenHash, input.sessionId, now()),
  ]);
  return c.json({ revision });
});

app.notFound(async (c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: { code: "not_found", message: "API route not found." } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

async function assertAnotherOwner(env: Env, workspaceId: string, excludedId: string) {
  const other = await env.DB.prepare(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND user_id <> ? LIMIT 1`,
  ).bind(workspaceId, excludedId).first();
  if (!other) throw new HttpError(409, "final_owner", "Promote another owner before removing or demoting the final owner.");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function currentPlainText(env: Env, pageId: string) {
  return (await env.DB.prepare(`SELECT plain_text FROM pages WHERE id = ?`).bind(pageId).first<{ plain_text: string }>())?.plain_text ?? "";
}

function isUnsafeMime(mime: string, name: string) {
  const normalizedMime = mime.toLowerCase().split(";", 1)[0].trim();
  const extension = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return UNSAFE_MIME_TYPES.has(normalizedMime) || UNSAFE_FILE_EXTENSIONS.has(extension);
}

function isInlineMime(mime: string) {
  return /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) || mime === "application/pdf" || mime === "text/plain" || mime === "text/markdown";
}

function cellValue(cell: Record<string, unknown>) {
  if (cell.text_value !== null && cell.text_value !== undefined) return String(cell.text_value);
  if (cell.number_value !== null && cell.number_value !== undefined) return Number(cell.number_value);
  if (cell.boolean_value !== null && cell.boolean_value !== undefined) return Boolean(cell.boolean_value);
  if (cell.date_value !== null && cell.date_value !== undefined) return String(cell.date_value);
  if (cell.select_value !== null && cell.select_value !== undefined) return String(cell.select_value);
  return null;
}

function typedCell(type: string, value: unknown): [string | null, number | null, number | null, string | null, string | null] {
  if (value === null || value === "") return [null, null, null, null, null];
  if (type === "text") return [text(value, "value", 10_000), null, null, null, null];
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new HttpError(422, "invalid_cell", "This cell requires a finite number.");
    return [null, number, null, null, null];
  }
  if (type === "checkbox") {
    if (typeof value !== "boolean") throw new HttpError(422, "invalid_cell", "This cell requires true or false.");
    return [null, null, value ? 1 : 0, null, null];
  }
  if (type === "date") {
    const date = text(value, "value", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new HttpError(422, "invalid_cell", "This cell requires a YYYY-MM-DD date.");
    }
    return [null, null, null, date, null];
  }
  if (type === "select") return [null, null, null, null, text(value, "value", 100)];
  throw new HttpError(422, "invalid_cell", "Unknown column type.");
}

async function guardedBatch(
  env: Env,
  pageId: string,
  input: { expectedRevision: number; tokenHash: string; sessionId: string },
  mutations: D1PreparedStatement[],
) {
  const updatedAt = now();
  const results = await env.DB.batch([
    ...mutations,
    env.DB.prepare(
      `UPDATE table_state SET revision = revision + 1
        WHERE page_id = ? AND revision = ? AND ${leaseGuards()}`,
    ).bind(pageId, input.expectedRevision, pageId, input.expectedRevision, input.tokenHash, input.sessionId, updatedAt),
  ]);
  if (!results.at(-1)?.meta.changes) {
    throw new HttpError(409, "lease_or_revision_conflict", "The table lease or revision changed. Reload before editing.");
  }
  return input.expectedRevision + 1;
}

async function handlePartyRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const documentPrefix = "/parties/document/";
  const workspacePrefix = "/parties/workspace-events/";
  const isDocument = url.pathname.startsWith(documentPrefix);
  const isWorkspace = url.pathname.startsWith(workspacePrefix);
  if (!isDocument && !isWorkspace) return null;
  try {
    assertSameOrigin(request, env.BETTER_AUTH_URL);
    const member = await requireMember(request, env);
    const room = decodeURIComponent(url.pathname.slice((isDocument ? documentPrefix : workspacePrefix).length));
    if (isDocument) {
      const separator = room.lastIndexOf("~");
      const pageId = room.slice(0, separator);
      const epoch = Number(room.slice(separator + 1));
      if (!pageId || !Number.isInteger(epoch)) throw new HttpError(404, "room_not_found", "Document room not found.");
      const page = await pageForMember(env, member, pageId);
      if (page.kind !== "document" || page.content_epoch !== epoch) {
        throw new HttpError(409, "stale_epoch", "Reload this page to connect to its current document version.");
      }
    } else if (room !== member.workspace.id) {
      throw new HttpError(404, "room_not_found", "Workspace event room not found.");
    }
    const expiresAt = Math.min(member.session.expiresAt.getTime(), now() + 5 * 60_000);
    return routePartykitRequest(request, env, {
      locationHint: locationHint(member.workspace.locationHint ?? undefined),
      onBeforeConnect(incoming) {
        const headers = new Headers(incoming.headers);
        for (const name of ["x-notes-user-id", "x-notes-role", "x-notes-expires-at", "x-notes-internal"]) headers.delete(name);
        headers.set("x-notes-user-id", member.user.id);
        headers.set("x-notes-role", member.role);
        headers.set("x-notes-expires-at", String(expiresAt));
        return new Request(incoming, { headers });
      },
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : "Something went wrong.";
    return Response.json({ error: { code, message } }, { status });
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const party = await handlePartyRequest(request, env);
    if (party) return party;
    return app.fetch(request, env, context);
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(processDueDeletionJobs(env).catch((error) => {
      console.error("Scheduled deletion cleanup failed", error);
    }));
  },
};

export { Document, WorkspaceEvents };
