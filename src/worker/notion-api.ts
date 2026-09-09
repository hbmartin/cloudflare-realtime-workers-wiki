import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import { Hono, type Context } from "hono";
import {
  documentBlocks,
  findDocumentBlock,
  NOTION_PAGE_SIZE_MAX,
  NOTION_VERSION,
  notionInputToBlockContainer,
  notionPayloadForBlock,
  notionRichTextToProseMirror,
  proseMirrorInlineToNotion,
  type NotionBlock,
} from "../shared/notion-blocks";
import { sha256Hex } from "../shared/import-integrity";
import { constantTimeEqual, hmacSha256Hex } from "../shared/security";
import type { DocumentContentEnvelope, WorkspaceEvent } from "../shared/types";
import {
  authenticateIntegration,
  integrationBearerToken,
  IntegrationAuthError,
  pageForIntegration,
  publicPageId,
  publicPageIds,
  type IntegrationPage,
  type IntegrationPrincipal,
} from "./integrations";
import type { Env } from "./env";
import { isInlineMime } from "./attachments";
import { attachmentDisposition } from "./http";
import { sweepOutbox } from "./jobs";
import { pageJson, type PageJsonRow } from "./page-row";
import { refreshPageSearchV2Statements, refreshPageSearchV2SubtreeStatements } from "./search-index";
import { webhookEventStatements, type WebhookEventType } from "./webhooks";
import { broadcastWorkspaceEvent } from "./workspace-events";

type ApiContext = { Bindings: Env; Variables: { principal: IntegrationPrincipal; requestId: string } };

class NotionError extends Error {
  override name = "NotionError";
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503,
    readonly code:
      | "invalid_json"
      | "invalid_request_url"
      | "invalid_request"
      | "validation_error"
      | "missing_version"
      | "unauthorized"
      | "restricted_resource"
      | "object_not_found"
      | "conflict_error"
      | "rate_limited"
      | "internal_server_error"
      | "service_unavailable",
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const notionApi = new Hono<ApiContext>();

function notionErrorResponse(requestId: string, error: NotionError) {
  return Response.json(
    { object: "error", status: error.status, code: error.code, message: error.message, request_id: requestId },
    {
      status: error.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId,
        ...(error.retryAfter ? { "retry-after": String(error.retryAfter) } : {}),
      },
    },
  );
}

notionApi.onError((error, c) => {
  const requestId = c.get("requestId") || crypto.randomUUID();
  if (error instanceof IntegrationAuthError) {
    return notionErrorResponse(requestId, new NotionError(401, "unauthorized", "API token is invalid."));
  }
  if (error instanceof NotionError) return notionErrorResponse(requestId, error);
  console.error("Notion API request failed", {
    requestId,
    error: error instanceof Error ? error.message : String(error),
  });
  return notionErrorResponse(requestId, new NotionError(500, "internal_server_error", "Internal server error."));
});

notionApi.notFound((c) =>
  notionErrorResponse(
    c.get("requestId") || crypto.randomUUID(),
    new NotionError(404, "invalid_request_url", "Invalid request URL."),
  ),
);

async function enforceApiRateLimits(burst: RateLimit | undefined, minute: RateLimit | undefined, key: string) {
  if (burst) {
    const { success } = await burst.limit({ key });
    if (!success) throw new NotionError(429, "rate_limited", "Rate limit exceeded.", 10);
  }
  if (minute) {
    const { success } = await minute.limit({ key });
    if (!success) throw new NotionError(429, "rate_limited", "Rate limit exceeded.", 60);
  }
}

// Cloudflare gives all cross-zone Worker subrequests this source IP. Add the
// platform-provided originating zone so one Worker cannot drain every other
// Worker client's pre-authentication bucket at the same colo.
const CROSS_ZONE_WORKER_IP = "2a06:98c0:3600::103";

async function sourceRateLimitKey(request: Request) {
  const ip = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() || "unattributed";
  const workerZone =
    ip === CROSS_ZONE_WORKER_IP ? request.headers.get("cf-worker")?.trim().toLowerCase() || "unknown" : null;
  return sha256Hex(workerZone ? `worker:${workerZone}` : `ip:${ip}`);
}

notionApi.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  const version = c.req.header("notion-version");
  if (!version) throw new NotionError(400, "missing_version", `Notion-Version must be ${NOTION_VERSION}.`);
  if (version !== NOTION_VERSION) {
    throw new NotionError(400, "validation_error", `This API supports exactly Notion-Version ${NOTION_VERSION}.`);
  }
  if (!integrationBearerToken(c.req.raw)) throw new IntegrationAuthError();
  await enforceApiRateLimits(
    c.env.API_SOURCE_BURST_LIMIT,
    c.env.API_SOURCE_MINUTE_LIMIT,
    await sourceRateLimitKey(c.req.raw),
  );
  const principal = await authenticateIntegration(c.req.raw, c.env);
  c.set("principal", principal);
  await enforceApiRateLimits(c.env.API_BURST_LIMIT, c.env.API_MINUTE_LIMIT, principal.integrationId);
  await next();
});

function capability(principal: IntegrationPrincipal, name: keyof IntegrationPrincipal) {
  if (!principal[name])
    throw new NotionError(403, "restricted_resource", "The integration lacks the required capability.");
}

function enqueueWebhooks(c: Context<ApiContext>) {
  c.executionCtx.waitUntil(sweepOutbox(c.env).catch((error) => console.error("Webhook enqueue failed", error)));
}

function enqueueWorkspaceEvent(c: Context<ApiContext>, workspaceId: string, event: WorkspaceEvent) {
  c.executionCtx.waitUntil(
    broadcastWorkspaceEvent(c.env, workspaceId, event).catch((error) =>
      console.error("Notion API workspace broadcast failed", error),
    ),
  );
}

