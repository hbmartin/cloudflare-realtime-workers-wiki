/**
 * Runs an import in three passes.
 *
 * The order is forced by how backlinks are built. `compactOnce` materialises
 * page_references by joining each mention's target id against the pages table, and a
 * mention whose target does not exist at that moment produces no row - permanently, for
 * that pass, because the projection only re-runs when the *source* page next compacts.
 * So every page is created before any content that might mention it is written.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  TABLE_BULK_MAX_BODY_BYTES,
  TABLE_BULK_MAX_CELLS,
  TABLE_BULK_MAX_COLUMNS,
  TABLE_BULK_MAX_ROWS,
  TABLE_COLUMN_NAME_MAX,
  TABLE_MAX_ROWS,
  TABLE_SELECT_LABEL_MAX,
  TABLE_TEXT_CELL_MAX,
} from "../../src/shared/table-limits.ts";
import { PAGE_TITLE_MAX } from "../../src/shared/validation.ts";
import { MAX_ATTACHMENT_BYTES } from "../../src/worker/attachments.ts";
import { documentProjectionHash, tableContentHash } from "../../src/shared/import-integrity.ts";
import { assignStableIds, createImportEditor, htmlToBlocks } from "./blocks.mjs";
import { readPageHtml, resolveLink } from "./export-tree.mjs";
import { normalizeNotionHtml } from "./normalize-html.mjs";
import { documentJsonForBlocks, documentJsonProjectionHash, pushDocument } from "./document-push.mjs";
import { tableFromCsv } from "./csv.mjs";
import { hashFileContent } from "./manifest.mjs";

const PAGE_BATCH = 50;
const EMPTY_DOCUMENT_PROJECTION_HASH = documentProjectionHash({
  plainText: "",
  pageReferences: [],
  memberMentions: [],
});

export function deterministicResourceId(importId, kind, sourcePath) {
  const hex = createHash("sha256")
    .update(JSON.stringify([importId, kind, sourcePath]))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function recordConversionIssue(report, code, detail) {
  if (code === "link_unresolved" || code === "link_ambiguous" || code === "attachment_missing") {
    report.error(code, detail);
  } else report.issue(code, detail);
}

export function assetUrlsFor(pages, manifest) {
  const urls = new Map();
  for (const page of pages) {
    const assets = manifest.node(keyOf(page))?.assets ?? {};
    for (const [path, value] of Object.entries(assets)) {
      if (value?.status === "uploaded" && value.id) urls.set(path, `/api/attachments/${value.id}`);
      else if (value?.status === "skipped-unsafe") urls.set(path, { skipped: true });
    }
  }
  return urls;
}

export async function convertDocument({ index, page, manifest, included, editor, report, assetUrls = null }) {
  const resolvedAssets = assetUrls ?? assetUrlsFor(included, manifest);
  return assignStableIds(
    await htmlToBlocks(
      editor,
      normalizeNotionHtml(readPageHtml(index.root, page), {
        onIssue: (code, detail) => recordConversionIssue(report, code, detail),
        resolveHref: (href) => {
          const target = resolveLink(href, index, page.path, (code, detail) =>
            recordConversionIssue(report, code, detail),
          );
          if (!target) return null;
          if (target.kind === "asset") {
            const asset = resolvedAssets.get(target.path);
            if (asset?.skipped) return { type: "skipped-unsafe-asset" };
            return asset ? { type: "asset", url: asset } : null;
          }
          if (!included.has(target)) return null;
          const targetRecord = manifest.node(keyOf(target));
          if (!targetRecord?.pageId) {
            report.error("mention_target_missing", target.title);
            return null;
          }
          return { type: "page", entityId: targetRecord.pageId, label: target.title || "Untitled" };
        },
      }),
    ),
    page.path,
  );
}

function validateTable(table, title) {
  if (table.rows.length > TABLE_MAX_ROWS) {
    throw new Error(`${title} has ${table.rows.length} rows; tables are limited to ${TABLE_MAX_ROWS}.`);
  }
  for (const column of table.columns) {
    if (column.name.length > TABLE_COLUMN_NAME_MAX) {
      throw new Error(`${title} has a column name longer than ${TABLE_COLUMN_NAME_MAX} characters.`);
    }
  }
  for (const [rowIndex, row] of table.rows.entries()) {
    for (const value of Object.values(row.cells)) {
      if (typeof value === "string" && value.length > TABLE_TEXT_CELL_MAX) {
        throw new Error(`${title} row ${rowIndex + 1} has text longer than ${TABLE_TEXT_CELL_MAX} characters.`);
      }
      if (value?.option?.length > TABLE_SELECT_LABEL_MAX) {
        throw new Error(
          `${title} row ${rowIndex + 1} has a select label longer than ${TABLE_SELECT_LABEL_MAX} characters.`,
        );
      }
    }
  }
}

function placeholderColumnIds(columns) {
  return new Map(
    columns.map((column, index) => [column.ref, `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`]),
  );
}

function mapRow(row, columnIds) {
  const cells = {};
  for (const [key, value] of Object.entries(row.cells)) {
    const ref = key.startsWith("ref:") ? key.slice(4) : key;
    const id = columnIds.get(ref);
    if (!id) throw new Error(`No server column id was recorded for ${ref}.`);
    cells[id] = value;
  }
  return { cells };
}

// Byte cost of the fixed request fields around an empty rows array, using the widest
// values a real request can carry. Adding a row to `rows: []` costs exactly the row's
// own JSON plus a separating comma, so each row is serialized once, not once per
// candidate batch size.
const BULK_ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({
    leaseToken: "x".repeat(200),
    expectedRevision: Number.MAX_SAFE_INTEGER,
    clientRequestId: "x".repeat(200),
    columns: [],
    rows: [],
  }),
);

export function planTableRowBatches(table) {
  const ids = placeholderColumnIds(table.columns);
  const batches = [];
  let start = 0;
  while (start < table.rows.length) {
    let count = 0;
    let cells = 0;
    let bytes = BULK_ENVELOPE_BYTES;
    let end = start;
    while (end < table.rows.length && count < TABLE_BULK_MAX_ROWS) {
      const candidate = mapRow(table.rows[end], ids);
      const candidateCells = Object.keys(candidate.cells).length;
      if (candidateCells > TABLE_BULK_MAX_CELLS) {
        throw new Error(
          `Row ${end + 1} has ${candidateCells} cells; one request is limited to ${TABLE_BULK_MAX_CELLS}.`,
        );
      }
      if (count && cells + candidateCells > TABLE_BULK_MAX_CELLS) break;
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate)) + (count ? 1 : 0);
      if (bytes + candidateBytes > TABLE_BULK_MAX_BODY_BYTES) {
        if (!count) throw new Error(`Row ${start + 1} cannot fit in one bulk table request.`);
        break;
      }
      count += 1;
      cells += candidateCells;
      bytes += candidateBytes;
      end += 1;
    }
    batches.push({ start, end });
    start = end;
  }
  return batches;
}

export function preflightTable(index, database, onIssue = () => {}) {
  const csv = readFileSync(join(index.root, database.csvPath), "utf8");
  const table = tableFromCsv(csv, onIssue);
  if (table.columns.length) validateTable(table, database.title);
  return table;
}

/**
 * Everything the import needs to know about one database, computed exactly once.
 * The plan is shared by preflight, reconciliation, and the write pass, so the CSV is
 * parsed, batch-planned, and hashed a single time per run.
 */
