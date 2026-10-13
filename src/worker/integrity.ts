import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { projectDocument } from "../shared/document-projection";
import { diagramFromYDoc, diagramRoots } from "../shared/diagram";
import { normalizeDocumentTables, validateDocumentTree } from "../shared/document-validation";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import {
  evaluateMetadataIntegrity,
  INTEGRITY_PAGE_COLUMNS,
  type IntegrityArtifact,
  type IntegrityFinding,
  type IntegrityPage,
  type IntegrityRowPage,
  type IntegritySource,
  type IntegritySpace,
} from "../shared/integrity";
import type { ProseMirrorJson } from "../shared/types";
import {
  metadataColumns,
  normalizedColumnName,
  validateTableValue,
  type CollaborativeColumn,
} from "../shared/table-protocol";
import { seal, unseal } from "./ai-auth";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";

type Fingerprint = {
  pages: number;
  revisions: string;
  epochs: string;
  updates: string;
  tables: string;
  spaceUpdates: string;
};
type IntegrityCursor = { after: string; fingerprint: Fingerprint; mode: string; expiresAt: number };
type Projection = { content_epoch: number; sequence: number; r2_key: string; content_hash: string; byte_size: number };
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

async function tableContentFindings(env: Env, page: IntegrityPage) {
  const failures: IntegrityFinding[] = [];
  const incomplete: IntegrityFinding[] = [];
  const fail = (code: string, detail?: string) =>
    failures.push({ code, pageId: page.id, ...(detail ? { detail } : {}) });
  const partial = (code: string) => incomplete.push({ code, pageId: page.id });
  const state = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
    .bind(page.id)
    .first<{ revision: number }>();
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 1) {
    fail("missing_table_state");
    return { failures, incomplete };
  }
  const authority = await env.DB.prepare(
    "SELECT state,generation,seed_revision,projected_revision FROM table_authority WHERE page_id=?",
  )
    .bind(page.id)
    .first<{ state: string; generation: number; seed_revision: number; projected_revision: number }>();
  if (authority) {
    if (
      !Number.isSafeInteger(authority.generation) ||
      authority.generation < 1 ||
      !Number.isSafeInteger(authority.seed_revision) ||
      authority.seed_revision < 1
    )
      fail("invalid_table_authority");
    if (["seeding", "repairing"].includes(authority.state)) partial("table_authority_transition");
    else if (authority.state === "do" && authority.projected_revision !== state.revision)
      partial("table_projection_revision_changed");
    else if (!["do", "d1"].includes(authority.state)) fail("invalid_table_authority");
  }
  const columns = await env.DB.prepare(
    "SELECT id,name,type,position,property_revision,config_json FROM table_columns WHERE page_id=? ORDER BY id LIMIT 201",
  )
    .bind(page.id)
    .all<{
      id: string;
      name: string;
      type: CollaborativeColumn["type"];
      position: number;
      property_revision: number;
      config_json: string | null;
    }>();
  const options = await env.DB.prepare(
    "SELECT o.id,o.column_id,o.label,o.position FROM table_select_options o JOIN table_columns c ON c.id=o.column_id WHERE c.page_id=? ORDER BY o.id LIMIT 2001",
  )
    .bind(page.id)
    .all<{ id: string; column_id: string; label: string; position: number }>();
  const rows = await env.DB.prepare(
    "SELECT id,position,created_at,updated_at FROM table_rows WHERE page_id=? ORDER BY id LIMIT 2001",
  )
    .bind(page.id)
    .all<{ id: string; position: number; created_at: number; updated_at: number }>();
  if (columns.results.length > 200 || options.results.length > 2000 || rows.results.length > 2000) {
    partial("table_content_limit");
    return { failures, incomplete };
  }
  const properties = new Map<string, CollaborativeColumn>();
  const names = new Set<string>();
  for (const column of columns.results) {
    const name = normalizedColumnName(column.name);
    if (!name || names.has(name)) fail("duplicate_table_property_name", column.id);
    names.add(name);
    if (
      !Number.isFinite(column.position) ||
      !Number.isSafeInteger(column.property_revision) ||
      column.property_revision < 1
    )
      fail("invalid_table_property", column.id);
    let config: Record<string, unknown> = {};
    try {
      if (column.config_json !== null) {
        config = JSON.parse(column.config_json);
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid config");
      }
    } catch {
      fail("invalid_table_property_config", column.id);
    }
    const choices = options.results.filter((option) => option.column_id === column.id);
    const labels = new Set<string>();
    for (const option of choices) {
      if (!option.label.trim() || labels.has(option.label) || !Number.isFinite(option.position))
        fail("invalid_table_option", option.id);
      labels.add(option.label);
    }
    properties.set(column.id, {
      id: column.id,
      name: column.name,
      type: column.type,
      position: column.position,
      revision: column.property_revision,
      config,
      options: choices,
    });
  }
  for (const row of rows.results)
    if (
      !Number.isFinite(row.position) ||
      !Number.isSafeInteger(row.created_at) ||
      !Number.isSafeInteger(row.updated_at)
    )
      fail("invalid_table_row", row.id);
  // Include either side of a cross-table cell. Foreign keys alone do not enforce this scope.
  const cellScope =
    "FROM table_cells c LEFT JOIN table_rows r ON r.id=c.row_id LEFT JOIN table_columns p ON p.id=c.column_id WHERE r.page_id=? OR p.page_id=?";
  const size = await env.DB.prepare(
    `SELECT count(*) count,coalesce(sum(length(cast(c.text_value AS BLOB))),0)+coalesce(sum(length(cast(c.json_value AS BLOB))),0) bytes ${cellScope}`,
  )
    .bind(page.id, page.id)
    .first<{ count: number; bytes: number }>();
  if (!size || size.count > 10000 || size.bytes > MAX_CONTENT_BYTES) {
    partial("table_cell_limit");
    return { failures, incomplete };
  }
  const cells = await env.DB.prepare(
    `SELECT c.*,r.page_id row_page_id,p.page_id column_page_id ${cellScope} ORDER BY c.row_id,c.column_id LIMIT 10001`,
  )
    .bind(page.id, page.id)
    .all<{
      row_id: string;
      column_id: string;
      row_page_id: string | null;
      column_page_id: string | null;
      text_value: string | null;
      number_value: number | null;
      boolean_value: number | null;
      date_value: string | null;
      select_value: string | null;
      json_value: string | null;
      cell_revision: number;
    }>();
  if (cells.results.length !== size.count) partial("table_revision_changed");
  for (const cell of cells.results) {
    const identity = `${cell.row_id}:${cell.column_id}`;
    if (cell.row_page_id !== page.id || cell.column_page_id !== page.id) {
      fail("table_cell_scope", identity);
      continue;
    }
    const column = properties.get(cell.column_id);
    if (!column) {
      fail("missing_table_cell_property", identity);
      continue;
    }
    if (!Number.isSafeInteger(cell.cell_revision) || cell.cell_revision < 1)
      fail("invalid_table_cell_revision", identity);
    if (metadataColumns.has(column.type) || column.type === "formula") {
      fail("stored_computed_property", identity);
      continue;
    }
    try {
      const slots: Record<string, unknown> = {
        text: cell.text_value,
        url: cell.text_value,
        number: cell.number_value,
        checkbox: cell.boolean_value === null ? null : Boolean(cell.boolean_value),
        date: cell.date_value,
        select: cell.select_value,
        status: cell.select_value,
      };
      const value = cell.json_value === null ? (slots[column.type] ?? null) : JSON.parse(cell.json_value);
      validateTableValue(column, value);
      if (cell.boolean_value !== null && ![0, 1].includes(cell.boolean_value)) throw new Error("Invalid boolean");
      const expectedSlot = ["text", "url"].includes(column.type)
        ? "text_value"
        : column.type === "number"
          ? "number_value"
          : column.type === "checkbox"
            ? "boolean_value"
            : column.type === "date"
              ? "date_value"
              : ["select", "status"].includes(column.type)
                ? "select_value"
                : null;
      for (const slot of ["text_value", "number_value", "boolean_value", "date_value", "select_value"] as const)
        if (slot !== expectedSlot && cell[slot] !== null) throw new Error("Unexpected scalar value");
      if (
        cell.json_value !== null &&
        expectedSlot &&
        canonicalJson(cell[expectedSlot as keyof typeof cell]) !==
          canonicalJson(expectedSlot === "boolean_value" && typeof value === "boolean" ? Number(value) : value)
      )
        throw new Error("Scalar projection differs");
    } catch {
      fail("invalid_table_cell_value", identity);
    }
  }
  return { failures, incomplete };
}

