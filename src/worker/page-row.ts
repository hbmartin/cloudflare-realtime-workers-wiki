import type { Page } from "../shared/types";

export type PageJsonRow = {
  id: string;
  workspace_id: string;
  space_id?: string | null;
  parent_id: string | null;
  kind: Page["kind"];
  position: string;
  title: string;
  icon: string | null;
  revision: number;
  content_epoch: number;
  is_template?: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

export function pageJson(row: PageJsonRow): Page {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id ?? `${row.workspace_id}-general`,
    parentId: row.parent_id,
    kind: row.kind,
    position: row.position,
    title: row.title,
    icon: row.icon,
    revision: row.revision,
    contentEpoch: row.content_epoch,
    isTemplate: Boolean(row.is_template),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
