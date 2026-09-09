import type { WorkflowStep } from "cloudflare:workers";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import {
  csvToTable,
  documentToYjsUpdate,
  htmlToDocument,
  markdownToDocument,
  type ImportIssue,
  type ImportedTable,
} from "../shared/import-content";
import { documentProjectionHash, sha256Hex, tableContentHash } from "../shared/import-integrity";
import { CLEANUP_JOB_STATUS_SQL } from "../shared/job-state";
import { projectDocument } from "../shared/document-projection";
import type { DocumentContentEnvelope, ImportPreview, ProseMirrorJson } from "../shared/types";
import { readZip, type ZipEntry } from "../shared/zip";
import { isUnsafeMime } from "./attachments";
import type { Env } from "./env";
import type { JobRow } from "./jobs";
import { deleteR2AttemptArtifactKeys, deleteR2AttemptArtifacts, deleteR2Prefix } from "./r2";
import { normalizeFilename } from "./http";
import { pageJson, type PageJsonRow } from "./page-row";
import { refreshPageSearchV2ForIdsStatements } from "./search-index";
import { broadcastWorkspaceEvent } from "./workspace-events";

const IMPORT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_IMPORT_PAGES = 500;
const MAX_NESTED_ZIP_DEPTH = 2;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;

type ImportOptions = { filename: string; format: ImportPreview["format"]; confirmed: boolean };
type ImportAsset = { source: string; name: string; mime: string; bytes: Uint8Array };
type ImportPage = {
  source: string;
  id: string;
  parentId: string | null;
  kind: "document" | "table";
  title: string;
  document?: ProseMirrorJson;
  table?: ImportedTable;
  assets: ImportAsset[];
};
type ImportBundle = { pages: ImportPage[]; issues: ImportIssue[]; preview: ImportPreview };

function record(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Import options are invalid.");
  return parsed as Record<string, unknown>;
}

function importOptions(job: JobRow): ImportOptions {
  const options = record(job.options_json);
  if (
    typeof options.filename !== "string" ||
    !["markdown", "html", "notion_zip"].includes(String(options.format)) ||
    typeof options.confirmed !== "boolean"
  ) {
    throw new Error("Import options are invalid.");
  }
  return options as ImportOptions;
}

function extension(path: string) {
  return /\.[^.]+$/.exec(path.toLowerCase())?.[0] ?? "";
}

function stem(path: string) {
  const name = path.split("/").at(-1) ?? path;
  return name.slice(0, Math.max(0, name.length - extension(name).length));
}

function stripNotionId(value: string) {
  return value
    .replace(/[ -]?[\da-f]{32}$/i, "")
    .replace(/ [\da-f]{4}-[\da-f]{4}$/i, "")
    .trim();
}

function cleanTitle(value: string) {
  return (stripNotionId(value) || "Untitled").replaceAll("\0", "").trim().slice(0, 200) || "Untitled";
}

function mimeFor(name: string) {
  const types: Record<string, string> = {
    ".avif": "image/avif",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
  };
  return types[extension(name)] ?? "application/octet-stream";
}

async function stableId(jobId: string, kind: string, source: string) {
  return `${kind}-${(await sha256Hex(`${jobId}:${kind}:${source}`)).slice(0, 48)}`;
}