async function pageRowsForSubtree(env: Env, workspaceId: string, rootPageId: string) {
  return (
    await env.DB.prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM pages WHERE id = ? AND workspace_id = ?
         UNION ALL SELECT child.id FROM pages child JOIN tree parent ON child.parent_id = parent.id
       ) SELECT id, workspace_id, space_id, parent_id, kind, position, title, icon, revision,
                content_epoch, is_template, archived_at, created_at, updated_at
           FROM pages WHERE id IN (SELECT id FROM tree) ORDER BY position, id`,
    )
      .bind(rootPageId, workspaceId)
      .all<PageJsonRow>()
  ).results;
}

async function body(request: Request, allowEmpty = false) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 500 * 1024) {
    throw new NotionError(413, "validation_error", "Request body exceeds 500 KiB.");
  }
  try {
    const source = await request.text();
    if (allowEmpty && !source.trim()) return {};
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof NotionError) throw error;
    throw new NotionError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function iso(value: number) {
  return new Date(value).toISOString();
}

function encodeCursor(offset: number) {
  return btoa(JSON.stringify({ offset })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(value: string | undefined) {
  if (!value) return 0;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(normalized)) as { offset?: unknown };
    if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error();
    return Number(parsed.offset);
  } catch {
    throw new NotionError(400, "validation_error", "start_cursor is invalid.");
  }
}

function pagination(input: { page_size?: unknown; start_cursor?: unknown }) {
  const size = input.page_size === undefined ? 100 : Number(input.page_size);
  if (!Number.isInteger(size) || size < 1 || size > NOTION_PAGE_SIZE_MAX) {
    throw new NotionError(400, "validation_error", "page_size must be between 1 and 100.");
  }
  if (input.start_cursor !== undefined && typeof input.start_cursor !== "string") {
    throw new NotionError(400, "validation_error", "start_cursor must be a string.");
  }
  return { size, offset: decodeCursor(input.start_cursor as string | undefined) };
}

function listEnvelope(
  results: unknown[],
  offset: number,
  size: number,
  type: "page_or_database" | "block" | "user" = "page_or_database",
) {
  const hasMore = results.length > size;
  return {
    object: "list",
    results: hasMore ? results.slice(0, size) : results,
    next_cursor: hasMore ? encodeCursor(offset + size) : null,
    has_more: hasMore,
    type,
    [type]: {},
  };
}

function plainTitle(value: unknown) {
  try {
    const nodes = notionRichTextToProseMirror(value);
    return nodes
      .map((node) => node.text ?? String(node.attrs?.label ?? node.attrs?.formula ?? ""))
      .join("")
      .trim();
  } catch (error) {
    throw new NotionError(400, "validation_error", error instanceof Error ? error.message : "Invalid rich text.");
  }
}

function actorObject(id: string | null, name = "Unknown") {
  return id
    ? { object: "user", id, type: "person", person: {}, name, avatar_url: null }
    : {
        object: "user",
        id: "00000000-0000-0000-0000-000000000000",
        type: "person",
        person: {},
        name,
        avatar_url: null,
      };
}

type PageObjectData = {
  publicIds: Map<string, string>;
  userNames: Map<string, string>;
  publicUrls: Map<string, string>;
};

async function preloadPageObjectData(env: Env, pages: IntegrationPage[], origin: string): Promise<PageObjectData> {
  const pageIds = pages.flatMap((page) => (page.parent_id ? [page.id, page.parent_id] : [page.id]));
  const userIds = [
    ...new Set(pages.flatMap((page) => [page.created_by, page.updated_by]).filter((id): id is string => Boolean(id))),
  ];
  const [publicIds, users, shares] = await Promise.all([
    publicPageIds(env, pageIds),
    userIds.length
      ? env.DB.prepare(`SELECT id, name FROM user WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(userIds))
          .all<{ id: string; name: string }>()
      : Promise.resolve({ results: [] as Array<{ id: string; name: string }> }),
    pages.length
      ? env.DB.prepare(
          `WITH RECURSIVE ancestors(page_id, ancestor_id, parent_id, depth) AS (
             SELECT id, id, parent_id, 0 FROM pages WHERE id IN (SELECT value FROM json_each(?))
             UNION ALL
             SELECT child.page_id, parent.id, parent.parent_id, child.depth + 1
               FROM pages parent JOIN ancestors child ON parent.id = child.parent_id
              WHERE child.depth < 50
           )
           SELECT ancestor.page_id, share.url_key, share.root_page_id, ancestor.depth
             FROM ancestors ancestor JOIN share_links share ON share.root_page_id = ancestor.ancestor_id
            WHERE share.workspace_id = ? AND share.revoked_at IS NULL
              AND (ancestor.depth = 0 OR share.include_subpages = 1)
            ORDER BY ancestor.page_id, ancestor.depth`,
        )
          .bind(JSON.stringify(pages.map((page) => page.id)), pages[0]!.workspace_id)
          .all<{ page_id: string; url_key: string; root_page_id: string; depth: number }>()
      : Promise.resolve({
          results: [] as Array<{ page_id: string; url_key: string; root_page_id: string; depth: number }>,
        }),
  ]);
  const publicUrls = new Map<string, string>();
  for (const share of shares.results) {
    if (publicUrls.has(share.page_id)) continue;
    publicUrls.set(
      share.page_id,
      `${origin}/share/${share.url_key}${share.root_page_id === share.page_id ? "" : `/pages/${encodeURIComponent(share.page_id)}`}`,
    );
  }
  return {
    publicIds,
    userNames: new Map(users.results.map((user) => [user.id, user.name])),
    publicUrls,
  };
}

async function pageObject(env: Env, page: IntegrationPage, origin: string, preloaded?: PageObjectData) {
  const data = preloaded ?? (await preloadPageObjectData(env, [page], origin));
  const id = data.publicIds.get(page.id);
  const parentId = page.parent_id ? data.publicIds.get(page.parent_id) : null;
  if (!id || (page.parent_id && !parentId)) throw new Error("A public page id could not be assigned.");
  const creatorName = data.userNames.get(page.created_by) ?? "Unknown";
  const editorName = (page.updated_by && data.userNames.get(page.updated_by)) || "Unknown";
  const publicUrl = data.publicUrls.get(page.id) ?? null;
  const title = {
    id: "title",
    type: "title",
    title: page.title
      ? [
          {
            type: "text",
            text: { content: page.title, link: null },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: "default",
            },
            plain_text: page.title,
            href: null,
          },
        ]
      : [],
  };
  const icon = page.icon
    ? page.icon.startsWith("https://")
      ? { type: "external", external: { url: page.icon } }
      : { type: "emoji", emoji: page.icon }
    : null;
  return {
    object: "page",
    id,
    created_time: iso(page.created_at),
    last_edited_time: iso(page.updated_at),
    created_by: actorObject(page.created_by, creatorName),
    last_edited_by: actorObject(page.updated_by, editorName),
    cover: null,
    icon,
    parent: parentId ? { type: "page_id", page_id: parentId } : { type: "workspace", workspace: true },
    in_trash: page.archived_at !== null,
    is_locked: false,
    properties: { title },
    url: `${origin}/?page=${encodeURIComponent(page.id)}`,
    public_url: publicUrl,
  };
}