export async function planTable(index, database, onIssue = () => {}) {
  const table = preflightTable(index, database, onIssue);
  const batches = table.columns.length ? planTableRowBatches(table) : [];
  const canonical = canonicalSourceTable(table);
  const contentHash = await tableContentHash(canonical.columns, canonical.rows);
  return { table, batches, contentHash };
}

export function canonicalSourceTable(source, columnLimit = source.columns.length, rowLimit = source.rows.length) {
  const columns = source.columns.slice(0, columnLimit);
  const rows = source.rows.slice(0, rowLimit);
  const optionLists = new Map(columns.map((column) => [column.ref, []]));
  const optionSets = new Map(columns.map((column) => [column.ref, new Set()]));
  for (const row of rows) {
    for (const column of columns) {
      if (column.type !== "select") continue;
      const label = row.cells[`ref:${column.ref}`]?.option;
      if (typeof label === "string" && !optionSets.get(column.ref).has(label)) {
        optionSets.get(column.ref).add(label);
        optionLists.get(column.ref).push(label);
      }
    }
  }
  return {
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      options: column.type === "select" ? optionLists.get(column.ref) : [],
    })),
    rows: rows.map((row) =>
      columns.map((column) => {
        const value = row.cells[`ref:${column.ref}`];
        return value?.option ?? value ?? null;
      }),
    ),
  };
}