async function fingerprint(env: Env, workspaceId: string) {
  return (await env.DB.prepare(`SELECT count(*) pages,cast(coalesce(sum(revision),0) AS TEXT) revisions,
    cast(coalesce(sum(content_epoch),0) AS TEXT) epochs,cast(coalesce(sum(updated_at),0) AS TEXT) updates,
    (SELECT cast(coalesce(sum(t.revision),0) AS TEXT) FROM table_state t JOIN pages p ON p.id=t.page_id WHERE p.workspace_id=?) tables,
    (SELECT cast(coalesce(sum(s.updated_at),0) AS TEXT) FROM spaces s WHERE s.workspace_id=?) spaceUpdates
    FROM pages WHERE workspace_id=?`)
    .bind(workspaceId, workspaceId, workspaceId)
    .first<Fingerprint>())!;
}

async function contentFindings(env: Env, page: IntegrityPage, artifacts: IntegrityArtifact[]) {
  const failures: IntegrityFinding[] = [];
  const incomplete: IntegrityFinding[] = [];
  const fail = (code: string, detail?: string) =>
    failures.push({ code, pageId: page.id, ...(detail ? { detail } : {}) });
  const partial = (code: string) => incomplete.push({ code, pageId: page.id });
  // Unpublished import staging has no committed content contract yet.
  if (page.import_job_id) return { failures, incomplete };
  if (page.kind === "table") {
    const findings = await tableContentFindings(env, page);
    failures.push(...findings.failures);
    incomplete.push(...findings.incomplete);
  } else {
    const table = page.kind === "diagram" ? "diagram_projections" : "document_projections";
    const projection = await env.DB.prepare(
      `SELECT content_epoch,sequence,r2_key,content_hash,byte_size FROM ${table} WHERE page_id=?`,
    )
      .bind(page.id)
      .first<Projection>();
    const key = `${page.kind === "diagram" ? "diagrams" : "documents"}/${page.id}/epochs/${page.content_epoch}/current.bin`;
    const snapshot = await env.BUCKET.get(key);
    if (!snapshot && !projection && page.indexed_seq === 0) {
      // A newly created empty page need not have initialized its Durable Object.
    } else if (!snapshot || !projection) {
      partial("canonical_content_incomplete");
    } else if (
      projection.content_epoch !== page.content_epoch ||
      projection.sequence !== page.indexed_seq ||
      snapshot.customMetadata?.sequence !== String(projection.sequence)
    ) {
      partial("canonical_revision_changed");
    } else if (snapshot.size > MAX_CONTENT_BYTES || projection.byte_size > MAX_CONTENT_BYTES) {
      partial("content_size_limit");
    } else {
      const stored = await env.BUCKET.get(projection.r2_key);
      if (!stored) fail("missing_projection_object");
      else if (stored.size !== projection.byte_size) fail("projection_size_mismatch");
      else {
        const bytes = new Uint8Array(await stored.arrayBuffer());
        if ((await sha256Hex(bytes)) !== projection.content_hash) fail("projection_hash_mismatch");
        let envelope: {
          schemaVersion?: number;
          pageId?: string;
          contentEpoch?: number;
          sequence?: number;
          document?: ProseMirrorJson;
          nodes?: unknown;
          edges?: unknown;
        };
        try {
          envelope = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          fail("invalid_projection_json");
          return { failures, incomplete };
        }
        if (
          envelope.schemaVersion !== 1 ||
          envelope.pageId !== page.id ||
          envelope.contentEpoch !== page.content_epoch ||
          envelope.sequence !== projection.sequence
        )
          fail("projection_identity_mismatch");
        if (page.kind === "document") {
          const document = new Y.Doc();
          let validated = false;
          try {
            Y.applyUpdate(document, new Uint8Array(await snapshot.arrayBuffer()));
            const canonical = yXmlFragmentToProsemirrorJSON(
              document.getXmlFragment("document-store"),
            ) as ProseMirrorJson;
            validateDocumentTree(normalizeDocumentTables(canonical));
            if (canonicalJson(canonical) !== canonicalJson(envelope.document)) fail("snapshot_projection_mismatch");
            validated = true;
            const references = projectDocument(canonical).pageReferences.map((reference) => reference.targetId);
            const collect = (node: ProseMirrorJson) => {
              for (const attr of ["pageId", "tablePageId", "sourcePageId"])
                if (typeof node.attrs?.[attr] === "string" && node.attrs[attr]) references.push(node.attrs[attr]);
              if (
                node.type === "mention" &&
                node.attrs?.entityType === "page" &&
                typeof node.attrs.entityId === "string"
              )
                references.push(node.attrs.entityId);
              for (const child of node.content ?? []) collect(child);
            };
            collect(canonical);
            const unique = [...new Set(references)];
            if (unique.length > 2000) partial("reference_limit");
            else {
              const targets = await env.DB.prepare(
                "SELECT id,workspace_id FROM pages WHERE id IN (SELECT value FROM json_each(?))",
              )
                .bind(JSON.stringify(unique))
                .all<{ id: string; workspace_id: string }>();
              const targetMap = new Map(targets.results.map((target) => [target.id, target.workspace_id]));
              for (const id of unique) {
                if (!targetMap.has(id)) fail("missing_canonical_reference", id);
                else if (targetMap.get(id) !== page.workspace_id) fail("cross_workspace_reference", id);
              }
              const projected = await env.DB.prepare(
                "SELECT target_page_id,projection_seq FROM page_references WHERE source_page_id=? LIMIT 2001",
              )
                .bind(page.id)
                .all<{ target_page_id: string; projection_seq: number }>();
              if (projected.results.length > 2000) partial("projected_reference_limit");
              else {
                const expected = [
                  ...new Set(projectDocument(canonical).pageReferences.map((reference) => reference.targetId)),
                ]
                  .filter((id) => targetMap.get(id) === page.workspace_id)
                  .sort();
                if (
                  canonicalJson(expected) !==
                    canonicalJson(projected.results.map((row) => row.target_page_id).sort()) ||
                  projected.results.some((row) => row.projection_seq !== page.indexed_seq)
                )
                  fail("reference_projection_mismatch");
              }
            }
          } catch {
            if (validated) partial("content_read_unavailable");
            else fail("invalid_document_snapshot");
          } finally {
            document.destroy();
          }
        } else {
          const diagram = new Y.Doc();
          let validated = false;
          try {
            Y.applyUpdate(diagram, new Uint8Array(await snapshot.arrayBuffer()));
            const canonical = diagramFromYDoc(
              diagram,
              { pageId: page.id, contentEpoch: page.content_epoch, sequence: projection.sequence },
              false,
            );
            const roots = diagramRoots(diagram, false);
            if (roots.nodes.size !== canonical.nodes.length || roots.edges.size !== canonical.edges.length)
              fail("invalid_diagram_structure");
            if (canonicalJson(canonical) !== canonicalJson(envelope)) fail("snapshot_projection_mismatch");
            validated = true;
            const ids = [
              ...new Set(
                canonical.nodes.flatMap((node) => [
                  ...(node.linkedPageId ? [node.linkedPageId] : []),
                  ...node.references.map((reference) => reference.id),
                ]),
              ),
            ];
            if (ids.length > 2000) partial("reference_limit");
            else {
              const targets = await env.DB.prepare(
                "SELECT id,workspace_id FROM pages WHERE id IN (SELECT value FROM json_each(?))",
              )
                .bind(JSON.stringify(ids))
                .all<{ id: string; workspace_id: string }>();
              const targetMap = new Map(targets.results.map((target) => [target.id, target.workspace_id]));
              for (const id of ids) {
                if (!targetMap.has(id)) fail("missing_canonical_reference", id);
                else if (targetMap.get(id) !== page.workspace_id) fail("cross_workspace_reference", id);
              }
              for (const node of canonical.nodes) {
                if (node.linkedViewId) {
                  const view = await env.DB.prepare("SELECT page_id FROM table_views WHERE id=? AND page_id=?")
                    .bind(node.linkedViewId, node.linkedPageId)
                    .first<{ page_id: string }>();
                  if (!node.linkedPageId || !view || view.page_id !== node.linkedPageId)
                    fail("invalid_diagram_view_reference", node.id);
                }
              }
            }
          } catch {
            if (validated) partial("content_read_unavailable");
            else fail("invalid_diagram_snapshot");
          } finally {
            diagram.destroy();
          }
        }
      }
    }
  }
  const versions = await env.DB.prepare(
    "SELECT r2_key,byte_size FROM page_versions WHERE page_id=? ORDER BY id LIMIT 101",
  )
    .bind(page.id)
    .all<{ r2_key: string; byte_size: number }>();
  if (versions.results.length > 100) partial("version_artifact_limit");
  for (const version of versions.results.slice(0, 100)) {
    const object = await env.BUCKET.head(version.r2_key);
    if (!object) fail("missing_version_object");
    else if (object.size !== version.byte_size) fail("version_size_mismatch");
  }
  for (const artifact of artifacts) {
    const object = await env.BUCKET.head(artifact.r2_key);
    if (!object) fail("missing_attachment_object", artifact.id);
    else if (object.size !== artifact.size) fail("attachment_size_mismatch", artifact.id);
  }
  return { failures, incomplete };
}

