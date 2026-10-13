import type { ComputedValue } from "./formula";
import { CALCULATION_KINDS, type CalculationKind, type CalculationResult } from "./table-computed";
import type { ColumnType } from "./types";

export const TABLE_PROTOCOL_VERSION = 1;
const TABLE_PROPERTY_CONFIG_VERSION = 1;
export function versionedPropertyConfig(input: unknown): Record<string, unknown> {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input)))
    throw Object.assign(new Error("Invalid property configuration."), { status: 422, code: "table_validation" });
  const config = (input ?? {}) as Record<string, unknown>;
  if (config.version !== undefined && config.version !== TABLE_PROPERTY_CONFIG_VERSION)
    throw Object.assign(new Error("Unsupported property configuration version."), {
      status: 422,
      code: "property_config_version",
    });
  return { ...config, version: TABLE_PROPERTY_CONFIG_VERSION };
}
export function allowedCalculationKinds(property: Pick<CollaborativeColumn, "type" | "config">): CalculationKind[] {
  const type = property.type === "formula" ? property.config?.resultType : property.type;
  return CALCULATION_KINDS.filter((kind) => {
    if (["row_count", "nonempty_count", "empty_count"].includes(kind)) return true;
    if (kind === "unique_count")
      return [
        "number",
        "string",
        "boolean",
        "date",
        "text",
        "checkbox",
        "url",
        "select",
        "status",
        "created_by",
        "last_edited_by",
        "created_time",
        "last_edited_time",
      ].includes(String(type));
    if (["sum", "average", "min", "max"].includes(kind)) return type === "number";
    return ["date", "created_time", "last_edited_time"].includes(String(type));
  });
}
export const TABLE_COLUMN_TYPES = [
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi_select",
  "person",
  "url",
  "status",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "formula",
] as const;
export type TableValue = string | number | boolean | string[] | null;
export type CollaborativeColumn = {
  id: string;
  name: string;
  type: ColumnType;
  position: number;
  revision: number;
  generation?: number;
  options: Array<{ id: string; label: string; position: number; color?: string }>;
  config?: Record<string, unknown> | undefined;
  conversion?: {
    id: string;
    type: ColumnType;
    failures: number;
    revision: number;
    generation: number;
    schemaRevision: number;
    converted: number;
    empty: number;
    total: number;
  };
};
export type CollaborativeRow = {
  id: string;
  revision?: number;
  position: number;
  cells: Record<string, TableValue>;
  cellRevisions: Record<string, number>;
  computedCells?: Record<string, ComputedValue>;
  detailPageId: string | null;
  createdAt: number;
  createdBy: string | null;
  editedAt: number;
  editedBy: string | null;
};
export type TableFilter =
  | { kind: "group"; operator: "and" | "or"; filters: TableFilter[] }
  | {
      kind: "condition";
      columnId: string;
      operator: "eq" | "neq" | "contains" | "empty" | "not_empty" | "in" | "gt" | "gte" | "lt" | "lte";
      value?: TableValue;
    };
export type TableView = {
  id: string;
  name: string;
  kind: "grid" | "board" | "calendar";
  revision: number;
  ownerId: string | null;
  columnId: string | null;
  filters: TableFilter | null;
  sorts: Array<{ columnId: string; direction: "asc" | "desc" }>;
  visibleColumnIds: string[];
  invalid?: boolean;
  calculations?: Record<string, CalculationKind>;
};
export type TableCommand = {
  operationId: string;
  expectedRevision?: number;
  kind:
    | "create_column"
    | "update_column"
    | "delete_column"
    | "add_option"
    | "delete_option"
    | "create_row"
    | "update_cells"
    | "delete_row"
    | "save_view"
    | "delete_view"
    | "move_row"
    | "prepare_type"
    | "commit_type"
    | "cancel_type"
    | "bulk";
  payload: Record<string, unknown>;
};
export type TableCommandResult = {
  revision: number;
  operationId: string;
  replayed: boolean;
  result: Record<string, unknown>;
  projectionPending: boolean;
};
export type TableQueryResult = {
  protocolVersion: number;
  taskList?: boolean;
  canEdit?: boolean;
  pageId: string;
  generation: number;
  revision: number;
  projectedRevision: number;
  columns: CollaborativeColumn[];
  views: TableView[];
  view: TableView | null;
  rows: CollaborativeRow[];
  rowCount: number;
  groupCounts: Record<string, number>;
  nextCursor: string | null;
  invalidView: boolean;
  calculations?: Record<string, CalculationResult>;
  people?: Array<{ id: string; name: string; active: boolean }>;
};

