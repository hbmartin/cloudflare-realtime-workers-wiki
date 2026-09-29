// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext, Page } from "../shared/types";
import type { Task, TaskResponse } from "../shared/tasks";
import { api, ApiClientError } from "./api";
import { TasksView } from "./TasksView";
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
const member: ClientMemberContext = {
  role: "editor",
  user: { id: "me", name: "Alex", email: "alex@example.test" },
  workspace: { id: "workspace", name: "Notes", locationHint: null },
};
const page: Page = {
  id: "list",
  workspaceId: "workspace",
  spaceId: "general",
  kind: "table",
  taskList: true,
  title: "Release",
  parentId: null,
  position: "a0",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};
const fixture: Task = {
  id: "task",
  listId: "list",
  listTitle: "Release",
  spaceId: "general",
  title: "Ship release",
  assigneeId: "me",
  assigneeName: "Alex",
  status: "todo",
  dueDate: null,
  detailPageId: "details",
  revision: 1,
  updatedAt: 1,
  position: 0,
  editable: true,
};
let task: Task;
let blocked: boolean;
let revision: number;
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  task = { ...fixture };
  blocked = false;
  revision = 1;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path.startsWith("/api/tasks?")) return { tasks: [task], hasMore: false, nextCursor: null };
    if (path === "/api/tables/list?limit=1") return { table: { revision, lease: { holderName: null } } };
    if (path === "/api/task-lists/list/assignees") return { members: [{ id: "me", name: "Alex" }] };
    if (path === "/api/task-lists/list/lease") return { lease: { holderName: null, heldByMe: false, expiresAt: null } };
    if (path === "/api/tables/list/lease") return { leaseToken: "lease", leaseDurationMs: 60000 };
    if (path === "/api/task-lists/list/tasks/task") {
      if (blocked)
        throw new ApiClientError(409, "lease_conflict", "Another editor holds this table. Retry when they finish.");
      const change = JSON.parse(String(init?.body)) as Partial<Task>;
      task = { ...task, ...change, revision: ++revision, updatedAt: task.updatedAt + 1 };
      return { revision, rowId: task.id, detailPageId: task.detailPageId };
    }
    throw new Error(`Unexpected ${path}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("task views", () => {
  it("uses a lease for edits, preserves values on the board, and releases when leaving", async () => {
    const select = vi.fn();
    const view = render(<TasksView page={page} member={member} onSelectPage={select} />);
    expect(await screen.findByLabelText("Status for Ship release")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit tasks" }));
    await waitFor(() => expect(screen.getByLabelText("Status for Ship release")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Status for Ship release"), { target: { value: "doing" } });
    await waitFor(() => expect(screen.getByLabelText("Status for Ship release")).toHaveValue("doing"));
    const mutation = vi.mocked(api).mock.calls.find(([path]) => path.endsWith("/tasks/task"));
    expect(JSON.parse(String(mutation?.[1]?.body))).toMatchObject({
      status: "doing",
      leaseToken: "lease",
      expectedRevision: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(
      within(screen.getByRole("region", { name: "In progress" })).getByRole("button", { name: "Ship release" }),
    );
    expect(select).toHaveBeenCalledWith("details");
    view.unmount();
    expect(api).toHaveBeenCalledWith(
      "/api/tables/list/lease",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
  });
  it("retries a blocked My Tasks update with the same operation ID and current revision", async () => {
    blocked = true;
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Status for Ship release"), { target: { value: "done" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Another editor");
    blocked = false;
    task = { ...task, revision: 2 };
    revision = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("Another editor");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    const writes = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path.endsWith("/tasks/task"))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ operationId: writes[0]!.operationId, status: "done", expectedRevision: 2 });
  });
  it("preserves a failed save and its retry when reconciliation also fails", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    let rejectLoads = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (rejectLoads && path.startsWith("/api/tasks?"))
        throw new ApiClientError(503, "tasks_unavailable", "Refresh failed.");
      return original(path, init);
    });
    blocked = true;
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    const status = await screen.findByLabelText("Status for Ship release");
    rejectLoads = true;
    fireEvent.change(status, { target: { value: "done" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Another editor");
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled());
    expect(screen.getByRole("alert")).not.toHaveTextContent("Refresh failed");

    blocked = false;
    rejectLoads = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    const writes = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path.endsWith("/tasks/task"))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ operationId: writes[0]!.operationId, status: "done" });
  });
  it("abandons an older task retry when saving the list title fails", async () => {
    blocked = true;
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit tasks" }));
    const status = await screen.findByLabelText("Status for Ship release");
    await waitFor(() => expect(status).toBeEnabled());
    fireEvent.change(status, { target: { value: "done" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Another editor");
    const taskWritesBeforeTitle = vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("/tasks/task")).length;
    const loadsBeforeRetry = vi.mocked(api).mock.calls.filter(([path]) => path.startsWith("/api/tasks?")).length;

    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Renamed list" } });
    fireEvent.blur(screen.getByLabelText("Page title"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Title could not be saved");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.filter(([path]) => path.startsWith("/api/tasks?")).length).toBeGreaterThan(
        loadsBeforeRetry,
      ),
    );
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("/tasks/task"))).toHaveLength(
      taskWritesBeforeTitle,
    );
  });
  it("uses submit semantics and the shared page-title limit for new tasks", async () => {
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit tasks" }));
    await waitFor(() => expect(screen.getByLabelText("New task title")).toBeEnabled());
    expect(screen.getByLabelText("New task title")).toHaveAttribute("maxlength", "200");
    expect(screen.getByRole("button", { name: "Add task" })).toHaveAttribute("type", "submit");
  });
  it("commits a due date only after the date edit is complete", async () => {
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit tasks" }));
    const due = await screen.findByLabelText("Due date for Ship release");
    await waitFor(() => expect(due).toBeEnabled());
    fireEvent.focus(due);
    fireEvent.change(due, { target: { value: "2027-04-09" } });
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("/tasks/task"))).toHaveLength(0);
    fireEvent.keyDown(due, { key: "Enter" });
    await waitFor(() =>
      expect(
        JSON.parse(String(vi.mocked(api).mock.calls.find(([path]) => path.endsWith("/tasks/task"))?.[1]?.body)),
      ).toMatchObject({ dueDate: "2027-04-09" }),
    );
  });
  it("shows an inaccessible current assignee until the user changes it", async () => {
    task = { ...task, assigneeId: "former", assigneeName: null };
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    expect(await screen.findByLabelText("Assignee for Ship release")).toHaveValue("former");
    expect(screen.getByRole("option", { name: "Former member" })).toHaveValue("former");
  });
  it("rebuilds pagination before loading more after archiving", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const later = { ...fixture, id: "later", title: "Later task", detailPageId: "later-details" };
    const next = { ...fixture, id: "next", title: "Next task", detailPageId: "next-details" };
    const final = { ...fixture, id: "final", title: "Final task", detailPageId: "final-details" };
    let archived = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
        if (!cursor) return { tasks: [fixture], hasMore: true, nextCursor: "second" };
        if (cursor === "second")
          return { tasks: [archived ? next : later], hasMore: true, nextCursor: archived ? "refreshed" : "old" };
        if (cursor === "refreshed") return { tasks: [final], hasMore: false, nextCursor: null };
        throw new Error(`Unexpected cursor ${cursor}`);
      }
      if (path === "/api/task-lists/list/tasks/later") {
        archived = true;
        return {
          revision: ++revision,
          detailPageId: later.detailPageId,
          pageIds: [later.detailPageId],
          cleanupPending: true,
          pendingPageCount: null,
        };
      }
      return original(path, init);
    });
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit tasks" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more tasks" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    expect(await screen.findByRole("button", { name: "Later task" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Later task" }));
    fireEvent.click(
      within(document.querySelector(".action-menu-portal")!).getByRole("button", { name: "Move to trash" }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Later task" })).toBeNull());
    expect(
      JSON.parse(
        String(vi.mocked(api).mock.calls.find(([path]) => path === "/api/task-lists/list/tasks/later")?.[1]?.body),
      ),
    ).toMatchObject({ archived: true });
    expect(screen.getByRole("button", { name: "Ship release" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    expect(await screen.findByRole("button", { name: "Next task" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Final task" })).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.some(([path]) => path.includes("cursor=refreshed"))).toBe(true);
  });
  it("removes a task that leaves the selected filter", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const status = new URL(path, "https://example.test").searchParams.get("status");
        return { tasks: status === "todo" && task.status !== "todo" ? [] : [task], hasMore: false, nextCursor: null };
      }
      return original(path, init);
    });
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Task status filter"), { target: { value: "todo" } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit tasks" }));
    const status = await screen.findByLabelText("Status for Ship release");
    await waitFor(() => expect(status).toBeEnabled());
    fireEvent.change(status, { target: { value: "done" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Ship release" })).toBeNull());
  });
  it("resets loaded depth when filters change and ignores an older refresh", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const later = { ...fixture, id: "later", title: "Later task", detailPageId: "later-details" };
    const done = { ...fixture, id: "done", title: "Done task", detailPageId: "done-details", status: "done" as const };
    let resolveOlder: ((value: { tasks: Task[]; hasMore: boolean; nextCursor: string | null }) => void) | null = null;
    let pauseRefresh = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const params = new URL(path, "https://example.test").searchParams;
        if (params.get("status") === "done") {
          if (params.has("cursor")) throw new Error("The new filter should start with one loaded page.");
          return { tasks: [done], hasMore: true, nextCursor: "done-second" };
        }
        if (params.get("cursor") === "second") return { tasks: [later], hasMore: false, nextCursor: null };
        if (pauseRefresh)
          return new Promise((resolve) => {
            resolveOlder = resolve;
          });
        return { tasks: [fixture], hasMore: true, nextCursor: "second" };
      }
      return original(path, init);
    });
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    await screen.findByRole("button", { name: "Load more tasks" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    expect(await screen.findByRole("button", { name: "Later task" })).toBeInTheDocument();
    pauseRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(resolveOlder).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Task status filter"), { target: { value: "done" } });
    expect(await screen.findByRole("button", { name: "Done task" })).toBeInTheDocument();
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(([path]) => path.startsWith("/api/tasks?") && path.includes("status=done"))
        .every(([path]) => !path.includes("cursor=")),
    ).toBe(true);
    resolveOlder!({ tasks: [fixture], hasMore: true, nextCursor: "second" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Ship release" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Later task" })).toBeNull();
  });
  it("keeps a confirmed archive removed when a later manual refresh fails", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const later = { ...fixture, id: "later", title: "Later task", detailPageId: "later-details" };
    let failLater = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
        if (!cursor)
          return {
            tasks: [failLater ? { ...fixture, title: "Changed remotely" } : fixture],
            hasMore: true,
            nextCursor: "second",
          };
        if (failLater) throw new ApiClientError(503, "tasks_unavailable", "Refresh failed.");
        return { tasks: [later], hasMore: false, nextCursor: null };
      }
      if (path === "/api/task-lists/list/tasks/later")
        return { revision: ++revision, detailPageId: later.detailPageId };
      return original(path, init);
    });
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit tasks" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more tasks" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    expect(await screen.findByRole("button", { name: "Later task" })).toBeInTheDocument();
    failLater = true;
    fireEvent.click(screen.getByRole("button", { name: "Actions for Later task" }));
    fireEvent.click(
      within(document.querySelector(".action-menu-portal")!).getByRole("button", { name: "Move to trash" }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Later task" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh failed.");
    expect(screen.queryByRole("button", { name: "Later task" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ship release" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Changed remotely" })).toBeNull();
  });
  it("pauses automatic requests beyond two pages but uses a targeted read after saves", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const second = { ...fixture, id: "second", title: "Second task", detailPageId: "second-details" };
    const third = { ...fixture, id: "third", title: "Third task", detailPageId: "third-details" };
    const poll = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const livePoll = () =>
      poll.mock.calls
        .map(([callback, delay], index) => ({
          callback,
          delay,
          id: poll.mock.results[index]?.value,
        }))
        .filter(({ delay, id }) => delay === 30_000 && !cleared.mock.calls.some(([removed]) => removed === id))
        .at(-1)?.callback;
    const cursors: Array<string | null> = [];
    let failThird = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const params = new URL(path, "https://example.test").searchParams;
        if (params.has("rowId")) return { tasks: [third], hasMore: false, nextCursor: null };
        const cursor = params.get("cursor");
        cursors.push(cursor);
        if (!cursor) return { tasks: [fixture], hasMore: true, nextCursor: "second" };
        if (cursor === "second") return { tasks: [second], hasMore: true, nextCursor: "third" };
        if (cursor === "third") {
          if (failThird) throw new ApiClientError(503, "tasks_unavailable", "Later page unavailable.");
          return { tasks: [third], hasMore: false, nextCursor: null };
        }
      }
      if (path === "/api/task-lists/list/tasks/third" && init?.method === "PATCH") {
        third.status = "done";
        return { revision: 2, rowId: third.id, detailPageId: third.detailPageId };
      }
      return original(path, init);
    });
    const view = render(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={0} />);
    await screen.findByRole("button", { name: "Load more tasks" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Second task" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Third task" });
    expect(screen.getByText(/Automatic updates paused/)).toBeInTheDocument();
    const beforeAuto = cursors.length;
    const pollCallback = livePoll();
    expect(pollCallback).toBeTypeOf("function");
    act(() => (pollCallback as () => void)());
    view.rerender(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={1} />);
    expect(cursors).toHaveLength(beforeAuto);
    expect(screen.getByText(/Updates available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(cursors).toHaveLength(beforeAuto + 3));
    expect(cursors.slice(-3)).toEqual([null, "second", "third"]);
    expect(screen.getByText(/Automatic updates paused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Third task" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status for Third task"), { target: { value: "done" } });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some(([path]) => path === "/api/tasks?rowId=third")).toBe(true),
    );
    expect(cursors).toHaveLength(beforeAuto + 3);
    expect(screen.getByRole("button", { name: "Second task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Third task" })).toBeInTheDocument();
    failThird = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Later page unavailable.");
    expect(cursors.slice(-3)).toEqual([null, "second", "third"]);
    expect(screen.getByRole("button", { name: "Ship release" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Third task" })).toBeInTheDocument();
  });
  it("keeps an event visible if it arrives during a long refresh, then resets depth on filter change", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const second = { ...fixture, id: "second", title: "Second task", detailPageId: "second-details" };
    const third = { ...fixture, id: "third", title: "Third task", detailPageId: "third-details" };
    let holdRefresh = false;
    let resolveSecond: ((value: TaskResponse) => void) | null = null;
    const cursors: Array<string | null> = [];
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const params = new URL(path, "https://example.test").searchParams;
        const cursor = params.get("cursor");
        cursors.push(cursor);
        if (params.get("status") === "done") return { tasks: [], hasMore: false, nextCursor: null };
        if (!cursor) return { tasks: [fixture], hasMore: true, nextCursor: "second" };
        if (cursor === "second") {
          if (holdRefresh)
            return new Promise<TaskResponse>((resolve) => {
              resolveSecond = resolve;
            });
          return { tasks: [second], hasMore: true, nextCursor: "third" };
        }
        if (cursor === "third") return { tasks: [third], hasMore: false, nextCursor: null };
      }
      return original(path, init);
    });
    const view = render(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={0} />);
    await screen.findByRole("button", { name: "Load more tasks" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Second task" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Third task" });
    holdRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(resolveSecond).not.toBeNull());
    view.rerender(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={1} />);
    expect(screen.getByText(/Updates available/)).toBeInTheDocument();
    holdRefresh = false;
    await act(async () => resolveSecond!({ tasks: [second], hasMore: true, nextCursor: "third" }));
    await waitFor(() => expect(cursors.slice(-3)).toEqual([null, "second", "third"]));
    expect(screen.getByText(/Updates available/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task status filter"), { target: { value: "done" } });
    await waitFor(() => expect(screen.queryByText(/Updates available/)).toBeNull());
    expect(screen.queryByText(/Automatic updates paused/)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Third task" })).toBeNull());
    expect(cursors.at(-1)).toBeNull();
  });
  it("coalesces shallow task events into one trailing refresh and skips a poll during loading", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const poll = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const livePoll = () =>
      poll.mock.calls
        .map(([callback, delay], index) => ({
          callback,
          delay,
          id: poll.mock.results[index]?.value,
        }))
        .filter(({ delay, id }) => delay === 30_000 && !cleared.mock.calls.some(([removed]) => removed === id))
        .at(-1)?.callback;
    let defer = false;
    let resolveRefresh: ((value: TaskResponse) => void) | null = null;
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        loads++;
        if (defer) {
          defer = false;
          return new Promise<TaskResponse>((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return { tasks: [fixture], hasMore: false, nextCursor: null };
      }
      return original(path, init);
    });
    const view = render(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={0} />);
    await screen.findByRole("button", { name: "Ship release" });
    defer = true;
    view.rerender(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={1} />);
    await waitFor(() => expect(resolveRefresh).not.toBeNull());
    view.rerender(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={2} />);
    view.rerender(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={3} />);
    const pollCallback = livePoll();
    act(() => (pollCallback as () => void)());
    expect(loads).toBe(2);
    await act(async () => resolveRefresh!({ tasks: [fixture], hasMore: false, nextCursor: null }));
    await waitFor(() => expect(loads).toBe(3));
    const currentPoll = livePoll();
    await act(async () => (currentPoll as () => void)());
    await waitFor(() => expect(loads).toBe(4));
  });
  it("reloads a superseded refresh when a task save finishes", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    let pauseRefresh = false;
    let loads = 0;
    let resolveRefresh: ((value: TaskResponse) => void) | null = null;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?") && !path.includes("rowId=")) {
        loads++;
        if (pauseRefresh) {
          pauseRefresh = false;
          return new Promise<TaskResponse>((resolve) => {
            resolveRefresh = resolve;
          });
        }
      }
      return original(path, init);
    });
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    const status = await screen.findByLabelText("Status for Ship release");
    pauseRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(resolveRefresh).not.toBeNull());
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    fireEvent.change(status, { target: { value: "done" } });
    await waitFor(() => expect(loads).toBe(3));
    await act(async () => resolveRefresh!({ tasks: [fixture], hasMore: false, nextCursor: null }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  });
  it("keeps viewer properties read-only while allowing access to details", async () => {
    render(<TasksView page={page} member={{ ...member, role: "viewer" }} onSelectPage={vi.fn()} />);
    expect(await screen.findByLabelText("Status for Ship release")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit tasks" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ship release" })).toBeEnabled();
  });
  it("keeps Load more usable when a newly encountered task list is archived", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const archivedTask = { ...fixture, id: "archived", listId: "archived-list", title: "Archived list task" };
    const finalTask = { ...fixture, id: "final", title: "Final task" };
    let firstAssigneeReads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
        if (!cursor) return { tasks: [fixture], hasMore: true, nextCursor: "second" };
        if (cursor === "second") return { tasks: [archivedTask], hasMore: true, nextCursor: "third" };
        return { tasks: [finalTask], hasMore: false, nextCursor: null };
      }
      if (path === "/api/task-lists/list/assignees") firstAssigneeReads++;
      if (path === "/api/task-lists/archived-list/assignees")
        throw new ApiClientError(404, "page_not_found", "Page not found.");
      return original(path, init);
    });
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more tasks" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Archived list task" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    expect(await screen.findByRole("button", { name: "Final task" })).toBeInTheDocument();
    expect(firstAssigneeReads).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("keeps the newer duplicate from a later My Tasks page", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const newer = { ...fixture, status: "done" as const, updatedAt: 2, revision: 2 };
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
        return cursor
          ? { tasks: [newer], hasMore: false, nextCursor: null }
          : { tasks: [fixture], hasMore: true, nextCursor: "second" };
      }
      return original(path, init);
    });
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more tasks" }));
    await waitFor(() => expect(screen.getByLabelText("Status for Ship release")).toHaveValue("done"));
    expect(screen.getAllByRole("button", { name: "Ship release" })).toHaveLength(1);
  });
  it("does not let a pending save replace a newly selected filter", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    let finishSave!: (value: { revision: number; rowId: string; detailPageId: string }) => void;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/task-lists/list/tasks/task")
        return new Promise((resolve) => {
          finishSave = resolve;
        });
      if (path.startsWith("/api/tasks?")) {
        const params = new URL(path, "https://example.test").searchParams;
        if (params.has("rowId"))
          return { tasks: [{ ...task, status: "done", updatedAt: 2 }], hasMore: false, nextCursor: null };
        return { tasks: params.get("status") === "todo" ? [] : [task], hasMore: false, nextCursor: null };
      }
      return original(path, init);
    });
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Status for Ship release"), { target: { value: "done" } });
    fireEvent.change(screen.getByLabelText("Task status filter"), { target: { value: "todo" } });
    await act(async () => finishSave({ revision: 2, rowId: "task", detailPageId: "details" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Ship release" })).toBeNull());
    expect(screen.getByLabelText("Task status filter")).toHaveValue("todo");
  });
  it("polls a lease holder independently of the paused task pages", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const second = { ...fixture, id: "second", title: "Second task" };
    const third = { ...fixture, id: "third", title: "Third task" };
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    let holder = "Other editor";
    let leaseReads = 0;
    let taskReads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        taskReads++;
        const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
        return cursor === "second"
          ? { tasks: [second], hasMore: true, nextCursor: "third" }
          : cursor === "third"
            ? { tasks: [third], hasMore: false, nextCursor: null }
            : { tasks: [fixture], hasMore: true, nextCursor: "second" };
      }
      if (path === "/api/task-lists/list/lease") {
        leaseReads++;
        return { lease: { holderName: holder, heldByMe: false, expiresAt: Date.now() + 60_000 } };
      }
      return original(path, init);
    });
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Second task" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Third task" });
    holder = "New editor";
    const before = taskReads;
    const activePolls = intervals.mock.calls
      .map(([callback, delay], index) => ({ callback, delay, id: intervals.mock.results[index]?.value }))
      .filter(({ delay, id }) => delay === 30_000 && !cleared.mock.calls.some(([removed]) => removed === id));
    expect(activePolls.length).toBeGreaterThan(0);
    await act(async () => {
      activePolls.forEach(({ callback }) => (callback as () => void)());
    });
    await waitFor(() => expect(screen.getByText("New editor is editing")).toBeInTheDocument());
    expect(leaseReads).toBeGreaterThan(0);
    expect(taskReads).toBe(before);
  });
  it("shows the current holder immediately after an edit-lock conflict", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/tables/list/lease" && init?.method === "POST")
        throw new ApiClientError(409, "lease_conflict", "Another editor holds this table lease.");
      if (path === "/api/task-lists/list/lease")
        return { lease: { holderName: "Morgan", heldByMe: false, expiresAt: Date.now() + 60_000 } };
      return original(path, init);
    });
    render(<TasksView page={page} member={member} onSelectPage={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit tasks" }));
    expect(await screen.findByText("Morgan is editing")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Another editor");
  });
  it("releases a stalled load on timeout and allows Retry", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let started = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        if (!started) {
          started = true;
          return new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          );
        }
        return { tasks: [fixture], hasMore: false, nextCursor: null };
      }
      return original(path, init);
    });
    render(<TasksView member={member} onSelectPage={vi.fn()} />);
    await waitFor(() => expect(started).toBe(true));
    act(() => timeout.abort(new DOMException("Timed out", "TimeoutError")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tasks could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Ship release" })).toBeInTheDocument();
  });
  it("refreshes again when an event arrives during a three-page load that shrinks to two", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    const second = { ...fixture, id: "second", title: "Second task" };
    const third = { ...fixture, id: "third", title: "Third task" };
    let held = false;
    let shrink = false;
    let resolveSecond!: (value: TaskResponse) => void;
    let requests = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/tasks?")) {
        requests++;
        const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
        if (!cursor) return { tasks: [fixture], hasMore: true, nextCursor: "second" };
        if (cursor === "second") {
          if (held)
            return new Promise<TaskResponse>((resolve) => {
              resolveSecond = resolve;
            });
          return { tasks: [second], hasMore: !shrink, nextCursor: shrink ? null : "third" };
        }
        return { tasks: [third], hasMore: false, nextCursor: null };
      }
      return original(path, init);
    });
    const view = render(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={0} />);
    await screen.findByRole("button", { name: "Load more tasks" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Second task" });
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    await screen.findByRole("button", { name: "Third task" });
    held = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(resolveSecond).toBeTypeOf("function"));
    view.rerender(<TasksView member={member} onSelectPage={vi.fn()} refreshVersion={1} />);
    held = false;
    shrink = true;
    await act(async () => resolveSecond({ tasks: [second], hasMore: false, nextCursor: null }));
    await waitFor(() => expect(requests).toBe(7));
    expect(screen.queryByText(/Updates available/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Third task" })).toBeNull();
  });
});
