/**
 * Runs an import in three passes.
 *
 * The order is forced by how backlinks are built. `compactOnce` materialises
 * page_references by joining each mention's target id against the pages table, and a
 * mention whose target does not exist at that moment produces no row - permanently, for
 * that pass, because the projection only re-runs when the *source* page next compacts.
 * So every page is created before any content that might mention it is written.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assignStableIds, createImportEditor, htmlToBlocks } from "./blocks.mjs";
import { readPageHtml, resolveLink } from "./export-tree.mjs";
import { normalizeNotionHtml } from "./normalize-html.mjs";
import { pushDocument } from "./document-push.mjs";
import { tableFromCsv } from "./csv.mjs";

const PAGE_BATCH = 50;
// Matches the route's own per-request caps, so a batch is never rejected for size.
const TABLE_ROW_BATCH = 200;
const TABLE_CELL_BATCH = 2_000;
const TITLE_MAX = 200;

// Extensions the server rejects outright, checked here so a refusal is a line in the
// report rather than an exception mid-run.
const DENIED_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".htx",
  ".xhtml",
  ".xht",
  ".svg",
  ".svgz",
  ".xml",
  ".js",
  ".jse",
  ".mjs",
  ".cjs",
]);

const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".pdf", "application/pdf"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".zip", "application/zip"],
]);

function extensionOf(path) {
  return path.toLowerCase().match(/\.[^./]+$/)?.[0] ?? "";
}

function keyOf(page) {
  // The file path is the stable identity: not every export gives every page an id.
  return page.path;
}

/** Groups pages by depth so each level can be created once its parents exist. */
function levelsOf(pages) {
  const depth = new Map();
  const depthOf = (page) => {
    if (depth.has(page)) return depth.get(page);
    const value = page.parent ? depthOf(page.parent) + 1 : 0;
    depth.set(page, value);
    return value;
  };
  const levels = [];
  for (const page of pages) {
    const value = depthOf(page);
    (levels[value] ??= []).push(page);
  }
  return levels;
}

