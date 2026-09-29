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

export type SpaceRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  position: string;
  visibility: "workspace" | "private";
  space_role: Exclude<Role, "owner"> | null;
  created_at: number;
  updated_at: number;
};

export function requirePageEditor(page: PageRow) {
  if (page.effective_role === "viewer") throw new HttpError(403, "read_only", "Your role in this space is read-only.");
}

export async function spaceForMember(env: Env, member: MemberContext, spaceId: string) {
  const row = await env.DB.prepare(
    `SELECT s.*, sm.role space_role FROM spaces s
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE s.id = ? AND s.workspace_id = ?
       AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)`,
  )
    .bind(member.user.id, spaceId, member.workspace.id, member.role)
    .first<SpaceRow>();
  if (!row) throw new HttpError(404, "space_not_found", "Space not found.");
  return row;
}

export async function editableSpaceForMember(env: Env, member: MemberContext, spaceId: string) {
  const space = await spaceForMember(env, member, spaceId);
  if (effectiveSpaceRole(member.role, space.visibility, space.space_role ?? null) === "viewer")
    throw new HttpError(403, "space_forbidden", "You cannot write to this space.");
  return space;
}

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
    `WITH RECURSIVE ancestors(root_id,id,parent_id) AS (
       SELECT page.id,page.id,page.parent_id FROM pages page
        WHERE page.workspace_id=? AND page.id IN (SELECT value FROM json_each(?))
       UNION
       SELECT ancestors.root_id,parent.id,parent.parent_id FROM pages parent
        JOIN ancestors ON parent.id=ancestors.parent_id WHERE parent.workspace_id=?
     ) SELECT DISTINCT ancestors.root_id id FROM ancestors
       LEFT JOIN table_row_pages row_detail ON row_detail.page_id=ancestors.id
       LEFT JOIN page_import_sources source ON source.page_id=ancestors.id
      WHERE row_detail.page_id IS NOT NULL OR source.source_role='table_row_detail'`,
  )
    .bind(workspaceId, JSON.stringify(pageIds), workspaceId)
    .all<{ id: string }>();
  return hidden.results.map((row) => row.id);
}