async function liveDocument(env: Env, page: IntegrationPage) {
  const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
  );
  if (!response.ok) throw new NotionError(503, "service_unavailable", "Document state is unavailable.");
  return response.json<DocumentContentEnvelope>();
}

type BlockMetadata = {
  id: string;
  internal_id: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

async function metadataForPage(env: Env, pageId: string) {
  const rows = await env.DB.prepare(`SELECT * FROM api_blocks WHERE page_id = ?`).bind(pageId).all<BlockMetadata>();
  return new Map(rows.results.map((row) => [row.internal_id, row]));
}

async function blockObject(env: Env, page: IntegrationPage, block: NotionBlock, metadata: Map<string, BlockMetadata>) {
  const record = metadata.get(block.internalId);
  const payload = notionPayloadForBlock(block);
  if (["image", "video", "audio", "file", "pdf"].includes(payload.type)) {
    const external = payload.payload.external as { url?: unknown } | undefined;
    const match = typeof external?.url === "string" ? /\/api\/attachments\/([A-Za-z0-9_-]+)/.exec(external.url) : null;
    if (match?.[1]) {
      const attachment = await env.DB.prepare(`SELECT id FROM attachments WHERE id = ? AND page_id = ?`)
        .bind(match[1], page.id)
        .first<{ id: string }>();
      if (attachment) {
        const expires = Date.now() + 60 * 60_000;
        payload.payload = {
          type: "file",
          file: { url: await notionFileUrl(env, attachment.id, expires), expiry_time: iso(expires) },
          caption: payload.payload.caption ?? [],
        };
      }
    }
  }
  const id = record?.id ?? block.id;
  return {
    object: "block",
    id,
    parent: { type: "page_id", page_id: await publicPageId(env, page.id) },
    created_time: iso(record?.created_at ?? page.created_at),
    last_edited_time: iso(record?.updated_at ?? page.updated_at),
    created_by: actorObject(record?.created_by ?? page.created_by),
    last_edited_by: actorObject(record?.updated_by ?? page.updated_by),
    has_children: block.children.length > 0,
    in_trash: Boolean(record?.deleted_at),
    type: payload.type,
    [payload.type]: payload.payload,
  };
}

async function accessiblePage(env: Env, principal: IntegrationPrincipal, id: string, includeTrash = false) {
  const page = await pageForIntegration(env, principal, id, includeTrash);
  if (!page || page.kind !== "document") {
    throw new NotionError(404, "object_not_found", "Could not find page or block with the requested ID.");
  }
  return page;
}

async function locatedBlock(env: Env, principal: IntegrationPrincipal, id: string, includeTrash = false) {
  const row = await env.DB.prepare(
    `SELECT block.page_id, block.internal_id FROM api_blocks block
       JOIN pages page ON page.id = block.page_id
      WHERE block.id = ? AND page.workspace_id = ? ${includeTrash ? "" : "AND block.deleted_at IS NULL"}`,
  )
    .bind(id, principal.workspaceId)
    .first<{ page_id: string; internal_id: string }>();
  if (!row) throw new NotionError(404, "object_not_found", "Could not find page or block with the requested ID.");
  const page = await accessiblePage(env, principal, row.page_id, includeTrash);
  const envelope = await liveDocument(env, page);
  const block = findDocumentBlock(envelope.document, row.internal_id);
  if (!block && !includeTrash) {
    throw new NotionError(404, "object_not_found", "Could not find page or block with the requested ID.");
  }
  return { page, block, internalId: row.internal_id, metadata: await metadataForPage(env, page.id) };
}

async function mutateDocument(env: Env, page: IntegrationPage, principal: IntegrationPrincipal, operations: unknown[]) {
  const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/api-mutate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
      body: JSON.stringify({ actorId: principal.botUserId, operations }),
    }),
  );
  if (response.status === 404) throw new NotionError(404, "object_not_found", "Block not found.");
  if (response.status === 409) throw new NotionError(409, "conflict_error", "The document could not be changed.");
  if (response.status === 413) throw new NotionError(413, "validation_error", "The mutation exceeds document limits.");
  if (!response.ok) throw new NotionError(400, "validation_error", "The block mutation is invalid.");
  return response.json<{ document: DocumentContentEnvelope["document"] }>();
}

function notionChildren(value: unknown) {
  if (!Array.isArray(value) || value.length > NOTION_PAGE_SIZE_MAX) {
    throw new NotionError(400, "validation_error", "children must contain at most 100 blocks.");
  }
  try {
    return value.map((child) => notionInputToBlockContainer(child));
  } catch (error) {
    throw new NotionError(400, "validation_error", error instanceof Error ? error.message : "Invalid block.");
  }
}

function requestedPosition(value: unknown): { type: "start" | "end" } | { type: "after_block"; id: string } {
  if (value === undefined) return { type: "end" as const };
  if (!value || typeof value !== "object") throw new NotionError(400, "validation_error", "position is invalid.");
  const position = value as Record<string, unknown>;
  if (position.type === "start" || position.type === "end") return { type: position.type };
  if (position.type === "after_block") {
    const after = position.after_block as Record<string, unknown> | undefined;
    if (typeof after?.id !== "string") throw new NotionError(400, "validation_error", "after_block.id is required.");
    return { type: "after_block" as const, id: after.id };
  }
  throw new NotionError(400, "validation_error", "position.type must be start, end, or after_block.");
}

