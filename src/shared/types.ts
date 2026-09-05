import type { PageKind } from "./page-kind";

export type { PageKind } from "./page-kind";

export type Role = "owner" | "editor" | "viewer";
export type SpaceRole = "owner" | "editor" | "viewer";
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

export type Space = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  position: string;
  visibility: "workspace" | "private";
  effectiveRole: SpaceRole;
  createdAt: number;
  updatedAt: number;
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
  spaceId: string;
  parentId: string | null;
  kind: PageKind;
  position: string;
  title: string;
  icon: string | null;
  revision: number;
  contentEpoch: number;
  isTemplate: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ProseMirrorJson = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: ProseMirrorJson[];
};

export type DocumentContentEnvelope = {
  schemaVersion: 1;
  pageId: string;
  contentEpoch: number;
  sequence: number;
  document: ProseMirrorJson;
};

export type JobType = "import" | "export" | "template_clone" | "comment_migration" | "search_reindex";
export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "canceling"
  | "canceled";

export type Job = {
  id: string;
  workspaceId: string;
  spaceId: string | null;
  type: JobType;
  status: JobStatus;
  progress: { current: number; total: number; label: string };
  warnings: string[];
  error: { code: string; message: string } | null;
  hasDownload: boolean;
  expiresAt: number | null;
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
  | { type: "pages-upserted"; pages: Page[]; restored: true; restoredRootId?: string }
  | { type: "pages-upserted"; pages: Page[]; restored?: false; restoredRootId?: never }
  | { type: "pages-removed"; pageIds: string[]; permanently: boolean; operationId?: string }
  | { type: "workspace-invalidated" }
  | { type: "organization-invalidated" }
  | { type: "notifications-invalidated" }
  | { type: "jobs-invalidated" }
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
