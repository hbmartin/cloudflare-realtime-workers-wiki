// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext, Page } from "../shared/types";
import type { Task } from "../shared/tasks";
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
    if (path === "/api/tables/list/lease") return { leaseToken: "lease", leaseDurationMs: 60000 };
    if (path === "/api/task-lists/list/tasks/task") {
      if (blocked)
        throw new ApiClientError(409, "lease_conflict", "Another editor holds this table. Retry when they finish.");
      const change = JSON.parse(String(init?.body)) as Partial<Task>;
      task = { ...task, ...change, revision: ++revision };
      return { revision, detailPageId: task.detailPageId };
    }
    throw new Error(`Unexpected ${path}`);
  });
});
afterEach(() => {
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
  it("keeps viewer properties read-only while allowing access to details", async () => {
    render(<TasksView page={page} member={{ ...member, role: "viewer" }} onSelectPage={vi.fn()} />);
    expect(await screen.findByLabelText("Status for Ship release")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit tasks" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ship release" })).toBeEnabled();
  });
});