notionApi.get("/pages/:pageId", async (c) => {
  const principal = c.get("principal");
  capability(principal, "readContent");
  return c.json(
    await pageObject(
      c.env,
      await accessiblePage(c.env, principal, c.req.param("pageId"), true),
      new URL(c.req.url).origin,
    ),
  );
});

notionApi.get("/pages/:pageId/properties/:propertyId", async (c) => {
  const principal = c.get("principal");
  capability(principal, "readContent");
  if (c.req.param("propertyId") !== "title") {
    throw new NotionError(404, "object_not_found", "Property not found.");
  }
  const page = await accessiblePage(c.env, principal, c.req.param("pageId"));
  const richText = (await pageObject(c.env, page, new URL(c.req.url).origin)).properties.title.title;
  return c.json({
    object: "list",
    results: richText.map((item: unknown) => ({ object: "property_item", id: "title", type: "title", title: item })),
    next_cursor: null,
    has_more: false,
    type: "property_item",
    property_item: { id: "title", type: "title", title: {} },
  });
});

notionApi.post("/pages", async (c) => {
  const principal = c.get("principal");
  capability(principal, "insertContent");
  const input = await body(c.req.raw);
  if (input.cover !== undefined || input.template !== undefined || input.is_locked !== undefined) {
    throw new NotionError(400, "validation_error", "Covers, templates, and locking are not supported.");
  }
  const parent = (input.parent ?? {}) as Record<string, unknown>;
  let parentPage: IntegrationPage | null = null;
  let parentId: string | null = null;
  let spaceId = `${principal.workspaceId}-general`;
  if (typeof parent.page_id === "string") {
    parentPage = await accessiblePage(c.env, principal, parent.page_id);
    parentId = parentPage.id;
    spaceId = parentPage.space_id;
  } else if (!(parent.type === "workspace" || parent.workspace === true)) {
    throw new NotionError(400, "validation_error", "Only workspace and page parents are supported.");
  }
  const properties = (input.properties ?? {}) as Record<string, unknown>;
  const titleProperty = (properties.title ?? {}) as Record<string, unknown>;
  const title = plainTitle(titleProperty.title ?? titleProperty.rich_text ?? []);
  const pageId = crypto.randomUUID();
  const previous = await c.env.DB.prepare(
    `SELECT position FROM pages WHERE workspace_id = ? AND space_id = ? AND parent_id IS ? ORDER BY position DESC LIMIT 1`,
  )
    .bind(principal.workspaceId, spaceId, parentId)
    .first<{ position: string }>();
  const timestamp = Date.now();
  const icon = (input.icon ?? null) as Record<string, unknown> | null;
  const iconValue = icon?.type === "emoji" && typeof icon.emoji === "string" ? icon.emoji : null;
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO pages
        (id, workspace_id, space_id, parent_id, kind, position, title, icon, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'document', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      pageId,
      principal.workspaceId,
      spaceId,
      parentId,
      generateJitteredKeyBetween(previous?.position ?? null, null),
      title || "Untitled",
      iconValue,
      principal.botUserId,
      principal.botUserId,
      timestamp,
      timestamp,
    ),
    c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, '')`).bind(
      pageId,
      principal.workspaceId,
      title || "Untitled",
    ),
    ...refreshPageSearchV2Statements(c.env.DB, pageId),
    ...webhookEventStatements(c.env.DB, {
      workspaceId: principal.workspaceId,
      type: "page.created",
      entityType: "page",
      entityId: pageId,
      pageId,
      actorId: principal.botUserId,
      sourceKey: `page.created:${pageId}`,
      createdAt: timestamp,
    }),
  ];
  if (!parentPage) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO integration_grants (integration_id, root_page_id, created_by, created_at) VALUES (?, ?, ?, ?)`,
      ).bind(principal.integrationId, pageId, principal.botUserId, timestamp),
    );
  }
  await c.env.DB.batch(statements);
  enqueueWebhooks(c);
  const createdPage = (await pageRowsForSubtree(c.env, principal.workspaceId, pageId))[0];
  if (createdPage) {
    enqueueWorkspaceEvent(c, principal.workspaceId, { type: "pages-upserted", pages: [pageJson(createdPage)] });
  }
  const children = input.children === undefined ? [] : notionChildren(input.children);
  if (children.length) {
    await mutateDocument(c.env, (await accessiblePage(c.env, principal, pageId))!, principal, [
      { type: "append_children", children, position: { type: "end" } },
    ]);
  }
  return c.json(
    await pageObject(c.env, (await accessiblePage(c.env, principal, pageId))!, new URL(c.req.url).origin),
    200,
  );
});