function parentPath(path: string) {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function normalizedRelativePath(sourcePath: string, href: string) {
  const raw = href.split("#", 1)[0]!.split("?", 1)[0]!;
  if (!raw || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  try {
    const base = new URL(`https://import.invalid/${sourcePath.split("/").map(encodeURIComponent).join("/")}`);
    const url = new URL(raw, base);
    if (url.origin !== base.origin) return null;
    return url.pathname
      .slice(1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}

type ArchiveBudget = { entries: number; bytes: number };

async function nestedEntries(
  bytes: Uint8Array,
  depth = 0,
  prefix = "",
  budget: ArchiveBudget = { entries: 0, bytes: 0 },
  output: ZipEntry[] = [],
): Promise<ZipEntry[]> {
  if (depth > MAX_NESTED_ZIP_DEPTH) throw new Error("The Notion export contains too many nested ZIP levels.");
  const entries = await readZip(bytes, {
    maxEntries: MAX_ARCHIVE_ENTRIES - budget.entries,
    maxExpandedBytes: MAX_EXPANDED_BYTES - budget.bytes,
  });
  budget.entries += entries.length;
  budget.bytes += entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  for (const entry of entries) {
    if (extension(entry.path) === ".zip" && /^Part-\d+\.zip$/i.test(entry.path.split("/").at(-1) ?? "")) {
      // Each Part-N.zip repeats the same inner layout, so without a per-archive prefix
      // their entries collide in `byPath` and pages hydrate another part's assets.
      await nestedEntries(entry.bytes, depth + 1, `${prefix}${entry.path}/`, budget, output);
      continue;
    }
    output.push({ path: `${prefix}${entry.path}`, bytes: entry.bytes });
  }
  return output;
}

function issueMessages(issues: ImportIssue[]) {
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  return [...counts].slice(0, 25).map(([code, count]) => `${code.replaceAll("_", " ")}: ${count}`);
}

function walkDocument(node: ProseMirrorJson, visit: (node: ProseMirrorJson) => void) {
  visit(node);
  for (const child of node.content ?? []) walkDocument(child, visit);
}

function dataImage(value: string): ImportAsset | null {
  const match = /^data:(image\/(?:png|gif|jpeg|webp));base64,([a-z\d+/=\s]+)$/i.exec(value);
  if (!match) return null;
  try {
    const raw = atob(match[2]!.replaceAll(/\s/g, ""));
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const subtype = match[1]!.split("/")[1]!.replace("jpeg", "jpg");
    return { source: value, name: `embedded-image.${subtype}`, mime: match[1]!, bytes };
  } catch {
    return null;
  }
}

async function hydrateDocumentAssets(
  job: JobRow,
  page: ImportPage,
  entries: ReadonlyMap<string, ZipEntry>,
  pageIds: ReadonlyMap<string, string>,
  issues: ImportIssue[],
) {
  if (!page.document) return;
  const bySource = new Map<string, ImportAsset>();
  walkDocument(page.document, (node) => {
    const url = typeof node.attrs?.url === "string" ? node.attrs.url : null;
    if (url) {
      const embedded = dataImage(url);
      const path = embedded ? null : normalizedRelativePath(page.source, url);
      const entry = path ? entries.get(path) : null;
      const asset =
        embedded ??
        (entry ? { source: path!, name: path!.split("/").at(-1)!, mime: mimeFor(path!), bytes: entry.bytes } : null);
      if (asset) bySource.set(asset.source, asset);
    }
    for (const mark of node.marks ?? []) {
      if (mark.type !== "link" || typeof mark.attrs?.href !== "string") continue;
      const path = normalizedRelativePath(page.source, mark.attrs.href);
      const targetId = path ? pageIds.get(path) : null;
      if (targetId) mark.attrs.href = `/?page=${encodeURIComponent(targetId)}`;
      else if (path) {
        const entry = entries.get(path);
        if (entry)
          bySource.set(path, { source: path, name: path.split("/").at(-1)!, mime: mimeFor(path), bytes: entry.bytes });
      }
    }
  });
  for (const asset of bySource.values()) {
    if (isUnsafeMime(asset.mime, asset.name)) {
      issues.push({ code: "unsafe_asset_skipped", detail: asset.name });
      continue;
    }
    const id = await stableId(job.id, "attachment", `${page.source}:${asset.source}`);
    walkDocument(page.document, (node) => {
      if (typeof node.attrs?.url === "string") {
        const path = normalizedRelativePath(page.source, node.attrs.url);
        const embedded = node.attrs.url.startsWith("data:") ? dataImage(node.attrs.url) : null;
        if (path === asset.source || embedded?.source === asset.source) node.attrs.url = `/api/attachments/${id}`;
      }
      for (const mark of node.marks ?? []) {
        if (mark.type !== "link" || typeof mark.attrs?.href !== "string") continue;
        if (normalizedRelativePath(page.source, mark.attrs.href) === asset.source) {
          mark.attrs.href = `/api/attachments/${id}`;
        }
      }
    });
    page.assets.push(asset);
  }
}

function pageOwnerPath(source: string, knownSources: ReadonlySet<string>) {
  let directory = parentPath(source);
  while (directory) {
    for (const suffix of [".html", ".htm", ".md", ".markdown"]) {
      if (knownSources.has(`${directory}${suffix}`)) return `${directory}${suffix}`;
    }
    directory = parentPath(directory);
  }
  return null;
}

async function notionBundle(job: JobRow, options: ImportOptions, bytes: Uint8Array): Promise<ImportBundle> {
  const entries = await nestedEntries(bytes);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const pageEntries = entries.filter((entry) => {
    const ext = extension(entry.path);
    const parent = parentPath(entry.path);
    // Nested Part-N.zip entries are prefixed by their archive, so "root" means the top
    // level of whichever archive the entry came out of.
    const atArchiveRoot = parent === "" || /\.zip$/i.test(parent);
    return (
      [".html", ".htm", ".md", ".markdown"].includes(ext) &&
      !(atArchiveRoot && /^index\.html?$/i.test(entry.path.split("/").at(-1) ?? ""))
    );
  });
  // Notion writes both a view CSV and an `_all` CSV per database; the latter ignores view filters.
  const csvByDatabase = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (extension(entry.path) !== ".csv") continue;
    const name = stem(entry.path);
    const key = `${parentPath(entry.path)}/${name.replace(/_all$/i, "")}`;
    if (!csvByDatabase.has(key) || /_all$/i.test(name)) csvByDatabase.set(key, entry);
  }
  const csvEntries = [...csvByDatabase.values()];
  if (!pageEntries.length && !csvEntries.length)
    throw new Error("The ZIP does not contain any importable Notion pages or databases.");
  if (pageEntries.length + csvEntries.length > MAX_IMPORT_PAGES)
    throw new Error(`Imports are limited to ${MAX_IMPORT_PAGES} pages.`);
  const pageIds = new Map<string, string>();
  for (const entry of pageEntries) pageIds.set(entry.path, await stableId(job.id, "page", entry.path));
  const matchedCsv = new Set<string>();
  const knownSources = new Set(pageEntries.map((entry) => entry.path));
  const issues: ImportIssue[] = [];
  const pages: ImportPage[] = [];
  for (const entry of pageEntries) {
    const rawStem = stem(entry.path);
    const csv = csvByDatabase.get(`${parentPath(entry.path)}/${rawStem}`);
    const parentSource = pageOwnerPath(entry.path, knownSources);
    const sourceText = new TextDecoder().decode(entry.bytes);
    const parsed = extension(entry.path).startsWith(".htm")
      ? htmlToDocument(sourceText)
      : markdownToDocument(sourceText);
    issues.push(...parsed.issues);
    if (csv) matchedCsv.add(csv.path);
    pages.push({
      source: entry.path,
      id: pageIds.get(entry.path)!,
      parentId: parentSource ? (pageIds.get(parentSource) ?? null) : null,
      kind: csv ? "table" : "document",
      title: cleanTitle(rawStem),
      ...(csv ? { table: csvToTable(new TextDecoder().decode(csv.bytes), issues) } : { document: parsed.document }),
      assets: [],
    });
  }
  for (const entry of csvEntries.filter((candidate) => !matchedCsv.has(candidate.path))) {
    const id = await stableId(job.id, "page", entry.path);
    pageIds.set(entry.path, id);
    pages.push({
      source: entry.path,
      id,
      parentId: null,
      kind: "table",
      title: cleanTitle(stem(entry.path).replace(/_all$/i, "")),
      table: csvToTable(new TextDecoder().decode(entry.bytes), issues),
      assets: [],
    });
  }
  for (const page of pages) await hydrateDocumentAssets(job, page, byPath, pageIds, issues);
  const assetPaths = entries.filter(
    (entry) => !knownSources.has(entry.path) && extension(entry.path) !== ".csv",
  ).length;
  const preview: ImportPreview = {
    format: "notion_zip",
    filename: options.filename,
    pages: pages.length,
    tables: pages.filter((page) => page.kind === "table").length,
    assets: assetPaths,
    warnings: issueMessages(issues),
  };
  return { pages, issues, preview };
}

async function singlePageBundle(job: JobRow, options: ImportOptions, bytes: Uint8Array): Promise<ImportBundle> {
  const source = new TextDecoder().decode(bytes);
  const html = options.format === "html" ? htmlToDocument(source) : null;
  const parsed = html ?? markdownToDocument(source);
  const importedTitle = html?.title ?? "";
  const title = cleanTitle(importedTitle || stem(options.filename));
  const page: ImportPage = {
    source: options.filename,
    id: await stableId(job.id, "page", options.filename),
    parentId: null,
    kind: "document",
    title,
    document: parsed.document,
    assets: [],
  };
  const issues = parsed.issues;
  await hydrateDocumentAssets(job, page, new Map(), new Map(), issues);
  const preview: ImportPreview = {
    format: options.format,
    filename: options.filename,
    pages: 1,
    tables: 0,
    assets: page.assets.length,
    warnings: issueMessages(issues),
  };
  return { pages: [page], issues, preview };
}

async function loadBundle(env: Env, job: JobRow, options: ImportOptions) {
  if (!job.input_key?.startsWith(`jobs/${job.id}/input/`)) throw new Error("The import upload is missing.");
  const object = await env.BUCKET.get(job.input_key);
  if (!object) throw new Error("The import upload is missing.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  return options.format === "notion_zip" ? notionBundle(job, options, bytes) : singlePageBundle(job, options, bytes);
}

async function assertImportActive(env: Env, job: Pick<JobRow, "id" | "attempt">) {
  const row = await env.DB.prepare(`SELECT status FROM jobs WHERE id = ? AND attempt = ?`)
    .bind(job.id, job.attempt)
    .first<{ status: string }>();
  if (!row || row.status !== "running")
    throw new Error(row?.status === "canceling" || row?.status === "canceled" ? "Job canceled." : "Job is not active.");
}

async function setProgress(env: Env, job: JobRow, current: number, total: number, label: string) {
  await env.DB.prepare(
    `UPDATE jobs SET progress_current = ?, progress_total = ?, progress_label = ?, updated_at = ?
      WHERE id = ? AND attempt = ? AND status = 'running'`,
  )
    .bind(current, total, label, Date.now(), job.id, job.attempt)
    .run();
  await broadcastWorkspaceEvent(env, job.workspace_id, { type: "jobs-invalidated" });
}

async function stagePageRows(env: Env, job: JobRow, bundle: ImportBundle) {
  const previous = new Map<string, string | null>();
  const timestamp = Date.now();
  for (const page of [...bundle.pages].sort(
    (left, right) =>
      left.source.split("/").length - right.source.split("/").length || left.source.localeCompare(right.source),
  )) {
    await assertImportActive(env, job);
    const existing = await env.DB.prepare(`SELECT import_job_id, content_epoch FROM pages WHERE id = ?`)
      .bind(page.id)
      .first<{ import_job_id: string | null; content_epoch: number }>();
    if (existing) {
      if (existing.import_job_id !== job.id) throw new Error("An imported page id is already in use.");
      if (existing.content_epoch !== job.attempt) {
        // A retry must not reuse the purged document room of the previous attempt.
        const updated = await env.DB.prepare(
          `UPDATE pages SET content_epoch = ? WHERE id = ? AND import_job_id = ?
            AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND attempt = ? AND status = 'running')`,
        )
          .bind(job.attempt, page.id, job.id, job.id, job.attempt)
          .run();
        if (!updated.meta.changes) {
          await assertImportActive(env, job);
          const current = await env.DB.prepare(`SELECT import_job_id, content_epoch FROM pages WHERE id = ?`)
            .bind(page.id)
            .first<{ import_job_id: string | null; content_epoch: number }>();
          if (current?.import_job_id !== job.id || current.content_epoch !== job.attempt) {
            throw new Error("An imported page could not be fenced to this attempt.");
          }
        }
      }
      continue;
    }
    const parentKey = page.parentId ?? "root";
    if (!previous.has(parentKey)) {
      const last = await env.DB.prepare(
        `SELECT position FROM pages WHERE space_id = ? AND parent_id IS ? AND archived_at IS NULL
          AND import_job_id IS NULL AND is_template = 0 ORDER BY position DESC, id DESC LIMIT 1`,
      )
        .bind(job.space_id, page.parentId)
        .first<{ position: string }>();
      previous.set(parentKey, last?.position ?? null);
    }
    const position = generateJitteredKeyBetween(previous.get(parentKey) ?? null, null);
    previous.set(parentKey, position);
    await env.DB.prepare(
      `INSERT INTO pages
        (id, workspace_id, space_id, parent_id, kind, position, title, import_job_id, content_epoch,
         created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        page.id,
        job.workspace_id,
        job.space_id,
        page.parentId,
        page.kind,
        position,
        page.title,
        job.id,
        job.attempt,
        job.requested_by,
        job.requested_by,
        timestamp,
        timestamp,
      )
      .run();
  }
}

async function stageAttachments(env: Env, job: JobRow, page: ImportPage) {
  for (const asset of page.assets) {
    await assertImportActive(env, job);
    const id = await stableId(job.id, "attachment", `${page.source}:${asset.source}`);
    const hash = await sha256Hex(asset.bytes);
    const key = `assets/${job.workspace_id}/${id}/attempts/${job.attempt}/${hash}`;
    const existing = await env.DB.prepare(`SELECT page_id, r2_key FROM attachments WHERE id = ?`)
      .bind(id)
      .first<{ page_id: string; r2_key: string }>();
    if (existing) {
      if (existing.page_id !== page.id) throw new Error("An imported attachment id is already in use.");
      if (existing.r2_key === key) continue;
      await env.BUCKET.put(key, asset.bytes, {
        httpMetadata: { contentType: asset.mime },
        customMetadata: { attachmentId: id, importJobId: job.id },
      });
      const moved = await env.DB.prepare(
        `UPDATE attachments SET r2_key = ? WHERE id = ? AND page_id = ? AND r2_key = ?
          AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND attempt = ? AND status = 'running')`,
      )
        .bind(key, id, page.id, existing.r2_key, job.id, job.attempt)
        .run();
      if (!moved.meta.changes) {
        const replay = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?`)
          .bind(id)
          .first<{ r2_key: string }>();
        if (replay?.r2_key !== key) {
          await env.BUCKET.delete(key);
          throw new Error("The imported attachment could not be fenced to this attempt.");
        }
      } else {
        await env.BUCKET.delete(existing.r2_key);
      }
      continue;
    }
    await env.BUCKET.put(key, asset.bytes, {
      httpMetadata: { contentType: asset.mime },
      customMetadata: { attachmentId: id, importJobId: job.id },
    });
    try {
      await env.DB.prepare(
        `INSERT INTO attachments
          (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          job.workspace_id,
          page.id,
          key,
          normalizeFilename(asset.name) || "attachment",
          asset.mime,
          asset.bytes.byteLength,
          hash,
          job.requested_by,
          Date.now(),
        )
        .run();
    } catch (error) {
      const replay = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?`)
        .bind(id)
        .first<{ r2_key: string }>();
      if (replay?.r2_key !== key) await env.BUCKET.delete(key);
      if (!replay || replay.r2_key !== key) throw error;
    }
  }
}

async function initializeDocument(env: Env, job: JobRow, page: ImportPage) {
  if (!page.document) throw new Error("Imported document content is missing.");
  const inputKey = `jobs/${job.id}/attempts/${job.attempt}/documents/${page.id}.bin`;
  await env.BUCKET.put(inputKey, documentToYjsUpdate(page.document), {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { jobId: job.id, pageId: page.id },
  });
  const response = await env.DOCUMENT.getByName(`${page.id}~${job.attempt}`).fetch(
    new Request("https://document.internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
      body: JSON.stringify({ jobId: job.id, inputKey }),
    }),
  );
  if (!response.ok) throw new Error(`Imported document initialization failed (${response.status}).`);
}

