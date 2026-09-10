import { documentBlocks } from "../shared/notion-blocks";
import {
  collectLinkedDiagramIds,
  collectTransclusions,
  projectDocument,
  serializeDocument,
} from "../shared/document-projection";
import { bytesToBase64Url } from "../shared/security";
import type { DocumentContentEnvelope, PageKind, ProseMirrorJson } from "../shared/types";
import { isInlineMime } from "./attachments";
import { diagramThumbnailResponse } from "./diagram-thumbnail";
import type { Env, MemberContext } from "./env";
import { attachmentDisposition, HttpError } from "./http";

const PUBLIC_DOCUMENT_FETCH_TIMEOUT_MS = 5_000;

export type ShareRow = {
  id: string;
  workspace_id: string;
  root_page_id: string;
  url_key: string;
  include_subpages: number;
  allow_indexing: number;
  show_toc: number;
  show_last_updated: number;
  views: number;
  last_accessed_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
};

export type SharedPageRow = ShareRow & {
  page_id: string;
  parent_id: string | null;
  page_title: string;
  page_icon: string | null;
  page_kind: PageKind;
  content_epoch: number;
  page_updated_at: number;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function randomUrlKey() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

function shareJson(row: ShareRow, origin: string) {
  return {
    id: row.id,
    rootPageId: row.root_page_id,
    url: `${origin}/share/${row.url_key}`,
    includeSubpages: Boolean(row.include_subpages),
    allowIndexing: Boolean(row.allow_indexing),
    showToc: Boolean(row.show_toc),
    showLastUpdated: Boolean(row.show_last_updated),
    views: row.views,
    lastAccessedAt: row.last_accessed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function activeShareForPage(env: Env, member: MemberContext, pageId: string) {
  const row = await env.DB.prepare(
    `SELECT share.* FROM share_links share JOIN pages page ON page.id = share.root_page_id
      WHERE share.root_page_id = ? AND share.workspace_id = ? AND share.revoked_at IS NULL
        AND page.archived_at IS NULL AND page.import_job_id IS NULL`,
  )
    .bind(pageId, member.workspace.id)
    .first<ShareRow>();
  return row;
}

export async function getShare(env: Env, member: MemberContext, pageId: string, origin: string) {
  const page = await env.DB.prepare(`SELECT id FROM pages WHERE id = ? AND workspace_id = ?`)
    .bind(pageId, member.workspace.id)
    .first();
  if (!page) throw new HttpError(404, "page_not_found", "Page not found.");
  const row = await activeShareForPage(env, member, pageId);
  return row ? shareJson(row, origin) : null;
}

export async function createShare(
  env: Env,
  member: MemberContext,
  pageId: string,
  origin: string,
  options: Partial<{ includeSubpages: boolean; allowIndexing: boolean; showToc: boolean; showLastUpdated: boolean }>,
) {
  const page = await env.DB.prepare(
    `SELECT id, kind FROM pages WHERE id = ? AND workspace_id = ? AND archived_at IS NULL AND import_job_id IS NULL`,
  )
    .bind(pageId, member.workspace.id)
    .first<{ id: string; kind: PageKind }>();
  if (!page) throw new HttpError(404, "page_not_found", "Page not found.");
  if (page.kind === "diagram") {
    throw new HttpError(422, "share_unavailable", "Public diagram shares are not available yet.");
  }
  const existing = await activeShareForPage(env, member, pageId);
  if (existing) return shareJson(existing, origin);
  const timestamp = Date.now();
  const id = crypto.randomUUID();
  const urlKey = randomUrlKey();
  try {
    await env.DB.prepare(
      `INSERT INTO share_links
        (id, workspace_id, root_page_id, url_key, include_subpages, allow_indexing, show_toc,
         show_last_updated, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        member.workspace.id,
        pageId,
        urlKey,
        options.includeSubpages ? 1 : 0,
        options.allowIndexing ? 1 : 0,
        options.showToc === false ? 0 : 1,
        options.showLastUpdated === false ? 0 : 1,
        member.user.id,
        timestamp,
        timestamp,
      )
      .run();
  } catch (error) {
    const raced = await activeShareForPage(env, member, pageId);
    if (raced) return shareJson(raced, origin);
    throw error;
  }
  return shareJson(
    {
      id,
      workspace_id: member.workspace.id,
      root_page_id: pageId,
      url_key: urlKey,
      include_subpages: options.includeSubpages ? 1 : 0,
      allow_indexing: options.allowIndexing ? 1 : 0,
      show_toc: options.showToc === false ? 0 : 1,
      show_last_updated: options.showLastUpdated === false ? 0 : 1,
      views: 0,
      last_accessed_at: null,
      revoked_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    origin,
  );
}

export async function updateShare(
  env: Env,
  member: MemberContext,
  pageId: string,
  origin: string,
  options: Partial<{ includeSubpages: boolean; allowIndexing: boolean; showToc: boolean; showLastUpdated: boolean }>,
) {
  const existing = await activeShareForPage(env, member, pageId);
  if (!existing) throw new HttpError(404, "share_not_found", "Public share not found.");
  const updated = await env.DB.prepare(
    `UPDATE share_links SET
       include_subpages = COALESCE(?, include_subpages),
       allow_indexing = COALESCE(?, allow_indexing),
       show_toc = COALESCE(?, show_toc),
       show_last_updated = COALESCE(?, show_last_updated),
       updated_at = ?
     WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL RETURNING *`,
  )
    .bind(
      options.includeSubpages === undefined ? null : options.includeSubpages ? 1 : 0,
      options.allowIndexing === undefined ? null : options.allowIndexing ? 1 : 0,
      options.showToc === undefined ? null : options.showToc ? 1 : 0,
      options.showLastUpdated === undefined ? null : options.showLastUpdated ? 1 : 0,
      Date.now(),
      existing.id,
      member.workspace.id,
    )
    .first<ShareRow>();
  if (!updated) throw new HttpError(404, "share_not_found", "Public share not found.");
  return shareJson(updated, origin);
}

export async function revokeShare(env: Env, member: MemberContext, pageId: string) {
  const result = await env.DB.prepare(
    `UPDATE share_links SET revoked_at = ?, revoked_by = ?, updated_at = ?
      WHERE root_page_id = ? AND workspace_id = ? AND revoked_at IS NULL`,
  )
    .bind(Date.now(), member.user.id, Date.now(), pageId, member.workspace.id)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "share_not_found", "Public share not found.");
}

async function resolveSharedTarget(
  env: Env,
  key: string,
  requestedPageId: string | undefined,
  target: "page" | "diagram",
) {
  const share = await env.DB.prepare(`SELECT * FROM share_links WHERE url_key = ? AND revoked_at IS NULL`)
    .bind(key)
    .first<ShareRow>();
  if (!share) return null;
  const pageId = requestedPageId ?? share.root_page_id;
  const page = await env.DB.prepare(
    `WITH RECURSIVE ancestors(id, parent_id) AS (
       SELECT id, parent_id FROM pages WHERE id = ?
       UNION ALL
       SELECT parent.id, parent.parent_id FROM pages parent JOIN ancestors child ON parent.id = child.parent_id
     )
     SELECT share.*, page.id page_id, page.parent_id, page.title page_title, page.icon page_icon,
            page.kind page_kind, page.content_epoch, page.updated_at page_updated_at
       FROM share_links share JOIN pages page ON page.id = ?
      WHERE share.id = ? AND share.revoked_at IS NULL
        AND page.workspace_id = share.workspace_id AND page.archived_at IS NULL AND page.import_job_id IS NULL
        AND page.kind ${target === "diagram" ? "=" : "<>"} 'diagram'
        AND EXISTS (SELECT 1 FROM pages root WHERE root.id = share.root_page_id AND root.archived_at IS NULL)
        AND (page.id = share.root_page_id OR
             (share.include_subpages = 1 AND EXISTS (SELECT 1 FROM ancestors WHERE id = share.root_page_id)))`,
  )
    .bind(pageId, pageId, share.id)
    .first<SharedPageRow>();
  return page;
}

export function resolveSharedPage(env: Env, key: string, requestedPageId?: string) {
  return resolveSharedTarget(env, key, requestedPageId, "page");
}

export function resolveSharedDiagram(env: Env, key: string, pageId: string) {
  return resolveSharedTarget(env, key, pageId, "diagram");
}

async function sharedTree(env: Env, share: SharedPageRow) {
  if (!share.include_subpages) return [] as Array<{ id: string; title: string; parentId: string | null }>;
  const rows = await env.DB.prepare(
    `WITH RECURSIVE tree(id, parent_id, title, kind, position, depth) AS (
       SELECT id, parent_id, title, kind, position, 0 FROM pages WHERE id = ? AND archived_at IS NULL
       UNION ALL
       SELECT child.id, child.parent_id, child.title, child.kind, child.position, tree.depth + 1
         FROM pages child JOIN tree ON child.parent_id = tree.id
        WHERE child.archived_at IS NULL AND child.import_job_id IS NULL AND tree.depth < 50
     )
     SELECT id, parent_id parentId, title FROM tree WHERE kind <> 'diagram'
      ORDER BY depth, position, id LIMIT 500`,
  )
    .bind(share.root_page_id)
    .all<{ id: string; parentId: string | null; title: string }>();
  return rows.results;
}

async function breadcrumbs(env: Env, page: SharedPageRow) {
  const rows = await env.DB.prepare(
    `WITH RECURSIVE trail(id, parent_id, title, depth) AS (
       SELECT id, parent_id, title, 0 FROM pages WHERE id = ?
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.title, trail.depth + 1
         FROM pages parent JOIN trail ON parent.id = trail.parent_id WHERE trail.depth < 50
     )
     SELECT id, title FROM trail ORDER BY depth DESC`,
  )
    .bind(page.page_id)
    .all<{ id: string; title: string }>();
  const rootIndex = rows.results.findIndex((row) => row.id === page.root_page_id);
  return rootIndex < 0 ? [] : rows.results.slice(rootIndex);
}

function documentBody(html: string) {
  const match = /<body>([\s\S]*)<\/body>/i.exec(html);
  return match?.[1] ?? html;
}

export function publicDocumentHtml(
  document: DocumentContentEnvelope["document"],
  key: string,
  sourcePageId: string,
  transclusions: Map<string, string> = new Map(),
  sharedDiagramIds: ReadonlySet<string> = new Set(),
) {
  let body = documentBody(
    serializeDocument(document, {
      pageHref: (pageId, nodeType) =>
        nodeType === "linkToPage" ? `/share/${encodeURIComponent(key)}/pages/${encodeURIComponent(pageId)}` : null,
      linkedDiagramThumbnailHref: (pageId) =>
        sharedDiagramIds.has(pageId)
          ? `/share/${encodeURIComponent(key)}/diagram-thumbnails/${encodeURIComponent(pageId)}.svg?source=${encodeURIComponent(sourcePageId)}`
          : null,
    }).html,
  );
  const headings = documentBlocks(document)
    .flatMap(function flatten(block): ReturnType<typeof documentBlocks> {
      return [block, ...block.children.flatMap(flatten)];
    })
    .filter((block) => block.node.type === "heading" && Number(block.node.attrs?.level ?? 1) <= 4);
  let headingIndex = 0;
  body = body.replace(/<h([1-4])>/g, (_match, level: string) => {
    const block = headings[headingIndex++];
    return block ? `<h${level} id="block-${escapeHtml(block.id)}">` : `<h${level}>`;
  });
  const toc = headings.length
    ? `<nav class="public-toc"><strong>On this page</strong>${headings
        .map(
          (block) =>
            `<a style="padding-left:${(Number(block.node.attrs?.level ?? 1) - 1) * 12}px" href="#block-${escapeHtml(block.id)}">${escapeHtml(projectDocument(block.node).plainText)}</a>`,
        )
        .join("")}</nav>`
    : "";
  body = body.replace('<nav class="table-of-contents" data-derived-block="table-of-contents"></nav>', toc);
  body = body.replaceAll(
    /((?:href|src)=")\/api\/attachments\/([A-Za-z0-9_-]+)"/g,
    `$1/share/${encodeURIComponent(key)}/assets/$2"`,
  );
  body = body.replace(
    /<div class="synced-reference" data-source-page-id="([^"]*)" data-block-id="([^"]*)">[\s\S]*?<\/div>/g,
    (_match, transcludedSourcePageId: string, blockId: string) =>
      transclusions.get(`${transcludedSourcePageId}:${blockId}`) ??
      '<div class="synced-reference">Synced content unavailable</div>',
  );
  body = body.replaceAll(
    /href="\/?\?page=([A-Za-z0-9_-]+)"/g,
    (_match, pageId: string) => `href="/share/${encodeURIComponent(key)}/pages/${encodeURIComponent(pageId)}"`,
  );
  return { body, toc };
}

async function eligibleSharedDiagramIds(env: Env, share: SharedPageRow, requested: ReadonlySet<string>) {
  if (!share.include_subpages || !requested.size) return new Set<string>();
  const rows = await env.DB.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT ?
       UNION ALL SELECT child.id FROM pages child JOIN subtree ON child.parent_id = subtree.id
     )
     SELECT page.id
       FROM pages page JOIN subtree ON subtree.id = page.id
       JOIN json_each(?) requested ON requested.value = page.id
      WHERE page.workspace_id = ? AND page.kind = 'diagram'
        AND page.archived_at IS NULL AND page.import_job_id IS NULL`,
  )
    .bind(share.root_page_id, JSON.stringify([...requested]), share.workspace_id)
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}

async function publicTransclusions(
  env: Env,
  share: SharedPageRow,
  key: string,
  document: DocumentContentEnvelope["document"],
) {
  const unique = [
    ...new Map(
      collectTransclusions(document).references.map((reference) => [
        `${reference.sourcePageId}:${reference.blockId}`,
        reference,
      ]),
    ).values(),
  ].slice(0, 25);
  const entries = await Promise.all(
    unique.map(async (reference) => {
      const sourcePage = await resolveSharedPage(env, key, reference.sourcePageId);
      if (!sourcePage || sourcePage.workspace_id !== share.workspace_id || sourcePage.page_kind !== "document")
        return null;
      const response = await env.DOCUMENT.getByName(`${sourcePage.page_id}~${sourcePage.content_epoch}`).fetch(
        new Request("https://document.internal/content", {
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      );
      if (!response.ok) return null;
      const sourceDocument = await response.json<DocumentContentEnvelope>();
      const source = collectTransclusions(sourceDocument.document).sources.find(
        (item) => item.blockId === reference.blockId,
      );
      if (!source) return null;
      return {
        key: `${reference.sourcePageId}:${reference.blockId}`,
        sourcePageId: sourcePage.page_id,
        document: { type: "doc", content: [{ type: "blockGroup", content: source.content }] } as ProseMirrorJson,
      };
    }),
  );
  const requestedDiagramIds = collectLinkedDiagramIds(document);
  for (const entry of entries) {
    if (entry) collectLinkedDiagramIds(entry.document, requestedDiagramIds);
  }
  const availableDiagramIds = await eligibleSharedDiagramIds(env, share, requestedDiagramIds);
  const available = new Map<string, string>();
  for (const entry of entries) {
    if (!entry) continue;
    let html = documentBody(
      serializeDocument(entry.document, {
        pageHref: (pageId, nodeType) =>
          nodeType === "linkToPage" ? `/share/${encodeURIComponent(key)}/pages/${encodeURIComponent(pageId)}` : null,
        linkedDiagramThumbnailHref: (pageId) =>
          availableDiagramIds.has(pageId)
            ? `/share/${encodeURIComponent(key)}/diagram-thumbnails/${encodeURIComponent(pageId)}.svg?source=${encodeURIComponent(entry.sourcePageId)}`
            : null,
      }).html,
    );
    html = html.replaceAll(
      /((?:href|src)=")\/api\/attachments\/([A-Za-z0-9_-]+)"/g,
      `$1/share/${encodeURIComponent(key)}/assets/$2?page=${encodeURIComponent(entry.sourcePageId)}"`,
    );
    html = html.replace(
      /<div class="synced-reference"[^>]*>[\s\S]*?<\/div>/g,
      '<div class="synced-reference">Synced content unavailable</div>',
    );
    available.set(entry.key, html);
  }
  return { html: available, diagramIds: availableDiagramIds };
}

async function publicTableHtml(env: Env, pageId: string) {
  const [columns, cells] = await Promise.all([
    env.DB.prepare(`SELECT id, name FROM table_columns WHERE page_id = ? ORDER BY position, id`)
      .bind(pageId)
      .all<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT row.id row_id, cell.column_id, cell.text_value, cell.number_value, cell.boolean_value,
              cell.date_value, option.label select_label
         FROM (
           SELECT id, position FROM table_rows WHERE page_id = ? ORDER BY position, id LIMIT 501
         ) row LEFT JOIN table_cells cell ON cell.row_id = row.id
         LEFT JOIN table_select_options option ON option.id = cell.select_value
        ORDER BY row.position, row.id, cell.column_id`,
    )
      .bind(pageId)
      .all<Record<string, unknown>>(),
  ]);
  const rows = new Map<string, Map<string, string>>();
  for (const raw of cells.results) {
    const rowId = String(raw.row_id);
    const values = rows.get(rowId) ?? new Map<string, string>();
    const value =
      raw.text_value ??
      raw.number_value ??
      raw.date_value ??
      raw.select_label ??
      (raw.boolean_value === 1 ? "✓" : raw.boolean_value === 0 ? "" : "");
    if (raw.column_id) values.set(String(raw.column_id), String(value ?? ""));
    rows.set(rowId, values);
  }
  const rowIds = [...rows.keys()];
  const truncated = rowIds.length > 500;
  const html = `<table><thead><tr>${columns.results.map((column) => `<th>${escapeHtml(column.name)}</th>`).join("")}</tr></thead><tbody>${rowIds
    .slice(0, 500)
    .map((rowId) => rows.get(rowId)!)
    .map(
      (row) =>
        `<tr>${columns.results.map((column) => `<td>${escapeHtml(row.get(column.id) ?? "")}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
  return { html, truncated };
}

export async function renderPublicShare(env: Env, share: SharedPageRow, key: string, origin: string) {
  if (share.page_kind === "diagram") return null;
  const [tree, trail] = await Promise.all([sharedTree(env, share), breadcrumbs(env, share)]);
  let content: string;
  let toc = "";
  let tableTruncated = false;
  if (share.page_kind === "document") {
    const response = await env.DOCUMENT.getByName(`${share.page_id}~${share.content_epoch}`).fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    if (!response.ok) return null;
    const envelope = await response.json<DocumentContentEnvelope>();
    const transclusions = await publicTransclusions(env, share, key, envelope.document);
    const rendered = publicDocumentHtml(
      envelope.document,
      key,
      share.page_id,
      transclusions.html,
      transclusions.diagramIds,
    );
    content = rendered.body;
    toc = rendered.toc;
  } else {
    const table = await publicTableHtml(env, share.page_id);
    content = table.html;
    tableTruncated = table.truncated;
  }
  const nav =
    tree.length > 1
      ? `<nav class="public-tree">${tree.map((item) => `<a class="${item.id === share.page_id ? "active" : ""}" href="${item.id === share.root_page_id ? `/share/${encodeURIComponent(key)}` : `/share/${encodeURIComponent(key)}/pages/${encodeURIComponent(item.id)}`}">${escapeHtml(item.title)}</a>`).join("")}</nav>`
      : "";
  const robots = share.allow_indexing ? "index,follow" : "noindex,nofollow";
  const canonicalPath =
    share.page_id === share.root_page_id
      ? `/share/${encodeURIComponent(key)}`
      : `/share/${encodeURIComponent(key)}/pages/${encodeURIComponent(share.page_id)}`;
  const canonical = `${origin}${canonicalPath}`;
  const breadcrumbHtml = trail.map((item) => escapeHtml(item.title)).join(" <span>/</span> ");
  content = content.replace(
    '<nav class="breadcrumb" data-derived-block="breadcrumb"></nav>',
    `<nav class="public-breadcrumb">${breadcrumbHtml}</nav>`,
  );
  if (tableTruncated) content += "<p><small>This public view is limited to the first 500 rows.</small></p>";
  const updatedAt = new Date(share.page_updated_at).toISOString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="${robots}"><link rel="canonical" href="${canonical}"><title>${escapeHtml(share.page_title)}</title><style>:root{color-scheme:light dark;--page:#fff;--ink:#25231f;--muted:#625f57;--line:#dfddd5;--card:#f7f5ef;--accent:#5b5bd6}html[data-theme=dark]{--page:#191a19;--ink:#f0f1ed;--muted:#a7aaa4;--line:#3a3c39;--card:#242624;--accent:#9a98ff}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:16px/1.6 system-ui,sans-serif}.public-shell{display:grid;grid-template-columns:${nav ? "240px" : "0"} minmax(0,860px) ${share.show_toc && toc ? "210px" : "0"};justify-content:center;gap:30px;padding:32px 24px}.public-tree,.public-toc{position:sticky;top:24px;align-self:start;display:grid;gap:5px;max-height:calc(100vh - 48px);overflow:auto}.public-tree a,.public-toc a{padding:5px 8px;border-radius:6px;color:var(--muted);text-decoration:none;font-size:13px}.public-tree a:hover,.public-tree a.active{background:var(--card);color:var(--ink)}main{min-width:0}header{margin-bottom:34px}.public-breadcrumb{color:var(--muted);font-size:12px}.public-breadcrumb span{padding:0 5px}h1{font:700 clamp(34px,6vw,54px)/1.1 Georgia,serif;margin:16px 0 8px}header small{color:var(--muted)}a{color:var(--accent)}img,video,iframe{max-width:100%}pre{white-space:pre-wrap;background:var(--card);padding:12px;border-radius:8px}.callout{display:flex;gap:10px;padding:12px;border-left:4px solid var(--accent);background:var(--card)}.columns{display:flex;gap:16px}.column{flex:1}table{width:100%;border-collapse:collapse}td,th{border:1px solid var(--line);padding:7px;text-align:left}.theme-switch{position:fixed;right:14px;top:14px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);padding:7px 10px;cursor:pointer}@media(max-width:900px){.public-shell{display:block}.public-tree,.public-toc{position:static;margin-bottom:24px}.columns{display:block}}</style><script>try{const media=matchMedia('(prefers-color-scheme:dark)');const values=['auto','light','dark'];const apply=()=>{const preference=localStorage.getItem('notes:public-theme')||'auto';document.documentElement.dataset.theme=preference==='dark'||(preference==='auto'&&media.matches)?'dark':'light';document.documentElement.dataset.themePreference=preference};apply();media.addEventListener('change',()=>{if((localStorage.getItem('notes:public-theme')||'auto')==='auto')apply()});window.cyclePublicTheme=()=>{const current=localStorage.getItem('notes:public-theme')||'auto';const next=values[(values.indexOf(current)+1)%values.length];localStorage.setItem('notes:public-theme',next);apply()}}catch{}</script></head><body><button class="theme-switch" aria-label="Change theme: system, light, or dark" title="Theme: system → light → dark" onclick="cyclePublicTheme()">◐</button><div class="public-shell">${nav}<main><header><nav class="public-breadcrumb">${breadcrumbHtml}</nav><h1>${escapeHtml(share.page_icon ? `${share.page_icon} ${share.page_title}` : share.page_title)}</h1>${share.show_last_updated ? `<small>Updated <time datetime="${updatedAt}">${updatedAt}</time></small>` : ""}</header>${content}</main>${share.show_toc ? toc : ""}</div></body></html>`;
}

export async function publicAttachment(env: Env, share: SharedPageRow, attachmentId: string) {
  const attachment = await env.DB.prepare(
    `SELECT id, page_id, r2_key, name, mime FROM attachments WHERE id = ? AND page_id = ?`,
  )
    .bind(attachmentId, share.page_id)
    .first<{ id: string; page_id: string; r2_key: string; name: string; mime: string }>();
  if (!attachment) return null;
  const object = await env.BUCKET.get(attachment.r2_key);
  if (!object) return null;
  const inline = isInlineMime(attachment.mime);
  const headers = new Headers({
    "content-type": inline ? attachment.mime : "application/octet-stream",
    "content-disposition": attachmentDisposition(attachment.name, inline),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { headers });
}

export async function publicDiagramThumbnail(env: Env, diagram: SharedPageRow, source: SharedPageRow) {
  if (diagram.page_kind !== "diagram" || source.page_kind !== "document") return null;
  let envelope: DocumentContentEnvelope;
  try {
    const response = await env.DOCUMENT.getByName(`${source.page_id}~${source.content_epoch}`).fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        signal: AbortSignal.timeout(PUBLIC_DOCUMENT_FETCH_TIMEOUT_MS),
      }),
    );
    if (!response.ok) return null;
    envelope = await response.json<DocumentContentEnvelope>();
  } catch {
    return null;
  }
  if (
    envelope.pageId !== source.page_id ||
    envelope.contentEpoch !== source.content_epoch ||
    !collectLinkedDiagramIds(envelope.document).has(diagram.page_id)
  )
    return null;
  return diagramThumbnailResponse(
    env,
    { id: diagram.page_id, content_epoch: diagram.content_epoch, title: diagram.page_title },
    { cacheControl: "no-store" },
  );
}

export async function publicSitemap(env: Env, share: SharedPageRow, key: string, origin: string) {
  if (!share.allow_indexing) return null;
  const tree = await sharedTree(env, share);
  const pages = tree.length ? tree : [{ id: share.root_page_id, title: share.page_title, parentId: null }];
  const urls = pages.map(
    (page) => `${origin}${page.id === share.root_page_id ? `/share/${key}` : `/share/${key}/pages/${page.id}`}`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${escapeHtml(url)}</loc></url>`).join("")}</urlset>`;
}