async function changePage(c: Context<ApiContext>, mode?: "move" | "trash") {
  const principal = c.get("principal") as IntegrationPrincipal;
  capability(principal, "updateContent");
  const page = await accessiblePage(c.env, principal, c.req.param("pageId")!, true);
  const input = await body(c.req.raw, mode === "trash");
  const timestamp = Date.now();
  let workspaceEvent: WorkspaceEvent | null = null;
  if (mode === "move") {
    const parent = (input.parent ?? input) as Record<string, unknown>;
    let parentId: string | null = null;
    let spaceId = page.space_id;
    if (typeof parent.page_id === "string") {
      const destination = await accessiblePage(c.env, principal, parent.page_id);
      if (destination.id === page.id) throw new NotionError(400, "validation_error", "A page cannot contain itself.");
      const cycle = await c.env.DB.prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM pages WHERE id = ? UNION ALL SELECT child.id FROM pages child JOIN descendants parent ON child.parent_id = parent.id
         ) SELECT 1 found FROM descendants WHERE id = ?`,
      )
        .bind(page.id, destination.id)
        .first();
      if (cycle) throw new NotionError(409, "conflict_error", "Moving the page would create a cycle.");
      parentId = destination.id;
      spaceId = destination.space_id;
    } else if (!(parent.type === "workspace" || parent.workspace === true)) {
      throw new NotionError(400, "validation_error", "Only workspace and page parents are supported.");
    }
    const previous = await c.env.DB.prepare(
      `SELECT position FROM pages WHERE workspace_id = ? AND space_id = ? AND parent_id IS ? AND id <> ? ORDER BY position DESC LIMIT 1`,
    )
      .bind(principal.workspaceId, spaceId, parentId, page.id)
      .first<{ position: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM pages WHERE id = ?
           UNION ALL SELECT child.id FROM pages child JOIN tree parent ON child.parent_id = parent.id
         ) UPDATE pages SET
             parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END,
             space_id = ?,
             position = CASE WHEN id = ? THEN ? ELSE position END,
             revision = revision + 1,
             updated_by = CASE WHEN id = ? THEN ? ELSE updated_by END,
             updated_at = CASE WHEN id = ? THEN ? ELSE updated_at END
           WHERE id IN (SELECT id FROM tree)`,
      ).bind(
        page.id,
        page.id,
        parentId,
        spaceId,
        page.id,
        generateJitteredKeyBetween(previous?.position ?? null, null),
        page.id,
        principal.botUserId,
        page.id,
        timestamp,
      ),
      c.env.DB.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT ? UNION ALL SELECT child.id FROM pages child JOIN tree parent ON child.parent_id = parent.id
         ) UPDATE page_search_v2 SET space_id = ? WHERE page_id IN (SELECT id FROM tree)`,
      ).bind(page.id, spaceId),
      ...webhookEventStatements(c.env.DB, {
        workspaceId: principal.workspaceId,
        type: "page.moved",
        entityType: "page",
        entityId: page.id,
        pageId: page.id,
        actorId: principal.botUserId,
        sourceKey: `page.moved:${page.id}:${timestamp}`,
        data: { parent_id: parentId },
        createdAt: timestamp,
      }),
    ]);
    workspaceEvent = { type: "workspace-invalidated" };
  } else {
    const inTrash = mode === "trash" ? true : input.in_trash;
    const titleProperty = ((input.properties ?? {}) as Record<string, unknown>).title as
      | Record<string, unknown>
      | undefined;
    const title = titleProperty ? plainTitle(titleProperty.title ?? titleProperty.rich_text ?? []) : null;
    let icon: string | null | undefined;
    if (input.icon === null) icon = null;
    else if (input.icon && typeof input.icon === "object") {
      const requested = input.icon as Record<string, unknown>;
      if (requested.type !== "emoji" || typeof requested.emoji !== "string") {
        throw new NotionError(400, "validation_error", "Only emoji page icons are supported.");
      }
      icon = requested.emoji;
    }
    if (inTrash !== undefined && typeof inTrash !== "boolean") {
      throw new NotionError(400, "validation_error", "in_trash must be true or false.");
    }
    const eventType: WebhookEventType =
      inTrash === true ? "page.deleted" : inTrash === false ? "page.undeleted" : "page.properties_updated";
    const statements = [
      inTrash === undefined
        ? c.env.DB.prepare(
            `UPDATE pages SET title = COALESCE(?, title), icon = CASE WHEN ? THEN ? ELSE icon END,
                revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
          ).bind(title, icon !== undefined ? 1 : 0, icon ?? null, principal.botUserId, timestamp, page.id)
        : c.env.DB.prepare(
            `WITH RECURSIVE tree(id) AS (
               SELECT id FROM pages WHERE id = ?
               UNION ALL SELECT child.id FROM pages child JOIN tree parent ON child.parent_id = parent.id
             ) UPDATE pages SET
                 title = CASE WHEN id = ? THEN COALESCE(?, title) ELSE title END,
                 icon = CASE WHEN id = ? AND ? THEN ? ELSE icon END,
                 archived_at = ?, archived_by = ?, revision = revision + 1,
                 updated_by = ?, updated_at = ? WHERE id IN (SELECT id FROM tree)`,
          ).bind(
            page.id,
            page.id,
            title,
            page.id,
            icon !== undefined ? 1 : 0,
            icon ?? null,
            inTrash ? timestamp : null,
            inTrash ? principal.botUserId : null,
            principal.botUserId,
            timestamp,
          ),
      ...webhookEventStatements(c.env.DB, {
        workspaceId: principal.workspaceId,
        type: eventType,
        entityType: "page",
        entityId: page.id,
        pageId: page.id,
        actorId: principal.botUserId,
        sourceKey: `${eventType}:${page.id}:${timestamp}`,
        createdAt: timestamp,
      }),
    ];
    if (inTrash === undefined) {
      statements.push(
        c.env.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(page.id),
        c.env.DB.prepare(
          `INSERT INTO page_search (page_id, workspace_id, title, body)
           SELECT id, workspace_id, title, COALESCE(plain_text, '') FROM pages
            WHERE id = ? AND archived_at IS NULL AND import_job_id IS NULL`,
        ).bind(page.id),
        ...refreshPageSearchV2Statements(c.env.DB, page.id),
      );
    } else {
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM page_search WHERE page_id IN (
             WITH RECURSIVE tree(id) AS (
               SELECT ? UNION ALL SELECT child.id FROM pages child JOIN tree parent ON child.parent_id = parent.id
             ) SELECT id FROM tree
           )`,
        ).bind(page.id),
      );
      if (!inTrash) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO page_search (page_id, workspace_id, title, body)
             SELECT id, workspace_id, title, COALESCE(plain_text, '') FROM pages WHERE id IN (
               WITH RECURSIVE tree(id) AS (
                 SELECT ? UNION ALL SELECT child.id FROM pages child JOIN tree parent ON child.parent_id = parent.id
               ) SELECT id FROM tree
             ) AND archived_at IS NULL AND import_job_id IS NULL`,
          ).bind(page.id),
        );
      }
      statements.push(...refreshPageSearchV2SubtreeStatements(c.env.DB, page.id));
    }
    await c.env.DB.batch(statements);
    const subtree = await pageRowsForSubtree(c.env, principal.workspaceId, page.id);
    if (inTrash === true) {
      workspaceEvent = { type: "pages-removed", pageIds: subtree.map((item) => item.id), permanently: false };
    } else if (inTrash === false) {
      workspaceEvent = {
        type: "pages-upserted",
        pages: subtree.filter((item) => item.archived_at === null).map(pageJson),
        restored: true,
        restoredRootId: page.id,
      };
    } else {
      const root = subtree.find((item) => item.id === page.id);
      if (root) workspaceEvent = { type: "pages-upserted", pages: [pageJson(root)] };
    }
    if (inTrash === true) {
      await c.env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
        new Request("https://document.internal/archive", {
          method: "POST",
          headers: { "x-notes-internal": c.env.BETTER_AUTH_SECRET },
        }),
      );
    }
  }
  enqueueWebhooks(c);
  if (workspaceEvent) enqueueWorkspaceEvent(c, principal.workspaceId, workspaceEvent);
  const updated = await c.env.DB.prepare(`SELECT * FROM pages WHERE id = ? AND workspace_id = ?`)
    .bind(page.id, principal.workspaceId)
    .first<IntegrationPage>();
  if (!updated) throw new NotionError(404, "object_not_found", "Page not found.");
  return c.json(await pageObject(c.env, updated, new URL(c.req.url).origin));
}