function cellColumns(
  column: ImportedTable["columns"][number] & { id: string },
  value: string | number | boolean | null,
  options: ReadonlyMap<string, string>,
) {
  return {
    text: column.type === "text" && typeof value === "string" ? value : null,
    number: column.type === "number" && typeof value === "number" ? value : null,
    boolean: column.type === "checkbox" && typeof value === "boolean" ? (value ? 1 : 0) : null,
    date: column.type === "date" && typeof value === "string" ? value : null,
    select:
      column.type === "select" && typeof value === "string" ? (options.get(`${column.id}:${value}`) ?? null) : null,
  };
}

async function initializeTable(env: Env, job: JobRow, page: ImportPage) {
  const table = page.table;
  if (!table) throw new Error("Imported table content is missing.");
  const timestamp = Date.now();
  const columns = await Promise.all(
    table.columns.map(async (column, index) => ({
      ...column,
      id: await stableId(job.id, "column", `${page.source}:${index}`),
      position: index,
    })),
  );
  const options = new Map<string, string>();
  const optionRows: Array<{ id: string; columnId: string; label: string; position: number }> = [];
  for (const column of columns) {
    for (const [position, label] of column.options.entries()) {
      const id = await stableId(job.id, "option", `${page.source}:${column.position}:${label}`);
      options.set(`${column.id}:${label}`, id);
      optionRows.push({ id, columnId: column.id, label, position });
    }
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO table_state (page_id, revision) VALUES (?, 1)`).bind(page.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO table_columns (id, page_id, name, type, position)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.name'), json_extract(value, '$.type'), json_extract(value, '$.position')
         FROM json_each(?)`,
    ).bind(page.id, JSON.stringify(columns)),
    env.DB.prepare(
      `INSERT OR IGNORE INTO table_select_options (id, column_id, label, position)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.columnId'), json_extract(value, '$.label'), json_extract(value, '$.position')
         FROM json_each(?)`,
    ).bind(JSON.stringify(optionRows)),
  ]);
  for (let offset = 0; offset < table.rows.length; offset += 100) {
    await assertImportActive(env, job);
    const values = await Promise.all(
      table.rows.slice(offset, offset + 100).map(async (row, rowOffset) => {
        const position = offset + rowOffset;
        const rowId = await stableId(job.id, "row", `${page.source}:${position}`);
        return {
          id: rowId,
          position,
          cells: row.flatMap((value, columnIndex) => {
            if (value === null) return [];
            const column = columns[columnIndex]!;
            return [{ rowId, columnId: column.id, ...cellColumns(column, value, options) }];
          }),
        };
      }),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
         SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.position'), ?, ?, ? FROM json_each(?)`,
      ).bind(page.id, job.requested_by, timestamp, timestamp, JSON.stringify(values)),
      env.DB.prepare(
        `INSERT OR REPLACE INTO table_cells
          (row_id, column_id, text_value, number_value, boolean_value, date_value, select_value, updated_at)
         SELECT json_extract(cell.value, '$.rowId'), json_extract(cell.value, '$.columnId'),
                json_extract(cell.value, '$.text'), json_extract(cell.value, '$.number'),
                json_extract(cell.value, '$.boolean'), json_extract(cell.value, '$.date'),
                json_extract(cell.value, '$.select'), ?
           FROM json_each(?) row_data, json_each(json_extract(row_data.value, '$.cells')) cell`,
      ).bind(timestamp, JSON.stringify(values)),
    ]);
  }
}

