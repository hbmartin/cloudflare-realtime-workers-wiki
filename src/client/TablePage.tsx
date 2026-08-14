import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemberContext } from "../worker/env";
import type { ColumnType, Page, TableColumn, TableData, TableRow } from "../shared/types";
import { ApiClientError, api, json } from "./api";

type Props = { page: Page; member: MemberContext; onPageChanged: (page: Page) => void };

export function TablePage({ page, member, onPageChanged }: Props) {
  const [table, setTable] = useState<TableData | null>(null);
  const [leaseToken, setLeaseToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [title, setTitle] = useState(page.title);
  const canEdit = member.role !== "viewer";

  const load = useCallback(async () => {
    const result = await api<{ table: TableData }>(`/api/tables/${page.id}`);
    setTable(result.table);
  }, [page.id]);

  const acquire = useCallback(async () => {
    if (!canEdit) return;
    try {
      const result = await api<{ leaseToken: string }>(`/api/tables/${page.id}/lease`, { method: "POST" });
      setLeaseToken(result.leaseToken);
      setError(null);
      await load();
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "lease_conflict") {
        setLeaseToken(null);
        setError("Another editor has this table open for editing.");
        await load();
        return;
      }
      throw cause;
    }
  }, [canEdit, load, page.id]);

  useEffect(() => {
    let active = true;
    void load().then(() => { if (active) return acquire(); });
    return () => { active = false; };
  }, [load, acquire]);

  useEffect(() => {
    if (!leaseToken) {
      const poll = window.setInterval(() => void load(), 5_000);
      return () => window.clearInterval(poll);
    }
    const renew = window.setInterval(async () => {
      try {
        await api(`/api/tables/${page.id}/lease`, {
          method: "PATCH", body: json({ leaseToken }),
        });
      } catch {
        setLeaseToken(null);
        setError("The editing lease was lost. Reloaded the authoritative table.");
        await load();
      }
    }, 20_000);
    return () => {
      window.clearInterval(renew);
      void fetch(`/api/tables/${page.id}/lease`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: json({ leaseToken }),
        keepalive: true,
      });
    };
  }, [leaseToken, load, page.id]);

  async function saveTitle() {
    const normalized = title.trim() || "Untitled";
    if (normalized === page.title) return;
    const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
      method: "PATCH", body: json({ title: normalized, revision: page.revision }),
    });
    onPageChanged(result.page);
  }

  async function mutation<T>(path: string, method: string, body: Record<string, unknown>) {
    if (!table || !leaseToken) return null;
    try {
      const result = await api<T & { revision: number }>(path, {
        method,
        body: json({ ...body, leaseToken, expectedRevision: table.revision }),
      });
      setTable((current) => current ? { ...current, revision: result.revision } : current);
      return result;
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 409) {
        setLeaseToken(null);
        setError(cause.message);
        await load();
        return null;
      }
      throw cause;
    }
  }

  async function addColumn() {
    if (!table) return;
    const name = prompt("Column name", "Property")?.trim();
    if (!name) return;
    const type = (prompt("Type: text, number, checkbox, date, or select", "text") ?? "") as ColumnType;
    if (!["text", "number", "checkbox", "date", "select"].includes(type)) return;
    const result = await mutation<{ column: TableColumn }>(`/api/tables/${page.id}/columns`, "POST", {
      name, type, position: table.columns.length,
    });
    if (result) setTable((current) => current ? { ...current, columns: [...current.columns, { ...result.column, options: [] }] } : current);
  }

  async function removeColumn(column: TableColumn) {
    if (!confirm(`Delete “${column.name}” and every value in it?`)) return;
    const result = await mutation(`/api/tables/${page.id}/columns/${column.id}`, "DELETE", {});
    if (result) setTable((current) => current ? { ...current, columns: current.columns.filter((item) => item.id !== column.id) } : current);
  }

  async function addOption(column: TableColumn) {
    const label = prompt(`New option for “${column.name}”`)?.trim();
    if (!label) return;
    const result = await mutation<{ option: { id: string; label: string; position: number } }>(
      `/api/tables/${page.id}/columns/${column.id}/options`, "POST", { label, position: column.options.length },
    );
    if (result) setTable((current) => current ? { ...current, columns: current.columns.map((item) => item.id === column.id ? { ...item, options: [...item.options, result.option] } : item) } : current);
  }

  async function addRow() {
    if (!table) return;
    const result = await mutation<{ row: TableRow }>(`/api/tables/${page.id}/rows`, "POST", { position: table.rows.length });
    if (result) setTable((current) => current ? { ...current, rows: [...current.rows, result.row] } : current);
  }

  async function removeRow(row: TableRow) {
    const result = await mutation(`/api/tables/${page.id}/rows/${row.id}`, "DELETE", {});
    if (result) setTable((current) => current ? { ...current, rows: current.rows.filter((item) => item.id !== row.id) } : current);
  }

  async function setCell(rowId: string, columnId: string, value: string | number | boolean | null) {
    const result = await mutation(`/api/tables/${page.id}/cells/${rowId}/${columnId}`, "PUT", { value });
    if (result) setTable((current) => current ? {
      ...current,
      rows: current.rows.map((row) => row.id === rowId ? { ...row, cells: { ...row.cells, [columnId]: value } } : row),
    } : current);
  }

  const visibleRows = useMemo(() => {
    if (!table) return [];
    const normalized = filter.toLowerCase();
    const rows = normalized
      ? table.rows.filter((row) => Object.values(row.cells).some((value) => String(value ?? "").toLowerCase().includes(normalized)))
      : [...table.rows];
    if (sortColumn) rows.sort((left, right) => String(left.cells[sortColumn] ?? "").localeCompare(String(right.cells[sortColumn] ?? ""), undefined, { numeric: true }));
    return rows;
  }, [filter, sortColumn, table]);

  return (
    <main className="page-canvas table-canvas">
      <div className="page-tools">
        <span className={`lease-state ${leaseToken ? "lease-active" : ""}`}>{leaseToken ? "Editing lease active" : "Read-only"}</span>
        {canEdit && <button className="quiet-button" onClick={async () => {
          const icon = prompt("Page icon (one emoji, or leave blank to remove)", page.icon ?? "")?.trim();
          if (icon === undefined) return;
          const result = await api<{ page: Page }>(`/api/pages/${page.id}`, { method: "PATCH", body: json({ icon: icon || null, revision: page.revision }) });
          onPageChanged(result.page);
        }}>{page.icon ?? "Add icon"}</button>}
        {!leaseToken && canEdit && <button className="quiet-button" onClick={() => void acquire()}>Try edit lock</button>}
        {member.role === "owner" && !leaseToken && (
          <button className="quiet-button" onClick={async () => {
            await api(`/api/tables/${page.id}/force-unlock`, { method: "POST" });
            await acquire();
          }}>Force unlock</button>
        )}
      </div>
      {error && <div className="notice">{error}</div>}
      <article className="table-paper">
        <input
          className="page-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          readOnly={!canEdit}
        />
        <div className="table-toolbar">
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter rows…" />
          <span>{visibleRows.length} / {table?.rows.length ?? 0} rows</span>
          {leaseToken && <button onClick={() => void addColumn()}>+ Property</button>}
        </div>
        {!table ? <div className="editor-loading">Loading table…</div> : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th key={column.id}>
                      <button className="column-sort" onClick={() => setSortColumn(sortColumn === column.id ? null : column.id)}>
                      {column.name} <small>{column.type}</small>{sortColumn === column.id ? " ↑" : ""}
                      </button>
                      {leaseToken && column.type === "select" && <button className="add-option" onClick={() => void addOption(column)} aria-label={`Add option to ${column.name}`}>+</button>}
                      {leaseToken && <button className="delete-column" onClick={() => void removeColumn(column)} aria-label={`Delete ${column.name}`}>×</button>}
                    </th>
                  ))}
                  {leaseToken && <th className="row-actions" />}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id}>
                    {table.columns.map((column) => (
                      <td key={column.id}>
                        <CellInput
                          key={`${row.id}:${column.id}:${String(row.cells[column.id] ?? "")}`}
                          column={column}
                          value={row.cells[column.id] ?? null}
                          disabled={!leaseToken}
                          onCommit={(value) => void setCell(row.id, column.id, value)}
                        />
                      </td>
                    ))}
                    {leaseToken && <td className="row-actions"><button onClick={() => void removeRow(row)} aria-label="Delete row">×</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {leaseToken && <button className="add-row" onClick={() => void addRow()} disabled={table.rows.length >= 500}>+ New row</button>}
            {!table.columns.length && <p className="empty-copy">Add a property to start this table.</p>}
          </div>
        )}
      </article>
    </main>
  );
}

function CellInput({ column, value, disabled, onCommit }: {
  column: TableColumn;
  value: string | number | boolean | null;
  disabled: boolean;
  onCommit: (value: string | number | boolean | null) => void;
}) {
  if (column.type === "checkbox") {
    return <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onCommit(event.target.checked)} />;
  }
  if (column.type === "select") {
    return (
      <select value={String(value ?? "")} disabled={disabled} onChange={(event) => onCommit(event.target.value || null)}>
        <option value="">—</option>
        {column.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
      </select>
    );
  }
  return (
    <input
      type={column.type === "number" ? "number" : column.type === "date" ? "date" : "text"}
      defaultValue={value === null ? "" : String(value)}
      disabled={disabled}
      onBlur={(event) => onCommit(column.type === "number" ? (event.target.value === "" ? null : Number(event.target.value)) : event.target.value || null)}
    />
  );
}
