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
  | { type: "pages-upserted"; pages: Page[] }
  | { type: "pages-removed"; pageIds: string[]; permanently: boolean }
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

export type TableData = {
  pageId: string;
  revision: number;
  columns: TableColumn[];
  rows: TableRow[];
  lease: { heldByMe: boolean; holderName: string | null; expiresAt: number | null };
};

export type TableLeaseTiming = { leaseDurationMs: number };

export type TableLeaseResponse = TableLeaseTiming & { leaseToken: string };