async function verifyPage(env: Env, job: JobRow, page: ImportPage) {
  if (page.document) {
    const response = await env.DOCUMENT.getByName(`${page.id}~${job.attempt}`).fetch(
      new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
    );
    if (!response.ok) throw new Error(`Imported document verification failed (${response.status}).`);
    const envelope = await response.json<DocumentContentEnvelope>();
    const expected = await documentProjectionHash(projectDocument(page.document));
    const actual = await documentProjectionHash(projectDocument(envelope.document));
    if (expected !== actual) throw new Error(`Imported document ${page.title} failed verification.`);
    return;
  }
  const table = page.table!;
  const columns = await env.DB.prepare(
    `SELECT id, name, type FROM table_columns WHERE page_id = ? ORDER BY position, id`,
  )
    .bind(page.id)
    .all<{ id: string; name: string; type: string }>();
  const options = await env.DB.prepare(
    `SELECT column_id, id, label FROM table_select_options
      WHERE column_id IN (SELECT id FROM table_columns WHERE page_id = ?) ORDER BY column_id, position, id`,
  )
    .bind(page.id)
    .all<{ column_id: string; id: string; label: string }>();
  const optionLabels = new Map(options.results.map((option) => [option.id, option.label]));
  const rows = await env.DB.prepare(
    `SELECT row.id row_id, cell.column_id, cell.text_value, cell.number_value, cell.boolean_value, cell.date_value, cell.select_value
       FROM table_rows row LEFT JOIN table_cells cell ON cell.row_id = row.id
      WHERE row.page_id = ? ORDER BY row.position, row.id`,
  )
    .bind(page.id)
    .all<{
      row_id: string;
      column_id: string | null;
      text_value: string | null;
      number_value: number | null;
      boolean_value: number | null;
      date_value: string | null;
      select_value: string | null;
    }>();
  const storedRows = new Map<string, Map<string, string | number | boolean | null>>();
  for (const row of rows.results) {
    const cells = storedRows.get(row.row_id) ?? new Map();
    storedRows.set(row.row_id, cells);
    if (!row.column_id) continue;
    const value =
      row.text_value ??
      row.number_value ??
      (row.boolean_value === null ? null : row.boolean_value === 1) ??
      row.date_value ??
      (row.select_value ? (optionLabels.get(row.select_value) ?? null) : null);
    cells.set(row.column_id, value);
  }
  const expectedHash = await tableContentHash(table.columns, table.rows);
  const storedHash = await tableContentHash(
    columns.results.map((column) => ({
      name: column.name,
      type: column.type,
      options: options.results.filter((option) => option.column_id === column.id).map((option) => option.label),
    })),
    [...storedRows.values()].map((cells) => columns.results.map((column) => cells.get(column.id) ?? null)),
  );
  if (expectedHash !== storedHash) throw new Error(`Imported table ${page.title} failed verification.`);
}

