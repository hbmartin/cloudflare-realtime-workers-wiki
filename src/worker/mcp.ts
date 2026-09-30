import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import { z } from "zod";
import { createCommentThread, type CommentPage } from "./comments";
import { projectNotionMarkdown } from "../shared/notion-markdown";
import { MarkdownWriteError, parseWritableMarkdown } from "../shared/notion-markdown-write";
import { markdownMutations } from "../shared/notion-markdown-mutations";
import { parseMarkdownCommand } from "../shared/notion-markdown-commands";
import type { DocumentContentEnvelope } from "../shared/types";
import { ID_PATTERN, PAGE_TITLE_MAX } from "../shared/validation";
import type { Env } from "./env";
import { HttpError, locationHint, sha256 } from "./http";
import { mcpAccess, mcpBearerChallenge, type McpAccess, type McpScope } from "./oauth";
import { correlationHeaders, logger } from "./observability";
import { editableSpaceForMember, pageForMember, requirePageEditor, type PageRow } from "./page-access";
import { pageJson } from "./page-row";
import { parseSearchRequest, searchPages } from "./search";
import { broadcastWorkspaceEvent } from "./workspace-events";
import { sweepOutbox } from "./jobs";
import { deleteR2Prefix } from "./r2";
import { consumeFixedWindow } from "./rate-limit";
import { sourceRateLimitKey } from "./source-rate-limit";
import { refreshPageSearchV2Statements } from "./search-index";
import { webhookEventStatements } from "./webhooks";

const MAX_MCP_BODY = 64 * 1024;
const OPERATION_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60_000;
const STAGED_PAGE_TTL_MS = 24 * 60 * 60_000;
const STAGED_CLEANUP_RETRY_MS = 60_000;
export type BackgroundContext = Pick<ExecutionContext, "waitUntil">;
const TOOL_SCOPES: Record<string, readonly McpScope[]> = {
  search_pages: ["pages:read"],
  fetch_page: ["pages:read"],
  create_page: ["pages:write"],
  update_page: ["pages:write"],
  create_comment: ["pages:read", "comments:write"],
};

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export async function pruneStagedMcpPages(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id,content_epoch,import_job_id,updated_at FROM pages
      WHERE ((import_job_id GLOB 'mcp:create:*' AND updated_at<?)
        OR (import_job_id GLOB 'mcp:cleanup:*' AND updated_at<?))
        AND created_at<? ORDER BY updated_at LIMIT 10`,
  )
    .bind(Date.now() - STAGED_CLEANUP_RETRY_MS, Date.now() - STAGED_CLEANUP_RETRY_MS, Date.now() - STAGED_PAGE_TTL_MS)
    .all<{ id: string; content_epoch: number; import_job_id: string; updated_at: number }>();
  for (const row of rows.results) {
    const cleanupId = `mcp:cleanup:${row.id}`;
    const claimedAt = Date.now();
    const claimed = await env.DB.prepare(
      "UPDATE pages SET import_job_id=?,updated_at=? WHERE id=? AND import_job_id=? AND updated_at=?",
    )
      .bind(cleanupId, claimedAt, row.id, row.import_job_id, row.updated_at)
      .run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const purged = await env.DOCUMENT.getByName(`${row.id}~${row.content_epoch}`).fetch(
        new Request("https://document.internal/purge", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
          signal: AbortSignal.timeout(30_000),
        }),
      );
      if (!purged.ok) throw new Error(`Staged document purge returned ${purged.status}.`);
      await deleteR2Prefix(env.BUCKET, `documents/${row.id}/`);
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE oauth_operation_receipts
            SET result_json=json_set(json_remove(result_json,'$.children'),'$.status','failed',
              '$.error',json_object('status',409,'code','page_creation_expired',
                'message','Staged page creation expired. Start a new operation.'))
            WHERE tool_name='create_page' AND json_extract(result_json,'$.status')='staged'
              AND json_extract(result_json,'$.pageId')=?
              AND EXISTS (SELECT 1 FROM pages WHERE id=? AND import_job_id=? AND updated_at=?)`,
        ).bind(row.id, row.id, cleanupId, claimedAt),
        env.DB.prepare("DELETE FROM pages WHERE id=? AND import_job_id=? AND updated_at=?").bind(
          row.id,
          cleanupId,
          claimedAt,
        ),
      ]);
    } catch (error) {
      logger.error(
        "mcp.staged_page.cleanup_failed",
        "mcp",
        "Staged page cleanup will be retried.",
        { pageId: row.id },
        error,
      );
      try {
        await env.DB.prepare("UPDATE pages SET updated_at=? WHERE id=? AND import_job_id=? AND updated_at=?")
          .bind(Date.now(), row.id, cleanupId, claimedAt)
          .run();
      } catch {
        // Preserve the original purge failure and continue with other staged pages.
      }
    }
  }
}