notionApi.patch("/pages/:pageId", (c) => changePage(c));
notionApi.post("/pages/:pageId/move", (c) => changePage(c, "move"));
notionApi.post("/pages/:pageId/trash", (c) => changePage(c, "trash"));

notionApi.get("/blocks/:blockId", async (c) => {
  const principal = c.get("principal");
  capability(principal, "readContent");
  const located = await locatedBlock(c.env, principal, c.req.param("blockId"));
  return c.json(await blockObject(c.env, located.page, located.block!, located.metadata));
});

notionApi.get("/blocks/:blockId/children", async (c) => {
  const principal = c.get("principal");
  capability(principal, "readContent");
  const { size, offset } = pagination({
    page_size: c.req.query("page_size"),
    start_cursor: c.req.query("start_cursor"),
  });
  const page = await pageForIntegration(c.env, principal, c.req.param("blockId"));
  let blocks: NotionBlock[];
  let owner: IntegrationPage;
  if (page?.kind === "document") {
    owner = page;
    blocks = documentBlocks((await liveDocument(c.env, page)).document);
  } else {
    const located = await locatedBlock(c.env, principal, c.req.param("blockId"));
    owner = located.page;
    blocks = located.block!.children;
  }
  const metadata = await metadataForPage(c.env, owner.id);
  const selected = blocks.slice(offset, offset + size + 1);
  const results = await Promise.all(selected.map((block) => blockObject(c.env, owner, block, metadata)));
  if (page) {
    const childPages = await c.env.DB.prepare(
      `SELECT * FROM pages WHERE parent_id = ? AND workspace_id = ? AND archived_at IS NULL AND kind = 'document'
        ORDER BY position, id LIMIT ? OFFSET ?`,
    )
      .bind(page.id, principal.workspaceId, size + 1, Math.max(0, offset - blocks.length))
      .all<IntegrationPage>();
    if (offset + results.length >= blocks.length) {
      for (const child of childPages.results.slice(0, size + 1 - results.length)) {
        results.push({
          object: "block",
          id: await publicPageId(c.env, child.id),
          parent: { type: "page_id", page_id: await publicPageId(c.env, page.id) },
          created_time: iso(child.created_at),
          last_edited_time: iso(child.updated_at),
          created_by: actorObject(child.created_by),
          last_edited_by: actorObject(child.updated_by),
          has_children: false,
          in_trash: false,
          type: "child_page",
          child_page: { title: child.title },
        });
      }
    }
  }
  return c.json(listEnvelope(results, offset, size, "block"));
});

notionApi.patch("/blocks/:blockId/children", async (c) => {
  const principal = c.get("principal");
  capability(principal, "insertContent");
  const input = await body(c.req.raw);
  const children = notionChildren(input.children);
  const position = requestedPosition(input.position);
  const page = await pageForIntegration(c.env, principal, c.req.param("blockId"));
  let owner: IntegrationPage;
  let parentInternalId: string | undefined;
  if (page?.kind === "document") owner = page;
  else {
    const located = await locatedBlock(c.env, principal, c.req.param("blockId"));
    owner = located.page;
    parentInternalId = located.internalId;
  }
  let afterInternalId: string | undefined;
  if (position.type === "after_block") {
    const after = await locatedBlock(c.env, principal, position.id);
    if (after.page.id !== owner.id)
      throw new NotionError(400, "validation_error", "after_block belongs to another page.");
    afterInternalId = after.internalId;
  }
  const mutated = await mutateDocument(c.env, owner, principal, [
    {
      type: "append_children",
      ...(parentInternalId ? { parentInternalId } : {}),
      children,
      position: { type: position.type, ...(afterInternalId ? { afterInternalId } : {}) },
    },
  ]);
  const metadata = await metadataForPage(c.env, owner.id);
  const inserted = children
    .map((container) => findDocumentBlock(mutated.document, String(container.attrs?.id)))
    .filter((item): item is NotionBlock => Boolean(item));
  return c.json({
    object: "list",
    results: await Promise.all(inserted.map((block) => blockObject(c.env, owner, block, metadata))),
    next_cursor: null,
    has_more: false,
    type: "block",
    block: {},
  });
});

notionApi.patch("/blocks/:blockId", async (c) => {
  const principal = c.get("principal");
  capability(principal, "updateContent");
  const located = await locatedBlock(c.env, principal, c.req.param("blockId"));
  const input = await body(c.req.raw);
  if (input.in_trash === true) {
    await mutateDocument(c.env, located.page, principal, [{ type: "delete_block", internalId: located.internalId }]);
    return c.json({ ...(await blockObject(c.env, located.page, located.block!, located.metadata)), in_trash: true });
  }
  let container;
  try {
    container = notionInputToBlockContainer({ ...input, id: located.internalId });
  } catch (error) {
    throw new NotionError(400, "validation_error", error instanceof Error ? error.message : "Invalid block.");
  }
  const node = container.content?.find((child) => child.type !== "blockGroup");
  if (!node) throw new NotionError(400, "validation_error", "Block content is required.");
  const mutated = await mutateDocument(c.env, located.page, principal, [
    { type: "update_block", internalId: located.internalId, node },
  ]);
  const updated = findDocumentBlock(mutated.document, located.internalId)!;
  return c.json(await blockObject(c.env, located.page, updated, await metadataForPage(c.env, located.page.id)));
});