/** Inspect persisted workspace data without waking a room or flushing live edits. */
export async function checkWorkspaceIntegrity(
  env: Env,
  member: MemberContext,
  options: { mode?: string; cursor?: string; limit?: number } = {},
) {
  if (member.role !== "owner")
    throw new HttpError(403, "owner_required", "Only a workspace owner can inspect integrity.");
  const mode = options.mode ?? "metadata";
  if (!["metadata", "content"].includes(mode))
    throw new HttpError(422, "invalid_integrity_mode", "Integrity mode is invalid.");
  const limit = options.limit ?? (mode === "content" ? 5 : 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > (mode === "content" ? 5 : 100))
    throw new HttpError(422, "invalid_integrity_limit", "Integrity limit is invalid.");
  const binding = `integrity:${member.workspace.id}:${member.user.id}:${mode}`;
  let cursor: IntegrityCursor | null = null;
  if (options.cursor) {
    try {
      cursor = await unseal(env.BETTER_AUTH_SECRET, binding, options.cursor);
      if (
        !cursor ||
        typeof cursor.after !== "string" ||
        cursor.after.length > 200 ||
        cursor.mode !== mode ||
        !cursor.fingerprint ||
        !Number.isFinite(cursor.expiresAt) ||
        cursor.expiresAt <= Date.now()
      )
        throw new Error("Invalid cursor.");
    } catch {
      throw new HttpError(422, "invalid_integrity_cursor", "Integrity cursor is invalid or expired.");
    }
  }
  const before = await fingerprint(env, member.workspace.id);
  const baseline = cursor?.fingerprint ?? before;
  const selectedRows = await env.DB.prepare(
    `SELECT ${INTEGRITY_PAGE_COLUMNS} FROM pages WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?`,
  )
    .bind(member.workspace.id, cursor?.after ?? "", limit + 1)
    .all<IntegrityPage>();
  const selected = selectedRows.results.slice(0, limit);
  const ids = JSON.stringify(selected.map((page) => page.id));
  const [ancestors, spaces, rows, sources, artifacts] = await Promise.all([
    env.DB.prepare(`WITH RECURSIVE lineage(id,depth) AS (SELECT value,0 FROM json_each(?) UNION ALL
      SELECT p.parent_id,l.depth+1 FROM lineage l JOIN pages p ON p.id=l.id WHERE p.parent_id IS NOT NULL AND l.depth<64)
      SELECT DISTINCT ${INTEGRITY_PAGE_COLUMNS.split(",")
        .map((column) => `p.${column}`)
        .join(",")} FROM pages p JOIN lineage l ON l.id=p.id LIMIT 6501`)
      .bind(ids)
      .all<IntegrityPage>(),
    env.DB.prepare("SELECT id,workspace_id FROM spaces WHERE workspace_id=? ORDER BY id LIMIT 10001")
      .bind(member.workspace.id)
      .all<IntegritySpace>(),
    env.DB.prepare(`SELECT link.page_id,link.row_id,r.page_id table_page_id,p.workspace_id,p.space_id FROM table_row_pages link
      LEFT JOIN table_rows r ON r.id=link.row_id LEFT JOIN pages p ON p.id=r.page_id WHERE link.page_id IN (SELECT value FROM json_each(?))`)
      .bind(ids)
      .all<IntegrityRowPage>(),
    env.DB.prepare(
      "SELECT page_id,source_role FROM page_import_sources WHERE page_id IN (SELECT value FROM json_each(?))",
    )
      .bind(ids)
      .all<IntegritySource>(),
    env.DB.prepare(
      "SELECT id,page_id,workspace_id,r2_key,size FROM attachments WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 101",
    )
      .bind(ids)
      .all<IntegrityArtifact>(),
  ]);
  const owners = await env.DB.prepare(
    `SELECT ${INTEGRITY_PAGE_COLUMNS} FROM pages WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(rows.results.map((row) => row.table_page_id)))
    .all<IntegrityPage>();
  const result = evaluateMetadataIntegrity(
    {
      workspaces: [{ id: member.workspace.id }],
      pages: [...ancestors.results, ...owners.results],
      spaces: spaces.results.slice(0, 10000),
      rowPages: rows.results,
      sources: sources.results,
      artifacts: artifacts.results.slice(0, 100),
      complete: ancestors.results.length <= 6500 && spaces.results.length <= 10000 && artifacts.results.length <= 100,
    },
    selected,
  );
  if (mode === "content") {
    for (const page of selected) {
      try {
        const findings = await contentFindings(
          env,
          page,
          artifacts.results.slice(0, 100).filter((artifact) => artifact.page_id === page.id),
        );
        result.failures.push(...findings.failures);
        result.incomplete.push(...findings.incomplete);
      } catch {
        result.incomplete.push({ code: "content_read_unavailable", pageId: page.id });
      }
    }
  }
  const after = await fingerprint(env, member.workspace.id);
  if (canonicalJson(baseline) !== canonicalJson(before) || canonicalJson(before) !== canonicalJson(after))
    result.incomplete.push({ code: "workspace_revision_changed" });
  const more = selectedRows.results.length > limit;
  const nextCursor =
    more && selected.at(-1)
      ? await seal(env.BETTER_AUTH_SECRET, binding, {
          after: selected.at(-1)!.id,
          fingerprint: baseline,
          mode,
          expiresAt: Date.now() + 15 * 60_000,
        })
      : null;
  const complete = !more && result.incomplete.length === 0;
  return {
    ...result,
    scope: mode === "content" ? "stored_canonical_content" : "metadata",
    complete,
    ok: complete && result.failures.length === 0,
    totalPages: before.pages,
    nextCursor,
  };
}
