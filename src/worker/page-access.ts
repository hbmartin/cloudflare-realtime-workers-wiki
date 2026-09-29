import type { Role } from "../shared/types";
import type { Env, MemberContext } from "./env";
import type { PageJsonRow } from "./page-row";
import { HttpError } from "./http";

export type PageRow = PageJsonRow & {
  created_by: string;
  plain_text: string;
  indexed_seq: number;
  visibility?: "workspace" | "private";
  space_role?: Exclude<Role, "owner"> | null;
  effective_role?: Role;
};

export async function pageForMember(env: Env, member: MemberContext, pageId: string, includeArchived = false) {
  const row = await env.DB.prepare(
    `SELECT p.*, s.visibility, sm.role space_role
       FROM pages p
       JOIN spaces s ON s.id = p.space_id AND s.workspace_id = p.workspace_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
      WHERE p.id = ? AND p.workspace_id = ? ${includeArchived ? "" : "AND p.archived_at IS NULL"}
        AND p.import_job_id IS NULL
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)`,
  )
    .bind(member.user.id, pageId, member.workspace.id, member.role)
    .first<PageRow>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  return { ...row, effective_role: effectiveSpaceRole(member.role, row.visibility!, row.space_role ?? null)! };
}

export function effectiveSpaceRole(
  workspaceRole: Role,
  visibility: "workspace" | "private",
  grant: Exclude<Role, "owner"> | null,
): Role | null {
  if (workspaceRole === "owner") return "owner";
  if (visibility === "private" && !grant) return null;
  if (workspaceRole === "viewer" || grant === "viewer") return "viewer";
  return "editor";
}

export async function sidebarHiddenPageIds(env: Env, workspaceId: string, pageIds: readonly string[]) {
  if (!pageIds.length) return [];
  const hidden = await env.DB.prepare(
    `WITH RECURSIVE hidden(id) AS (
       SELECT link.page_id FROM table_row_pages link JOIN pages root ON root.id=link.page_id
        WHERE root.workspace_id=?
       UNION
       SELECT source.page_id FROM page_import_sources source JOIN pages root ON root.id=source.page_id
        WHERE root.workspace_id=? AND source.source_role='table_row_detail'
       UNION ALL
       SELECT child.id FROM pages child JOIN hidden parent ON child.parent_id=parent.id
        WHERE child.workspace_id=?
     ) SELECT id FROM hidden WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(workspaceId, workspaceId, workspaceId, JSON.stringify(pageIds))
    .all<{ id: string }>();
  return hidden.results.map((row) => row.id);
}