notionApi.delete("/blocks/:blockId", async (c) => {
  const principal = c.get("principal");
  capability(principal, "updateContent");
  const located = await locatedBlock(c.env, principal, c.req.param("blockId"));
  await mutateDocument(c.env, located.page, principal, [{ type: "delete_block", internalId: located.internalId }]);
  return c.json({ ...(await blockObject(c.env, located.page, located.block!, located.metadata)), in_trash: true });
});

notionApi.post("/search", async (c) => {
  const principal = c.get("principal");
  capability(principal, "readContent");
  const input = await body(c.req.raw);
  const { size, offset } = pagination(input);
  const query = typeof input.query === "string" ? input.query.slice(0, 200) : "";
  const rows = await c.env.DB.prepare(
    `WITH RECURSIVE granted(id) AS (
       SELECT root_page_id FROM integration_grants WHERE integration_id = ?
       UNION SELECT child.id FROM pages child JOIN granted parent ON child.parent_id = parent.id
     ) SELECT page.* FROM pages page JOIN granted ON granted.id = page.id
       WHERE page.workspace_id = ? AND page.kind = 'document' AND page.archived_at IS NULL AND page.import_job_id IS NULL
         AND page.title LIKE ? ESCAPE '\\' ORDER BY page.updated_at DESC, page.id LIMIT ? OFFSET ?`,
  )
    .bind(
      principal.integrationId,
      principal.workspaceId,
      `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
      size + 1,
      offset,
    )
    .all<IntegrationPage>();
  const origin = new URL(c.req.url).origin;
  const pageData = await preloadPageObjectData(c.env, rows.results, origin);
  const results = await Promise.all(rows.results.map((page) => pageObject(c.env, page, origin, pageData)));
  return c.json(listEnvelope(results, offset, size));
});

function userObject(
  row: { id: string; name: string; email: string; image: string | null; account_type: string },
  principal: IntegrationPrincipal,
) {
  if (row.account_type === "bot")
    return {
      object: "user",
      id: row.id,
      type: "bot",
      name: row.name,
      avatar_url: row.image,
      bot: { owner: { type: "workspace", workspace: true }, workspace_name: principal.workspaceName },
    };
  return {
    object: "user",
    id: row.id,
    type: "person",
    name: row.name,
    avatar_url: row.image,
    person: principal.userInformation === "email" ? { email: row.email } : {},
  };
}

notionApi.get("/users/me", async (c) => {
  const principal = c.get("principal");
  const row = await c.env.DB.prepare(`SELECT id, name, email, image, account_type FROM user WHERE id = ?`)
    .bind(principal.botUserId)
    .first<{ id: string; name: string; email: string; image: string | null; account_type: string }>();
  return c.json(userObject(row!, principal));
});

notionApi.get("/users", async (c) => {
  const principal = c.get("principal");
  if (principal.userInformation === "none")
    throw new NotionError(403, "restricted_resource", "User information capability is required.");
  const { size, offset } = pagination({
    page_size: c.req.query("page_size"),
    start_cursor: c.req.query("start_cursor"),
  });
  const rows = await c.env.DB.prepare(
    `SELECT user.id, user.name, user.email, user.image, user.account_type FROM workspace_members member
       JOIN user ON user.id = member.user_id WHERE member.workspace_id = ? AND user.account_type = 'person'
      ORDER BY user.name, user.id LIMIT ? OFFSET ?`,
  )
    .bind(principal.workspaceId, size + 1, offset)
    .all<{ id: string; name: string; email: string; image: string | null; account_type: string }>();
  return c.json(
    listEnvelope(
      rows.results.map((row) => userObject(row, principal)),
      offset,
      size,
      "user",
    ),
  );
});

notionApi.get("/users/:userId", async (c) => {
  const principal = c.get("principal");
  if (principal.userInformation === "none")
    throw new NotionError(403, "restricted_resource", "User information capability is required.");
  const row = await c.env.DB.prepare(
    `SELECT user.id, user.name, user.email, user.image, user.account_type FROM user
       LEFT JOIN workspace_members member ON member.user_id = user.id AND member.workspace_id = ?
       LEFT JOIN integrations integration ON integration.bot_user_id = user.id AND integration.workspace_id = ?
      WHERE user.id = ? AND (member.user_id IS NOT NULL OR integration.id IS NOT NULL)`,
  )
    .bind(principal.workspaceId, principal.workspaceId, c.req.param("userId"))
    .first<{ id: string; name: string; email: string; image: string | null; account_type: string }>();
  if (!row) throw new NotionError(404, "object_not_found", "User not found.");
  return c.json(userObject(row, principal));
});

type ApiCommentRow = {
  id: string;
  thread_id: string;
  block_id: string | null;
  page_id: string;
  user_id: string;
  plain_text: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
};
function commentObject(row: ApiCommentRow) {
  return {
    object: "comment",
    id: row.id,
    parent: row.block_id ? { type: "block_id", block_id: row.block_id } : { type: "page_id", page_id: row.page_id },
    discussion_id: row.thread_id,
    created_time: iso(row.created_at),
    last_edited_time: iso(row.updated_at),
    created_by: actorObject(row.user_id),
    rich_text: row.deleted_at ? [] : proseMirrorInlineToNotion([{ type: "text", text: row.plain_text }]),
  };
}

async function commentRows(env: Env, where: string, binds: unknown[], orderBy = "") {
  return env.DB.prepare(
    `SELECT comment.id, comment.thread_id, thread.block_id, thread.page_id, comment.user_id, comment.plain_text, comment.deleted_at, comment.created_at, comment.updated_at FROM comments comment JOIN comment_threads thread ON thread.id = comment.thread_id WHERE ${where}${orderBy ? ` ORDER BY ${orderBy}` : ""}`,
  )
    .bind(...binds)
    .all<ApiCommentRow>();
}

notionApi.get("/comments", async (c) => {
  const principal = c.get("principal");
  capability(principal, "readComments");
  const blockId = c.req.query("block_id");
  if (!blockId) throw new NotionError(400, "validation_error", "block_id is required.");
  const page = await pageForIntegration(c.env, principal, blockId);
  let internalPage: IntegrationPage;
  let matchId: string | null = null;
  if (page) internalPage = page;
  else {
    const block = await locatedBlock(c.env, principal, blockId);
    internalPage = block.page;
    matchId = blockId;
  }
  const rows = await commentRows(
    c.env,
    `thread.page_id = ? AND thread.block_id IS ? AND comment.deleted_at IS NULL`,
    [internalPage.id, matchId],
    "comment.created_at",
  );
  return c.json({
    object: "list",
    results: rows.results.map(commentObject),
    next_cursor: null,
    has_more: false,
    type: "comment",
    comment: {},
  });
});

notionApi.post("/comments", async (c) => {
  const principal = c.get("principal");
  capability(principal, "insertComments");
  const input = await body(c.req.raw);
  const parent = (input.parent ?? {}) as Record<string, unknown>;
  const suppliedId =
    typeof parent.page_id === "string" ? parent.page_id : typeof parent.block_id === "string" ? parent.block_id : "";
  if (!suppliedId) throw new NotionError(400, "validation_error", "A page_id or block_id parent is required.");
  let page = await pageForIntegration(c.env, principal, suppliedId);
  let blockId: string | null = null;
  if (!page) {
    const block = await locatedBlock(c.env, principal, suppliedId);
    page = block.page;
    blockId = suppliedId;
  }
  const content = plainTitle(input.rich_text ?? []);
  if (!content) throw new NotionError(400, "validation_error", "Comment rich_text is required.");
  const timestamp = Date.now();
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO comment_threads (id, workspace_id, space_id, page_id, block_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(threadId, principal.workspaceId, page.space_id, page.id, blockId, principal.botUserId, timestamp, timestamp),
    c.env.DB.prepare(
      `INSERT INTO comments (id, thread_id, user_id, body_json, plain_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      commentId,
      threadId,
      principal.botUserId,
      JSON.stringify([{ type: "text", text: content }]),
      content,
      timestamp,
      timestamp,
    ),
    ...webhookEventStatements(c.env.DB, {
      workspaceId: principal.workspaceId,
      type: "comment.created",
      entityType: "comment",
      entityId: commentId,
      pageId: page.id,
      actorId: principal.botUserId,
      sourceKey: `comment.created:${commentId}`,
      createdAt: timestamp,
    }),
  ]);
  enqueueWebhooks(c);
  return c.json(
    commentObject({
      id: commentId,
      thread_id: threadId,
      block_id: blockId,
      page_id: page.id,
      user_id: principal.botUserId,
      plain_text: content,
      deleted_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    }),
    200,
  );
});

