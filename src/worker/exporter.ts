import type { WorkflowStep } from "cloudflare:workers";
import type { DocumentContentEnvelope, ExportFormat } from "../shared/types";
import { serializeDocument } from "../shared/document-projection";
import { createZip, type ZipEntry } from "../shared/zip";
import type { Env } from "./env";
import type { JobRow } from "./jobs";
import { normalizeFilename } from "./http";
import { broadcastWorkspaceEvent } from "./workspace-events";

const EXPORT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000;
const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
const TABLE_EXPORT_BATCH = 500;

type ExportOptions = { pageId: string; format: ExportFormat; portable: boolean };
type ExportPage = {
  id: string;
  workspace_id: string;
  content_epoch: number;
  kind: "document" | "table";
  title: string;
};
type ExportColumn = { id: string; name: string };
type ExportTableRow = { id: string; cells: string };
type ExportAttachment = { id: string; r2_key: string; name: string; mime: string };

function jsonRecord(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Export options are invalid.");
  return parsed as Record<string, unknown>;
}

function exportOptions(job: JobRow): ExportOptions {
  const options = jsonRecord(job.options_json);
  if (
    typeof options.pageId !== "string" ||
    !["markdown", "html", "pdf"].includes(String(options.format)) ||
    typeof options.portable !== "boolean"
  ) {
    throw new Error("Export options are invalid.");
  }
  return options as ExportOptions;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeMarkdownCell(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\r", "").replaceAll("\n", "<br>");
}

function fileStem(title: string) {
  const normalized = normalizeFilename(title).replace(/\.(md|html|pdf|zip)$/i, "").trim();
  return normalized || "Untitled";
}

async function assertExportActive(env: Env, jobId: string) {
  const row = await env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(jobId).first<{ status: string }>();
  if (!row || row.status === "canceling" || row.status === "canceled") throw new Error("Job canceled.");
}

async function documentExport(env: Env, page: ExportPage) {
  const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }),
  );
  if (!response.ok) throw new Error(`The latest document content could not be flushed (${response.status}).`);
  const envelope = await response.json<DocumentContentEnvelope>();
  if (envelope.pageId !== page.id || envelope.contentEpoch !== page.content_epoch) {
    throw new Error("The document projection did not match the requested page.");
  }
  const serialized = serializeDocument(envelope.document);
  return {
    markdown: `# ${page.title.replaceAll("\n", " ")}\n\n${serialized.markdown}`,
    html: serialized.html.replace(
      "<head>",
      `<head><title>${escapeHtml(page.title)}</title>`,
    ).replace("<body>", `<body><h1>${escapeHtml(page.title)}</h1>`),
  };
}