function tableRequestId(manifest, database, phase, offset) {
  const pathHash = createHash("sha256").update(database.path).digest("hex").slice(0, 16);
  const prefix = `notion:${manifest.state.importId}:${phase}:${offset}:${pathHash}:`;
  // Keep the source path visible for diagnostics while the hash preserves uniqueness
  // when a deeply nested export path has to be truncated to the API's 200-char limit.
  return `${prefix}${encodeURIComponent(database.path).slice(0, 200 - prefix.length)}`;
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

/** Includes the ancestors a limited selection needs in order to preserve its tree. */
export function selectPages(pages, limit) {
  const included = new Set(pages.slice(0, limit));
  for (const page of included) {
    let parent = page.parent;
    while (parent) {
      included.add(parent);
      parent = parent.parent;
    }
  }
  return [...included];
}

function expectedPageFor(page, manifest, rootParentId) {
  return {
    id: deterministicResourceId(manifest.state.importId, "page", page.path),
    kind: page.kind === "database" ? "table" : "document",
    // Trimmed after the cap because the server trims what it stores; without it a
    // truncation landing on whitespace would make every later comparison a mismatch.
    title: page.title.slice(0, PAGE_TITLE_MAX).trim() || "Untitled",
    parentId: page.parent
      ? deterministicResourceId(manifest.state.importId, "page", page.parent.path)
      : (rootParentId ?? null),
  };
}

/**
 * The batch offsets exactly one committed bulk write ahead, or null when no further
 * batch exists. Columns advance to exhaustion before any rows, mirroring importTable's
 * write order. The boundaries come from the current plan (TABLE_BULK_MAX_COLUMNS and
 * the byte-size row batches), so a manifest written by an importer with different
 * boundaries models a different write sequence than the one that ran; its own
 * unrecorded batches then fail the revision fence and are kept as destination edits
 * rather than resumed - a known limit of receipt-free recovery.
 */
function advancedOffsetsFor(plan, columnOffset, rowOffset) {
  const { table, batches } = plan;
  if (columnOffset < table.columns.length) {
    return { columnOffset: Math.min(columnOffset + TABLE_BULK_MAX_COLUMNS, table.columns.length), rowOffset };
  }
  const batch = batches.find((candidate) => candidate.start === rowOffset);
  if (!batch) return null;
  return { columnOffset, rowOffset: batch.end };
}

function mergeColumnMap(columnsByRef, requestedColumns, result) {
  if (result.columns?.length !== requestedColumns.length) {
    throw new Error("The bulk route returned an incomplete column map.");
  }
  const requestedRefs = new Set(requestedColumns.map((column) => column.ref));
  const returnedRefs = new Set();
  const merged = { ...columnsByRef };
  for (const column of result.columns) {
    if (!column.ref || !requestedRefs.has(column.ref) || returnedRefs.has(column.ref)) {
      throw new Error("The bulk route returned an unexpected column reference.");
    }
    returnedRefs.add(column.ref);
    merged[column.ref] = column.id;
  }
  return merged;
}

/**
 * The exact body of a column bulk write. The server keys its idempotency receipt on the
 * clientRequestId and a hash over {columns, rows}, so the original send in importTable
 * and the recovery replay in reconcileCommitted must construct byte-identical requests;
 * that is why both go through this one builder.
 */
function columnBatchRequest(manifest, database, { leaseToken, revision, offset, columns }) {
  return {
    leaseToken,
    expectedRevision: revision,
    clientRequestId: tableRequestId(manifest, database, "columns", offset),
    columns,
    rows: [],
  };
}

async function withTableLease(client, pageId, action) {
  const lease = await client.acquireTableLease(pageId);
  try {
    return await action(lease.leaseToken);
  } finally {
    await client.releaseTableLease(pageId, lease.leaseToken).catch(() => undefined);
  }
}

/** A live imported prefix whose ownership cannot be proved by a durable receipt. */
class ColumnRecoveryAmbiguousError extends Error {
  constructor() {
    super("The live table matches an unrecorded import batch, but no durable receipt proves who committed it.");
    this.name = "ColumnRecoveryAmbiguousError";
  }
}

/**
 * The batches this import committed beyond what the manifest recorded, or null when the
 * live table cannot be that committed prefix. Ordinarily a kill between the server
 * commit and the recordNow checkpoint leaves the live table exactly one batch ahead,
 * but a manifest written by an importer that debounced these checkpoints can trail by
 * several. Every bulk write advances the revision by exactly one, so only the prefix
 * exactly (live.revision - savedRevision) batches ahead can be this import's own
 * writes; a live revision anywhere else means the destination was edited even when the
 * content coincides (an edit undone). That fence selects the single admissible
 * candidate before any content is hashed, so the walk costs one prefix hash however
 * large the table is.
 */
async function advancedCommitMatch(plan, columnOffset, rowOffset, savedRevision, live) {
  const steps = live.revision - savedRevision;
  if (!Number.isInteger(steps) || steps < 1) return null;
  const columnBatches = [];
  let nextColumnOffset = columnOffset;
  let nextRowOffset = rowOffset;
  for (let step = 1; step <= steps; step += 1) {
    const next = advancedOffsetsFor(plan, nextColumnOffset, nextRowOffset);
    // Row offsets only grow, so once the live count falls behind a candidate no later
    // prefix can match either; stopping bounds the walk on destination-edited tables.
    if (!next || live.rowCount < next.rowOffset) return null;
    if (next.columnOffset > nextColumnOffset) {
      columnBatches.push({ offset: nextColumnOffset, endOffset: next.columnOffset, step });
    }
    nextColumnOffset = next.columnOffset;
    nextRowOffset = next.rowOffset;
  }
  if (live.rowCount !== nextRowOffset) return null;
  const canonical = canonicalSourceTable(plan.table, nextColumnOffset, nextRowOffset);
  if (live.contentHash !== (await tableContentHash(canonical.columns, canonical.rows))) return null;
  return { columnOffset: nextColumnOffset, rowOffset: nextRowOffset, columnBatches };
}

export async function reconcileCommitted({
  selected,
  client,
  manifest,
  report,
  tablePlans = new Map(),
  skipPaths = new Set(),
  keepAmbiguousTables = new Set(),
}) {
  const ambiguousTablePaths = keepAmbiguousTables instanceof Set ? keepAmbiguousTables : new Set(keepAmbiguousTables);
  for (const page of selected) {
    const key = keyOf(page);
    // A node first planned by this run has provably no committed server state to
    // reconcile; probing it would be one guaranteed 404 per page before any work.
    if (skipPaths.has(key)) continue;
    const node = manifest.node(key);
    const pageId = node?.pageId ?? node?.plannedPageId;
    if (!pageId) continue;
    let pageVerification;
    try {
      pageVerification = await client.pageVerification(pageId);
    } catch (error) {
      if (error?.status === 404) {
        // A planned id is recorded before page creation. Its absence simply means the
        // batch has not committed yet; only a resource previously recorded as created
        // is a deletion that must fail the run.
        if (!node.pageId) continue;
        manifest.recordNow(key, { remoteMissing: true });
        report.error("remote_page_missing", page.title);
        continue;
      }
      throw error;
    }
    const livePage = pageVerification.page;
    const expected = node.expectedPage;
    if (!expected || livePage.kind !== expected.kind) {
      manifest.recordNow(key, { remoteKindMismatch: livePage.kind });
      report.error("remote_page_kind_changed", `${page.title}: ${livePage.kind}`);
      continue;
    }
    const reconciledPage = { ...expected };
    if (livePage.title !== expected.title) {
      reconciledPage.acceptedRemoteTitle = livePage.title;
      report.issue("destination_title_kept", page.title);
    } else delete reconciledPage.acceptedRemoteTitle;
    if ((livePage.parentId ?? null) !== (expected.parentId ?? null)) {
      reconciledPage.acceptedRemoteParentId = livePage.parentId ?? null;
      report.issue("destination_placement_kept", page.title);
    } else delete reconciledPage.acceptedRemoteParentId;
    const patch = {
      pageId,
      contentEpoch: livePage.contentEpoch,
      title: node.title ?? page.title,
      kind: node.kind ?? page.kind,
      sourcePath: node.sourcePath ?? page.path,
      expectedPage: reconciledPage,
      remoteMissing: false,
      remoteKindMismatch: null,
    };

    // Document content is deliberately not reconciled here. The write pass compares
    // the live document against its expected bases inside pushDocument's own
    // synchronized connection and fully re-derives the conflict classification, so a
    // read here would cost one WebSocket sync per resumed document to compute a result
    // the write pass immediately overwrites.

    if (node.assets) {
      const remoteAssets = new Map((await client.listAttachments(pageId)).map((asset) => [asset.id, asset]));
      const assets = { ...node.assets };
      for (const [assetPath, saved] of Object.entries(assets)) {
        // An uploading record may have a live multipart session but no attachment yet.
        // Only a previously committed attachment can be classified as destination
        // drift or deletion; the upload pass reconciles active sessions by stable id.
        if (!saved?.id || saved.status !== "uploaded") continue;
        const live = remoteAssets.get(saved.id);
        if (!live) {
          assets[assetPath] = { ...saved, remoteMissing: true };
          report.error("remote_attachment_missing", assetPath);
          continue;
        }
        const differs =
          live.contentSha256 !== saved.contentSha256 ||
          live.size !== saved.size ||
          live.name !== saved.name ||
          live.mime !== saved.mime;
        const next = { ...saved, remoteMissing: false };
        if (differs) {
          next.acceptedRemote = live;
          report.issue("destination_attachment_kept", assetPath);
        } else delete next.acceptedRemote;
        assets[assetPath] = next;
      }
      patch.assets = assets;
    }

    if (page.kind === "database") {
      try {
        const live = await client.tableVerification(pageId);
        patch.remoteTableMissing = false;
        const plan = tablePlans.get(page);
        if (plan) {
          // Re-derived from scratch on every planned table, before any branch below can
          // decline to classify. runImport skips an ambiguous table in silence, so a
          // verdict left in the record by an earlier run would otherwise end a later run
          // with no error reported and no rows written. Without a plan there is no basis
          // for replacing either durable verdict.
          patch.tableRecoveryAmbiguous = false;
          patch.tableError = null;
          const source = plan.table;
          const progress = node.table;
          const complete = progress?.phase === "complete";
          // A record saved without a revision predates the fence below; nothing can be
          // attributed by arithmetic from it, so it is accepted on content alone.
          const savedRevision = Number.isInteger(progress?.revision) ? progress.revision : null;
          const columnOffset = complete ? source.columns.length : (progress?.columnOffset ?? 0);
          const rowOffset = complete ? source.rows.length : (progress?.rowOffset ?? 0);
          const lastCommitted = canonicalSourceTable(source, columnOffset, rowOffset);
          const lastCommittedHash = await tableContentHash(lastCommitted.columns, lastCommitted.rows);
          // Matching content is not enough: an edit followed by an exact revert leaves
          // the same hash at a later revision. Treat that as destination-owned instead
          // of resuming from a revision the server will reject forever.
          const matchesLastCommit = (current) =>
            current.contentHash === lastCommittedHash &&
            current.rowCount === rowOffset &&
            (savedRevision === null || current.revision === savedRevision);
          if (!progress && !matchesLastCommit(live)) {
            // Committed content with no recorded baseline cannot be attributed: there
            // is no revision to fence own writes against, so classifying here could
            // only guess between a half-recovered import and a destination table.
            // Leave the record without table progress; importTable's guard fails this
            // table loudly, which is an operator decision rather than a silent one.
          } else {
            const table = {
              ...progress,
              phase: progress?.phase ?? "columns",
              revision: savedRevision ?? live.revision,
              contentHash: plan.contentHash,
              expectedColumns: source.columns.length,
              expectedRows: source.rows.length,
              columnOffset,
              rowOffset,
              columnsByRef: progress?.columnsByRef ?? {},
            };
            patch.table = table;
            // Destination edits win the whole table facet, including when they race an
            // incomplete import. Stop further batches so user-owned rows are never
            // combined with the remaining source rows into a hybrid table.
            const keepDestinationTable = (current, shouldReport = true) => {
              table.phase = "complete";
              table.acceptedRemoteHash = current.contentHash;
              table.acceptedRemoteRowCount = current.rowCount;
              if (shouldReport) report.issue("destination_table_kept", page.title);
            };
            const adoptOwnBaseline = () => {
              delete table.acceptedRemoteHash;
              delete table.acceptedRemoteRowCount;
              delete table.settledByOperator;
            };
            if (matchesLastCommit(live)) {
              // With no recorded baseline, the empty table itself needs attribution:
              // fresh tables start at revision 1, and an own write never leaves a
              // table empty, so an empty table at any later revision was emptied by
              // the destination and its edit-and-revert claims the facet.
              if (progress || live.revision === 1) adoptOwnBaseline();
              else keepDestinationTable(live);
            } else if (complete || savedRevision === null) {
              keepDestinationTable(live);
            } else if (!(await advancedCommitMatch(plan, columnOffset, rowOffset, savedRevision, live))) {
              keepDestinationTable(live);
            } else {
              // A process killed after the server committed bulk batches but before
              // the manifest recorded them leaves the live table ahead by those
              // batches: this import's own writes, so the offsets advance and the run
              // resumes. The offsets recovery records must describe a table no other
              // writer is moving, so the classification is repeated and applied under
              // the table lease, whose guards exclude every other writer.
              try {
                await withTableLease(client, pageId, async (leaseToken) => {
                  const leased = await client.tableVerification(pageId);
                  if (matchesLastCommit(leased)) return adoptOwnBaseline();
                  const advanced = await advancedCommitMatch(plan, columnOffset, rowOffset, savedRevision, leased);
                  if (!advanced) return keepDestinationTable(leased);
                  // Merged locally so a batch that replays before a later one fails
                  // cannot leave recovered column ids in the record while the catch
                  // below deliberately leaves the offsets that describe them unadvanced.
                  let recoveredColumns = table.columnsByRef;
                  try {
                    for (const batch of advanced.columnBatches) {
                      // The response is the only durable source of the generated
                      // column ids. Replaying each deterministic request returns its
                      // stored receipt before lease or revision guards, without a
                      // second column batch.
                      const columns = source.columns.slice(batch.offset, batch.endOffset);
                      let replayed;
                      try {
                        replayed = await client.bulkTableWrite(
                          pageId,
                          columnBatchRequest(manifest, page, {
                            leaseToken,
                            revision: table.revision + batch.step - 1,
                            offset: batch.offset,
                            columns,
                          }),
                        );
                      } catch (error) {
                        // A missing receipt cannot distinguish a destination edit from
                        // an importer-owned batch whose legacy receipt was cleared.
                        // Preserve the recorded offsets and require operator recovery
                        // instead of silently accepting a potentially partial table.
                        const code = error?.status === 409 ? error.code : null;
                        if (code === "table_revision_conflict" || code === "idempotency_key_reused") {
                          throw new ColumnRecoveryAmbiguousError();
                        }
                        throw error;
                      }
                      if (!replayed.replayed || replayed.revision !== table.revision + batch.step) {
                        throw new ColumnRecoveryAmbiguousError();
                      }
                      recoveredColumns = mergeColumnMap(recoveredColumns, columns, replayed);
                    }
                  } catch (error) {
                    const wasAlreadyAmbiguous = node.tableRecoveryAmbiguous === true;
                    if (
                      !(error instanceof ColumnRecoveryAmbiguousError) ||
                      !wasAlreadyAmbiguous ||
                      !ambiguousTablePaths.has(key)
                    ) {
                      throw error;
                    }
                    // The one settlement that needs no missing receipt, and the only way
                    // out of an ambiguity that every rerun re-derives identically: the
                    // operator has decided the live table is the destination's, so it is
                    // accepted whole and the import stops writing to it. Taken under the
                    // lease, against the same verification the classification used.
                    report.issue("ambiguous_table_kept", page.title);
                    table.settledByOperator = true;
                    return keepDestinationTable(leased, false);
                  }
                  table.columnsByRef = recoveredColumns;
                  table.columnOffset = advanced.columnOffset;
                  table.rowOffset = advanced.rowOffset;
                  table.revision = leased.revision;
                  adoptOwnBaseline();
                });
              } catch (error) {
                // A held lease or transient failure classifies nothing. A receipt
                // ambiguity is durable and reported here; the write pass then skips it
                // instead of issuing another mutation from an unproven baseline.
                patch.tableError = errorMessage(error);
                if (error instanceof ColumnRecoveryAmbiguousError) {
                  patch.tableRecoveryAmbiguous = true;
                  report.error(
                    "table_recovery_ambiguous",
                    `${page.title}: ${patch.tableError} Re-run with --keep-ambiguous-table ${shellQuote(key)} to accept only this live table as the destination's.`,
                  );
                } else {
                  // This attempt proved nothing either way, so an ambiguity an earlier
                  // run recorded still stands. What stopped this attempt is the transient
                  // failure, and that is the message worth surfacing.
                  patch.tableRecoveryAmbiguous = node.tableRecoveryAmbiguous ?? false;
                  if (patch.tableRecoveryAmbiguous) {
                    report.error("table_recovery_ambiguous", `${page.title}: ${patch.tableError}`);
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        if (error?.status !== 404) throw error;
        report.error("remote_table_missing", page.title);
        patch.remoteTableMissing = true;
      }
    }
    manifest.record(key, patch);
  }
}

export async function runImport({
  index,
  client,
  manifest,
  report,
  rootParentId,
  limit,
  lingerMs,
  keepAmbiguousTables = [],
  documentPush = pushDocument,
}) {
  const selected = selectPages(index.pages, limit);
  const included = new Set(selected);
  const selectedPaths = selected.map((page) => page.path);
  if (manifest.state.selectedPaths && !sameStringSets(manifest.state.selectedPaths, selectedPaths)) {
    throw new Error("This manifest was started with a different --limit selection.");
  }
  const ambiguousTablePaths = new Set(keepAmbiguousTables);
  for (const path of ambiguousTablePaths) {
    const selectedTable = selected.find((page) => page.path === path && page.kind === "database");
    if (!selectedTable) {
      throw new Error(`--keep-ambiguous-table target ${JSON.stringify(path)} is not a selected database source path.`);
    }
    const recovery = manifest.node(path);
    if (recovery?.tableRecoveryAmbiguous !== true && recovery?.table?.settledByOperator !== true) {
      throw new Error(
        `--keep-ambiguous-table target ${JSON.stringify(path)} is not recorded as table_recovery_ambiguous.`,
      );
    }
  }
  const expectedPages = new Map();
  for (const page of selected) {
    const expectedPage = expectedPageFor(page, manifest, rootParentId);
    expectedPages.set(page, expectedPage);
  }
  const tablePlans = new Map();
  for (const database of selected.filter((page) => page.kind === "database")) {
    report.inPage(database.title);
    try {
      tablePlans.set(database, await planTable(index, database, (code, detail) => report.issue(code, detail)));
    } catch (error) {
      throw new Error(`${database.title} (${database.path}): ${errorMessage(error)}`, { cause: error });
    }
  }
  // Finish every local hard-limit/body check before writing even the manifest. The
  // failing page is named: a bare parser error from deep inside one file would
  // otherwise leave the operator bisecting the export.
  for (const page of selected) {
    try {
      if (page.kind === "document") {
        normalizeNotionHtml(readPageHtml(index.root, page), {
          onIssue() {},
          resolveHref: (href) => {
            const target = resolveLink(href, index, page.path);
            if (!target) return null;
            return target.kind === "asset"
              ? { type: "asset", url: "/api/attachments/preflight" }
              : { type: "page", entityId: "preflight", label: target.title };
          },
        });
      }
      for (const asset of page.assets) {
        if (DENIED_EXTENSIONS.has(extensionOf(asset))) continue;
        const size = statSync(join(index.root, asset)).size;
        if (size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`${asset} is ${size} bytes; attachments are limited to ${MAX_ATTACHMENT_BYTES}.`);
        }
      }
    } catch (error) {
      throw new Error(`${page.title} (${page.path}): ${errorMessage(error)}`, { cause: error });
    }
  }
  manifest.state.selectedPaths = selectedPaths;
  // Paths this run is the first to plan. They have no committed server state, so
  // reconciliation skips them; probing each would be one guaranteed 404 per page.
  const freshPaths = new Set();
  for (const page of selected) {
    const expectedPage = expectedPages.get(page);
    const current = manifest.node(keyOf(page));
    if (!current) freshPaths.add(keyOf(page));
    manifest.record(keyOf(page), {
      plannedPageId: expectedPage.id,
      expectedPage: current?.expectedPage ?? expectedPage,
    });
  }
  manifest.flush();
  await reconcileCommitted({
    selected,
    client,
    manifest,
    report,
    tablePlans,
    skipPaths: freshPaths,
    keepAmbiguousTables: ambiguousTablePaths,
  });

  // Pass 1: every page, no content.
  const levels = levelsOf(selected);
  for (const [depth, level] of levels.entries()) {
    const missing = level.filter((page) => !manifest.node(keyOf(page))?.pageId);
    for (let offset = 0; offset < missing.length; offset += PAGE_BATCH) {
      const chunk = missing.slice(offset, offset + PAGE_BATCH);
      const created = await client.createPages(
        chunk.map((page) => ({
          id: expectedPages.get(page).id,
          parentId: expectedPages.get(page).parentId,
          kind: expectedPages.get(page).kind,
          // A Notion title can exceed what the API accepts, and losing the page over its
          // name would be worse than shortening it.
          title: expectedPages.get(page).title,
        })),
      );
      if (!Array.isArray(created) || created.length !== chunk.length) {
        throw new Error(
          `Page batch returned ${Array.isArray(created) ? created.length : "no"} results for ${chunk.length} pages.`,
        );
      }
      for (const [position, remote] of created.entries()) {
        if (remote.id !== expectedPages.get(chunk[position]).id) {
          throw new Error(`Page batch returned an unexpected id for ${chunk[position].title}.`);
        }
      }
      chunk.forEach((page, position) => {
        const remote = created[position];
        if (page.title.length > PAGE_TITLE_MAX) report.issue("title_truncated", page.title);
        manifest.record(keyOf(page), {
          title: page.title,
          kind: page.kind,
          sourcePath: page.path,
          pageId: remote.id,
          contentEpoch: remote.contentEpoch,
        });
      });
      manifest.flush();
      report.progress("pages", offset + chunk.length, missing.length, `level ${depth}`);
    }
  }
  manifest.flush();

  // Pass 1.5: assets, so content can point at real attachments.
  for (const page of selected) {
    report.inPage(page.title);
    const record = manifest.node(keyOf(page));
    if (record.remoteMissing || record.remoteKindMismatch) continue;
    const uploaded = { ...record.assets };
    for (const asset of page.assets) {
      const extension = extensionOf(asset);
      if (DENIED_EXTENSIONS.has(extension)) {
        uploaded[asset] = { status: "skipped-unsafe" };
        manifest.record(keyOf(page), { assets: { ...uploaded } });
        report.issue("attachment_denied_type", basename(asset));
        continue;
      }
      try {
        const path = join(index.root, asset);
        const size = statSync(path).size;
        // Already computed once by the export fingerprint; hash again only if a caller
        // supplied a manifest without the digest map.
        const contentSha256 = manifest.contentSha256?.(asset) ?? hashFileContent(path);
        const attachmentId = deterministicResourceId(manifest.state.importId, "attachment", `${page.path}\0${asset}`);
        if (uploaded[asset]?.id) {
          if (uploaded[asset].id !== attachmentId || uploaded[asset].contentSha256 !== contentSha256) {
            throw new Error(`Saved attachment metadata for ${basename(asset)} does not match this export.`);
          }
          if (uploaded[asset].status === "uploaded") continue;
        }
        const mime = MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
        uploaded[asset] = {
          ...uploaded[asset],
          status: "uploading",
          id: attachmentId,
          contentSha256,
          size,
          name: basename(asset),
          mime,
        };
        // Persist the deterministic identity before the first external write. If every
        // response is lost, the next run can still reconcile the server-side session by
        // attachment id without creating a second object.
        manifest.recordNow(keyOf(page), { assets: { ...uploaded } });
        const attachment = await client.uploadAttachment(
          record.pageId,
          basename(asset),
          mime,
          { path, size },
          {
            attachmentId,
            contentSha256,
          },
        );
        uploaded[asset] = {
          status: "uploaded",
          id: attachment.id,
          contentSha256,
          size,
          name: attachment.name,
          mime: attachment.mime,
        };
        // Debounced: a lost record is re-derived on resume by asking for the
        // deterministic attachment id, so only the pre-write record above must flush.
        manifest.record(keyOf(page), { assets: { ...uploaded } });
      } catch (error) {
        report.error("attachment_failed", `${basename(asset)}: ${errorMessage(error)}`);
      }
    }
    manifest.record(keyOf(page), { assets: uploaded });
  }
  manifest.flush();

  // Pass 2: content. Every page now exists, so a mention can name its real target.
  const editor = await createImportEditor();
  const assetUrls = assetUrlsFor(selected, manifest);
  const documents = selected.filter((page) => page.kind === "document");
  let written = 0;
  for (const [position, page] of documents.entries()) {
    report.inPage(page.title);
    const record = manifest.node(keyOf(page));
    if (record.remoteMissing || record.remoteKindMismatch) {
      report.progress("content", position + 1, documents.length);
      continue;
    }
    let projectionHash = null;
    let baseRemoteHash = null;
    // Captured before any write can replace the record: the catch below carries this
    // run's recovery knowledge forward from what earlier runs had established.
    const prior = record.content;
    try {
      const blocks = await convertDocument({ index, page, manifest, included, editor, report, assetUrls });
      projectionHash = await documentJsonProjectionHash(await documentJsonForBlocks(editor, blocks));
      const expectedBeforeWrite = prior?.projectionHash ?? (await EMPTY_DOCUMENT_PROJECTION_HASH);
      const expectedProjectionHashes = [expectedBeforeWrite];
      if ((prior?.status === "writing" || prior?.status === "failed") && prior.baseRemoteHash) {
        expectedProjectionHashes.push(prior.baseRemoteHash);
      }
      const result = await documentPush({
        client,
        editor,
        blocks,
        pageId: record.pageId,
        epoch: record.contentEpoch,
        lingerMs,
        expectedProjectionHashes,
        beforeWrite: (liveProjectionHash) => {
          baseRemoteHash = liveProjectionHash;
          // Persist the comparison point before the guarded write transaction. A killed
          // process can then distinguish no commit, its own update, and a later edit.
          manifest.recordNow(keyOf(page), {
            content: { status: "writing", projectionHash, baseRemoteHash },
            contentError: null,
          });
        },
      });
      if (result.conflict) {
        // baseRemoteHash stays owned by beforeWrite: recording the destination's hash
        // there would let a later failure persist it as a writable base, and the next
        // run would overwrite the very edit this branch exists to keep.
        manifest.record(keyOf(page), {
          content: {
            status: "destination-owned",
            projectionHash,
            acceptedRemoteHash: result.liveProjectionHash,
          },
          contentError: null,
        });
        report.issue("destination_document_kept", page.title);
        report.progress("content", position + 1, documents.length);
        continue;
      }
      // Debounced: losing this record leaves 'writing', which the next run resolves by
      // comparing the live document against the recorded base - never by rewriting.
      manifest.record(keyOf(page), {
        content: { status: result.updates > 0 ? "written" : "unchanged", projectionHash },
        contentError: null,
      });
      if (result.updates > 0) written += 1;
    } catch (error) {
      // A push that failed before its connection synced never observed the live
      // document, so beforeWrite recorded no base for this attempt. Without one the
      // next run could not tell the untouched destination from an edit and would
      // permanently keep it, so the base falls back to what is already known: a prior
      // attempt's base, the last content this import wrote, or - for a page that has
      // never held content - the empty document.
      const fallbackBase =
        baseRemoteHash ??
        prior?.baseRemoteHash ??
        (prior?.status === "written" || prior?.status === "unchanged" ? prior.projectionHash : null) ??
        (prior ? null : await EMPTY_DOCUMENT_PROJECTION_HASH);
      manifest.record(keyOf(page), {
        content: {
          status: "failed",
          ...(projectionHash ? { projectionHash } : {}),
          ...(fallbackBase ? { baseRemoteHash: fallbackBase } : {}),
        },
        contentError: errorMessage(error),
      });
      report.error("content_failed", `${page.title}: ${errorMessage(error)}`);
    }
    report.progress("content", position + 1, documents.length);
  }
  manifest.flush();

  // Databases last: a table page has to exist before its rows can be written, and the
  // lease it takes is exclusive, so this is kept away from the content pass.
  const databases = selected.filter((page) => page.kind === "database");
  let rowsWritten = 0;
  for (const database of databases) {
    report.inPage(database.title);
    const record = manifest.node(keyOf(database));
    if (record.remoteMissing || record.remoteKindMismatch || record.remoteTableMissing) continue;
    if (record.table?.phase === "complete") {
      rowsWritten += record.table.acceptedRemoteRowCount ?? record.table.expectedRows ?? 0;
      continue;
    }
    if (record.tableRecoveryAmbiguous) {
      continue;
    }
    try {
      rowsWritten += await importTable({
        index,
        client,
        manifest,
        report,
        database,
        record,
        plan: tablePlans.get(database),
      });
    } catch (error) {
      manifest.recordNow(keyOf(database), { tableError: errorMessage(error) });
      report.error("table_failed", `${database.title}: ${errorMessage(error)}`);
    }
  }
  manifest.flush();

  return {
    pages: selected.length,
    written,
    databases: databases.length,
    rows: rowsWritten,
    errors: report.errorCount,
  };
}

function sameStringSets(left, right) {
  const sortedLeft = [...left].sort((first, second) => first.localeCompare(second));
  const sortedRight = [...right].sort((first, second) => first.localeCompare(second));
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
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
export async function importTable({ index, client, manifest, report, database, record, plan = null }) {
  plan ??= await planTable(index, database, (code, detail) => report.issue(code, detail));
  const { table, batches: rowBatches, contentHash } = plan;
  if (table.columns.length === 0) {
    manifest.record(keyOf(database), {
      table: {
        phase: "complete",
        contentHash,
        expectedColumns: 0,
        expectedRows: 0,
        columnsByRef: {},
        columnOffset: 0,
        rowOffset: 0,
      },
      tableError: null,
    });
    return 0;
  }

  await withTableLease(client, record.pageId, async (leaseToken) => {
    let progress = record.table;
    if (!progress) {
      const live = (await client.readTable(record.pageId)).table;
      if (live.columns.length || live.rowCount) {
        throw new Error("The destination table is not empty, but the manifest has no table progress.");
      }
      progress = {
        phase: "columns",
        revision: live.revision,
        columnOffset: 0,
        rowOffset: 0,
        columnsByRef: {},
        contentHash,
        expectedColumns: table.columns.length,
        expectedRows: table.rows.length,
      };
      // Flushed before the first bulk write so a kill can never leave committed server
      // state with no recorded baseline to reconcile it against.
      manifest.recordNow(keyOf(database), { table: progress, tableError: null });
    }
    if (progress.expectedColumns !== table.columns.length || progress.expectedRows !== table.rows.length) {
      throw new Error("The saved table progress does not match the current CSV.");
    }
    if (progress.contentHash && progress.contentHash !== contentHash) {
      throw new Error("The saved table content hash does not match the current CSV.");
    }
    progress = { ...progress, contentHash, columnsByRef: progress.columnsByRef ?? progress.columnIds ?? {} };

    while (progress.columnOffset < table.columns.length) {
      const offset = progress.columnOffset;
      const columns = table.columns.slice(offset, offset + TABLE_BULK_MAX_COLUMNS);
      const result = await client.bulkTableWrite(
        record.pageId,
        columnBatchRequest(manifest, database, { leaseToken, revision: progress.revision, offset, columns }),
      );
      progress = {
        ...progress,
        revision: result.revision,
        columnOffset: offset + columns.length,
        columnsByRef: mergeColumnMap(progress.columnsByRef, columns, result),
      };
      // The server commit and its generated column ids must have a durable local
      // checkpoint before another batch can get ahead of the manifest.
      manifest.recordNow(keyOf(database), { table: progress });
    }
    if (progress.phase === "columns") {
      progress = { ...progress, phase: "rows" };
      manifest.record(keyOf(database), { table: progress });
    }

    const columnIds = new Map(Object.entries(progress.columnsByRef));
    while (progress.rowOffset < table.rows.length) {
      const batch = rowBatches.find((candidate) => candidate.start === progress.rowOffset);
      if (!batch) throw new Error(`Saved row offset ${progress.rowOffset} is not a valid batch boundary.`);
      const rows = table.rows.slice(batch.start, batch.end).map((row) => mapRow(row, columnIds));
      const body = {
        leaseToken,
        expectedRevision: progress.revision,
        clientRequestId: tableRequestId(manifest, database, "rows", batch.start),
        columns: [],
        rows,
      };
      if (Buffer.byteLength(JSON.stringify(body)) > TABLE_BULK_MAX_BODY_BYTES) {
        throw new Error(`Rows at offset ${batch.start} exceed the bulk request byte limit.`);
      }
      const result = await client.bulkTableWrite(record.pageId, body);
      if (result.rows?.length !== rows.length) throw new Error("The bulk route returned an incomplete row result.");
      progress = { ...progress, revision: result.revision, rowOffset: batch.end };
      manifest.recordNow(keyOf(database), { table: progress });
      report.progress("tables", progress.rowOffset, table.rows.length, database.title);
    }

    const live = (await client.readTable(record.pageId)).table;
    if (live.columns.length !== table.columns.length || live.rowCount !== table.rows.length) {
      throw new Error(
        `The completed table has ${live.columns.length} columns/${live.rowCount} rows; expected ${table.columns.length}/${table.rows.length}.`,
      );
    }
    // Reconciliation and the write pass take separate leases. When recovery already
    // advanced both offsets to the end, no bulk request remains to revision-fence an
    // edit made in that gap, so fence the final read before declaring completion.
    if (live.revision !== progress.revision) {
      throw new Error(
        `The completed table is at revision ${live.revision}; expected imported revision ${progress.revision}.`,
      );
    }
    progress = { ...progress, phase: "complete" };
    manifest.record(keyOf(database), { table: progress, tableError: null });
  });
  return table.rows.length;
}
