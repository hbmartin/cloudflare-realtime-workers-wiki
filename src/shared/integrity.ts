export interface IntegrityPage {
  id: string;
  workspace_id: string;
  space_id: string | null;
  parent_id: string | null;
  kind: string;
  revision: number;
  content_epoch: number;
  indexed_seq: number;
  updated_at: number;
  archived_at: number | null;
  is_template: number;
  import_job_id: string | null;
}

export interface IntegritySpace {
  id: string;
  workspace_id: string;
}
export interface IntegrityRowPage {
  page_id: string;
  row_id: string;
  table_page_id: string;
  workspace_id: string;
  space_id: string | null;
}
export interface IntegritySource {
  page_id: string;
  source_role: string;
}
export interface IntegrityArtifact {
  id: string;
  page_id: string;
  workspace_id: string;
  r2_key: string;
  size: number;
}
export interface IntegrityFinding {
  code: string;
  pageId?: string;
  detail?: string;
}
export interface IntegrityMetadata {
  workspaces: Array<{ id: string }>;
  pages: IntegrityPage[];
  spaces: IntegritySpace[];
  rowPages: IntegrityRowPage[];
  sources: IntegritySource[];
  artifacts: IntegrityArtifact[];
  complete: boolean;
}

export const INTEGRITY_PAGE_COLUMNS =
  "id,workspace_id,space_id,parent_id,kind,revision,content_epoch,indexed_seq,updated_at,archived_at,is_template,import_job_id";
/** Fixed collection contract shared by the D1 deployment checker and the owner API. */
export function integrityMetadataSql(limit = 100_000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new Error("Integrity row limit is invalid.");
  return {
    workspaces: `SELECT id FROM workspaces ORDER BY id LIMIT ${limit + 1}`,
    pages: `SELECT ${INTEGRITY_PAGE_COLUMNS} FROM pages ORDER BY id LIMIT ${limit + 1}`,
    spaces: `SELECT id,workspace_id FROM spaces ORDER BY id LIMIT ${limit + 1}`,
    rowPages: `SELECT link.page_id,link.row_id,r.page_id table_page_id,p.workspace_id,p.space_id
      FROM table_row_pages link LEFT JOIN table_rows r ON r.id=link.row_id LEFT JOIN pages p ON p.id=r.page_id
      ORDER BY link.page_id LIMIT ${limit + 1}`,
    sources: `SELECT page_id,source_role FROM page_import_sources ORDER BY page_id LIMIT ${limit + 1}`,
    artifacts: `SELECT id,page_id,workspace_id,r2_key,size FROM attachments ORDER BY id LIMIT ${limit + 1}`,
  };
}

/** Evaluate stored metadata only; hidden import, template and row-detail roots are intentional. */
export function evaluateMetadataIntegrity(data: IntegrityMetadata, selected = data.pages) {
  const pages = new Map(data.pages.map((page) => [page.id, page]));
  const spaces = new Map(data.spaces.map((space) => [space.id, space]));
  const workspaces = new Set(data.workspaces.map((workspace) => workspace.id));
  const rows = new Map(data.rowPages.map((row) => [row.page_id, row]));
  const sources = new Map(data.sources.map((source) => [source.page_id, source.source_role]));
  const failures: IntegrityFinding[] = [];
  const incomplete: IntegrityFinding[] = data.complete ? [] : [{ code: "metadata_coverage_incomplete" }];
  const classifications: Record<string, number> = {};
  const add = (code: string, pageId: string, detail?: string) =>
    failures.push({ code, pageId, ...(detail ? { detail } : {}) });
  for (const space of data.spaces)
    if (!workspaces.has(space.workspace_id)) failures.push({ code: "orphan_space", detail: space.id });
  for (const page of selected) {
    const space = page.space_id ? spaces.get(page.space_id) : null;
    if (!workspaces.has(page.workspace_id)) add("missing_workspace", page.id);
    if (!space || space.workspace_id !== page.workspace_id) add("invalid_space", page.id);
    if (
      !Number.isSafeInteger(page.revision) ||
      page.revision < 1 ||
      !Number.isSafeInteger(page.content_epoch) ||
      page.content_epoch < 1 ||
      !Number.isSafeInteger(page.indexed_seq) ||
      page.indexed_seq < 0
    )
      add("invalid_revision", page.id);
    if (!["document", "table", "diagram"].includes(page.kind)) add("invalid_page_kind", page.id);
    const row = rows.get(page.id);
    if (
      row &&
      (!row.table_page_id ||
        row.workspace_id !== page.workspace_id ||
        row.space_id !== page.space_id ||
        page.kind !== "document" ||
        pages.get(row.table_page_id)?.kind !== "table")
    )
      add("invalid_row_detail", page.id);
    if (!row && sources.get(page.id) === "table_row_detail" && !page.import_job_id) add("unlinked_row_detail", page.id);
    let classification = page.import_job_id
      ? "staged"
      : page.archived_at !== null
        ? "archived"
        : page.is_template
          ? "template"
          : row
            ? "row_detail"
            : sources.get(page.id) === "generated_folder" || sources.get(page.id) === "unmatched_table_page"
              ? "import_artifact"
              : !page.parent_id
                ? "root"
                : "child";
    const visited = new Set([page.id]);
    let current = page;
    for (let depth = 0; current.parent_id; depth++) {
      if (visited.has(current.parent_id)) {
        add("ancestor_cycle", page.id);
        break;
      }
      if (depth >= 64) {
        incomplete.push({ code: "ancestor_depth_limit", pageId: page.id });
        break;
      }
      visited.add(current.parent_id);
      const parent = pages.get(current.parent_id);
      if (!parent) {
        if (data.complete) add("missing_ancestor", page.id, current.parent_id);
        else incomplete.push({ code: "ancestor_coverage_incomplete", pageId: page.id });
        break;
      }
      if (parent.workspace_id !== page.workspace_id || parent.space_id !== page.space_id) {
        add("ancestor_scope_mismatch", page.id);
        break;
      }
      if (page.archived_at === null && parent.archived_at !== null) add("active_below_archived", page.id);
      if (!page.import_job_id && parent.import_job_id) add("published_below_staged", page.id);
      if (rows.has(parent.id) && classification === "child") classification = "row_detail_child";
      if (parent.is_template && classification === "child") classification = "template_child";
      current = parent;
    }
    classifications[classification] = (classifications[classification] ?? 0) + 1;
  }
  for (const artifact of data.artifacts) {
    const page = pages.get(artifact.page_id);
    if (!page) {
      if (data.complete) add("orphan_artifact", artifact.page_id, artifact.id);
      else incomplete.push({ code: "artifact_coverage_incomplete", pageId: artifact.page_id });
    } else if (
      artifact.workspace_id !== page.workspace_id ||
      !artifact.r2_key ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0
    )
      add("invalid_artifact", page.id, artifact.id);
  }
  return {
    failures,
    incomplete,
    classifications,
    checkedPages: selected.length,
    complete: incomplete.length === 0,
    ok: failures.length === 0 && incomplete.length === 0,
  };
}
