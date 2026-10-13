// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext } from "../shared/types";
import type { CollaborativeColumn, CollaborativeRow, TableQueryResult } from "../shared/table-protocol";
import { taskColumns } from "../shared/tasks";
import { api } from "./api";
import { CollaborativeTablePage } from "./CollaborativeTablePage";

vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));

const sourceId = "task-source";
const queryBase = `/api/pages/host/linked-tables/${sourceId}`;
const ids = taskColumns(sourceId);
const member = { role: "editor", user: { id: "alex" }, features: { expandedEmbeds: false } } as ClientMemberContext;
type TaskWrite = { path: string; method: string; body: Record<string, unknown> };
let data: TableQueryResult;
let writes: TaskWrite[];
let loseNextTaskResponse: boolean;
let committed: Set<string>;

function column(id: string, name: string, type: CollaborativeColumn["type"], position: number): CollaborativeColumn {
  return { id, name, type, position, revision: 1, generation: 1, options: [] };
}
function row(id: string, title: string): CollaborativeRow {
  return {
    id,
    position: 0,
    revision: 7,
    cells: { [ids.title]: title, [ids.assignee]: "alex", [ids.status]: `${sourceId}-todo`, [ids.due]: null },
    cellRevisions: { [ids.title]: 7, [ids.assignee]: 7, [ids.status]: 7, [ids.due]: 7 },
    detailPageId: `${id}-detail`,
    createdAt: 1,
    createdBy: "alex",
    editedAt: 1,
    editedBy: "alex",
  };
}
function show() {
  // Linked blocks do not know whether a source is a task list before the authoritative query returns.
  render(
    <CollaborativeTablePage
      page={{ id: sourceId, title: "Linked tasks", taskList: false }}
      member={member}
      queryBase={queryBase}
      onSelectPage={vi.fn()}
      embedded
    />,
  );
}
function editTitle(value: string) {
  const input = screen.getByLabelText("Task");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

beforeEach(() => {
  writes = [];
  loseNextTaskResponse = false;
  committed = new Set();
  data = {
    protocolVersion: 1,
    pageId: sourceId,
    taskList: true,
    canEdit: true,
    generation: 1,
    revision: 7,
    projectedRevision: 7,
    columns: [
      column(ids.title, "Task", "text", 0),
      column(ids.assignee, "Assignee", "text", 1),
      {
        ...column(ids.status, "Status", "select", 2),
        options: [
          { id: `${sourceId}-todo`, label: "To do", position: 0 },
          { id: `${sourceId}-done`, label: "Done", position: 1 },
        ],
      },
      column(ids.due, "Due date", "date", 3),
    ],
    rows: [row("existing", "Existing task")],
    views: [],
    view: null,
    rowCount: 1,
    groupCounts: {},
    nextCursor: null,
    invalidView: false,
    people: [
      { id: "alex", name: "Alex", active: true },
      { id: "pat", name: "Pat", active: true },
    ],
  };
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path, init) => {
      if (!init?.method || init.method === "GET") return structuredClone(data);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push({ path, method: init.method, body });
      if (!path.startsWith(`${queryBase}/tasks`)) throw new Error("Task mutation bypassed its linked adapter.");
      const operationId = String(body.operationId);
      if (!committed.has(operationId)) {
        committed.add(operationId);
        if (init.method === "POST") {
          data.rows.push(row(`created-${operationId}`, String(body.title)));
          data.rowCount++;
        } else {
          const existing = data.rows.find((item) => path === `${queryBase}/tasks/${item.id}`)!;
          if (body.title !== undefined) existing.cells[ids.title] = String(body.title);
          if (body.assigneeId !== undefined) existing.cells[ids.assignee] = body.assigneeId as string | null;
          if (body.status !== undefined) existing.cells[ids.status] = `${sourceId}-${String(body.status)}`;
        }
        data.revision++;
      }
      if (loseNextTaskResponse) {
        loseNextTaskResponse = false;
        throw new TypeError("The committed task response was lost.");
      }
      return { rowId: "existing", revision: data.revision, replayed: false };
    });
});

describe("linked task query metadata", () => {
  it("routes task creation and fixed-cell edits through the host-scoped task adapter", async () => {
    show();
    await screen.findByLabelText("Task");
    editTitle("Updated task");
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        path: `${queryBase}/tasks/existing`,
        method: "PATCH",
        body: { expectedRevision: 7, title: "Updated task" },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Assignee")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "pat" } });
    await waitFor(() =>
      expect(writes[1]).toMatchObject({
        path: `${queryBase}/tasks/existing`,
        method: "PATCH",
        body: { assigneeId: "pat" },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Status")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: `${sourceId}-done` } });
    await waitFor(() => expect(writes[2]?.body.status).toBe("done"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "New linked task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await waitFor(() =>
      expect(writes[3]).toMatchObject({
        path: `${queryBase}/tasks`,
        method: "POST",
        body: { expectedRevision: 10, title: "New linked task" },
      }),
    );
    expect(
      writes.every((write) => typeof write.body.operationId === "string" && write.body.operationId.length > 0),
    ).toBe(true);
    expect(writes.some((write) => write.path.endsWith("/commands"))).toBe(false);
  });

  it("protects fixed task properties even though the linked block supplied taskList false", async () => {
    show();
    await screen.findByLabelText("Task");
    expect(screen.getByLabelText("Assignee")).not.toHaveAttribute("multiple");
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    for (const name of ["Task", "Assignee", "Status", "Due date"]) {
      expect(screen.getByText(`${name} · Fixed task property`)).toBeInTheDocument();
      expect(screen.queryByLabelText(`Name for ${name}`)).toBeNull();
      expect(screen.queryByLabelText(`Type for ${name}`)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Delete property" })).toBeNull();
    expect(screen.queryByRole("button", { name: /To do ×|Done ×/ })).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("uses the source canEdit false response to hide writes for an otherwise editing member", async () => {
    data.canEdit = false;
    show();
    await screen.findByLabelText("Task");
    for (const name of ["Task", "Assignee", "Status", "Due date"]) expect(screen.getByLabelText(name)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Properties" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Views" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete row" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();
    expect(writes).toHaveLength(0);
  });

  it("explains when a saved task is hidden by the source view's remaining filters", async () => {
    show();
    await screen.findByLabelText("Task");
    vi.mocked(api).mockResolvedValueOnce({ rowId: "hidden", revision: 8, visibleInView: false });
    fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Hidden task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current filters hide this task. Choose All rows");
    expect(screen.getByLabelText("New row title")).toHaveValue("");
  });

  it.each(["create", "edit"] as const)(
    "retries a lost %s response with the identical linked task operation",
    async (kind) => {
      show();
      await screen.findByLabelText("Task");
      loseNextTaskResponse = true;
      if (kind === "create") {
        fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Once" } });
        fireEvent.click(screen.getByRole("button", { name: "Add row" }));
      } else editTitle("Once");
      const retry = await screen.findByRole("button", { name: "Retry saved operation" });
      expect(writes).toHaveLength(1);
      expect(committed.size).toBe(1);
      expect(writes[0]?.path).toBe(kind === "create" ? `${queryBase}/tasks` : `${queryBase}/tasks/existing`);
      fireEvent.click(retry);
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]).toEqual(writes[0]);
      expect(committed.size).toBe(1);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull());
      expect(data.rows.filter((item) => item.cells[ids.title] === "Once")).toHaveLength(1);
    },
  );
});
