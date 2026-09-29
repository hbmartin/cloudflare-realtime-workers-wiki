import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ClientMemberContext, Page, TableData, TableLeaseResponse, TableLeaseTiming } from "../shared/types";
import { TASK_STATUSES, TASK_STATUS_LABELS, type Task, type TaskFields, type TaskResponse } from "../shared/tasks";
import { PAGE_TITLE_MAX } from "../shared/validation";
import { api, ApiClientError, apiErrorMessage, json } from "./api";
import { ActionMenu, Icon, PageTools, readPreference, savePreference } from "./WorkspaceUI";

type Person = { id: string; name: string };
type Change = Partial<TaskFields> & { archived?: boolean };
const AUTO_REFRESH_PAGE_LIMIT = 2;
const REQUEST_TIMEOUT_MS = 15_000;

function taskApi<T>(path: string, init?: RequestInit) {
  return api<T>(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

const taskBucket = (task: Task) => (task.status === "done" ? 2 : task.dueDate ? 0 : 1);
const taskDueSort = (task: Task) => (task.status === "done" ? "" : (task.dueDate ?? ""));

function taskOrder(a: Task, b: Task, list: boolean) {
  if (list) return a.position - b.position || a.id.localeCompare(b.id);
  return (
    taskBucket(a) - taskBucket(b) ||
    taskDueSort(a).localeCompare(taskDueSort(b)) ||
    b.updatedAt - a.updatedAt ||
    a.id.localeCompare(b.id)
  );
}

function matchesTask(
  task: Task,
  filters: { pageId?: string; status: string; due: string; query: string; userId: string },
) {
  if (filters.pageId ? task.listId !== filters.pageId : task.assigneeId !== filters.userId) return false;
  if (filters.status && task.status !== filters.status) return false;
  if (filters.query && !task.title.toLowerCase().includes(filters.query.toLowerCase())) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (filters.due === "today" && task.dueDate !== today) return false;
  if (filters.due === "undated" && task.dueDate !== null) return false;
  if (filters.due === "overdue" && !(task.dueDate && task.dueDate < today && task.status !== "done")) return false;
  return true;
}

export function TasksView({
  page,
  member,
  metadata,
  onSelectPage,
  onPageChanged,
  refreshVersion = 0,
  forceRefreshVersion = 0,
  onTaskOperationStart,
  onTaskOperationSettled,
}: {
  page?: Page;
  member: ClientMemberContext;
  metadata?: ReactNode;
  onSelectPage: (id: string) => void;
  onPageChanged?: (page: Page) => void;
  refreshVersion?: number;
  forceRefreshVersion?: number;
  onTaskOperationStart?: (operationId: string, pageId: string) => void;
  onTaskOperationSettled?: (operationId: string, reconciled: boolean) => void;
}) {
  const [data, setData] = useState<TaskResponse>({ tasks: [], hasMore: false, nextCursor: null });
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const [mode, setMode] = useState<"table" | "board">(() =>
    readPreference(`notes:tasks-view:${member.user.id}:${page?.id ?? "mine"}`, "table"),
  );
  const [status, setStatus] = useState("");
  const [due, setDue] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<{ owner: "load" | "save" | "lease" | "title"; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(1);
  const revisionRef = useRef(revision);
  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);
  const [members, setMembers] = useState<Record<string, Person[]>>({});
  const membersRef = useRef<Record<string, Person[]>>({});
  const [newTitle, setNewTitle] = useState("");
  const retryRef = useRef<(() => Promise<boolean>) | null>(null);
  const [lease, setLease] = useState<string | null>(null);
  const leaseRef = useRef<string | null>(null);
  const leaseExpiresAtRef = useRef(0);
  const [holder, setHolder] = useState<string | null>(null);
  const generation = useRef(0);
  const activeLoad = useRef<number | null>(null);
  const loadedPageCount = useRef(1);
  const eventEpoch = useRef(0);
  const queuedAutoRefresh = useRef(false);
  const queuedForceRefresh = useRef(false);
  const paginationDirty = useRef(false);
  const taskReadVersion = useRef(new Map<string, number>());
  const [updatesAvailable, setUpdatesAvailable] = useState(false);
  const active = useRef(true);
  const pageId = page?.id;
  const filterKey = JSON.stringify([pageId, status, due, query.trim()]);
  const filterKeyRef = useRef(filterKey);
  const viewEpoch = useRef(0);
  if (filterKeyRef.current !== filterKey) {
    filterKeyRef.current = filterKey;
    viewEpoch.current++;
  }
  const filtersRef = useRef({ pageId, status, due, query: query.trim(), userId: member.user.id });
  filtersRef.current = { pageId, status, due, query: query.trim(), userId: member.user.id };
  const editable = page ? member.role !== "viewer" : true;
  const key = `notes:tasks-view:${member.user.id}:${page?.id ?? "mine"}`;
  useEffect(() => {
    savePreference(key, mode);
  }, [key, mode]);
  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      if (cursor && paginationDirty.current) {
        await load();
        if (paginationDirty.current) return;
        const next = dataRef.current.nextCursor;
        if (next && filterKeyRef.current === filterKey) await load(next);
        return;
      }
      const request = ++generation.current;
      activeLoad.current = request;
      const startingEventEpoch = eventEpoch.current;
      const requestedFilterKey = filterKey;
      setLoading(true);
      const params = new URLSearchParams(pageId ? { listId: pageId } : { mine: "true" });
      if (status) params.set("status", status);
      if (due) params.set("due", due);
      if (query.trim()) params.set("q", query.trim());
      try {
        const tasks = cursor ? [...dataRef.current.tasks] : [];
        const seen = new Map(tasks.map((task, index) => [task.id, index]));
        const pagesToFetch = cursor ? 1 : loadedPageCount.current;
        let nextCursor = cursor;
        let result: TaskResponse = { tasks: [], hasMore: false, nextCursor: null };
        let fetchedPages = 0;
        for (let index = 0; index < pagesToFetch; index++) {
          if (nextCursor) params.set("cursor", nextCursor);
          else params.delete("cursor");
          result = await taskApi<TaskResponse>(`/api/tasks?${params}`);
          if (!active.current || request !== generation.current || requestedFilterKey !== filterKeyRef.current) return;
          fetchedPages++;
          for (const task of result.tasks) {
            const existing = seen.get(task.id);
            if (existing === undefined) {
              seen.set(task.id, tasks.length);
              tasks.push(task);
            } else if (
              task.updatedAt > tasks[existing]!.updatedAt ||
              (task.updatedAt === tasks[existing]!.updatedAt && task.revision > tasks[existing]!.revision)
            )
              tasks[existing] = task;
          }
          if (!result.hasMore || !result.nextCursor) break;
          nextCursor = result.nextCursor;
        }
        if (pageId) {
          const response = await taskApi<{ table: TableData }>(`/api/tables/${pageId}?limit=1`);
          if (!active.current || request !== generation.current || requestedFilterKey !== filterKeyRef.current) return;
          setRevision(response.table.revision);
          revisionRef.current = response.table.revision;
          setHolder(response.table.lease.holderName);
        }
        const ids = [...new Set(tasks.map((task) => task.listId)), ...(pageId ? [pageId] : [])];
        const entries = await Promise.all(
          [...new Set(ids)]
            .filter((id) => !(id in membersRef.current))
            .map(async (id) => {
              try {
                const people = await taskApi<{ members: Person[] }>(`/api/task-lists/${id}/assignees`);
                return [id, people.members] as const;
              } catch (cause) {
                if (cause instanceof ApiClientError && cause.status === 404) return [id, null] as const;
                throw cause;
              }
            }),
        );
        if (active.current && request === generation.current && requestedFilterKey === filterKeyRef.current) {
          const missing = new Set(entries.filter((entry) => entry[1] === null).map((entry) => entry[0]));
          const refreshed = {
            tasks: tasks.filter((task) => !missing.has(task.listId)),
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
          };
          loadedPageCount.current = cursor ? loadedPageCount.current + 1 : fetchedPages;
          dataRef.current = refreshed;
          setData(refreshed);
          membersRef.current = {
            ...membersRef.current,
            ...Object.fromEntries(entries.filter((entry) => entry[1] !== null)),
          };
          setMembers(membersRef.current);
          if (!cursor) paginationDirty.current = false;
          setError((current) => (current?.owner === "load" ? null : current));
          if (!cursor && startingEventEpoch === eventEpoch.current) setUpdatesAvailable(false);
        }
      } catch (cause) {
        if (
          active.current &&
          request === generation.current &&
          requestedFilterKey === filterKeyRef.current &&
          !retryRef.current
        ) {
          retryRef.current = null;
          setError({ owner: "load", message: apiErrorMessage(cause, "Tasks could not be loaded.") });
        }
      } finally {
        if (activeLoad.current === request) activeLoad.current = null;
        if (active.current && request === generation.current) setLoading(false);
      }
    },
    [pageId, status, due, query, filterKey],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    active.current = true;
    loadedPageCount.current = 1;
    paginationDirty.current = false;
    eventEpoch.current++;
    queuedAutoRefresh.current = false;
    queuedForceRefresh.current = false;
    const timer = setTimeout(() => void load(), 150);
    return () => {
      clearTimeout(timer);
      // This counter invalidates an in-flight request, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !busy &&
        !loading &&
        activeLoad.current === null &&
        loadedPageCount.current <= AUTO_REFRESH_PAGE_LIMIT
      )
        void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [load, busy, loading]);
  useEffect(() => {
    if (busy || loading) return;
    if (queuedForceRefresh.current) {
      queuedForceRefresh.current = false;
      queuedAutoRefresh.current = false;
      void load();
      return;
    }
    if (!queuedAutoRefresh.current) return;
    queuedAutoRefresh.current = false;
    if (loadedPageCount.current > AUTO_REFRESH_PAGE_LIMIT) {
      paginationDirty.current = true;
      setUpdatesAvailable(true);
    } else void load();
  }, [busy, loading, load]);
  const observedRefreshVersion = useRef(refreshVersion);
  useEffect(() => {
    if (refreshVersion === observedRefreshVersion.current) return;
    observedRefreshVersion.current = refreshVersion;
    eventEpoch.current++;
    if (busy || activeLoad.current !== null) {
      queuedAutoRefresh.current = true;
      setUpdatesAvailable(true);
    } else if (loadedPageCount.current > AUTO_REFRESH_PAGE_LIMIT) {
      paginationDirty.current = true;
      setUpdatesAvailable(true);
    } else void load();
  }, [busy, load, refreshVersion]);
  const observedForceVersion = useRef(forceRefreshVersion);
  useEffect(() => {
    if (forceRefreshVersion === observedForceVersion.current) return;
    observedForceVersion.current = forceRefreshVersion;
    eventEpoch.current++;
    if (busy || activeLoad.current !== null) queuedForceRefresh.current = true;
    else void load();
  }, [busy, forceRefreshVersion, load]);
  const release = useCallback(
    (token: string) => {
      if (pageId)
        void taskApi(`/api/tables/${pageId}/lease`, {
          method: "DELETE",
          body: json({ leaseToken: token }),
          keepalive: true,
        }).catch(() => undefined);
    },
    [pageId],
  );
  const refreshLease = useCallback(async () => {
    if (!pageId) return;
    try {
      const response = await taskApi<{ lease: TableData["lease"] }>(`/api/task-lists/${pageId}/lease`);
      if (active.current && filtersRef.current.pageId === pageId) {
        setHolder(response.lease.holderName);
        if (leaseRef.current && !response.lease.heldByMe) {
          leaseRef.current = null;
          leaseExpiresAtRef.current = 0;
          setLease(null);
          setError({ owner: "lease", message: "The edit lock expired. Acquire it again to continue." });
        }
      }
    } catch (cause) {
      if (
        active.current &&
        filtersRef.current.pageId === pageId &&
        cause instanceof ApiClientError &&
        cause.status === 404
      )
        setHolder(null);
    }
  }, [pageId]);
  useEffect(() => {
    if (!pageId) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void refreshLease();
    }, 30_000);
    return () => clearInterval(timer);
  }, [pageId, refreshLease]);
  useEffect(
    () => () => {
      active.current = false;
      generation.current++;
      if (leaseRef.current) release(leaseRef.current);
      leaseRef.current = null;
      leaseExpiresAtRef.current = 0;
    },
    [release],
  );
  useEffect(() => {
    if (!lease || !pageId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(() => void renew(), delay);
    };
    const loseLease = (cause: unknown) => {
      if (!active.current || leaseRef.current !== lease) return;
      leaseRef.current = null;
      leaseExpiresAtRef.current = 0;
      setLease(null);
      setError({
        owner: "lease",
        message: apiErrorMessage(cause, "The edit lock expired. Acquire it again to continue."),
      });
    };
    const renew = async () => {
      try {
        const result = await taskApi<TableLeaseTiming>(`/api/tables/${pageId}/lease`, {
          method: "PATCH",
          body: json({ leaseToken: lease }),
        });
        if (cancelled || leaseRef.current !== lease) return;
        leaseExpiresAtRef.current = Date.now() + result.leaseDurationMs;
        setError((current) => (current?.owner === "lease" ? null : current));
        schedule(20_000);
      } catch (cause) {
        if (cancelled || leaseRef.current !== lease) return;
        const authoritative = cause instanceof ApiClientError && [401, 403, 404, 409].includes(cause.status);
        if (authoritative || Date.now() + 5_000 >= leaseExpiresAtRef.current) loseLease(cause);
        else schedule(5_000);
      }
    };
    schedule(20_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lease, pageId]);
  async function toggleLease() {
    if (!page) return;
    const leasePageId = page.id;
    if (lease) {
      release(lease);
      leaseRef.current = null;
      leaseExpiresAtRef.current = 0;
      setLease(null);
      setHolder(null);
      void refreshLease();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await taskApi<TableLeaseResponse>(`/api/tables/${leasePageId}/lease`, { method: "POST" });
      if (!active.current || filtersRef.current.pageId !== leasePageId) {
        release(result.leaseToken);
        return;
      }
      leaseRef.current = result.leaseToken;
      leaseExpiresAtRef.current = Date.now() + result.leaseDurationMs;
      setLease(result.leaseToken);
      setHolder(null);
    } catch (cause) {
      if (active.current && filtersRef.current.pageId === leasePageId) {
        await refreshLease();
        setError({
          owner: "lease",
          message: apiErrorMessage(cause, "This task list is being edited. Try again when it is available."),
        });
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function save(task: Task | null, changes: Change, operationId = crypto.randomUUID()): Promise<boolean> {
    const listId = task?.listId ?? page?.id;
    if (!listId) return false;
    const startedViewEpoch = viewEpoch.current;
    const startedFilterKey = filterKeyRef.current;
    const current = task ? (dataRef.current.tasks.find((item) => item.id === task.id) ?? task) : null;
    const readVersion = task ? (taskReadVersion.current.get(task.id) ?? 0) + 1 : 1;
    if (task) taskReadVersion.current.set(task.id, readVersion);
    const expectedRevision = page ? revisionRef.current : current!.revision;
    setBusy(true);
    setError(null);
    retryRef.current = () => save(task, changes, operationId);
    onTaskOperationStart?.(operationId, listId);
    try {
      const result = await taskApi<{ revision: number; rowId: string; detailPageId: string }>(
        `/api/task-lists/${listId}/tasks${task ? `/${task.id}` : ""}`,
        {
          method: task ? "PATCH" : "POST",
          body: json({
            ...changes,
            operationId,
            expectedRevision,
            ...(leaseRef.current ? { leaseToken: leaseRef.current } : {}),
          }),
        },
      );
      if (!active.current || viewEpoch.current !== startedViewEpoch) {
        onTaskOperationSettled?.(operationId, false);
        return true;
      }
      // A list load that started before this mutation can contain stale rows.
      const needsReload = activeLoad.current !== null || filterKeyRef.current !== startedFilterKey;
      generation.current++;
      setLoading(false);
      setRevision(result.revision);
      revisionRef.current = result.revision;
      const revised = {
        ...dataRef.current,
        tasks: dataRef.current.tasks.map((item) =>
          item.listId === listId ? { ...item, revision: result.revision } : item,
        ),
      };
      dataRef.current = revised;
      setData(revised);
      retryRef.current = null;
      setError(null);
      setBusy(false);
      paginationDirty.current = true;
      if (needsReload) void loadRef.current();
      if (changes.archived === true && task) {
        const remaining = { ...dataRef.current, tasks: dataRef.current.tasks.filter((item) => item.id !== task.id) };
        dataRef.current = remaining;
        setData(remaining);
        onTaskOperationSettled?.(operationId, true);
        return true;
      }
      const rowId = result.rowId;
      if (!task) taskReadVersion.current.set(rowId, readVersion);
      const reconcile = async () => {
        const response = await taskApi<TaskResponse>(`/api/tasks?rowId=${encodeURIComponent(rowId)}`);
        const assignees =
          listId in membersRef.current
            ? null
            : await taskApi<{ members: Person[] }>(`/api/task-lists/${listId}/assignees`);
        if (
          !active.current ||
          viewEpoch.current !== startedViewEpoch ||
          taskReadVersion.current.get(rowId) !== readVersion
        )
          return false;
        if (assignees) {
          membersRef.current = { ...membersRef.current, [listId]: assignees.members };
          setMembers(membersRef.current);
        }
        const found = response.tasks.find((item) => item.id === rowId);
        const currentListRevision = Math.max(
          result.revision,
          ...dataRef.current.tasks.filter((item) => item.listId === listId).map((item) => item.revision),
        );
        const authoritative = found ? { ...found, revision: Math.max(found.revision, currentListRevision) } : null;
        const tasks = dataRef.current.tasks.filter((item) => item.id !== rowId);
        if (authoritative && matchesTask(authoritative, filtersRef.current)) tasks.push(authoritative);
        tasks.sort((a, b) => taskOrder(a, b, Boolean(filtersRef.current.pageId)));
        const updated = { ...dataRef.current, tasks };
        dataRef.current = updated;
        setData(updated);
        return true;
      };
      try {
        const reconciled = await reconcile();
        onTaskOperationSettled?.(operationId, reconciled);
      } catch (cause) {
        onTaskOperationSettled?.(operationId, false);
        retryRef.current = async () => {
          try {
            const refreshed = await reconcile();
            if (refreshed) {
              retryRef.current = null;
              setError(null);
            }
            return refreshed;
          } catch {
            return false;
          }
        };
        setError({ owner: "load", message: apiErrorMessage(cause, "The task was saved, but could not be refreshed.") });
      }
      return true;
    } catch (cause) {
      onTaskOperationSettled?.(operationId, false);
      if (active.current && viewEpoch.current === startedViewEpoch) {
        setError({
          owner: "save",
          message: apiErrorMessage(cause, "The task could not be saved. Your change is ready to retry."),
        });
        // A timed-out mutation may have committed; its operation ID remains safe to retry.
      }
      return false;
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const ready = editable && (!page || Boolean(lease));
  const controls = (task: Task) => (
    <TaskControls
      key={`${task.id}:${task.dueDate ?? ""}`}
      task={task}
      members={members[task.listId] ?? []}
      disabled={busy || !ready || !task.editable}
      onChange={(changes) => void save(task, changes)}
    />
  );
  return (
    <main className={page ? "page-canvas tasks-canvas" : "utility-view tasks-canvas"}>
      {page && (
        <PageTools>
          <output className="lease-state">
            {lease ? "Editing tasks" : holder ? `${holder} is editing` : "Read-only"}
          </output>
          {editable && (
            <button className="quiet-button" disabled={busy} onClick={() => void toggleLease()}>
              {lease ? "Finish editing" : "Edit tasks"}
            </button>
          )}
        </PageTools>
      )}
      {page ? (
        <input
          className="page-title"
          aria-label="Page title"
          defaultValue={page.title}
          key={`${page.id}:${page.title}`}
          readOnly={!editable}
          onBlur={(event) => {
            const title = event.target.value.trim() || "Untitled tasks";
            if (title !== page.title)
              void taskApi<{ page: Page }>(`/api/pages/${page.id}`, {
                method: "PATCH",
                body: json({ title, revision: page.revision }),
              })
                .then((result) => onPageChanged?.(result.page))
                .catch((cause) => {
                  retryRef.current = null;
                  setError({ owner: "title", message: apiErrorMessage(cause, "Title could not be saved.") });
                });
          }}
        />
      ) : (
        <>
          <p className="eyebrow">Across your spaces</p>
          <h1>My Tasks</h1>
        </>
      )}
      {metadata}
      <div className="task-toolbar">
        <div className="view-switch">
          <button aria-pressed={mode === "table"} onClick={() => setMode("table")}>
            <Icon name="table" />
            Table
          </button>
          <button aria-pressed={mode === "board"} onClick={() => setMode("board")}>
            <Icon name="tasks" />
            Board
          </button>
        </div>
        <input
          aria-label="Find tasks"
          placeholder="Find tasks…"
          value={query}
          onChange={(event) => {
            loadedPageCount.current = 1;
            setQuery(event.target.value);
            setUpdatesAvailable(false);
          }}
        />
        <select
          aria-label="Task status filter"
          value={status}
          onChange={(event) => {
            loadedPageCount.current = 1;
            setStatus(event.target.value);
            setUpdatesAvailable(false);
          }}
        >
          <option value="">All statuses</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Task due date filter"
          value={due}
          onChange={(event) => {
            loadedPageCount.current = 1;
            setDue(event.target.value);
            setUpdatesAvailable(false);
          }}
        >
          <option value="">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today (UTC)</option>
          <option value="undated">No due date</option>
        </select>
        <button className="quiet-button" disabled={loading} onClick={() => void load()}>
          Refresh
        </button>
        {(loadedPageCount.current > AUTO_REFRESH_PAGE_LIMIT || updatesAvailable) && (
          <output className="muted">
            {updatesAvailable
              ? "Updates available. Refresh tasks to see them."
              : "Automatic updates paused for this long view. Refresh to check for changes."}
          </output>
        )}
      </div>
      {error && (
        <div className="notice notice-danger" role="alert">
          {error.message}
          <button
            className="quiet-button"
            disabled={busy || loading}
            onClick={() => {
              if (retryRef.current) void retryRef.current();
              else void load();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {page && editable && (
        <form
          className="new-task-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (newTitle.trim())
              void save(null, { title: newTitle.trim() }).then((ok) => {
                if (ok) setNewTitle("");
              });
          }}
        >
          <input
            aria-label="New task title"
            placeholder={lease ? "Add a task…" : "Choose Edit tasks to add a task"}
            value={newTitle}
            disabled={!ready || busy}
            onChange={(event) => setNewTitle(event.target.value)}
            maxLength={PAGE_TITLE_MAX}
          />
          <button type="submit" className="primary-small" disabled={!ready || busy || !newTitle.trim()}>
            Add task
          </button>
        </form>
      )}
      {mode === "table" ? (
        <div className="data-table-wrap">
          <table className="data-table task-table">
            <thead>
              <tr>
                <th>Task</th>
                {!page && <th>Project</th>}
                <th>Assignee · Status · Due date</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <button className="task-title" onClick={() => onSelectPage(task.detailPageId)}>
                      {task.title}
                    </button>
                  </td>
                  {!page && (
                    <td>
                      <button className="quiet-button" onClick={() => onSelectPage(task.listId)}>
                        {task.listTitle}
                      </button>
                    </td>
                  )}
                  <td>{controls(task)}</td>
                  <td aria-label={`Actions for ${task.title}`}>
                    <ActionMenu label={`Actions for ${task.title}`}>
                      <button data-close-menu onClick={() => onSelectPage(task.detailPageId)}>
                        Open details & comments
                      </button>
                      <button
                        disabled={!ready || busy || !task.editable}
                        onClick={() => {
                          const title = prompt("Task title", task.title);
                          if (title?.trim()) void save(task, { title: title.trim() });
                        }}
                      >
                        Rename
                      </button>
                      <button
                        disabled={!ready || busy || !task.editable}
                        data-close-menu
                        onClick={() => void save(task, { archived: true })}
                      >
                        Move to trash
                      </button>
                    </ActionMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="task-board">
          {TASK_STATUSES.map((s) => (
            // Drag/drop supplements the keyboard-accessible status select on every card.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
            <section
              key={s}
              className="task-column"
              aria-label={TASK_STATUS_LABELS[s]}
              onDragOver={(event) => {
                if (ready && !busy) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const task = data.tasks.find((t) => t.id === event.dataTransfer.getData("text/task-id"));
                if (task && ready && task.editable && !busy && task.status !== s) void save(task, { status: s });
              }}
            >
              <h2>
                {TASK_STATUS_LABELS[s]} <span>{data.tasks.filter((t) => t.status === s).length}</span>
              </h2>
              {data.tasks
                .filter((t) => t.status === s)
                .map((task) => (
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                  <article
                    key={task.id}
                    className="task-card"
                    draggable={ready && !busy && task.editable}
                    onDragStart={(event) => event.dataTransfer.setData("text/task-id", task.id)}
                  >
                    <button className="task-title" onClick={() => onSelectPage(task.detailPageId)}>
                      {task.title}
                    </button>
                    {!page && (
                      <button className="task-project" onClick={() => onSelectPage(task.listId)}>
                        {task.listTitle}
                      </button>
                    )}
                    {controls(task)}
                  </article>
                ))}
            </section>
          ))}
        </div>
      )}
      {loading && <output className="muted">Loading tasks…</output>}
      {!loading && !data.tasks.length && (
        <p className="empty-copy">
          {page
            ? "No tasks match this view."
            : "No assigned tasks match this view. Tasks assigned to you will appear here."}
        </p>
      )}
      {data.hasMore && data.nextCursor && (
        <button className="quiet-button" disabled={loading} onClick={() => void load(data.nextCursor!)}>
          Load more tasks
        </button>
      )}
    </main>
  );
}

function TaskControls({
  task,
  members,
  disabled,
  onChange,
}: {
  task: Task;
  members: Person[];
  disabled: boolean;
  onChange: (change: Change) => void;
}) {
  const [dueDraft, setDueDraft] = useState(task.dueDate ?? "");
  const commitDueDate = () => {
    const current = task.dueDate ?? "";
    if (dueDraft !== current) onChange({ dueDate: dueDraft || null });
  };
  const currentAssignee =
    task.assigneeId && !members.some((member) => member.id === task.assigneeId)
      ? { id: task.assigneeId, name: task.assigneeName ?? "Former member" }
      : null;
  return (
    <div className="task-fields">
      <select
        aria-label={`Assignee for ${task.title}`}
        value={task.assigneeId ?? ""}
        disabled={disabled}
        onChange={(event) => onChange({ assigneeId: event.target.value || null })}
      >
        <option value="">Unassigned</option>
        {currentAssignee && <option value={currentAssignee.id}>{currentAssignee.name}</option>}
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <select
        aria-label={`Status for ${task.title}`}
        value={task.status}
        disabled={disabled}
        onChange={(event) => onChange({ status: event.target.value as TaskFields["status"] })}
      >
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {TASK_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <input
        type="date"
        aria-label={`Due date for ${task.title}`}
        value={dueDraft}
        disabled={disabled}
        onChange={(event) => setDueDraft(event.target.value)}
        onBlur={commitDueDate}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitDueDate();
          }
          if (event.key === "Escape") {
            setDueDraft(task.dueDate ?? "");
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
