import type { Comment, CommentBody, CommentThread, Role } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";

const COMMENT_BODY_MAX_BYTES = 32 * 1024;
const COMMENT_BODY_MAX_NODES = 2_000;
const COMMENT_BODY_MAX_DEPTH = 30;

export type CommentPage = {
  id: string;
  workspace_id: string;
  space_id: string;
  content_epoch: number;
  created_by: string;
  effective_role: Role;
};

type ThreadRow = {
  id: string;
  workspace_id: string;
  space_id: string;
  page_id: string;
  created_by: string;
  resolved_at: number | null;
  resolved_by: string | null;
  anchor_json: string | null;
  created_at: number;
  updated_at: number;
};

type CommentRow = {
  id: string;
  thread_id: string;
  parent_id: string | null;
  user_id: string;
  body_json: string;
  plain_text: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  user_name: string;
  user_email: string;
};

type LegacyComment = {
  id: string;
  userId: string;
  body: unknown;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type LegacyThread = {
  id: string;
  createdAt: number;
  updatedAt: number;
  resolved: boolean;
  resolvedUpdatedAt?: number;
  resolvedBy?: string;
  anchored: boolean;
  comments: LegacyComment[];
};

function validateJsonTree(value: unknown, depth = 0, counter = { count: 0 }): void {
  counter.count += 1;
  if (counter.count > COMMENT_BODY_MAX_NODES || depth > COMMENT_BODY_MAX_DEPTH) {
    throw new HttpError(422, "comment_too_complex", "The comment is too complex.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(422, "invalid_comment", "The comment contains invalid data.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonTree(item, depth + 1, counter);
    return;
  }
  if (typeof value !== "object") {
    throw new HttpError(422, "invalid_comment", "The comment contains invalid data.");
  }
  for (const item of Object.values(value)) validateJsonTree(item, depth + 1, counter);
}

function validatedCommentBody(value: unknown): { body: CommentBody; json: string; plainText: string } {
  if (!value || (typeof value !== "object" && !Array.isArray(value))) {
    throw new HttpError(422, "invalid_comment", "A structured comment body is required.");
  }
  validateJsonTree(value);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > COMMENT_BODY_MAX_BYTES) {
    throw new HttpError(413, "comment_too_large", "Comments are limited to 32 KiB.");
  }
  const plainText = commentPlainText(value);
  if (!plainText) throw new HttpError(422, "empty_comment", "Write a comment before posting it.");
  return { body: value as CommentBody, json, plainText };
}

function commentPlainText(value: unknown) {
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") parts.push(record.text);
    if (record.type === "mention" && record.props && typeof record.props === "object") {
      const label = (record.props as Record<string, unknown>).label;
      if (typeof label === "string") parts.push(`@${label}`);
    }
    visit(record.content);
    visit(record.children);
  };
  visit(value);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function parseBody(value: string): CommentBody | null {
  try {
    return JSON.parse(value) as CommentBody | null;
  } catch {
    return null;
  }
}

function commentJson(row: CommentRow): Comment {
  return {
    id: row.id,
    threadId: row.thread_id,
    parentId: row.parent_id,
    userId: row.user_id,
    user: { id: row.user_id, name: row.user_name, email: row.user_email },
    body: row.deleted_at ? null : parseBody(row.body_json),
    plainText: row.deleted_at ? "" : row.plain_text,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canResolve(member: MemberContext, page: CommentPage, thread: ThreadRow) {
  return member.role === "owner" || page.effective_role !== "viewer" || thread.created_by === member.user.id;
}

async function commentsForThreads(env: Env, threadIds: string[]) {
  if (!threadIds.length) return new Map<string, Comment[]>();
  const placeholders = threadIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT c.*, u.name user_name, u.email user_email
       FROM comments c JOIN user u ON u.id = c.user_id
      WHERE c.thread_id IN (${placeholders})
      ORDER BY c.created_at, c.id`,
  )
    .bind(...threadIds)
    .all<CommentRow>();
  const grouped = new Map<string, Comment[]>();
  for (const row of rows.results) {
    const comments = grouped.get(row.thread_id) ?? [];
    comments.push(commentJson(row));
    grouped.set(row.thread_id, comments);
  }
  return grouped;
}

function threadJson(row: ThreadRow, comments: Comment[], member: MemberContext, page: CommentPage): CommentThread {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id,
    pageId: row.page_id,
    createdBy: row.created_by,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    anchored: Boolean(row.anchor_json),
    canResolve: canResolve(member, page, row),
    comments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCommentThreads(env: Env, member: MemberContext, page: CommentPage) {
  const rows = await env.DB.prepare(`SELECT * FROM comment_threads WHERE page_id = ? ORDER BY created_at, id`)
    .bind(page.id)
    .all<ThreadRow>();
  const comments = await commentsForThreads(
    env,
    rows.results.map((row) => row.id),
  );
  return rows.results.map((row) => threadJson(row, comments.get(row.id) ?? [], member, page));
}

async function threadRow(env: Env, page: CommentPage, threadId: string) {
  const row = await env.DB.prepare(`SELECT * FROM comment_threads WHERE id = ? AND page_id = ? AND workspace_id = ?`)
    .bind(threadId, page.id, page.workspace_id)
    .first<ThreadRow>();
  if (!row) throw new HttpError(404, "comment_thread_not_found", "Comment thread not found.");
  return row;
}

export async function commentThread(env: Env, member: MemberContext, page: CommentPage, threadId: string) {
  const row = await threadRow(env, page, threadId);
  const comments = await commentsForThreads(env, [threadId]);
  return threadJson(row, comments.get(threadId) ?? [], member, page);
}

function refreshCommentSearchStatements(database: D1Database, pageId: string) {
  return [
    database.prepare(`DELETE FROM page_search_v2 WHERE page_id = ?`).bind(pageId),
    database
      .prepare(
        `INSERT INTO page_search_v2
          (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
         SELECT p.id, p.workspace_id, p.space_id, p.title,
                COALESCE((SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id), ''),
                COALESCE(p.plain_text, ''),
                COALESCE((SELECT group_concat(c.plain_text, ' ') FROM comment_threads ct JOIN comments c ON c.thread_id = ct.id WHERE ct.page_id = p.id AND c.deleted_at IS NULL), ''),
                COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
           FROM pages p WHERE p.id = ? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0`,
      )
      .bind(pageId),
  ];
}

function watchPageStatement(database: D1Database, page: CommentPage, userId: string, timestamp: number) {
  return database
    .prepare(
      `INSERT INTO subscriptions
        (id, workspace_id, user_id, resource_type, resource_id, created_by, muted_at, created_at)
       VALUES (?, ?, ?, 'page', ?, ?, NULL, ?)
       ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET muted_at = NULL`,
    )
    .bind(`page:${page.id}:${userId}`, page.workspace_id, userId, page.id, userId, timestamp);
}

export async function createCommentThread(env: Env, member: MemberContext, page: CommentPage, bodyValue: unknown) {
  const body = validatedCommentBody(bodyValue);
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO comment_threads
        (id, workspace_id, space_id, page_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(threadId, page.workspace_id, page.space_id, page.id, member.user.id, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO comments
        (id, thread_id, parent_id, user_id, body_json, plain_text, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).bind(commentId, threadId, member.user.id, body.json, body.plainText, timestamp, timestamp),
    watchPageStatement(env.DB, page, member.user.id, timestamp),
    ...refreshCommentSearchStatements(env.DB, page.id),
  ]);
  return commentThread(env, member, page, threadId);
}

export async function addCommentReply(
  env: Env,
  member: MemberContext,
  page: CommentPage,
  threadId: string,
  bodyValue: unknown,
  requestedParentId?: unknown,
) {
  const thread = await threadRow(env, page, threadId);
  const body = validatedCommentBody(bodyValue);
  let parentId: string | null = null;
  if (typeof requestedParentId === "string") {
    const parent = await env.DB.prepare(`SELECT id FROM comments WHERE id = ? AND thread_id = ?`)
      .bind(requestedParentId, threadId)
      .first<{ id: string }>();
    if (!parent) throw new HttpError(422, "invalid_comment_parent", "The reply target is not in this thread.");
    parentId = parent.id;
  } else {
    parentId =
      (
        await env.DB.prepare(`SELECT id FROM comments WHERE thread_id = ? ORDER BY created_at, id LIMIT 1`)
          .bind(threadId)
          .first<{ id: string }>()
      )?.id ?? null;
  }
  const commentId = crypto.randomUUID();
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO comments
        (id, thread_id, parent_id, user_id, body_json, plain_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(commentId, threadId, parentId, member.user.id, body.json, body.plainText, timestamp, timestamp),
    env.DB.prepare(`UPDATE comment_threads SET updated_at = ? WHERE id = ?`).bind(timestamp, thread.id),
    watchPageStatement(env.DB, page, member.user.id, timestamp),
    ...refreshCommentSearchStatements(env.DB, page.id),
  ]);
  return commentThread(env, member, page, threadId);
}

export async function updateComment(
  env: Env,
  member: MemberContext,
  page: CommentPage,
  threadId: string,
  commentId: string,
  bodyValue: unknown,
) {
  await threadRow(env, page, threadId);
  const existing = await env.DB.prepare(`SELECT user_id, deleted_at FROM comments WHERE id = ? AND thread_id = ?`)
    .bind(commentId, threadId)
    .first<{ user_id: string; deleted_at: number | null }>();
  if (!existing) throw new HttpError(404, "comment_not_found", "Comment not found.");
  if (existing.user_id !== member.user.id) {
    throw new HttpError(403, "comment_author_required", "Only the comment author may edit it.");
  }
  if (existing.deleted_at) throw new HttpError(409, "comment_deleted", "A deleted comment cannot be edited.");
  const body = validatedCommentBody(bodyValue);
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE comments SET body_json = ?, plain_text = ?, updated_at = ? WHERE id = ?`).bind(
      body.json,
      body.plainText,
      timestamp,
      commentId,
    ),
    env.DB.prepare(`UPDATE comment_threads SET updated_at = ? WHERE id = ?`).bind(timestamp, threadId),
    ...refreshCommentSearchStatements(env.DB, page.id),
  ]);
  return commentThread(env, member, page, threadId);
}

export async function softDeleteComment(
  env: Env,
  member: MemberContext,
  page: CommentPage,
  threadId: string,
  commentId: string,
) {
  await threadRow(env, page, threadId);
  const existing = await env.DB.prepare(`SELECT user_id, deleted_at FROM comments WHERE id = ? AND thread_id = ?`)
    .bind(commentId, threadId)
    .first<{ user_id: string; deleted_at: number | null }>();
  if (!existing) throw new HttpError(404, "comment_not_found", "Comment not found.");
  if (existing.user_id !== member.user.id) {
    throw new HttpError(403, "comment_author_required", "Only the comment author may delete it.");
  }
  const timestamp = existing.deleted_at ?? Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE comments SET body_json = 'null', plain_text = '', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
        WHERE id = ?`,
    ).bind(timestamp, timestamp, commentId),
    env.DB.prepare(`UPDATE comment_threads SET updated_at = ? WHERE id = ?`).bind(timestamp, threadId),
    ...refreshCommentSearchStatements(env.DB, page.id),
  ]);
  return commentThread(env, member, page, threadId);
}

export async function setThreadResolved(
  env: Env,
  member: MemberContext,
  page: CommentPage,
  threadId: string,
  resolved: boolean,
) {
  const thread = await threadRow(env, page, threadId);
  if (!canResolve(member, page, thread)) {
    throw new HttpError(403, "comment_resolve_forbidden", "You cannot change this thread's resolution state.");
  }
  const timestamp = Date.now();
  await env.DB.prepare(`UPDATE comment_threads SET resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?`)
    .bind(resolved ? timestamp : null, resolved ? member.user.id : null, timestamp, threadId)
    .run();
  return commentThread(env, member, page, threadId);
}

function validLegacyThread(value: unknown): value is LegacyThread {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<LegacyThread>;
  return (
    typeof thread.id === "string" &&
    typeof thread.createdAt === "number" &&
    typeof thread.updatedAt === "number" &&
    typeof thread.resolved === "boolean" &&
    Array.isArray(thread.comments)
  );
}

export async function migrateLegacyComments(env: Env, page: CommentPage) {
  const migrated = await env.DB.prepare(`SELECT completed_at FROM comment_migrations WHERE page_id = ?`)
    .bind(page.id)
    .first<{ completed_at: number }>();
  if (migrated) return;
  const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/legacy-comments", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }),
  );
  if (!response.ok) throw new HttpError(503, "comments_unavailable", "Comments are temporarily unavailable.");
  const payload = await response.json<{ threads?: unknown[] }>();
  const threads = (payload.threads ?? []).filter(validLegacyThread);
  const statements: D1PreparedStatement[] = [];
  for (const thread of threads) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO comment_threads
          (id, workspace_id, space_id, page_id, created_by, resolved_at, resolved_by, anchor_json,
           legacy_migrated, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        thread.id,
        page.workspace_id,
        page.space_id,
        page.id,
        thread.comments[0]?.userId ?? page.created_by,
        thread.resolved ? (thread.resolvedUpdatedAt ?? thread.updatedAt) : null,
        thread.resolved ? (thread.resolvedBy ?? null) : null,
        thread.anchored ? JSON.stringify({ legacy: true }) : null,
        thread.createdAt,
        thread.updatedAt,
      ),
    );
    for (const comment of thread.comments) {
      if (
        !comment ||
        typeof comment.id !== "string" ||
        typeof comment.userId !== "string" ||
        typeof comment.createdAt !== "number" ||
        typeof comment.updatedAt !== "number"
      )
        continue;
      const storedBody = comment.body ?? null;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO comments
            (id, thread_id, parent_id, user_id, body_json, plain_text, deleted_at, created_at, updated_at)
           SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM user WHERE id = ?)`,
        ).bind(
          comment.id,
          thread.id,
          comment.userId,
          JSON.stringify(storedBody),
          comment.deletedAt ? "" : commentPlainText(storedBody),
          comment.deletedAt ?? null,
          comment.createdAt,
          comment.updatedAt,
          comment.userId,
        ),
      );
    }
  }
  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50));
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO comment_migrations (page_id, completed_at) VALUES (?, ?)`).bind(
      page.id,
      Date.now(),
    ),
    ...refreshCommentSearchStatements(env.DB, page.id),
  ]);
  await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`)
    .fetch(
      new Request("https://document.internal/legacy-comments/clear", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    )
    .catch((error) => console.error("Failed to clear migrated Yjs comment bodies", { pageId: page.id, error }));
}