async function publishImport(env: Env, job: JobRow, bundle: ImportBundle) {
  await assertImportActive(env, job);
  const timestamp = Date.now();
  const roots = bundle.pages.filter((page) => page.parentId === null);
  const pageIdValues = bundle.pages.map((page) => page.id);
  const pageIds = JSON.stringify(pageIdValues);
  const result = JSON.stringify({
    warnings: issueMessages(bundle.issues),
    pageId: roots[0]?.id ?? bundle.pages[0]?.id,
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO subscriptions (id, workspace_id, user_id, resource_type, resource_id, created_by, created_at)
       SELECT ? || ':' || id, workspace_id, ?, 'page', id, ?, ? FROM pages
        WHERE import_job_id = ? AND content_epoch = ?`,
    ).bind(job.id, job.requested_by, job.requested_by, timestamp, job.id, job.attempt),
    env.DB.prepare(
      `UPDATE pages SET import_job_id = NULL, updated_at = ? WHERE import_job_id = ? AND content_epoch = ?
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND attempt = ? AND status = 'running')`,
    ).bind(timestamp, job.id, job.attempt, job.id, job.attempt),
    env.DB.prepare(
      `INSERT INTO page_search (page_id, workspace_id, title, body)
       SELECT id, workspace_id, title, plain_text FROM pages
        WHERE id IN (SELECT value FROM json_each(?)) AND import_job_id IS NULL AND is_template = 0`,
    ).bind(pageIds),
    ...refreshPageSearchV2ForIdsStatements(env.DB, pageIdValues),
    env.DB.prepare(
      `UPDATE jobs SET status = 'succeeded', progress_current = 7, progress_total = 7,
        progress_label = 'Complete', result_json = ?, expires_at = ?, error_code = NULL, error_message = NULL,
        updated_at = ? WHERE id = ? AND attempt = ? AND status = 'running'`,
    ).bind(result, timestamp + IMPORT_ARTIFACT_TTL_MS, timestamp, job.id, job.attempt),
  ]);
  const published = await env.DB.prepare(
    `SELECT * FROM pages WHERE id IN (SELECT value FROM json_each(?)) AND import_job_id IS NULL ORDER BY position, id`,
  )
    .bind(pageIds)
    .all<PageJsonRow>();
  if (published.results.length !== bundle.pages.length)
    throw new Error("The imported pages could not be published atomically.");
  // The pages are published and the job is already marked succeeded, so a broadcast
  // failure must not throw the step back to the workflow for a retry.
  const broadcast = async (event: Parameters<typeof broadcastWorkspaceEvent>[2]) => {
    try {
      await broadcastWorkspaceEvent(env, job.workspace_id, event);
    } catch (error) {
      console.error("Failed to broadcast a published import", { jobId: job.id, type: event.type, error });
    }
  };
  await broadcast({ type: "pages-upserted", pages: published.results.map(pageJson) });
  await broadcast({ type: "jobs-invalidated" });
}

export async function cleanupImport(env: Env, job: JobRow, stillOwned: () => Promise<boolean>) {
  const current = await env.DB.prepare(
    `SELECT 1 active FROM jobs WHERE id = ? AND attempt = ? AND status IN (${CLEANUP_JOB_STATUS_SQL})`,
  )
    .bind(job.id, job.attempt)
    .first();
  if (!current || !(await stillOwned())) return;
  const pages = await env.DB.prepare(
    `SELECT id, kind, content_epoch FROM pages WHERE import_job_id = ? AND content_epoch <= ?`,
  )
    .bind(job.id, job.attempt)
    .all<{ id: string; kind: "document" | "table"; content_epoch: number }>();
  const attachments = await env.DB.prepare(
    `SELECT id, r2_key, content_sha256 FROM attachments WHERE page_id IN (
      SELECT id FROM pages WHERE import_job_id = ? AND content_epoch <= ?
    )`,
  )
    .bind(job.id, job.attempt)
    .all<{ id: string; r2_key: string; content_sha256: string | null }>();
  for (const page of pages.results) {
    if (page.kind !== "document") continue;
    if (!(await stillOwned())) return;
    const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
      new Request("https://document.internal/purge", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    if (!(await stillOwned())) return;
    if (!response.ok) throw new Error("A staged import document could not be purged.");
  }
  await deleteR2AttemptArtifactKeys(
    env.BUCKET,
    attachments.results.map((attachment) => ({
      rootPrefix: `assets/${job.workspace_id}/${attachment.id}`,
      artifactPath: attachment.content_sha256 ?? attachment.r2_key.split("/").at(-1)!,
    })),
    job.attempt,
    stillOwned,
  );
  for (const page of pages.results) {
    if (!(await stillOwned())) return;
    await deleteR2Prefix(env.BUCKET, `documents/${page.id}/epochs/${page.content_epoch}/`);
  }
  if (!(await stillOwned())) return;
  await deleteR2AttemptArtifacts(env.BUCKET, `jobs/${job.id}`, job.attempt, "documents/");
  if (!(await stillOwned())) return;
  await deleteR2Prefix(env.BUCKET, `jobs/${job.id}/documents/`);
  if (!(await stillOwned())) return;
  await env.DB.prepare(`DELETE FROM pages WHERE import_job_id = ? AND content_epoch <= ?`)
    .bind(job.id, job.attempt)
    .run();
}

export async function runImport(env: Env, job: JobRow, step: Pick<WorkflowStep, "do">) {
  const options = importOptions(job);
  let bundlePromise: Promise<ImportBundle> | null = null;
  const bundle = () => (bundlePromise ??= loadBundle(env, job, options));
  const preview = await step.do("inspect import", async () => {
    await assertImportActive(env, job);
    return (await bundle()).preview;
  });
  if (!options.confirmed) {
    await step.do("await confirmation", async () => {
      await assertImportActive(env, job);
      await env.DB.prepare(
        `UPDATE jobs SET status = 'awaiting_confirmation', progress_current = 2, progress_total = 7,
          progress_label = 'Ready to import', result_json = ?, expires_at = ?, updated_at = ?
         WHERE id = ? AND attempt = ? AND status = 'running'`,
      )
        .bind(
          JSON.stringify({ warnings: preview.warnings, preview }),
          Date.now() + IMPORT_ARTIFACT_TTL_MS,
          Date.now(),
          job.id,
          job.attempt,
        )
        .run();
      await broadcastWorkspaceEvent(env, job.workspace_id, { type: "jobs-invalidated" });
    });
    return;
  }
  await step.do("create staged resources", async () => {
    const loaded = await bundle();
    await setProgress(env, job, 2, 7, "Creating staged pages");
    await stagePageRows(env, job, loaded);
  });
  await step.do("upload imported assets", async () => {
    const loaded = await bundle();
    await setProgress(env, job, 3, 7, "Uploading assets");
    for (const page of loaded.pages) await stageAttachments(env, job, page);
  });
  await step.do("write imported content", async () => {
    const loaded = await bundle();
    await setProgress(env, job, 4, 7, "Writing content");
    for (const page of loaded.pages) {
      await assertImportActive(env, job);
      if (page.kind === "document") await initializeDocument(env, job, page);
      else await initializeTable(env, job, page);
    }
  });
  await step.do("verify imported content", async () => {
    const loaded = await bundle();
    await setProgress(env, job, 5, 7, "Verifying import");
    for (const page of loaded.pages) await verifyPage(env, job, page);
  });
  await step.do("publish import", async () => {
    const loaded = await bundle();
    await setProgress(env, job, 6, 7, "Publishing pages");
    await publishImport(env, job, loaded);
  });
}
