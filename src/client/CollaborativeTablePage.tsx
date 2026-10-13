import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ClientMemberContext, Page } from "../shared/types";
import {
  TABLE_COLUMN_TYPES,
  metadataColumns,
  allowedCalculationKinds,
  type CollaborativeColumn,
  type CollaborativeRow,
  type TableCommand,
  type TableCommandResult,
  type TableQueryResult,
  type TableValue,
  type TableView,
  type TableFilter,
} from "../shared/table-protocol";
import { type CalculationKind } from "../shared/table-computed";
import { isErrorCell, format, type FormulaTypeOptions } from "../shared/formula";
import { api, apiErrorMessage, ApiClientError, json } from "./api";
import { taskColumns } from "../shared/tasks";
import { calendarDay } from "../shared/table-calendar";
import "./collaborative-table.css";

export type CollaborativeTableProps = {
  page: Pick<Page, "id" | "title" | "taskList">;
  member: ClientMemberContext;
  metadata?: ReactNode;
  onSelectPage: (id: string) => void;
  queryBase?: string;
  initialViewId?: string;
  onViewChanged?: (id: string) => void;
  embedded?: boolean;
};

/** Shared host/source renderer. A linked host uses its permission-checking endpoint for every read/write. */
export function CollaborativeTablePage({
  page,
  member,
  metadata,
  onSelectPage,
  queryBase,
  initialViewId,
  onViewChanged,
  embedded = false,
}: CollaborativeTableProps) {
  const base = queryBase ?? `/api/tables/${page.id}/query`;
  const commandsPath = queryBase ? `${queryBase}/commands` : `/api/tables/${page.id}/commands`;
  const [data, setData] = useState<TableQueryResult | null>(null);
  const [viewId, setViewId] = useState(initialViewId ?? "");
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => Promise<unknown>) | null>(null);
  const [panel, setPanel] = useState<"view" | "properties" | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const epoch = useRef(0),
    dataRef = useRef(data),
    dirty = useRef(false),
    active = useRef(true);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const editable = member.role !== "viewer" && data?.canEdit !== false;
  const taskList = Boolean(page.taskList || data?.taskList);
  const tasksPath = queryBase ? `${queryBase}/tasks` : `/api/task-lists/${page.id}/tasks`;
  const discardDenied = useCallback((cause: unknown) => {
    if (!(cause instanceof ApiClientError) || ![401, 403, 404].includes(cause.status)) return false;
    setData(null);
    dataRef.current = null;
    setRetry(null);
    setPanel(null);
    dirty.current = false;
    return true;
  }, []);
  const load = useCallback(
    async function fetchTable(cursor?: string) {
      const owner = ++epoch.current;
      const params = new URLSearchParams({ limit: "100" });
      if (viewId) params.set("viewId", viewId);
      if (query) params.set("q", query);
      // Grid queries are reusable in a linked host; month is applied only to the selected Calendar.
      params.set("month", month);
      params.set("includeUnscheduled", "true");
      params.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (cursor) params.set("cursor", cursor);
      try {
        const result = await api<TableQueryResult>(`${base}?${params}`, { signal: AbortSignal.timeout(15000) });
        if (owner !== epoch.current || !active.current) return;
        if (dirty.current) return; // Permission is rechecked while preserving the draft's original revision.
        setData((current) =>
          cursor && current?.revision === result.revision
            ? { ...result, rows: [...current.rows, ...result.rows] }
            : result,
        );
        setError("");
      } catch (cause) {
        if (owner === epoch.current && active.current) {
          discardDenied(cause);
          setError(apiErrorMessage(cause, "The table could not be loaded."));
          if (cause instanceof ApiClientError && cause.code === "table_cursor_stale" && cursor) void fetchTable();
        }
      }
    },
    [base, viewId, query, month, discardDenied],
  );
  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(() => load());
    const requestEpoch = epoch;
    return () => {
      active.current = false;
      requestEpoch.current++;
    };
  }, [load]);
  useEffect(() => {
    if (queryBase) return undefined;
    let socket: WebSocket | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    const connect = () => {
      if (stopped) return;
      const url = new URL(`/api/tables/${page.id}/socket`, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.addEventListener("message", () => {
        void load();
      });
      socket.addEventListener("close", () => {
        if (!stopped) timer = setTimeout(connect, 2000);
      });
    };
    connect();
    const heartbeat = setInterval(() => {
      if (document.hidden) return;
      if (socket?.readyState === WebSocket.OPEN) socket.send("refresh");
      else void load();
    }, 15000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      socket?.close();
    };
  }, [page.id, queryBase, load]);
  useEffect(() => {
    if (!queryBase) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => clearInterval(timer);
  }, [queryBase, load]);
  useEffect(() => {
    const invalidate = () => void load();
    window.addEventListener("notes:workspace-event", invalidate);
    return () => window.removeEventListener("notes:workspace-event", invalidate);
  }, [load]);
  const send = async (command: TableCommand) => {
    setBusy(true);
    setError("");
    setRetry(null);
    try {
      const result = await api<TableCommandResult>(commandsPath, {
        method: "POST",
        body: json(command),
        signal: AbortSignal.timeout(30000),
      });
      dirty.current = false;
      await load();
      if (result.projectionPending) setError("Saved. Search and task lists are catching up.");
      if (result.result.visibleInView === false)
        setError("Saved. The new row is hidden by this view's filters. Open All rows to see it.");
      return true;
    } catch (cause) {
      setError(apiErrorMessage(cause, "The table update could not be saved."));
      if (discardDenied(cause)) return false;
      if (!(cause instanceof ApiClientError) || cause.status >= 500) setRetry(() => () => send(command));
      else if (cause.status === 409) {
        dirty.current = false;
        await load();
        setError("The table changed. Review the latest value before saving again.");
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  const command = (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision = false) =>
    send({
      operationId: crypto.randomUUID(),
      ...(globalRevision && data ? { expectedRevision: data.revision } : {}),
      kind,
      payload,
    });
  const saveTask = async (body: Record<string, unknown>, rowId?: string): Promise<boolean> => {
    setBusy(true);
    setError("");
    setRetry(null);
    try {
      const result = await api<{ visibleInView?: boolean }>(rowId ? `${tasksPath}/${rowId}` : tasksPath, {
        method: rowId ? "PATCH" : "POST",
        body: json(body),
        signal: AbortSignal.timeout(30000),
      });
      dirty.current = false;
      if (!rowId) setNewTitle("");
      await load();
      if (result?.visibleInView === false)
        setError("Saved. Current filters hide this task. Choose All rows to see it.");
      return true;
    } catch (cause) {
      setError(apiErrorMessage(cause, "The task could not be saved."));
      if (discardDenied(cause)) return false;
      if (!(cause instanceof ApiClientError) || cause.status >= 500) setRetry(() => () => saveTask(body, rowId));
      else if (cause.status === 409) {
        dirty.current = false;
        await load();
        setError("The task list changed. Review the latest value before saving again.");
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  const changeCell = (row: CollaborativeRow, column: CollaborativeColumn, value: TableValue) => {
    if (taskList) {
      const columns = taskColumns(page.id),
        field = Object.entries(columns).find(([, id]) => id === column.id)?.[0];
      const fields: Record<string, unknown> = {
        title: "title",
        assignee: "assigneeId",
        status: "status",
        due: "dueDate",
      };
      if (field) {
        const op = crypto.randomUUID();
        void saveTask(
          {
            operationId: op,
            expectedRevision: data?.revision,
            [String(fields[field])]:
              field === "status" && typeof value === "string"
                ? value.slice(page.id.length + 1)
                : field === "assignee" && Array.isArray(value)
                  ? (value[0] ?? null)
                  : value,
          },
          row.id,
        );
        return;
      }
    }
    void command("update_cells", {
      rowId: row.id,
      values: { [column.id]: value },
      expectedCellRevisions: { [column.id]: row.cellRevisions[column.id] ?? 0 },
    });
  };
  const add = async (groupId?: string, date?: string) => {
    const titleColumn = data?.columns.find((column) => column.type === "text");
    if (taskList) {
      await saveTask({
        operationId: crypto.randomUUID(),
        expectedRevision: data?.revision,
        title: newTitle || "Untitled task",
        ...(viewId ? { viewId } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(date ? { date } : {}),
      });
      return;
    }
    await command(
      "create_row",
      {
        ...(viewId ? { viewId } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(date ? { date } : {}),
        values: titleColumn ? { [titleColumn.id]: newTitle } : {},
      },
      false,
    );
    setNewTitle("");
  };
  if (!data)
    return (
      <output className="table-live">
        {error || "Loading table…"}
        <button onClick={() => void load()}>Reload</button>
      </output>
    );
  const view = data.invalidView ? null : data.view;
  const columns = view
    ? view.visibleColumnIds.flatMap((id) => data.columns.filter((column) => column.id === id))
    : data.columns;
  const groupColumn = data.columns.find((column) => column.id === view?.columnId);
  const textColumn = data.columns.find((column) => column.type === "text");
  const rowLabel = (row: CollaborativeRow) =>
    String(textColumn ? (row.cells[textColumn.id] ?? "Untitled") : "Untitled");
  const card = (row: CollaborativeRow) => (
    <div
      className="table-card"
      key={row.id}
      draggable={editable && !busy}
      onDragStart={(event) => event.dataTransfer.setData("application/noteflare-row", row.id)}
    >
      <button
        className="quiet-button"
        disabled={!row.detailPageId}
        onClick={() => row.detailPageId && onSelectPage(row.detailPageId)}
      >
        {rowLabel(row)}
      </button>
      {columns
        .filter((column) => column.id !== textColumn?.id)
        .map((column) => (
          <label key={column.id}>
            {column.name}
            <Cell
              column={column}
              row={row}
              people={data.people ?? []}
              taskAssignee={Boolean(taskList && column.id === taskColumns(page.id).assignee)}
              disabled={!editable || busy}
              dirty={(value) => {
                dirty.current = value;
              }}
              onChange={(value) => changeCell(row, column, value)}
            />
          </label>
        ))}
    </div>
  );
  const drop = (event: React.DragEvent, target: string | null) => {
    event.preventDefault();
    const row = data.rows.find((candidate) => candidate.id === event.dataTransfer.getData("application/noteflare-row"));
    if (!row || !view?.columnId || busy) return;
    if (taskList) {
      const column = data.columns.find((candidate) => candidate.id === view.columnId);
      if (column) changeCell(row, column, target);
      return;
    }
    void command("move_row", {
      rowId: row.id,
      viewId: view.id,
      expectedCellRevision: row.cellRevisions[view.columnId] ?? 0,
      ...(view.kind === "board" ? { targetOptionId: target || null } : { targetDate: target }),
    });
  };
  return (
    <section className={`table-live ${embedded ? "table-live-embedded" : "page-canvas"}`}>
      {!embedded && (
        <>
          <h1>{page.title}</h1>
          {metadata}
        </>
      )}
      <div className="table-toolbar">
        <select
          aria-label="Saved table view"
          value={viewId}
          onChange={(event) => {
            setViewId(event.target.value);
            onViewChanged?.(event.target.value);
          }}
        >
          <option value="">All rows · Grid</option>
          {data.views.map((savedView) => (
            <option key={savedView.id} value={savedView.id}>
              {savedView.name}
              {savedView.ownerId ? " · Personal" : ""}
              {savedView.invalid ? " · Needs repair" : ""}
            </option>
          ))}
        </select>
        <input
          aria-label="Search table"
          placeholder="Search rows"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {view?.kind === "calendar" && (
          <input
            aria-label="Calendar month"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
        )}
        <span>{data.rowCount} rows</span>
        {editable && (
          <>
            <button disabled={busy} onClick={() => setPanel(panel === "view" ? null : "view")}>
              Views
            </button>
            <button disabled={busy} onClick={() => setPanel(panel === "properties" ? null : "properties")}>
              Properties
            </button>
          </>
        )}
        <button disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && (
        <div role="alert">
          {error}
          {retry && (
            <button disabled={busy} onClick={() => void retry()}>
              Retry saved operation
            </button>
          )}
        </div>
      )}
      {data.invalidView && (
        <p role="alert">
          This view uses a removed or changed property. Showing all rows in Grid. Open Views to repair it.
        </p>
      )}
      {panel === "view" && (
        <ViewEditor
          key={data.view?.id ?? "new"}
          view={data.view}
          columns={data.columns}
          enabledKinds={[
            "grid",
            ...(member.features?.tableBoard ? ["board" as const] : []),
            ...(member.features?.tableCalendar ? ["calendar" as const] : []),
          ]}
          busy={busy}
          save={(payload) => void command("save_view", payload)}
          remove={() =>
            data.view &&
            void command("delete_view", { viewId: data.view.id }).then((saved) => {
              if (saved) {
                setViewId("");
                onViewChanged?.("");
              }
            })
          }
        />
      )}
      {panel === "properties" && (
        <PropertyEditor
          columns={data.columns}
          fixedColumnIds={taskList ? Object.values(taskColumns(page.id)) : []}
          busy={busy}
          command={command}
        />
      )}
      {view?.kind === "board" && groupColumn ? (
        <div className="table-board">
          {[
            { id: "", label: "Unassigned" },
            ...groupColumn.options,
            ...Object.keys(data.groupCounts)
              .filter((groupId) => groupId && !groupColumn.options.some((option) => option.id === groupId))
              .map((groupId) => ({ id: groupId, label: "Deleted option", deleted: true })),
          ].map((group) => (
            <section
              className="table-board-group"
              key={group.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => drop(event, group.id)}
            >
              <h3>
                {group.label} · {data.groupCounts[group.id] ?? 0}
              </h3>
              {data.rows.filter((row) => (row.cells[groupColumn.id] ?? "") === group.id).map(card)}
              {editable &&
                !("deleted" in group) &&
                !(taskList && groupColumn.id === taskColumns(page.id).status && !group.id) && (
                  <button disabled={busy} onClick={() => void add(group.id)}>
                    Add in {group.label}
                  </button>
                )}
            </section>
          ))}
        </div>
      ) : view?.kind === "calendar" && groupColumn ? (
        <>
          <div className="table-calendar">
            {Array.from({ length: new Date(`${month}-01T12:00:00`).getDay() }, (_, index) => (
              <div key={`blank-${index}`} aria-hidden="true" />
            ))}
            {Array.from(
              { length: new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate() },
              (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
            ).map((date) => (
              <section key={date} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, date)}>
                <h3>{date.slice(-2)}</h3>
                {data.rows
                  .filter(
                    (row) =>
                      calendarDay(row.cells[groupColumn.id], Intl.DateTimeFormat().resolvedOptions().timeZone) === date,
                  )
                  .map(card)}
                {editable && (
                  <button disabled={busy} onClick={() => void add(undefined, date)}>
                    Add
                  </button>
                )}
              </section>
            ))}
          </div>
          <section
            className="table-unscheduled"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, null)}
          >
            <h3>Unscheduled</h3>
            {data.rows.filter((row) => !row.cells[groupColumn.id]).map(card)}
            {editable && (
              <button disabled={busy} onClick={() => void add()}>
                Add unscheduled
              </button>
            )}
          </section>
        </>
      ) : (
        <div className="table-grid-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.id}>
                    {column.name}
                    <small>{column.type.replaceAll("_", " ")}</small>
                  </th>
                ))}
                <th>Row</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  {columns.map((column) => (
                    <td key={column.id}>
                      <Cell
                        column={column}
                        row={row}
                        people={data.people ?? []}
                        taskAssignee={Boolean(taskList && column.id === taskColumns(page.id).assignee)}
                        disabled={!editable || busy}
                        dirty={(value) => {
                          dirty.current = value;
                        }}
                        onChange={(value) => changeCell(row, column, value)}
                      />
                    </td>
                  ))}
                  <td>
                    {row.detailPageId ? (
                      <button onClick={() => onSelectPage(row.detailPageId!)}>Open</button>
                    ) : (
                      editable && (
                        <button disabled={busy} onClick={() => void command("delete_row", { rowId: row.id })}>
                          Delete row
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {Object.keys(data.calculations ?? {}).length > 0 && (
              <tfoot>
                <tr>
                  {columns.map((column) => (
                    <td key={column.id}>
                      {data.calculations?.[column.id]
                        ? `${data.calculations[column.id]!.kind.replaceAll("_", " ")}: ${data.calculations[column.id]!.value ?? "—"}`
                        : ""}
                    </td>
                  ))}
                  <td>
                    All {data.rowCount} matching rows · revision {data.revision}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {data.nextCursor && (
        <button disabled={busy} onClick={() => void load(data.nextCursor!)}>
          Load more rows
        </button>
      )}
      {editable && (
        <form
          className="table-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            aria-label="New row title"
            placeholder="Add a row…"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <button disabled={busy}>Add row</button>
        </form>
      )}
    </section>
  );
}

function Cell({
  column,
  row,
  people,
  taskAssignee = false,
  disabled,
  dirty,
  onChange,
}: {
  column: CollaborativeColumn;
  row: CollaborativeRow;
  people: NonNullable<TableQueryResult["people"]>;
  taskAssignee?: boolean;
  disabled: boolean;
  dirty: (value: boolean) => void;
  onChange: (value: TableValue) => void;
}) {
  const value = row.cells[column.id] ?? null;
  const [draft, setDraft] = useState(String(value ?? ""));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value ?? ""));
  }, [value]);
  if (column.type === "formula") {
    const computedValue = row.computedCells?.[column.id]?.value;
    return (
      <output title={isErrorCell(computedValue) ? computedValue.msg : undefined}>
        {isErrorCell(computedValue)
          ? `#${computedValue["__err"]}`
          : computedValue === null || computedValue === undefined
            ? "—"
            : String(computedValue)}
      </output>
    );
  }
  if (metadataColumns.has(column.type))
    return (
      <output>
        {["created_by", "last_edited_by"].includes(column.type) && typeof value === "string"
          ? (people.find((person) => person.id === value)?.name ?? "Former member")
          : String(value ?? "—")}
      </output>
    );
  if (taskAssignee) {
    const selected = Array.isArray(value) ? (value[0] ?? "") : String(value ?? "");
    return (
      <select
        aria-label={column.name}
        disabled={disabled}
        value={selected}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Unassigned</option>
        {people.map((person) => (
          <option key={person.id} value={person.id} disabled={!person.active && person.id !== selected}>
            {person.name}
            {person.active ? "" : " (former member)"}
          </option>
        ))}
        {selected && !people.some((person) => person.id === selected) && (
          <option value={selected}>Former member</option>
        )}
      </select>
    );
  }
  if (column.type === "person") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <select
        aria-label={column.name}
        multiple
        disabled={disabled || Boolean(column.conversion)}
        value={selected}
        onChange={(event) => onChange([...event.target.selectedOptions].map((option) => option.value))}
      >
        {people.map((person) => (
          <option key={person.id} value={person.id} disabled={!person.active && !selected.includes(person.id)}>
            {person.name}
            {person.active ? "" : " (former member)"}
          </option>
        ))}
        {selected
          .filter((personId) => !people.some((person) => person.id === personId))
          .map((personId) => (
            <option key={personId} value={personId}>
              Former member
            </option>
          ))}
      </select>
    );
  }
  if (column.type === "checkbox")
    return (
      <input
        aria-label={column.name}
        type="checkbox"
        checked={value === true}
        disabled={disabled || Boolean(column.conversion)}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  if (["select", "status", "multi_select"].includes(column.type))
    return (
      <select
        aria-label={column.name}
        multiple={column.type === "multi_select"}
        disabled={disabled || Boolean(column.conversion)}
        value={column.type === "multi_select" ? (Array.isArray(value) ? value : []) : String(value ?? "")}
        onChange={(event) =>
          onChange(
            column.type === "multi_select"
              ? [...event.target.selectedOptions].map((option) => option.value)
              : event.target.value || null,
          )
        }
      >
        {column.type !== "multi_select" && <option value="">Unassigned</option>}
        {column.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        {typeof value === "string" && !column.options.some((option) => option.id === value) && (
          <option value={value}>Deleted option</option>
        )}
      </select>
    );
  return (
    <>
      <input
        aria-label={column.name}
        type={
          column.type === "number"
            ? "number"
            : column.type === "date" && !(String(value).includes("T") || column.config?.timeZone)
              ? "date"
              : column.type === "url"
                ? "url"
                : "text"
        }
        value={draft}
        disabled={disabled || Boolean(column.conversion)}
        onFocus={() => {
          focused.current = true;
          dirty(true);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          focused.current = false;
          dirty(false);
          const next = column.type === "number" ? (draft === "" ? null : Number(draft)) : draft || null;
          if (JSON.stringify(next) !== JSON.stringify(value)) onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {column.type === "url" && typeof value === "string" && /^https?:\/\//i.test(value) && (
        <a href={value} target="_blank" rel="noopener noreferrer">
          Open link
        </a>
      )}
    </>
  );
}

function ViewEditor({
  view,
  columns,
  enabledKinds,
  busy,
  save,
  remove,
}: {
  view: TableView | null;
  columns: CollaborativeColumn[];
  enabledKinds: TableView["kind"][];
  busy: boolean;
  save: (payload: Record<string, unknown>) => void;
  remove: () => void;
}) {
  const [name, setName] = useState(view?.name ?? "New view"),
    [kind, setKind] = useState<TableView["kind"]>(view?.kind ?? "grid"),
    [columnId, setColumnId] = useState(view?.columnId ?? ""),
    [personal, setPersonal] = useState(Boolean(view?.ownerId));
  const [filterColumn, setFilterColumn] = useState(""),
    [filterValue, setFilterValue] = useState(""),
    [filterOperator, setFilterOperator] = useState("eq"),
    [filters, setFilters] = useState<TableFilter[]>(
      view?.filters?.kind === "group" ? view.filters.filters : view?.filters ? [view.filters] : [],
    ),
    [join, setJoin] = useState<"and" | "or">(view?.filters?.kind === "group" ? view.filters.operator : "and");
  const [sorts, setSorts] = useState(view?.sorts ?? []),
    [visible, setVisible] = useState(view?.visibleColumnIds ?? columns.map((column) => column.id)),
    [calculations, setCalculations] = useState(view?.calculations ?? {});
  return (
    <form
      className="table-settings"
      onSubmit={(event) => {
        event.preventDefault();
        save({
          ...(view ? { id: view.id, revision: view.revision } : {}),
          name,
          kind,
          columnId: kind === "grid" ? null : columnId,
          personal,
          filters: { kind: "group", operator: join, filters },
          sorts,
          visibleColumnIds: visible,
          calculations,
        });
      }}
    >
      <label>
        View name
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
      </label>
      <label>
        Layout
        <select value={kind} onChange={(event) => setKind(event.target.value as TableView["kind"])}>
          {[...new Set([...enabledKinds, ...(view ? [view.kind] : [])])].map((layoutKind) => (
            <option key={layoutKind}>{layoutKind}</option>
          ))}
        </select>
      </label>
      {kind !== "grid" && (
        <label>
          {kind === "board" ? "Group property" : "Date property"}
          <select required value={columnId} onChange={(event) => setColumnId(event.target.value)}>
            <option value="">Choose property</option>
            {columns
              .filter((column) =>
                kind === "board" ? ["select", "status"].includes(column.type) : column.type === "date",
              )
              .map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        <input type="checkbox" checked={personal} onChange={(event) => setPersonal(event.target.checked)} />
        Personal view
      </label>
      <fieldset>
        <legend>Filters</legend>
        <select
          aria-label="Filter combination"
          value={join}
          onChange={(event) => setJoin(event.target.value as "and" | "or")}
        >
          <option value="and">Match all</option>
          <option value="or">Match any</option>
        </select>
        {filters.map((filter, index) => (
          <p key={index}>
            {filter.kind === "condition"
              ? `${columns.find((column) => column.id === filter.columnId)?.name ?? "Removed property"} ${filter.operator} ${JSON.stringify(filter.value ?? "")}`
              : "Filter group"}
            <button type="button" onClick={() => setFilters(filters.filter((_, i) => i !== index))}>
              Remove
            </button>
          </p>
        ))}
        <select
          aria-label="Filter property"
          value={filterColumn}
          onChange={(event) => setFilterColumn(event.target.value)}
        >
          <option value="">Choose property</option>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter operator"
          value={filterOperator}
          onChange={(event) => setFilterOperator(event.target.value)}
        >
          {["eq", "neq", "contains", "empty", "not_empty", "gt", "gte", "lt", "lte"].map((operator) => (
            <option key={operator}>{operator}</option>
          ))}
        </select>
        <input
          aria-label="Filter value"
          value={filterValue}
          onChange={(event) => setFilterValue(event.target.value)}
          placeholder="Value or option ID"
        />
        <button
          type="button"
          disabled={!filterColumn}
          onClick={() => {
            const column = columns.find((candidate) => candidate.id === filterColumn)!;
            setFilters([
              ...filters,
              {
                kind: "condition",
                columnId: filterColumn,
                operator: filterOperator as "eq",
                value:
                  column.type === "number"
                    ? Number(filterValue)
                    : column.type === "checkbox"
                      ? filterValue === "true"
                      : filterValue,
              },
            ]);
          }}
        >
          Add filter
        </button>
      </fieldset>
      <fieldset>
        <legend>Sort order</legend>
        {sorts.map((sort, index) => (
          <label key={index}>
            {columns.find((column) => column.id === sort.columnId)?.name}
            <select
              value={sort.direction}
              onChange={(event) =>
                setSorts(
                  sorts.map((s, i) => (i === index ? { ...s, direction: event.target.value as "asc" | "desc" } : s)),
                )
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button type="button" onClick={() => setSorts(sorts.filter((_, i) => i !== index))}>
              Remove
            </button>
          </label>
        ))}
        <select
          aria-label="Add sort property"
          value=""
          onChange={(event) => setSorts([...sorts, { columnId: event.target.value, direction: "asc" }])}
        >
          <option value="">Add sort…</option>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset>
        <legend>Visible properties and calculations</legend>
        {columns.map((column) => (
          <label key={column.id}>
            <input
              type="checkbox"
              checked={visible.includes(column.id)}
              onChange={(event) =>
                setVisible(event.target.checked ? [...visible, column.id] : visible.filter((id) => id !== column.id))
              }
            />
            {column.name}
            <select
              aria-label={`Calculation for ${column.name}`}
              value={calculations[column.id] ?? ""}
              onChange={(event) => {
                const next = { ...calculations };
                if (event.target.value) next[column.id] = event.target.value as CalculationKind;
                else delete next[column.id];
                setCalculations(next);
              }}
            >
              <option value="">No calculation</option>
              {allowedCalculationKinds(column).map((calculationKind) => (
                <option key={calculationKind}>{calculationKind}</option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      <button disabled={busy}>Save view</button>
      {view && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              save({
                name: `${name} copy`,
                kind,
                columnId: kind === "grid" ? null : columnId,
                personal,
                filters: { kind: "group", operator: join, filters },
                sorts,
                visibleColumnIds: visible,
                calculations,
              })
            }
          >
            Save as new view
          </button>
          <button type="button" disabled={busy} onClick={remove}>
            Delete view
          </button>
        </>
      )}
    </form>
  );
}

function PropertyEditor({
  columns,
  fixedColumnIds,
  busy,
  command,
}: {
  columns: CollaborativeColumn[];
  fixedColumnIds: string[];
  busy: boolean;
  command: (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision?: boolean) => Promise<boolean>;
}) {
  const [name, setName] = useState(""),
    [type, setType] = useState("text"),
    [source, setSource] = useState("");
  return (
    <section className="table-settings">
      <h3>Properties</h3>
      {columns.map((column) =>
        fixedColumnIds.includes(column.id) ? (
          <p key={column.id}>{column.name} · Fixed task property</p>
        ) : (
          <Property key={column.id} column={column} columns={columns} busy={busy} command={command} />
        ),
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command("create_column", { name, type, ...(type === "formula" ? { source } : {}) });
          setName("");
        }}
      >
        <input
          aria-label="New property name"
          required
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
        <select aria-label="New property type" value={type} onChange={(event) => setType(event.target.value)}>
          {TABLE_COLUMN_TYPES.map((columnType) => (
            <option key={columnType}>{columnType}</option>
          ))}
        </select>
        {type === "formula" && (
          <input
            aria-label="New formula"
            value={source}
            required
            placeholder='prop("Amount") * 2'
            onChange={(event) => setSource(event.target.value)}
          />
        )}
        <button disabled={busy}>Add property</button>
      </form>
    </section>
  );
}
function Property({
  column,
  columns,
  busy,
  command,
}: {
  column: CollaborativeColumn;
  columns: CollaborativeColumn[];
  busy: boolean;
  command: (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision?: boolean) => Promise<boolean>;
}) {
  const [name, setName] = useState(column.name),
    [type, setType] = useState(column.type),
    [option, setOption] = useState(""),
    [source, setSource] = useState(
      column.config?.ast
        ? format(
            (column.config as unknown as FormulaTypeOptions).ast,
            new Map(columns.map((property) => [property.id, property.name])),
          )
        : String(column.config?.source ?? ""),
    ),
    [clearInvalid, setClearInvalid] = useState(false);
  return (
    <div className="table-property">
      <input
        aria-label={`Name for ${column.name}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (name !== column.name)
            void command("update_column", { columnId: column.id, name, revision: column.revision });
        }}
      />
      <select
        aria-label={`Type for ${column.name}`}
        value={type}
        disabled={busy || Boolean(column.conversion) || column.type === "formula"}
        onChange={(event) => {
          setType(event.target.value as CollaborativeColumn["type"]);
          void command("prepare_type", { columnId: column.id, type: event.target.value, revision: column.revision });
        }}
      >
        {TABLE_COLUMN_TYPES.filter((columnType) => columnType !== "formula").map((columnType) => (
          <option key={columnType}>{columnType}</option>
        ))}
      </select>
      {column.type === "formula" && (
        <>
          <input
            aria-label={`Formula for ${column.name}`}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <button
            disabled={busy}
            onClick={() => void command("update_column", { columnId: column.id, revision: column.revision, source })}
          >
            Update formula
          </button>
        </>
      )}
      {column.conversion && (
        <output>
          Preview: {column.conversion.converted} converted, {column.conversion.empty} empty,{" "}
          {column.conversion.failures} invalid of {column.conversion.total} rows. Generation{" "}
          {column.conversion.generation}, schema {column.conversion.schemaRevision}.
          {column.conversion.failures > 0 && (
            <label>
              <input
                type="checkbox"
                checked={clearInvalid}
                onChange={(event) => setClearInvalid(event.target.checked)}
              />
              Clear these values
            </label>
          )}
          <button
            disabled={busy || (column.conversion.failures > 0 && !clearInvalid)}
            onClick={() =>
              void command("commit_type", { columnId: column.id, conversionId: column.conversion!.id, clearInvalid })
            }
          >
            Commit type change
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setType(column.type);
              void command("cancel_type", { columnId: column.id, conversionId: column.conversion!.id });
            }}
          >
            Cancel
          </button>
        </output>
      )}
      {["select", "multi_select", "status"].includes(column.type) && (
        <>
          <span>
            {column.options.map((existingOption) => (
              <button
                key={existingOption.id}
                disabled={busy}
                title="Delete option; existing cells keep a deleted-option marker"
                onClick={() => void command("delete_option", { columnId: column.id, optionId: existingOption.id })}
              >
                {existingOption.label} ×
              </button>
            ))}
          </span>
          <input
            aria-label={`New option for ${column.name}`}
            value={option}
            onChange={(event) => setOption(event.target.value)}
          />
          <button
            disabled={busy || !option}
            onClick={() => {
              void command("add_option", { columnId: column.id, label: option });
              setOption("");
            }}
          >
            Add option
          </button>
        </>
      )}
      <button disabled={busy} onClick={() => void command("delete_column", { columnId: column.id }, true)}>
        Delete property
      </button>
    </div>
  );
}