async function tableExport(env: Env, page: ExportPage) {
  const columns = await env.DB.prepare(`SELECT id, name FROM table_columns WHERE page_id = ? ORDER BY position, id`)
    .bind(page.id)
    .all<ExportColumn>();
  const markdown = [`# ${page.title.replaceAll("\n", " ")}\n\n`];
  const html = [
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(page.title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 24px;color:#171717}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:7px;text-align:left;vertical-align:top}</style></head><body><h1>${escapeHtml(page.title)}</h1><table><thead><tr>`,
    ...columns.results.map((column) => `<th>${escapeHtml(column.name)}</th>`),
    "</tr></thead><tbody>",
  ];
  if (columns.results.length) {
    markdown.push(`| ${columns.results.map((column) => escapeMarkdownCell(column.name)).join(" | ")} |\n`);
    markdown.push(`| ${columns.results.map(() => "---").join(" | ")} |\n`);
  }
  let offset = 0;
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT row.id,
              COALESCE(json_group_object(column.id,
                COALESCE(cell.text_value, cell.number_value,
                  CASE WHEN cell.boolean_value IS NULL THEN NULL WHEN cell.boolean_value = 1 THEN 'true' ELSE 'false' END,
                  cell.date_value, option.label, '')), '{}') cells
         FROM table_rows row
         CROSS JOIN table_columns column
         LEFT JOIN table_cells cell ON cell.row_id = row.id AND cell.column_id = column.id
         LEFT JOIN table_select_options option ON option.id = cell.select_value
        WHERE row.page_id = ? AND column.page_id = ?
        GROUP BY row.id, row.position
        ORDER BY row.position, row.id LIMIT ? OFFSET ?`,
    )
      .bind(page.id, page.id, TABLE_EXPORT_BATCH, offset)
      .all<ExportTableRow>();
    for (const row of rows.results) {
      const cells = jsonRecord(row.cells);
      const values = columns.results.map((column) => String(cells[column.id] ?? ""));
      markdown.push(`| ${values.map(escapeMarkdownCell).join(" | ")} |\n`);
      html.push(`<tr>${values.map((value) => `<td>${escapeHtml(value).replaceAll("\n", "<br>")}</td>`).join("")}</tr>`);
    }
    offset += rows.results.length;
    if (rows.results.length < TABLE_EXPORT_BATCH) break;
  }
  html.push("</tbody></table></body></html>");
  return { markdown: markdown.join(""), html: html.join("") };
}

function uniqueAssetName(name: string, used: Set<string>) {
  const safe = normalizeFilename(name) || "attachment";
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

async function portableExport(
  env: Env,
  job: JobRow,
  page: ExportPage,
  format: Exclude<ExportFormat, "pdf">,
  content: string,
) {
  const attachments = await env.DB.prepare(`SELECT id, r2_key, name, mime FROM attachments WHERE page_id = ?`)
    .bind(page.id)
    .all<ExportAttachment>();
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  let rewritten = content;
  for (const attachment of attachments.results) {
    await assertExportActive(env, job.id);
    const object = await env.BUCKET.get(attachment.r2_key);
    if (!object) throw new Error(`Attachment ${attachment.name} is missing.`);
    const name = uniqueAssetName(attachment.name, used);
    const relative = `assets/${name}`;
    rewritten = rewritten.replaceAll(`/api/attachments/${attachment.id}`, relative.split("/").map(encodeURIComponent).join("/"));
    entries.push({ path: relative, bytes: new Uint8Array(await object.arrayBuffer()) });
  }
  entries.unshift({ path: `${fileStem(page.title)}.${format === "markdown" ? "md" : "html"}`, bytes: new TextEncoder().encode(rewritten) });
  return createZip(entries);
}

export async function runExport(env: Env, job: JobRow, step: Pick<WorkflowStep, "do">) {
  const options = exportOptions(job);
  const artifact = await step.do("render export", async () => {
    await assertExportActive(env, job.id);
    const page = await env.DB.prepare(
      `SELECT id, workspace_id, content_epoch, kind, title FROM pages
        WHERE id = ? AND workspace_id = ? AND space_id = ? AND import_job_id IS NULL AND is_template = 0`,
    )
      .bind(options.pageId, job.workspace_id, job.space_id)
      .first<ExportPage>();
    if (!page) throw new Error("The page is no longer available for export.");
    const serialized = page.kind === "document" ? await documentExport(env, page) : await tableExport(env, page);
    await assertExportActive(env, job.id);
    let bytes: Uint8Array;
    let contentType: string;
    let filename: string;
    if (options.format === "pdf") {
      if (!env.BROWSER) throw new Error("PDF export is not configured.");
      const response = await env.BROWSER.quickAction("pdf", {
        html: serialized.html,
        pdfOptions: { format: "a4", printBackground: true, margin: { top: "24mm", right: "18mm", bottom: "24mm", left: "18mm" } },
      });
      if (!response.ok) throw new Error(`PDF rendering failed (${response.status}).`);
      bytes = new Uint8Array(await response.arrayBuffer());
      contentType = "application/pdf";
      filename = `${fileStem(page.title)}.pdf`;
    } else {
      const content = options.format === "markdown" ? serialized.markdown : serialized.html;
      if (options.portable) {
        bytes = await portableExport(env, job, page, options.format, content);
        contentType = "application/zip";
        filename = `${fileStem(page.title)}-${options.format}.zip`;
      } else {
        bytes = new TextEncoder().encode(content);
        contentType = options.format === "markdown" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8";
        filename = `${fileStem(page.title)}.${options.format === "markdown" ? "md" : "html"}`;
      }
    }
    if (!bytes.byteLength || bytes.byteLength > EXPORT_MAX_BYTES) throw new Error("The export exceeds the 64 MiB limit.");
    const outputKey = `jobs/${job.id}/output/${encodeURIComponent(filename)}`;
    await env.BUCKET.put(outputKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { filename, pageId: page.id, jobId: job.id },
    });
    return { outputKey, filename, byteLength: bytes.byteLength };
  });
  await step.do("publish export", async () => {
    await assertExportActive(env, job.id);
    const timestamp = Date.now();
    await env.DB.prepare(
      `UPDATE jobs SET status = 'succeeded', output_key = ?, progress_current = 2, progress_total = 2,
         progress_label = 'Complete', result_json = ?, expires_at = ?, error_code = NULL, error_message = NULL,
         updated_at = ? WHERE id = ? AND status = 'running'`,
    )
      .bind(
        artifact.outputKey,
        JSON.stringify({ warnings: [], filename: artifact.filename, byteLength: artifact.byteLength }),
        timestamp + EXPORT_ARTIFACT_TTL_MS,
        timestamp,
        job.id,
      )
      .run();
    await broadcastWorkspaceEvent(env, job.workspace_id, { type: "jobs-invalidated" });
  });
}