async function existingComment(env: Env, principal: IntegrationPrincipal, id: string) {
  const rows = await commentRows(env, `comment.id = ?`, [id]);
  const row = rows.results[0];
  if (!row || !(await pageForIntegration(env, principal, row.page_id)) || row.user_id !== principal.botUserId) {
    throw new NotionError(404, "object_not_found", "Comment not found.");
  }
  return row;
}

notionApi.patch("/comments/:commentId", async (c) => {
  const principal = c.get("principal");
  capability(principal, "insertComments");
  const existing = await existingComment(c.env, principal, c.req.param("commentId"));
  const input = await body(c.req.raw);
  const content = plainTitle(input.rich_text ?? []);
  if (!content) throw new NotionError(400, "validation_error", "Comment rich_text is required.");
  const timestamp = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE comments SET plain_text = ?, body_json = ?, updated_at = ? WHERE id = ?`).bind(
      content,
      JSON.stringify([{ type: "text", text: content }]),
      timestamp,
      existing.id,
    ),
    ...webhookEventStatements(c.env.DB, {
      workspaceId: principal.workspaceId,
      type: "comment.updated",
      entityType: "comment",
      entityId: existing.id,
      pageId: existing.page_id,
      actorId: principal.botUserId,
      sourceKey: `comment.updated:${existing.id}:${timestamp}`,
      createdAt: timestamp,
    }),
  ]);
  enqueueWebhooks(c);
  return c.json(commentObject({ ...existing, plain_text: content, updated_at: timestamp }));
});

notionApi.delete("/comments/:commentId", async (c) => {
  const principal = c.get("principal");
  capability(principal, "insertComments");
  const existing = await existingComment(c.env, principal, c.req.param("commentId"));
  const timestamp = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE comments SET deleted_at = ?, updated_at = ?, plain_text = '', body_json = 'null' WHERE id = ?`,
    ).bind(timestamp, timestamp, existing.id),
    ...webhookEventStatements(c.env.DB, {
      workspaceId: principal.workspaceId,
      type: "comment.deleted",
      entityType: "comment",
      entityId: existing.id,
      pageId: existing.page_id,
      actorId: principal.botUserId,
      sourceKey: `comment.deleted:${existing.id}`,
      createdAt: timestamp,
    }),
  ]);
  enqueueWebhooks(c);
  return c.json(commentObject({ ...existing, deleted_at: timestamp, updated_at: timestamp, plain_text: "" }));
});

export { notionApi };

async function notionFileUrl(env: Env, attachmentId: string, expires: number) {
  const signature = await hmacSha256Hex(env.BETTER_AUTH_SECRET, `${attachmentId}:${expires}`);
  return new URL(
    `/v1/files/${encodeURIComponent(attachmentId)}?expires=${expires}&signature=${signature}`,
    env.BETTER_AUTH_URL,
  ).toString();
}

export async function notionFileResponse(request: Request, env: Env, attachmentId: string) {
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 2 * 60 * 60_000) return null;
  const expected = await hmacSha256Hex(env.BETTER_AUTH_SECRET, `${attachmentId}:${expires}`);
  if (!constantTimeEqual(signature, expected)) return null;
  const attachment = await env.DB.prepare(`SELECT r2_key, name, mime FROM attachments WHERE id = ?`)
    .bind(attachmentId)
    .first<{ r2_key: string; name: string; mime: string }>();
  if (!attachment) return null;
  const object = await env.BUCKET.get(attachment.r2_key);
  if (!object) return null;
  return new Response(object.body, {
    headers: {
      "content-type": attachment.mime,
      "content-disposition": attachmentDisposition(attachment.name, isInlineMime(attachment.mime)),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
