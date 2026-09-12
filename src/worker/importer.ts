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

type ImportOptions = {
  filename: string;
  format: ImportPreview["format"];
  confirmed: boolean;
  groupSpaceIds?: Record<string, string>;
};
type ImportAsset = { source: string; name: string; mime: string; bytes: Uint8Array };
type ImportPage = {
  source: string;
  id: string;
  parentId: string | null;
  parentSource: string | null;
  spaceId: string;
  groupKey: string;
  notionId: string | null;
  sourceRole: "page" | "table_row_detail" | "unmatched_table_page" | "generated_folder";
  tableRowId: string | null;
  order: number;
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
  if (
    options.groupSpaceIds !== undefined &&
    (!options.groupSpaceIds ||
      typeof options.groupSpaceIds !== "object" ||
      Array.isArray(options.groupSpaceIds) ||
      Object.values(options.groupSpaceIds).some((value) => typeof value !== "string"))
  ) {
    throw new Error("Import space mappings are invalid.");
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

function notionId(value: string) {
  return /([\da-f]{32})$/i.exec(value)?.[1]?.toLowerCase() ?? null;
}

function markdownTitle(source: string) {
  const match = source.replace(/^\uFEFF/, "").match(/^#\s+([^\r\n]+)\s*(?:\r?\n|$)/);
  return match?.[1]?.replaceAll("\u00a0", " ").trim() ?? "";
}

function withoutLeadingNotionTitle(document: ProseMirrorJson) {
  const group = document.content?.[0];
  if (group?.type !== "blockGroup") return document;
  const [container, ...rest] = group.content ?? [];
  const heading = container?.type === "blockContainer" ? container.content?.[0] : null;
  if (heading?.type !== "heading" || Number(heading.attrs?.level) !== 1) return document;
  return {
    ...document,
    content: [
      {
        ...group,
        content: rest.length
          ? rest
          : [
              {
                type: "blockContainer",
                attrs: { id: "import-empty" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
                  },
                ],
              },
            ],
      },
    ],
  };
}

function notionRelativeSegments(source: string) {
  const segments = source.split("/");
  const archive = segments.findLastIndex((segment) => /\.zip$/i.test(segment));
  return segments.slice(archive + 1);
}

function groupKeyFor(source: string) {
  const segments = notionRelativeSegments(source);
  return segments.length > 2 && /^Export-/i.test(segments[0]!) ? segments[1]! : "Imported";
}

function groupRootFor(source: string) {
  const segments = source.split("/");
  const relative = notionRelativeSegments(source);
  const group = groupKeyFor(source);
  if (group === "Imported") return segments.slice(0, segments.length - relative.length).join("/");
  const groupIndex = segments.length - relative.length + 1;
  return segments.slice(0, groupIndex + 1).join("/");
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
  linkStats: { resolved: number; unresolved: number },
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
      if (targetId) {
        linkStats.resolved += 1;
        mark.attrs.href = `/?page=${encodeURIComponent(targetId)}`;
      } else if (path) {
        const entry = entries.get(path);
        if (entry) {
          linkStats.resolved += 1;
          bySource.set(path, { source: path, name: path.split("/").at(-1)!, mime: mimeFor(path), bytes: entry.bytes });
        } else {
          linkStats.unresolved += 1;
          issues.push({ code: "local_link_unresolved", detail: path });
        }
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

function markdownHrefs(source: string) {
  return [...source.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
}

function directoryOwners(entries: ZipEntry[]) {
  const pages = entries.map((entry) => ({
    entry,
    directory: parentPath(entry.path),
    rawStem: stem(entry.path),
    title: stripNotionId(stem(entry.path)),
    notionId: notionId(stem(entry.path)),
    text: new TextDecoder().decode(entry.bytes),
  }));
  const byPath = new Map(pages.map((page) => [page.entry.path, page]));
  const directories = new Set<string>();
  for (const page of pages) {
    let directory = page.directory;
    while (directory) {
      directories.add(directory);
      directory = parentPath(directory);
    }
  }
  const claimed = new Set<string>();
  const owners = new Map<string, string>();
  const ordered = [...directories].sort((left, right) => {
    const leftPartial = / [\da-f]{4}-[\da-f]{4}$/i.test(left) ? 0 : 1;
    const rightPartial = / [\da-f]{4}-[\da-f]{4}$/i.test(right) ? 0 : 1;
    return leftPartial - rightPartial || left.localeCompare(right);
  });
  for (const directory of ordered) {
    for (const suffix of [".html", ".htm", ".md", ".markdown"]) {
      const exact = byPath.get(`${directory}${suffix}`);
      if (exact && !claimed.has(exact.entry.path)) {
        owners.set(directory, exact.entry.path);
        claimed.add(exact.entry.path);
        break;
      }
    }
    if (owners.has(directory)) continue;
    const directoryParent = parentPath(directory);
    const name = directory.split("/").at(-1) ?? directory;
    const siblings = pages.filter((page) => page.directory === directoryParent && !claimed.has(page.entry.path));
    const partial = / ([\da-f]{4})-([\da-f]{4})$/i.exec(name);
    if (partial) {
      const matches = siblings.filter(
        (page) =>
          page.notionId?.startsWith(partial[1]!.toLowerCase()) && page.notionId.endsWith(partial[2]!.toLowerCase()),
      );
      if (matches.length === 1) {
        owners.set(directory, matches[0]!.entry.path);
        claimed.add(matches[0]!.entry.path);
        continue;
      }
    }
    const titled = siblings.filter((page) => page.title === stripNotionId(name));
    if (titled.length === 1) {
      owners.set(directory, titled[0]!.entry.path);
      claimed.add(titled[0]!.entry.path);
      continue;
    }
    if (titled.length > 1) {
      const linked = titled.filter((page) =>
        markdownHrefs(page.text).some((href) => {
          const target = normalizedRelativePath(page.entry.path, href);
          return target === directory || target?.startsWith(`${directory}/`);
        }),
      );
      if (linked.length === 1) {
        owners.set(directory, linked[0]!.entry.path);
        claimed.add(linked[0]!.entry.path);
      }
    }
  }
  return { owners, directories };
}

function ownerFor(source: string, owners: ReadonlyMap<string, string>) {
  const groupRoot = groupRootFor(source);
  let directory = parentPath(source);
  while (directory && directory !== groupRoot) {
    const owner = owners.get(directory);
    if (owner && owner !== source) return owner;
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
  const fallbackSpaceId = job.space_id;
  if (!fallbackSpaceId) throw new Error("The import destination space is missing.");
  const { owners, directories } = directoryOwners(pageEntries);
  const archiveOrder = new Map(entries.map((entry, index) => [entry.path, index]));
  const matchedCsv = new Set<string>();
  const knownSources = new Set(pageEntries.map((entry) => entry.path));
  const issues: ImportIssue[] = [];
  const pages: ImportPage[] = [];
  for (const entry of pageEntries) {
    const rawStem = stem(entry.path);
    const csv = csvByDatabase.get(`${parentPath(entry.path)}/${rawStem}`);
    const parentSource = ownerFor(entry.path, owners);
    const groupKey = groupKeyFor(entry.path);
    const sourceText = new TextDecoder().decode(entry.bytes);
    const html = extension(entry.path).startsWith(".htm") ? htmlToDocument(sourceText) : null;
    const parsed = html ?? markdownToDocument(sourceText);
    issues.push(...parsed.issues);
    if (csv) matchedCsv.add(csv.path);
    const title = cleanTitle(html?.title || markdownTitle(sourceText) || rawStem);
    pages.push({
      source: entry.path,
      id: pageIds.get(entry.path)!,
      parentId: parentSource ? (pageIds.get(parentSource) ?? null) : null,
      parentSource,
      spaceId: options.groupSpaceIds?.[groupKey] ?? fallbackSpaceId,
      groupKey,
      notionId: notionId(rawStem),
      sourceRole: "page",
      tableRowId: null,
      order: archiveOrder.get(entry.path) ?? Number.MAX_SAFE_INTEGER,
      kind: csv ? "table" : "document",
      title,
      ...(csv
        ? { table: csvToTable(new TextDecoder().decode(csv.bytes), issues) }
        : { document: markdownTitle(sourceText) ? withoutLeadingNotionTitle(parsed.document) : parsed.document }),
      assets: [],
    });
  }
  for (const entry of csvEntries.filter((candidate) => !matchedCsv.has(candidate.path))) {
    const id = await stableId(job.id, "page", entry.path);
    pageIds.set(entry.path, id);
    const parentSource = ownerFor(entry.path, owners);
    const groupKey = groupKeyFor(entry.path);
    pages.push({
      source: entry.path,
      id,
      parentId: parentSource ? (pageIds.get(parentSource) ?? null) : null,
      parentSource,
      spaceId: options.groupSpaceIds?.[groupKey] ?? fallbackSpaceId,
      groupKey,
      notionId: notionId(stem(entry.path)),
      sourceRole: "page",
      tableRowId: null,
      order: archiveOrder.get(entry.path) ?? Number.MAX_SAFE_INTEGER,
      kind: "table",
      title: cleanTitle(stem(entry.path).replace(/_all$/i, "")),
      table: csvToTable(new TextDecoder().decode(entry.bytes), issues),
      assets: [],
    });
  }

  // Notion emits database row bodies as ordinary child Markdown pages. Preserve
  // those bodies, but link them to their canonical table rows and keep them out of
  // the normal page tree so a database does not appear twice in the sidebar.
  for (const tablePage of pages.filter((page) => page.kind === "table" && page.table)) {
    const children = pages
      .filter((candidate) => candidate.parentId === tablePage.id && candidate.kind === "document")
      .sort((left, right) => left.order - right.order || left.source.localeCompare(right.source));
    const rowsByTitle = new Map<string, number[]>();
    for (const [index, row] of tablePage.table!.rows.entries()) {
      const key = cleanTitle(String(row[0] ?? "")).toLocaleLowerCase();
      const indexes = rowsByTitle.get(key) ?? [];
      indexes.push(index);
      rowsByTitle.set(key, indexes);
    }
    for (const child of children) {
      const indexes = rowsByTitle.get(child.title.toLocaleLowerCase()) ?? [];
      const rowIndex = indexes.shift();
      if (rowIndex === undefined) {
        child.sourceRole = "unmatched_table_page";
        issues.push({ code: "table_row_page_unmatched", detail: child.source });
        continue;
      }
      child.sourceRole = "table_row_detail";
      child.tableRowId = await stableId(job.id, "row", `${tablePage.source}:${rowIndex}`);
      child.order = rowIndex;
    }
  }

  const linkStats = { resolved: 0, unresolved: 0 };
  for (const page of pages) await hydrateDocumentAssets(job, page, byPath, pageIds, issues, linkStats);
  const assetPaths = entries.filter(
    (entry) => !knownSources.has(entry.path) && extension(entry.path) !== ".csv",
  ).length;
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const depth = (page: ImportPage) => {
    let current: ImportPage | undefined = page;
    let value = 0;
    const visited = new Set<string>();
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      current = pageById.get(current.parentId);
      value += 1;
    }
    return value;
  };
  const siblingTitles = new Map<string, number>();
  for (const page of pages) {
    const key = `${page.spaceId}:${page.parentId ?? "root"}:${page.title.toLocaleLowerCase()}`;
    siblingTitles.set(key, (siblingTitles.get(key) ?? 0) + 1);
  }
  const unresolvedParents = pages.filter((page) => {
    if (page.parentSource) return !page.parentId;
    const directory = parentPath(page.source);
    return directory !== groupRootFor(page.source) && directories.has(directory) && !/\/[\da-f]{32}$/i.test(directory);
  }).length;
  const blockingIssues = unresolvedParents
    ? [`${unresolvedParents} parent folder mappings could not be resolved.`]
    : [];
  const groups = [...new Set(pages.map((page) => page.groupKey))].map((key) => ({
    key,
    name: stripNotionId(key),
    pages: pages.filter((page) => page.groupKey === key).length,
    roots: pages.filter((page) => page.groupKey === key && page.parentId === null).length,
    suggestedVisibility: /private\s*&\s*shared/i.test(key) ? ("private" as const) : ("workspace" as const),
  }));
  const preview: ImportPreview = {
    format: "notion_zip",
    filename: options.filename,
    pages: pages.length,
    tables: pages.filter((page) => page.kind === "table").length,
    assets: assetPaths,
    roots: pages.filter((page) => page.parentId === null).length,
    nested: pages.filter((page) => page.parentId !== null).length,
    maxDepth: Math.max(0, ...pages.map(depth)),
    resolvedLinks: linkStats.resolved,
    unresolvedLinks: linkStats.unresolved,
    duplicateTitles: [...siblingTitles.values()]
      .filter((count) => count > 1)
      .reduce((total, count) => total + count, 0),
    unresolvedParents,
    blockingIssues,
    groups,
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
    parentSource: null,
    spaceId:
      job.space_id ??
      (() => {
        throw new Error("The import destination space is missing.");
      })(),
    groupKey: "Imported",
    notionId: null,
    sourceRole: "page",
    tableRowId: null,
    order: 0,
    kind: "document",
    title,
    document: parsed.document,
    assets: [],
  };
  const issues = parsed.issues;
  const linkStats = { resolved: 0, unresolved: 0 };
  await hydrateDocumentAssets(job, page, new Map(), new Map(), issues, linkStats);
  const preview: ImportPreview = {
    format: options.format,
    filename: options.filename,
    pages: 1,
    tables: 0,
    assets: page.assets.length,
    roots: 1,
    nested: 0,
    maxDepth: 0,
    resolvedLinks: linkStats.resolved,
    unresolvedLinks: linkStats.unresolved,
    duplicateTitles: 0,
    unresolvedParents: 0,
    blockingIssues: [],
    groups: [{ key: "Imported", name: "Imported", pages: 1, roots: 1, suggestedVisibility: "workspace" }],
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
  const byId = new Map(bundle.pages.map((page) => [page.id, page]));
  const pageDepth = (page: ImportPage) => {
    let value = 0;
    let current = page;
    const visited = new Set<string>();
    while (current.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      value += 1;
      current = parent;
    }
    return value;
  };
  for (const page of [...bundle.pages].sort(
    (left, right) =>
      pageDepth(left) - pageDepth(right) || left.order - right.order || left.source.localeCompare(right.source),
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
    const parentKey = `${page.spaceId}:${page.parentId ?? "root"}`;
    if (!previous.has(parentKey)) {
      const last = await env.DB.prepare(
        `SELECT position FROM pages WHERE space_id = ? AND parent_id IS ? AND archived_at IS NULL
          AND import_job_id IS NULL AND is_template = 0 ORDER BY position DESC, id DESC LIMIT 1`,
      )
        .bind(page.spaceId, page.parentId)
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
        page.spaceId,
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
  const metadata = await env.DB.prepare(
    `SELECT workspace_id, space_id, parent_id, kind, title FROM pages
      WHERE id = ? AND import_job_id = ? AND content_epoch = ?`,
  )
    .bind(page.id, job.id, job.attempt)
    .first<{ workspace_id: string; space_id: string; parent_id: string | null; kind: string; title: string }>();
  if (
    !metadata ||
    metadata.workspace_id !== job.workspace_id ||
    metadata.space_id !== page.spaceId ||
    metadata.parent_id !== page.parentId ||
    metadata.kind !== page.kind ||
    metadata.title !== page.title
  ) {
    throw new Error(`Imported page ${page.title} failed metadata verification.`);
  }
  if (page.tableRowId) {
    const detail = await env.DB.prepare(`SELECT row_id FROM table_row_pages WHERE page_id = ?`)
      .bind(page.id)
      .first<{ row_id: string }>();
    if (detail?.row_id !== page.tableRowId) {
      throw new Error(`Imported row detail ${page.title} failed verification.`);
    }
  }
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
      `INSERT OR REPLACE INTO page_import_sources
        (page_id, job_id, source_path, notion_id, source_group, parent_source_path, source_role, created_at)
       SELECT json_extract(value, '$.pageId'), ?, json_extract(value, '$.source'),
              json_extract(value, '$.notionId'), json_extract(value, '$.groupKey'),
              json_extract(value, '$.parentSource'), json_extract(value, '$.sourceRole'), ?
         FROM json_each(?)`,
    ).bind(
      job.id,
      timestamp,
      JSON.stringify(
        bundle.pages.map((page) => ({
          pageId: page.id,
          source: page.source,
          notionId: page.notionId,
          groupKey: page.groupKey,
          parentSource: page.parentSource,
          sourceRole: page.sourceRole,
        })),
      ),
    ),
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
    const rowDetails = loaded.pages
      .filter((page) => page.tableRowId)
      .map((page) => ({ rowId: page.tableRowId, pageId: page.id }));
    if (rowDetails.length) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO table_row_pages (row_id, page_id, created_at)
         SELECT json_extract(value, '$.rowId'), json_extract(value, '$.pageId'), ? FROM json_each(?)`,
      )
        .bind(Date.now(), JSON.stringify(rowDetails))
        .run();
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
