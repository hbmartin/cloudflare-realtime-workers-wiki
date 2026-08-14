export type Role = "owner" | "editor" | "viewer";
export type PageKind = "document" | "table";
export type ColumnType = "text" | "number" | "checkbox" | "date" | "select";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
};

export type Workspace = {
  id: string;
  name: string;
  locationHint: string | null;
};

export type Page = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: PageKind;
  position: string;
  title: string;
  icon: string | null;
  revision: number;
  contentEpoch: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PageNode = Page & { children: PageNode[] };

export type TableColumn = {
  id: string;
  name: string;
  type: ColumnType;
  position: number;
  options: Array<{ id: string; label: string; position: number }>;
};

export type TableRow = {
  id: string;
  position: number;
  cells: Record<string, string | number | boolean | null>;
};

export type TableData = {
  pageId: string;
  revision: number;
  columns: TableColumn[];
  rows: TableRow[];
  lease: { heldByMe: boolean; holderName: string | null; expiresAt: number | null };
};

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};

export function canEdit(role: Role): boolean {
  return role === "owner" || role === "editor";
}
