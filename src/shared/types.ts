import type { PageKind } from "./page-kind";

export type { PageKind } from "./page-kind";

export type Role = "owner" | "editor" | "viewer";
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

export type MemberContext = {
  user: SessionUser;
  session: { id: string; expiresAt: Date };
  workspace: Workspace;
  role: Role;
};

export type ClientMemberContext = Omit<MemberContext, "session">;

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

export type MentionEntityType = "page" | "user";

export type MentionSuggestion = {
  entityType: MentionEntityType;
  entityId: string;
  label: string;
  detail: string;
  icon: string | null;
};

export type PagePreview = {
  page: Page;
  excerpt: string;
};

export type Backlink = {
  page: Page;
  excerpt: string;
};

export type MentionInboxItem = {
  page: Page;
  excerpt: string;
  firstSeenAt: number;
  unread: boolean;
};

export type WorkspaceEvent =
  | { type: "pages-upserted"; pages: Page[]; restored?: boolean }
  | { type: "pages-removed"; pageIds: string[]; permanently: boolean; operationId?: string }
  | {
      type: "projection-updated";
      pageId: string;
      backlinkTargetIds: string[];
      mentionTargetUserIds: string[];
    };

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

export type TableCursor = { position: number; rowId: string };

export type TableData = {
  pageId: string;
  revision: number;
  columns: TableColumn[];
  rows: TableRow[];
  lease: { heldByMe: boolean; holderName: string | null; expiresAt: number | null };
  /** Page size this response was built with. */
  limit: number;
  /** Column the rows were sorted by, or null for the stored order. */
  sort: string | null;
  dir: "asc" | "desc";
  hasMore: boolean;
  /** Keyset cursor for the next page. Null when sorting, which pages by offset. */
  nextCursor: TableCursor | null;
  /** Offset for the next sorted page. Null for stored-order paging or when sorting cannot continue. */
  nextOffset: number | null;
  /** Whether more sorted rows exist beyond the server's supported offset depth. */
  truncated: boolean;
  /** Total rows, present only when the request asked for `count=true`. */
  rowCount: number | null;
};

export type TableLeaseTiming = { leaseDurationMs: number };

export type TableLeaseResponse = TableLeaseTiming & { leaseToken: string };