function toolError(error: unknown) {
  const message =
    error instanceof HttpError || error instanceof MarkdownWriteError
      ? error.message
      : "The tool could not complete this request.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: {
      error: {
        code:
          error instanceof HttpError
            ? error.code
            : error instanceof MarkdownWriteError
              ? "invalid_markdown"
              : "tool_unavailable",
        retryable:
          error instanceof HttpError
            ? error.status >= 500 || error.status === 429
            : !(error instanceof MarkdownWriteError),
      },
    },
  };
}

function creationResult(receipt: unknown) {
  const value = receipt as { status?: unknown; error?: { status: HttpError["status"]; code: string; message: string } };
  if (value?.status === "failed" && value.error)
    throw new HttpError(value.error.status, value.error.code, value.error.message);
  return receipt;
}

async function mutationFailure(response: Response) {
  if (response.status === 409) {
    const conflict = await response.json<{ error?: string }>().catch((): { error?: string } => ({}));
    if (conflict.error === "revision_changed")
      return new HttpError(409, "page_changed", "The document changed. Read it again and update the request.");
    if (conflict.error === "This document is read-only.")
      return new HttpError(409, "document_read_only", "This document is read-only.");
    if (conflict.error === "duplicate_date_token")
      return new HttpError(409, "duplicate_date_token", "Move the original date token before reusing its ID.");
    if (conflict.error === "idempotency_key_reused")
      return new HttpError(409, "idempotency_key_reused", "Use a new operation ID for a different mutation.");
    return new HttpError(409, "mutation_conflict", "The document could not be changed.");
  }
  if (response.status === 404)
    return new HttpError(404, "block_not_found", "The block is no longer available. Read the document again.");
  if (response.status === 410) return new HttpError(404, "page_not_found", "This document is no longer available.");
  if (response.status === 413) return new HttpError(413, "document_limit", "The mutation exceeds document limits.");
  if ([400, 415, 422].includes(response.status))
    return new HttpError(422, "invalid_mutation", "The block mutation is invalid.");
  if (response.status === 429)
    return new HttpError(429, "document_busy", "The document is busy. Retry with the same operation ID.");
  return new HttpError(
    503,
    "document_unavailable",
    "The document is temporarily unavailable. Retry with the same operation ID.",
  );
}

async function writableDestination(env: Env, access: McpAccess, spaceId: string, parentId: string | null) {
  await editableSpaceForMember(env, access.member, spaceId);
  if (!parentId) return;
  const parent = await pageForMember(env, access.member, parentId);
  requirePageEditor(parent);
  if (parent.space_id !== spaceId)
    throw new HttpError(422, "cross_space_parent", "The parent page belongs to another space.");
}

type CreatePageInput = {
  space_id: string;
  parent_id?: string | null | undefined;
  title: string;
  markdown: string;
  operation_id: string;
};