export const metadataColumns = new Set<ColumnType>([
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
]);
export function normalizedColumnName(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
export function validateTableValue(column: CollaborativeColumn, input: unknown): TableValue {
  if (metadataColumns.has(column.type) || column.type === "formula")
    throw Object.assign(new Error("Computed properties are maintained by the server."), {
      status: 422,
      code: "computed_property",
    });
  if (input === null || input === "" || input === undefined) return null;
  if (column.type === "number") {
    if (typeof input !== "number" || !Number.isFinite(input))
      throw Object.assign(new Error("Enter a finite number."), { status: 422, code: "table_validation" });
    return input;
  }
  if (column.type === "checkbox") {
    if (typeof input !== "boolean")
      throw Object.assign(new Error("Enter a checkbox value."), { status: 422, code: "table_validation" });
    return input;
  }
  if (column.type === "person" || column.type === "multi_select") {
    if (!Array.isArray(input) || input.length > 100 || input.some((id) => typeof id !== "string" || id.length > 100))
      throw Object.assign(new Error("Enter at most 100 IDs."), { status: 422, code: "table_validation" });
    const ids = [...new Set(input as string[])].sort();
    if (column.type === "multi_select" && ids.some((id) => !column.options.some((option) => option.id === id)))
      throw Object.assign(new Error("An option no longer belongs to this property."), {
        status: 422,
        code: "table_validation",
      });
    return ids;
  }
  if (typeof input !== "string" || input.length > 10_000)
    throw Object.assign(new Error("Enter text of up to 10,000 characters."), { status: 422, code: "table_validation" });
  if ((column.type === "select" || column.type === "status") && !column.options.some((option) => option.id === input))
    throw Object.assign(new Error("The selected option does not belong to this property."), {
      status: 422,
      code: "table_validation",
    });
  if (column.type === "url") {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw Object.assign(new Error("Enter an absolute HTTP(S) URL."), { status: 422, code: "table_validation" });
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw Object.assign(new Error("Enter an absolute HTTP(S) URL."), { status: 422, code: "table_validation" });
  }
  if (column.type === "date" && (!Number.isFinite(Date.parse(input)) || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(input)))
    throw Object.assign(new Error("Enter an ISO date or timestamp."), { status: 422, code: "table_validation" });
  return input;
}

/** Conservative equality defaults adapted from AFFiNE's MIT generate-default-values.ts,
 * source 0b69a6da21e8fd35beb85667bb8496d9b3852238. Group assignment is applied afterwards. */
export function tableFilterDefaults(
  filter: TableFilter | null,
  columns: readonly Pick<CollaborativeColumn, "id" | "type">[],
): Record<string, TableValue> {
  if (!filter || filter.kind !== "group" || filter.operator !== "and") return {};
  const counts = new Map<string, number>();
  for (const child of filter.filters)
    if (child.kind === "condition") counts.set(child.columnId, (counts.get(child.columnId) ?? 0) + 1);
  return Object.fromEntries(
    filter.filters.flatMap((child) =>
      child.kind === "condition" &&
      child.operator === "eq" &&
      child.value !== undefined &&
      columns.some(
        (column) => column.id === child.columnId && column.type !== "formula" && !metadataColumns.has(column.type),
      ) &&
      counts.get(child.columnId) === 1
        ? [[child.columnId, child.value]]
        : [],
    ),
  );
}
