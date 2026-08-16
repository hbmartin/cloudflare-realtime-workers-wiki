import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientMemberContext } from "../shared/types";
import type { ColumnType, Page, TableColumn, TableData, TableRow } from "../shared/types";
import { ApiClientError, api, json } from "./api";
import { BacklinksPanel } from "./BacklinksPanel";

type IsCurrent = () => boolean;

const LEASE_CONFLICT_MESSAGE = "Another editor has this table open for editing.";
const REQUEST_TIMEOUT_MS = 15_000;

function releaseTableLease(pageId: string, leaseToken: string) {
  void api(`/api/tables/${pageId}/lease`, {
    method: "DELETE",
    body: json({ leaseToken }),
    keepalive: true,
  }).catch((cause) => console.error("Failed to release table lease", cause));
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export type TablePageProps = {
  page: Page;
  member: ClientMemberContext;
  onPageChanged: (page: Page) => void;
  onSelectPage: (pageId: string) => void;
  backlinksRevision: number;
};

export function TablePage({ page, member, onPageChanged, onSelectPage, backlinksRevision }: TablePageProps) {
  const canEdit = member.role !== "viewer";
  const [table, setTable] = useState<TableData | null>(null);
  const [leaseToken, setLeaseToken] = useState<string | null>(null);
  const [leasePending, setLeasePending] = useState(canEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [leaseError, setLeaseError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [title, setTitle] = useState(page.title);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const revisionRef = useRef<number | null>(null);
  const leaseTokenRef = useRef<string | null>(null);
  const columnCountRef = useRef(0);
  const rowCountRef = useRef(0);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const leaseActionRef = useRef<{ owner: IsCurrent; promise: Promise<void> } | null>(null);
  const leaseExpiresAtRef = useRef<number | null>(null);
  const loadsInFlightRef = useRef(0);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const tableLoaded = table !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const currentLease = leaseTokenRef.current;
      leaseTokenRef.current = null;
      leaseExpiresAtRef.current = null;
      if (currentLease) releaseTableLease(page.id, currentLease);
    };
  }, [page.id]);

  const isMounted = useCallback(() => mountedRef.current, []);

  const load = useCallback(
    async (isCurrent: IsCurrent) => {
      const generation = ++loadGenerationRef.current;
      loadsInFlightRef.current += 1;
      try {
        const result = await api<{ table: TableData }>(`/api/tables/${page.id}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!isCurrent() || generation !== loadGenerationRef.current) return;
        revisionRef.current = result.table.revision;
        columnCountRef.current = result.table.columns.length;
        rowCountRef.current = result.table.rows.length;
        setTable(result.table);
        setLoadError(null);
        if (!result.table.lease.expiresAt) {
          setLeaseError((current) => (current === LEASE_CONFLICT_MESSAGE ? null : current));
        }
      } catch (cause) {
        if (isCurrent() && generation === loadGenerationRef.current) {
          setLoadError(errorMessage(cause, "Table could not be loaded."));
        }
        throw cause;
      } finally {
        loadsInFlightRef.current -= 1;
      }
    },
    [page.id],
  );

  const runLeaseAction = useCallback((isCurrent: IsCurrent, action: () => Promise<void>) => {
    if (!isCurrent()) return Promise.resolve();
    const current = leaseActionRef.current;
    if (current?.owner === isCurrent) return current.promise;
    setLeasePending(true);
    const attempt = current
      ? current.promise.catch(() => undefined).then(() => (isCurrent() ? action() : undefined))
      : action();
    const tracked = { owner: isCurrent, promise: Promise.resolve() };
    tracked.promise = attempt.finally(() => {
      if (leaseActionRef.current !== tracked) return;
      leaseActionRef.current = null;
      if (mountedRef.current) setLeasePending(false);
    });
    leaseActionRef.current = tracked;
    return tracked.promise;
  }, []);

  const performAcquire = useCallback(
    async (isCurrent: IsCurrent, priorLoad?: Promise<void>) => {
      if (!canEdit) return;
      let result: { leaseToken: string; expiresAt: number };
      try {
        result = await api<{ leaseToken: string; expiresAt: number }>(`/api/tables/${page.id}/lease`, {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        if (!isCurrent()) return;
        if (cause instanceof ApiClientError && cause.code === "lease_conflict") {
          leaseTokenRef.current = null;
          setLeaseToken(null);
          setLeaseError(LEASE_CONFLICT_MESSAGE);
          await priorLoad?.catch(() => undefined);
          if (isCurrent()) await load(isCurrent).catch(() => undefined);
          return;
        }
        throw cause;
      }
      if (!isCurrent()) {
        releaseTableLease(page.id, result.leaseToken);
        return;
      }
      leaseTokenRef.current = result.leaseToken;
      leaseExpiresAtRef.current = result.expiresAt;
      setLeaseToken(result.leaseToken);
      setLeaseError(null);
      // Let the immediate mount load settle before starting the authoritative
      // post-acquisition load. This preserves a successful fallback if the
      // latter request fails without allowing an older response to overwrite it.
      await priorLoad?.catch(() => undefined);
      if (isCurrent()) await load(isCurrent).catch(() => undefined);
    },
    [canEdit, load, page.id],
  );

  const acquire = useCallback(
    (isCurrent: IsCurrent, priorLoad?: Promise<void>) => {
      if (!canEdit) return Promise.resolve();
      return runLeaseAction(isCurrent, () => performAcquire(isCurrent, priorLoad));
    },
    [canEdit, performAcquire, runLeaseAction],
  );

  const reportLeaseError = useCallback((cause: unknown) => {
    if (mountedRef.current) setLeaseError(errorMessage(cause, "The editing lease could not be acquired."));
  }, []);

  useEffect(() => {
    let active = true;
    const isCurrent = () => active && mountedRef.current;
    const initialLoad = load(isCurrent);
    void initialLoad.catch(() => undefined);
    if (canEdit) void acquire(isCurrent, initialLoad).catch(reportLeaseError);
    return () => {
      active = false;
    };
  }, [load, acquire, canEdit, reportLeaseError]);

  useEffect(() => {
    if (leaseToken && tableLoaded) return undefined;
    let active = true;
    const isCurrent = () => active && mountedRef.current;
    const poll = window.setInterval(() => {
      if (!loadsInFlightRef.current) void load(isCurrent).catch(() => undefined);
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [leaseToken, load, tableLoaded]);

  useEffect(() => {
    if (!leaseToken) return undefined;
    let active = true;
    let expiryTimer: number | undefined;
    let renew: number | undefined;
    const expireLease = () => {
      if (!active) return;
      active = false;
      if (renew !== undefined) window.clearInterval(renew);
      leaseTokenRef.current = null;
      leaseExpiresAtRef.current = null;
      setLeaseToken(null);
      setLeaseError("The editing lease expired after renewal failures. Reloaded the authoritative table.");
      releaseTableLease(page.id, leaseToken);
      void load(isMounted).catch(() => undefined);
    };
    const scheduleExpiry = (expiresAt: number | null) => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      if (expiresAt !== null) expiryTimer = window.setTimeout(expireLease, Math.max(0, expiresAt - Date.now()));
    };
    scheduleExpiry(leaseExpiresAtRef.current);
    const renewLease = async () => {
      try {
        const result = await api<{ expiresAt: number }>(`/api/tables/${page.id}/lease`, {
          method: "PATCH",
          body: json({ leaseToken }),
        });
        if (active) {
          leaseExpiresAtRef.current = result.expiresAt;
          scheduleExpiry(result.expiresAt);
          setLeaseError(null);
        }
      } catch (cause) {
        if (!active) return;
        const retryable = !(cause instanceof ApiClientError) || cause.status === 429 || cause.status >= 500;
        if (retryable) {
          setLeaseError(`${errorMessage(cause, "The editing lease could not be renewed.")} Retrying.`);
          return;
        }
        active = false;
        if (renew !== undefined) window.clearInterval(renew);
        if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
        leaseTokenRef.current = null;
        leaseExpiresAtRef.current = null;
        setLeaseToken(null);
        setLeaseError(
          cause.status === 409 ? "The editing lease was lost. Reloaded the authoritative table." : cause.message,
        );
        if (cause.status !== 401) releaseTableLease(page.id, leaseToken);
        await load(isMounted).catch(() => undefined);
      }
    };
    renew = window.setInterval(() => void renewLease(), 20_000);
    return () => {
      active = false;
      if (renew !== undefined) window.clearInterval(renew);
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    };
  }, [isMounted, leaseToken, load, page.id]);

  async function saveTitle() {
    const normalized = title.trim() || "Untitled";
    if (normalized === page.title) return;
    const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: json({ title: normalized, revision: page.revision }),
    });
    onPageChanged(result.page);
  }

  async function mutation<T>(
    path: string,
    method: string,
    body: Record<string, unknown>,
    position?: () => number,
    onSuccess?: () => void,
  ) {
    const execute = async () => {
      const currentLease = leaseTokenRef.current;
      const currentRevision = revisionRef.current;
      if (!currentLease || currentRevision === null) return null;
      try {
        const result = await api<T & { revision: number }>(path, {
          method,
          body: json({
            ...body,
            ...(position ? { position: position() } : {}),
            leaseToken: currentLease,
            expectedRevision: currentRevision,
          }),
        });
        if (!isMounted()) return null;
        revisionRef.current = result.revision;
        onSuccess?.();
        setTable((current) => (current ? { ...current, revision: result.revision } : current));
        return result;
      } catch (cause) {
        if (!isMounted()) return null;
        if (cause instanceof ApiClientError && cause.status === 409) {
          leaseTokenRef.current = null;
          setLeaseToken(null);
          setLeaseError(cause.message);
          releaseTableLease(page.id, currentLease);
          await load(isMounted).catch(() => undefined);
          return null;
        }
        throw cause;
      }
    };
    const pending = mutationQueue.current.then(execute, execute);
    mutationQueue.current = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function addColumn() {
    if (!table) return;
    const name = prompt("Column name", "Property")?.trim();
    if (!name) return;
    const type = (prompt("Type: text, number, checkbox, date, or select", "text") ?? "") as ColumnType;
    if (!["text", "number", "checkbox", "date", "select"].includes(type)) return;
    const result = await mutation<{ column: TableColumn }>(
      `/api/tables/${page.id}/columns`,
      "POST",
      { name, type },
      () => columnCountRef.current,
      () => {
        columnCountRef.current += 1;
      },
    );
    if (result)
      setTable((current) =>
        current ? { ...current, columns: [...current.columns, { ...result.column, options: [] }] } : current,
      );
  }

  async function removeColumn(column: TableColumn) {
    if (!confirm(`Delete “${column.name}” and every value in it?`)) return;
    const result = await mutation(`/api/tables/${page.id}/columns/${column.id}`, "DELETE", {}, undefined, () => {
      columnCountRef.current = Math.max(0, columnCountRef.current - 1);
    });
    if (result)
      setTable((current) =>
        current ? { ...current, columns: current.columns.filter((item) => item.id !== column.id) } : current,
      );
  }

  async function addOption(column: TableColumn) {
    const label = prompt(`New option for “${column.name}”`)?.trim();
    if (!label) return;
    const result = await mutation<{ option: { id: string; label: string; position: number } }>(
      `/api/tables/${page.id}/columns/${column.id}/options`,
      "POST",
      { label, position: column.options.length },
    );
    if (result)
      setTable((current) =>
        current
          ? {
              ...current,
              columns: current.columns.map((item) =>
                item.id === column.id ? { ...item, options: [...item.options, result.option] } : item,
              ),
            }
          : current,
      );
  }

  async function addRow() {
    if (!table) return;
    const result = await mutation<{ row: TableRow }>(
      `/api/tables/${page.id}/rows`,
      "POST",
      {},
      () => rowCountRef.current,
      () => {
        rowCountRef.current += 1;
      },
    );
    if (result) setTable((current) => (current ? { ...current, rows: [...current.rows, result.row] } : current));
  }

  async function removeRow(row: TableRow) {
    const result = await mutation(`/api/tables/${page.id}/rows/${row.id}`, "DELETE", {}, undefined, () => {
      rowCountRef.current = Math.max(0, rowCountRef.current - 1);
    });
    if (result)
      setTable((current) =>
        current ? { ...current, rows: current.rows.filter((item) => item.id !== row.id) } : current,
      );
  }

  async function setCell(rowId: string, columnId: string, value: string | number | boolean | null) {
    const result = await mutation(`/api/tables/${page.id}/cells/${rowId}/${columnId}`, "PUT", { value });
    if (result)
      setTable((current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((row) =>
                row.id === rowId ? { ...row, cells: { ...row.cells, [columnId]: value } } : row,
              ),
            }
          : current,
      );
  }

  const visibleRows = useMemo(() => {
    if (!table) return [];
    const normalized = filter.toLowerCase();
    const rows = normalized
      ? table.rows.filter((row) =>
          Object.values(row.cells).some((value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(normalized),
          ),
        )
      : [...table.rows];
    if (sortColumn)
      rows.sort((left, right) =>
        String(left.cells[sortColumn] ?? "").localeCompare(String(right.cells[sortColumn] ?? ""), undefined, {
          numeric: true,
        }),
      );
    return rows;
  }, [filter, sortColumn, table]);
  const tryAcquire = async () => {
    await acquire(isMounted).catch(reportLeaseError);
  };

  const forceUnlock = () =>
    runLeaseAction(isMounted, async () => {
      try {
        await api(`/api/tables/${page.id}/force-unlock`, {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        if (isMounted()) setLeaseError(errorMessage(cause, "The table could not be force-unlocked."));
        return;
      }
      if (!isMounted()) return;
      await performAcquire(isMounted).catch(reportLeaseError);
    });

  return (
    <main className="page-canvas table-canvas">
      <div className="page-tools">
        <span className={`lease-state ${leaseToken ? "lease-active" : ""}`}>
          {leaseToken ? "Editing lease active" : "Read-only"}
        </span>
        {canEdit && (
          <button
            className="quiet-button"
            onClick={async () => {
              const icon = prompt("Page icon (one emoji, or leave blank to remove)", page.icon ?? "")?.trim();
              if (icon === undefined) return;
              const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
                method: "PATCH",
                body: json({ icon: icon || null, revision: page.revision }),
              });
              onPageChanged(result.page);
            }}
          >
            {page.icon ?? "Add icon"}
          </button>
        )}
        {!leaseToken && canEdit && (
          <button className="quiet-button" disabled={leasePending} onClick={() => void tryAcquire()}>
            Try edit lock
          </button>
        )}
        {member.role === "owner" && !leaseToken && (
          <button className="quiet-button" disabled={leasePending} onClick={() => void forceUnlock()}>
            Force unlock
          </button>
        )}
        <button className="quiet-button" onClick={() => setBacklinksOpen((open) => !open)}>
          Backlinks
        </button>
      </div>
      {leaseError && <div className="notice">{leaseError}</div>}
      {loadError && <div className="notice notice-danger">{loadError}</div>}
      <article className="table-paper">
        <input
          className="page-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          readOnly={!canEdit}
        />
        <div className="table-toolbar">
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter rows…" />
          <span>
            {visibleRows.length} / {table?.rows.length ?? 0} rows
          </span>
          {leaseToken && <button onClick={() => void addColumn()}>+ Property</button>}
        </div>
        {!table ? (
          <div className="editor-loading">Loading table…</div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th key={column.id}>
                      <button
                        className="column-sort"
                        onClick={() => setSortColumn(sortColumn === column.id ? null : column.id)}
                      >
                        {column.name} <small>{column.type}</small>
                        {sortColumn === column.id ? " ↑" : ""}
                      </button>
                      {leaseToken && column.type === "select" && (
                        <button
                          className="add-option"
                          onClick={() => void addOption(column)}
                          aria-label={`Add option to ${column.name}`}
                        >
                          +
                        </button>
                      )}
                      {leaseToken && (
                        <button
                          className="delete-column"
                          onClick={() => void removeColumn(column)}
                          aria-label={`Delete ${column.name}`}
                        >
                          ×
                        </button>
                      )}
                    </th>
                  ))}
                  {leaseToken && <th className="row-actions" aria-label="Row actions" />}
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
                    {leaseToken && (
                      <td className="row-actions">
                        <button onClick={() => void removeRow(row)} aria-label="Delete row">
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {leaseToken && (
              <button className="add-row" onClick={() => void addRow()} disabled={table.rows.length >= 500}>
                + New row
              </button>
            )}
            {!table.columns.length && <p className="empty-copy">Add a property to start this table.</p>}
          </div>
        )}
      </article>
      {backlinksOpen && <BacklinksPanel pageId={page.id} revision={backlinksRevision} onSelect={onSelectPage} />}
    </main>
  );
}

function CellInput({
  column,
  value,
  disabled,
  onCommit,
}: {
  column: TableColumn;
  value: string | number | boolean | null;
  disabled: boolean;
  onCommit: (value: string | number | boolean | null) => void;
}) {
  if (column.type === "checkbox") {
    return (
      <input
        aria-label={column.name}
        type="checkbox"
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.checked)}
      />
    );
  }
  if (column.type === "select") {
    return (
      <select
        aria-label={column.name}
        value={String(value ?? "")}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.value || null)}
      >
        <option value="">—</option>
        {column.options.map((option) => (
          <option value={option.id} key={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={column.name}
      type={column.type === "number" ? "number" : column.type === "date" ? "date" : "text"}
      defaultValue={value === null ? "" : String(value)}
      disabled={disabled}
      onBlur={(event) =>
        onCommit(
          column.type === "number"
            ? event.target.value === ""
              ? null
              : Number(event.target.value)
            : event.target.value || null,
        )
      }
    />
  );
}