async function createPageTool(request: Request, env: Env, context: BackgroundContext, input: CreatePageInput) {
  let access = await currentAccess(request, env, ["pages:write"]);
  const parentId = input.parent_id ?? null;
  await writableDestination(env, access, input.space_id, parentId);
  const inputHash = await sha256(JSON.stringify({ ...input, parent_id: parentId }));
  type Staged = { status: "staged"; pageId: string; children: ReturnType<typeof parseWritableMarkdown> };
  let receipt = await receiptFor(env, access.grantId, input.operation_id, "create_page", inputHash);
  if (receipt && (receipt as { status?: unknown }).status !== "staged") return creationResult(receipt);
  if (!receipt) {
    const children = parseWritableMarkdown(input.markdown);
    if (children.length > 100)
      throw new HttpError(413, "too_many_blocks", "Create up to 100 Markdown blocks at a time.");
    const pageId = crypto.randomUUID();
    const stageId = `mcp:create:${pageId}`;
    const previous = await env.DB.prepare(
      `SELECT position FROM pages WHERE workspace_id=? AND parent_id IS ? AND archived_at IS NULL
        ORDER BY position DESC,id DESC LIMIT 1`,
    )
      .bind(access.member.workspace.id, parentId)
      .first<{ position: string }>();
    const position = generateJitteredKeyBetween(previous?.position ?? null, null);
    const staged: Staged = { status: "staged", pageId, children };
    const timestamp = Date.now();
    access = await currentAccess(request, env, ["pages:write"]);
    await writableDestination(env, access, input.space_id, parentId);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO pages
            (id,workspace_id,space_id,parent_id,kind,position,title,import_job_id,
             created_by,updated_by,created_at,updated_at)
           VALUES (?,?,?,?,'document',?,?,?,?,?,?,?)`,
        ).bind(
          pageId,
          access.member.workspace.id,
          input.space_id,
          parentId,
          position,
          input.title,
          stageId,
          access.member.user.id,
          access.member.user.id,
          timestamp,
          timestamp,
        ),
        receiptStatement(env, access.grantId, input.operation_id, "create_page", inputHash, staged),
      ]);
      receipt = staged;
    } catch (error) {
      receipt = await receiptFor(env, access.grantId, input.operation_id, "create_page", inputHash);
      if (!receipt) throw error;
    }
  }
  if ((receipt as { status?: unknown }).status !== "staged") return creationResult(receipt);
  const staged = receipt as Staged;
  const stageId = `mcp:create:${staged.pageId}`;
  const stage = await env.DB.prepare("SELECT content_epoch,import_job_id FROM pages WHERE id=? AND workspace_id=?")
    .bind(staged.pageId, access.member.workspace.id)
    .first<{ content_epoch: number; import_job_id: string | null }>();
  if (!stage || stage.import_job_id !== stageId)
    throw new HttpError(409, "page_create_unknown", "The page creation outcome could not be verified.");
  const reserved = await env.DB.prepare(
    "UPDATE pages SET updated_at=? WHERE id=? AND workspace_id=? AND import_job_id=?",
  )
    .bind(Date.now(), staged.pageId, access.member.workspace.id, stageId)
    .run();
  if (reserved.meta.changes !== 1)
    throw new HttpError(409, "page_create_unknown", "The staged page was changed before content could be saved.");
  access = await currentAccess(request, env, ["pages:write"]);
  await writableDestination(env, access, input.space_id, parentId);
  let sequence = 0;
  if (staged.children.length) {
    const operationId = `mcp:${access.grantId}:${input.operation_id}`;
    const response = await env.DOCUMENT.getByName(`${staged.pageId}~${stage.content_epoch}`).fetch(
      new Request("https://document.internal/api-mutate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-notes-internal": env.BETTER_AUTH_SECRET,
          ...correlationHeaders(),
        },
        body: JSON.stringify({
          actorId: access.member.user.id,
          operations: [{ type: "append_children", children: staged.children, position: { type: "end" } }],
          suppressExternalEffects: true,
          operationId,
        }),
      }),
    );
    if (!response.ok) {
      const error = await mutationFailure(response);
      if (error.status < 500 && error.status !== 429) {
        await env.DB.prepare(
          "UPDATE oauth_operation_receipts SET result_json=? WHERE grant_id=? AND operation_id=? AND input_hash=? AND json_extract(result_json,'$.status')='staged'",
        )
          .bind(
            JSON.stringify({
              status: "failed",
              pageId: staged.pageId,
              error: { status: error.status, code: error.code, message: error.message },
            }),
            access.grantId,
            input.operation_id,
            inputHash,
          )
          .run();
      }
      throw error;
    }
    sequence = (await response.json<{ sequence: number }>()).sequence;
  }
  access = await currentAccess(request, env, ["pages:write"]);
  await writableDestination(env, access, input.space_id, parentId);
  const value = {
    id: staged.pageId,
    title: input.title,
    url: new URL(`/?page=${staged.pageId}`, env.BETTER_AUTH_URL).href,
    revision: sequence,
    operationId: input.operation_id,
  };
  const timestamp = Date.now();
  try {
    const published = await env.DB.batch([
      env.DB.prepare(
        `UPDATE oauth_operation_receipts SET result_json=?
         WHERE grant_id=? AND operation_id=? AND input_hash=?
           AND EXISTS (SELECT 1 FROM pages WHERE id=? AND import_job_id=?)`,
      ).bind(JSON.stringify(value), access.grantId, input.operation_id, inputHash, staged.pageId, stageId),
      env.DB.prepare(
        `UPDATE pages SET import_job_id=NULL WHERE id=? AND import_job_id=?
          AND EXISTS (SELECT 1 FROM oauth_operation_receipts
            WHERE grant_id=? AND operation_id=? AND input_hash=? AND result_json=?)`,
      ).bind(staged.pageId, stageId, access.grantId, input.operation_id, inputHash, JSON.stringify(value)),
      env.DB.prepare(
        `INSERT INTO page_search(page_id,workspace_id,title,body)
         SELECT id,workspace_id,title,plain_text FROM pages WHERE id=? AND import_job_id IS NULL`,
      ).bind(staged.pageId),
      ...refreshPageSearchV2Statements(env.DB, staged.pageId),
      env.DB.prepare(
        `INSERT INTO subscriptions(id,workspace_id,user_id,resource_type,resource_id,created_by,created_at)
         SELECT ?,workspace_id,?,'page',id,?,? FROM pages WHERE id=? AND import_job_id IS NULL`,
      ).bind(
        `page:${staged.pageId}:${access.member.user.id}`,
        access.member.user.id,
        access.member.user.id,
        timestamp,
        staged.pageId,
      ),
      ...webhookEventStatements(env.DB, {
        workspaceId: access.member.workspace.id,
        type: "page.created",
        entityType: "page",
        entityId: staged.pageId,
        pageId: staged.pageId,
        contentEpoch: stage.content_epoch,
        publishedOnly: true,
        actorId: access.member.user.id,
        sourceKey: `page.created:${staged.pageId}`,
        createdAt: timestamp,
      }),
    ]);
    if (published[0]?.meta.changes !== 1 || published[1]?.meta.changes !== 1)
      throw new HttpError(409, "page_create_unknown", "The staged page was changed before publication.");
  } catch (error) {
    const committed = await receiptFor(env, access.grantId, input.operation_id, "create_page", inputHash);
    if (!committed || (committed as { status?: unknown }).status === "staged") throw error;
    return creationResult(committed);
  }
  const page = await pageForMember(env, access.member, staged.pageId);
  await broadcastWorkspaceEvent(env, access.member.workspace.id, {
    type: "pages-upserted",
    pages: [pageJson(page)],
  }).catch((error: unknown) => {
    logger.warn("mcp.page_event.failed", "mcp", "Page event delivery failed.", { pageId: page.id }, error);
  });
  context.waitUntil(
    sweepOutbox(env).catch((error: unknown) => {
      logger.warn(
        "mcp.page_webhook.failed",
        "mcp",
        "Page webhook delivery will be retried.",
        { pageId: page.id },
        error,
      );
    }),
  );
  return value;
}

async function roomContent(env: Env, access: McpAccess, page: PageRow) {
  const hint = locationHint(access.member.workspace.locationHint ?? undefined);
  const response = await env.DOCUMENT.getByName(
    `${page.id}~${page.content_epoch}`,
    hint ? { locationHint: hint } : undefined,
  ).fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
    }),
  );
  if (!response.ok) throw new HttpError(503, "content_unavailable", "Page content is temporarily unavailable.");
  const envelope = await response.json<DocumentContentEnvelope>();
  if (envelope.pageId !== page.id || envelope.contentEpoch !== page.content_epoch)
    throw new HttpError(503, "content_unavailable", "Page content is temporarily unavailable.");
  return envelope;
}

async function roomMutationReceipt(env: Env, page: PageRow, operationId: string) {
  const url = new URL("https://document.internal/api-mutate-receipt");
  url.searchParams.set("operationId", operationId);
  const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request(url, { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() } }),
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new HttpError(503, "receipt_unavailable", "The document receipt is unavailable.");
  return response.json<{ found: true; sequence: number }>();
}

async function updatePageTool(
  request: Request,
  env: Env,
  input: { page_id: string; command: Record<string, unknown>; operation_id: string },
) {
  let access = await currentAccess(request, env, ["pages:write"]);
  let page = await pageForMember(env, access.member, input.page_id);
  requirePageEditor(page);
  if (page.kind !== "document") throw new HttpError(422, "document_required", "This page is not a document.");
  const inputHash = await sha256(JSON.stringify(input));
  const cached = await receiptFor(env, access.grantId, input.operation_id, "update_page", inputHash);
  if (cached) return cached;
  const operationId = `mcp:${access.grantId}:${input.operation_id}`;
  const complete = async (sequence: number) => {
    access = await currentAccess(request, env, ["pages:write"]);
    page = await pageForMember(env, access.member, input.page_id);
    requirePageEditor(page);
    const value = {
      id: page.id,
      title: page.title,
      url: new URL(`/?page=${page.id}`, env.BETTER_AUTH_URL).href,
      revision: sequence,
      operationId: input.operation_id,
    };
    try {
      await receiptStatement(env, access.grantId, input.operation_id, "update_page", inputHash, value).run();
    } catch (error) {
      const committed = await receiptFor(env, access.grantId, input.operation_id, "update_page", inputHash);
      if (!committed) throw error;
      return committed;
    }
    return value;
  };
  const prior = await roomMutationReceipt(env, page, operationId);
  if (prior) return complete(prior.sequence);
  const envelope = await roomContent(env, access, page);
  const projection = projectNotionMarkdown(envelope.document, new Map(), {
    pageHref: (id) => new URL(`/?page=${encodeURIComponent(id)}`, env.BETTER_AUTH_URL).href,
  });
  const command = parseMarkdownCommand(input.command, projection.markdown);
  const protectedRows = await env.DB.prepare(
    `SELECT DISTINCT COALESCE(block.internal_id,thread.block_id) internal_id FROM comment_threads thread
       LEFT JOIN api_blocks block ON (block.id=thread.block_id OR block.internal_id=thread.block_id)
         AND block.page_id=thread.page_id
      WHERE thread.page_id=? AND thread.block_id IS NOT NULL`,
  )
    .bind(page.id)
    .all<{ internal_id: string }>();
  const operations = markdownMutations(
    envelope.document,
    projection,
    command.edits,
    command.allowDeletingContent,
    new Set(protectedRows.results.map((row) => row.internal_id)),
  );
  if (!operations.length) return complete(envelope.sequence);
  access = await currentAccess(request, env, ["pages:write"]);
  page = await pageForMember(env, access.member, input.page_id);
  requirePageEditor(page);
  if (page.content_epoch !== envelope.contentEpoch)
    throw new HttpError(409, "page_changed", "The page content version changed.");
  const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/api-mutate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notes-internal": env.BETTER_AUTH_SECRET,
        ...correlationHeaders(),
      },
      body: JSON.stringify({
        actorId: access.member.user.id,
        operations,
        expectedSequence: envelope.sequence,
        operationId,
      }),
    }),
  );
  if (!response.ok) {
    const committed = await roomMutationReceipt(env, page, operationId);
    if (committed) return complete(committed.sequence);
    throw await mutationFailure(response);
  }
  return complete((await response.json<{ sequence: number }>()).sequence);
}

async function currentAccess(request: Request, env: Env, scopes: readonly McpScope[]) {
  const access = await mcpAccess(request, env, scopes);
  if (!access) throw new HttpError(403, "mcp_access_denied", "This connection no longer has access.");
  return access;
}

async function receiptFor(env: Env, grantId: string, operationId: string, toolName: string, inputHash: string) {
  const row = await env.DB.prepare(
    "SELECT tool_name,input_hash,result_json FROM oauth_operation_receipts WHERE grant_id=? AND operation_id=?",
  )
    .bind(grantId, operationId)
    .first<{ tool_name: string; input_hash: string; result_json: string }>();
  if (!row) return null;
  if (row.tool_name !== toolName || row.input_hash !== inputHash)
    throw new HttpError(409, "operation_id_reused", "This operation ID was used with different input.");
  return JSON.parse(row.result_json) as unknown;
}

function receiptStatement(
  env: Env,
  grantId: string,
  operationId: string,
  toolName: string,
  inputHash: string,
  value: unknown,
) {
  const timestamp = Date.now();
  return env.DB.prepare(
    `INSERT INTO oauth_operation_receipts
      (grant_id,operation_id,tool_name,input_hash,result_json,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(grantId, operationId, toolName, inputHash, JSON.stringify(value), timestamp, timestamp + RECEIPT_TTL_MS);
}

async function commentTool(
  request: Request,
  env: Env,
  context: BackgroundContext,
  input: { page_id: string; body: string; block_id?: string | undefined; operation_id: string },
) {
  const scopes = TOOL_SCOPES.create_comment!;
  let access = await currentAccess(request, env, scopes);
  await pageForMember(env, access.member, input.page_id);
  const inputHash = await sha256(JSON.stringify(input));
  const cached = await receiptFor(env, access.grantId, input.operation_id, "create_comment", inputHash);
  if (cached) return cached;
  access = await currentAccess(request, env, scopes);
  const page = await pageForMember(env, access.member, input.page_id);
  const scoped: CommentPage = {
    id: page.id,
    workspace_id: page.workspace_id,
    space_id: page.space_id ?? `${page.workspace_id}-general`,
    content_epoch: page.content_epoch,
    created_by: page.created_by,
    effective_role: page.effective_role,
  };
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const value = { threadId, commentId, pageId: page.id, url: new URL(`/?page=${page.id}`, env.BETTER_AUTH_URL).href };
  try {
    await createCommentThread(
      env,
      access.member,
      scoped,
      page.kind === "diagram"
        ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: input.body }] }] }
        : [{ type: "paragraph", props: {}, content: [{ type: "text", text: input.body, styles: {} }], children: [] }],
      null,
      input.block_id ?? null,
      {
        threadId,
        commentId,
        receipt: receiptStatement(env, access.grantId, input.operation_id, "create_comment", inputHash, value),
      },
    );
  } catch (error) {
    const committed = await receiptFor(env, access.grantId, input.operation_id, "create_comment", inputHash);
    if (!committed) throw error;
    return committed;
  }
  context.waitUntil(
    Promise.allSettled([
      broadcastWorkspaceEvent(env, access.member.workspace.id, { type: "comments-invalidated", pageId: page.id }),
      broadcastWorkspaceEvent(env, access.member.workspace.id, { type: "notifications-invalidated" }),
      sweepOutbox(env),
    ]).then((results) => {
      for (const delivery of results)
        if (delivery.status === "rejected")
          logger.warn(
            "mcp.comment_followup.failed",
            "mcp",
            "Comment follow-up delivery failed.",
            { pageId: page.id },
            delivery.reason,
          );
    }),
  );
  return value;
}