export async function runImport({ index, client, manifest, report, rootParentId, limit, lingerMs }) {
  const selected = index.pages.slice(0, limit);
  const included = new Set(selected);

  // Pass 1: every page, no content.
  const levels = levelsOf(selected);
  for (const [depth, level] of levels.entries()) {
    const missing = level.filter((page) => !manifest.node(keyOf(page))?.pageId);
    for (let offset = 0; offset < missing.length; offset += PAGE_BATCH) {
      const chunk = missing.slice(offset, offset + PAGE_BATCH);
      const created = await client.createPages(
        chunk.map((page) => ({
          parentId: page.parent ? manifest.node(keyOf(page.parent))?.pageId : rootParentId,
          kind: page.kind === "database" ? "table" : "document",
          // A Notion title can exceed what the API accepts, and losing the page over its
          // name would be worse than shortening it.
          title: page.title.slice(0, TITLE_MAX) || "Untitled",
        })),
      );
      chunk.forEach((page, position) => {
        const remote = created[position];
        if (page.title.length > TITLE_MAX) report.issue("title_truncated", page.title);
        manifest.record(keyOf(page), {
          title: page.title,
          kind: page.kind,
          sourcePath: page.path,
          pageId: remote.id,
          contentEpoch: remote.contentEpoch,
        });
      });
      report.progress("pages", offset + chunk.length, missing.length, `level ${depth}`);
    }
  }
  manifest.flush();

  // Pass 1.5: assets, so content can point at real attachments.
  const assetUrls = new Map();
  for (const page of selected) {
    const record = manifest.node(keyOf(page));
    const uploaded = { ...record.assets };
    for (const asset of page.assets) {
      if (uploaded[asset]) {
        assetUrls.set(asset, `/api/attachments/${uploaded[asset]}`);
        continue;
      }
      const extension = extensionOf(asset);
      if (DENIED_EXTENSIONS.has(extension)) {
        report.issue("attachment_denied_type", basename(asset));
        continue;
      }
      try {
        const bytes = readFileSync(join(index.root, asset));
        const attachment = await client.uploadAttachment(
          record.pageId,
          basename(asset),
          MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream",
          bytes,
        );
        uploaded[asset] = attachment.id;
        assetUrls.set(asset, `/api/attachments/${attachment.id}`);
      } catch (error) {
        report.issue("attachment_failed", `${basename(asset)}: ${error.message}`);
      }
    }
    manifest.record(keyOf(page), { assets: uploaded });
  }
  manifest.flush();

  // Pass 2: content. Every page now exists, so a mention can name its real target.
  const editor = await createImportEditor();
  const documents = selected.filter((page) => page.kind === "document");
  let written = 0;
  for (const [position, page] of documents.entries()) {
    const record = manifest.node(keyOf(page));
    try {
      const html = normalizeNotionHtml(readPageHtml(index.root, page), {
        onIssue: (code, detail) => report.issue(code, detail),
        resolveHref: (href) => {
          const target = resolveLink(href, index);
          if (!target) return null;
          if (target.kind === "asset") {
            const url = assetUrls.get(target.path);
            return url ? { type: "asset", url } : null;
          }
          if (!included.has(target)) return null;
          const targetRecord = manifest.node(keyOf(target));
          if (!targetRecord?.pageId) {
            report.issue("mention_target_missing", target.title);
            return null;
          }
          return { type: "page", entityId: targetRecord.pageId, label: target.title || "Untitled" };
        },
      });
      // Seeded with the source path so a second run over an unchanged page produces an
      // identical document and therefore no Yjs update at all.
      const blocks = assignStableIds(await htmlToBlocks(editor, html), page.path);
      const result = await pushDocument({
        client,
        editor,
        blocks,
        pageId: record.pageId,
        epoch: record.contentEpoch,
        lingerMs,
      });
      manifest.record(keyOf(page), { content: result.updates > 0 ? "written" : "unchanged" });
      if (result.updates > 0) written += 1;
      else report.issue("unchanged", page.title);
    } catch (error) {
      manifest.record(keyOf(page), { content: "failed" });
      report.issue("content_failed", `${page.title}: ${error.message}`);
    }
    report.progress("content", position + 1, documents.length);
  }
  manifest.flush();

  // Databases last: a table page has to exist before its rows can be written, and the
  // lease it takes is exclusive, so this is kept away from the content pass.
  const databases = selected.filter((page) => page.kind === "database");
  let rowsWritten = 0;
  for (const database of databases) {
    const record = manifest.node(keyOf(database));
    if (record.rowsWritten) continue;
    try {
      rowsWritten += await importTable({ index, client, report, database, record });
      manifest.record(keyOf(database), { rowsWritten: true });
    } catch (error) {
      report.issue("table_failed", `${database.title}: ${error.message}`);
    }
  }
  manifest.flush();

  return { pages: selected.length, written, databases: databases.length, rows: rowsWritten };
}

/**
 * Writes one Notion database into a typed table.
 *
 * Every mutation carries the current revision, so these requests are strictly
 * sequential no matter how they are batched. Batching is still what makes it viable: a
 * three thousand row database costs tens of requests here rather than tens of thousands
 * of per-cell writes. The lease renews itself on each bulk write, so a long table does
 * not need a renewal timer running alongside.
 */
async function importTable({ index, client, report, database, record }) {
  const csv = readFileSync(join(index.root, database.csvPath), "utf8");
  const table = tableFromCsv(csv, (code, detail) => report.issue(code, detail));
  if (table.columns.length === 0) return 0;

  const lease = await client.acquireTableLease(record.pageId);
  let revision = (await client.readTable(record.pageId)).table.revision;
  let written = 0;
  try {
    // Columns travel with the first batch of rows, addressed by ref, so nothing has to
    // wait on a round trip to learn the generated column ids.
    // Sized so a batch never trips the route's row or cell cap.
    const perBatch = Math.max(1, Math.min(TABLE_ROW_BATCH, Math.floor(TABLE_CELL_BATCH / table.columns.length)));
    let columns = table.columns;
    let offset = 0;
    do {
      const rows = table.rows.slice(offset, offset + perBatch);
      const result = await client.bulkTableWrite(record.pageId, {
        leaseToken: lease.leaseToken,
        expectedRevision: revision,
        // Identifies the batch so a lost response replays instead of duplicating rows.
        clientRequestId: `${database.path}#${offset}`,
        columns: columns ?? [],
        rows,
      });
      revision = result.revision;
      written += rows.length;
      columns = null;
      offset += perBatch;
      report.progress("tables", Math.min(written, table.rows.length), table.rows.length, database.title);
    } while (offset < table.rows.length);
  } finally {
    await client.releaseTableLease(record.pageId, lease.leaseToken).catch(() => undefined);
  }
  return written;
}