function cursorOffset(cursor: string | undefined, query: string) {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      (decoded as { query?: unknown }).query !== query ||
      !Number.isInteger((decoded as { offset?: unknown }).offset) ||
      Number((decoded as { offset: number }).offset) < 0 ||
      Number((decoded as { offset: number }).offset) > 1000
    )
      throw new Error("Invalid cursor");
    return Number((decoded as { offset: number }).offset);
  } catch {
    throw new HttpError(400, "invalid_cursor", "The search cursor is invalid.");
  }
}

function nextCursor(query: string, offset: number) {
  return btoa(JSON.stringify({ query, offset })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function searchPageTool(request: Request, env: Env, query: string, cursor?: string) {
  const access = await currentAccess(request, env, ["pages:read"]);
  const offset = cursorOffset(cursor, query);
  const url = new URL("/api/search", env.BETTER_AUTH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("offset", String(offset));
  const searched = await searchPages(env.DB, access.member, parseSearchRequest(url.href));
  return {
    pages: searched.results.map(({ page, snippet }) => ({
      id: page.id,
      title: page.title,
      kind: page.kind,
      url: new URL(`/?page=${encodeURIComponent(page.id)}`, env.BETTER_AUTH_URL).href,
      snippet: snippet.text,
    })),
    nextCursor: searched.hasMore ? nextCursor(query, offset + searched.results.length) : null,
  };
}

async function fetchPageTool(request: Request, env: Env, pageId: string) {
  const access = await currentAccess(request, env, ["pages:read"]);
  const page = await pageForMember(env, access.member, pageId);
  if (page.kind !== "document") throw new HttpError(422, "document_required", "This page is not a document.");
  const envelope = await roomContent(env, access, page);
  const projected = projectNotionMarkdown(envelope.document, new Map(), {
    pageHref: (id) => new URL(`/?page=${encodeURIComponent(id)}`, env.BETTER_AUTH_URL).href,
  });
  return {
    id: page.id,
    title: page.title,
    url: new URL(`/?page=${encodeURIComponent(page.id)}`, env.BETTER_AUTH_URL).href,
    revision: envelope.sequence,
    markdown: projected.markdown,
    truncated: projected.truncated,
    unknownBlockIds: projected.unknownBlockIds,
  };
}

function serverFor(request: Request, env: Env, context: BackgroundContext, access: McpAccess) {
  const server = new McpServer({ name: "noteflare", version: "1.0.0" });
  if (access.scopes.has("pages:read"))
    server.registerTool(
      "search_pages",
      {
        title: "Search pages",
        description: "Search pages currently accessible to the connected member.",
        inputSchema: z.object({ query: z.string().trim().min(1).max(200), cursor: z.string().max(512).optional() }),
      },
      async ({ query, cursor }) => {
        try {
          return result(await searchPageTool(request, env, query, cursor));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  if (TOOL_SCOPES.create_comment!.every((scope) => access.scopes.has(scope)))
    server.registerTool(
      "create_comment",
      {
        title: "Create comment",
        description: "Post a comment as the connected member. Reuse operation_id when retrying.",
        inputSchema: z.object({
          page_id: z.string().regex(ID_PATTERN),
          body: z.string().trim().min(1).max(16_000),
          block_id: z.string().regex(ID_PATTERN).optional(),
          operation_id: z.string().regex(OPERATION_ID),
        }),
      },
      async (input) => {
        try {
          return result(await commentTool(request, env, context, input));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  if (access.scopes.has("pages:write"))
    server.registerTool(
      "create_page",
      {
        title: "Create page",
        description: "Create a document in a writable space. Reuse operation_id when retrying.",
        inputSchema: z.object({
          space_id: z.string().regex(ID_PATTERN),
          parent_id: z.string().regex(ID_PATTERN).nullable().optional(),
          title: z.string().trim().min(1).max(PAGE_TITLE_MAX),
          markdown: z.string().max(64_000),
          operation_id: z.string().regex(OPERATION_ID),
        }),
      },
      async (input) => {
        try {
          return result(await createPageTool(request, env, context, input));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  if (access.scopes.has("pages:write"))
    server.registerTool(
      "update_page",
      {
        title: "Update page",
        description: "Apply a Phase 5 Markdown command to a writable document. Reuse operation_id when retrying.",
        inputSchema: z.object({
          page_id: z.string().regex(ID_PATTERN),
          command: z.record(z.string(), z.unknown()),
          operation_id: z.string().regex(OPERATION_ID),
        }),
      },
      async (input) => {
        try {
          return result(await updatePageTool(request, env, input));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  if (access.scopes.has("pages:read"))
    server.registerTool(
      "fetch_page",
      {
        title: "Fetch page",
        description: "Read a document as Markdown using current member permissions.",
        inputSchema: z.object({ page_id: z.string().regex(ID_PATTERN) }),
      },
      async ({ page_id }) => {
        try {
          return result(await fetchPageTool(request, env, page_id));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  return server;
}

export async function mcpRequest(request: Request, env: Env, context: BackgroundContext) {
  const site = new URL(env.BETTER_AUTH_URL).origin;
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== site) return Response.json({ error: "Invalid Origin." }, { status: 403 });
  if (new URL(request.url).origin !== site) return Response.json({ error: "Invalid host." }, { status: 403 });
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return new Response("Expected application/json.", { status: 415 });
  const source = await sourceRateLimitKey(request);
  for (const [binding, retryAfter] of [
    [env.API_SOURCE_BURST_LIMIT, 10],
    [env.API_SOURCE_MINUTE_LIMIT, 60],
  ] as const) {
    if (binding && !(await binding.limit({ key: source })).success)
      return new Response("Too many MCP requests.", {
        status: 429,
        headers: { "retry-after": String(retryAfter), "www-authenticate": mcpBearerChallenge(env) },
      });
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_MCP_BODY) return new Response("Request is too large.", { status: 413 });
  const reader = request.clone().body?.getReader();
  if (!reader) return new Response("Expected a JSON request.", { status: 400 });
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_MCP_BODY) {
      await reader.cancel();
      return new Response("Request is too large.", { status: 413 });
    }
    parts.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    body = null;
  }
  const message = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const params = message?.params;
  const name =
    message?.method === "tools/call" && params && typeof params === "object" && !Array.isArray(params)
      ? (params as { name?: unknown }).name
      : null;
  const required = typeof name === "string" && Object.hasOwn(TOOL_SCOPES, name) ? TOOL_SCOPES[name]! : [];
  const access = await mcpAccess(request, env);
  if (!access) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "www-authenticate": `${mcpBearerChallenge(env, required.join(" "))}${/^Bearer(?:\s|$)/i.test(request.headers.get("authorization") ?? "") ? ', error="invalid_token"' : ""}`,
        "cache-control": "no-store",
      },
    });
  }
  const rate = await consumeFixedWindow(env, `mcp-grant:${access.grantId}`, { window: 60, max: 120 });
  if (!rate.allowed)
    return new Response("Too many MCP requests.", {
      status: 429,
      headers: { "retry-after": String(rate.retryAfter ?? 60) },
    });
  if (required.some((scope) => !access.scopes.has(scope)))
    return new Response("Insufficient scope", {
      status: 403,
      headers: {
        "www-authenticate": `${mcpBearerChallenge(env, [...new Set([...access.scopes, ...required])].join(" "))}, error="insufficient_scope"`,
        "cache-control": "no-store",
      },
    });
  const handler = createMcpHandler(() => serverFor(request, env, context, access), {
    legacy: "reject",
    responseMode: "json",
    maxRequestBodySize: MAX_MCP_BODY,
  });
  try {
    return await handler.fetch(request);
  } finally {
    await handler.close();
  }
}
