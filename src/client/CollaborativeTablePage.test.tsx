// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext } from "../shared/types";
import type { CollaborativeColumn, TableCommand, TableQueryResult, TableView } from "../shared/table-protocol";
import { api, ApiClientError } from "./api";
import { CollaborativeTablePage } from "./CollaborativeTablePage";
import { taskColumns } from "../shared/tasks";

vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
const member = {
  role: "editor",
  user: { id: "owner" },
  features: { expandedEmbeds: false, tableBoard: true, tableCalendar: true },
} as ClientMemberContext;
const column = (id: string, type: CollaborativeColumn["type"]): CollaborativeColumn => ({
  id,
  name: id,
  type,
  position: 0,
  revision: 1,
  generation: 1,
  options: [],
});
const grid: TableView = {
  id: "grid",
  name: "Grid",
  kind: "grid",
  revision: 1,
  ownerId: null,
  columnId: null,
  filters: null,
  sorts: [],
  visibleColumnIds: [],
};
const board: TableView = { ...grid, id: "board", name: "Board", kind: "board", columnId: "State" };
const calendar: TableView = { ...grid, id: "calendar", name: "Calendar", kind: "calendar", columnId: "Due" };
let data: TableQueryResult;
let failure: Error | null;
let deniedRead: boolean;
let writes: TableCommand[];
beforeEach(() => {
  writes = [];
  failure = null;
  deniedRead = false;
  data = {
    protocolVersion: 1,
    pageId: "table",
    generation: 1,
    revision: 1,
    projectedRevision: 1,
    view: null,
    columns: [
      column("Title", "text"),
      {
        ...column("State", "select"),
        options: [
          { id: "todo", label: "Todo", position: 0 },
          { id: "done", label: "Done", position: 1 },
        ],
      },
      column("Amount", "number"),
      column("People", "person"),
      column("Due", "date"),
      column("Check", "checkbox"),
      column("Link", "url"),
      column("Twice", "formula"),
    ],
    views: [grid, board, calendar],
    people: [
      { id: "owner", name: "Alex", active: true },
      { id: "former", name: "Pat", active: false },
    ],
    rows: [
      {
        id: "row",
        position: 0,
        cells: { Title: "Alpha", State: "todo", Amount: 2, People: ["former"], Due: null, Check: false, Link: null },
        cellRevisions: { Title: 1, State: 1, Amount: 1 },
        detailPageId: "detail",
        createdAt: 1,
        createdBy: "owner",
        editedAt: 1,
        editedBy: "owner",
        computedCells: {
          Twice: {
            version: 1,
            value: 4,
            source: {
              version: 1,
              tableId: "table",
              tableRevision: 1,
              schemaRevision: 1,
              rowId: "row",
              rowRevision: 1,
              dependencies: [],
            },
          },
        },
      },
    ],
    rowCount: 1,
    groupCounts: { todo: 1 },
    nextCursor: null,
    invalidView: false,
  };
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path, init) => {
      if (path.endsWith("/commands")) {
        const command = JSON.parse(String(init?.body)) as TableCommand;
        writes.push(command);
        if (failure) {
          const problem = failure;
          failure = null;
          throw problem;
        }
        if (command.kind === "update_cells") Object.assign(data.rows[0]!.cells, command.payload.values);
        if (command.kind === "prepare_type")
          data.columns.find((property) => property.id === command.payload.columnId)!.conversion = {
            id: "conversion",
            type: command.payload.type as CollaborativeColumn["type"],
            failures: 1,
            revision: data.revision,
            generation: 2,
            schemaRevision: 1,
            converted: 0,
            empty: 0,
            total: 1,
          };
        if (command.kind === "commit_type" || command.kind === "cancel_type")
          delete data.columns.find((property) => property.id === command.payload.columnId)!.conversion;
        if (command.kind === "delete_view")
          data.views = data.views.filter((view) => view.id !== command.payload.viewId);
        data = { ...data, revision: data.revision + 1 };
        return { revision: data.revision, result: {}, projectionPending: false };
      }
      if (deniedRead) throw new ApiClientError(403, "forbidden", "Table access was removed.");
      const selected = new URL(path, "https://test").searchParams.get("viewId");
      return { ...data, view: data.views.find((view) => view.id === selected) ?? null };
    });
});
afterEach(() => vi.useRealTimers());
function show(initialViewId = "", context = member, onSelectPage = vi.fn(), taskList = false, onViewChanged = vi.fn()) {
  render(
    <CollaborativeTablePage
      page={{ id: "table", title: "Roadmap", taskList }}
      member={context}
      queryBase={taskList ? undefined : "/linked"}
      initialViewId={initialViewId}
      onSelectPage={onSelectPage}
      onViewChanged={onViewChanged}
    />,
  );
}
describe("collaborative table UI", () => {
  it("rechecks linked source access while a draft is dirty and removes cached rows on denial", async () => {
    vi.useFakeTimers();
    await act(async () => {
      show();
    });
    const title = screen.getByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Unsaved draft" } });
    deniedRead = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Table access was removed");
    expect(screen.queryByText("Unsaved draft")).toBeNull();
  });
  it("clears cached rows and pending controls when a command loses source permission", async () => {
    show();
    await screen.findByLabelText("Title");
    failure = new ApiClientError(403, "forbidden", "Table access was removed.");
    fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Denied" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Table access was removed");
  });
  it("assigns and clears a task through its scalar adapter and keeps fixed properties immutable", async () => {
    const ids = taskColumns("table");
    data.columns = [
      { ...column(ids.title, "text"), name: "Task" },
      { ...column(ids.assignee, "text"), name: "Assignee" },
      { ...column(ids.status, "select"), name: "Status" },
      { ...column(ids.due, "date"), name: "Due" },
    ];
    data.rows[0]!.cells = { [ids.title]: "Task", [ids.assignee]: "former" };
    show("", member, vi.fn(), true);
    const picker = await screen.findByLabelText("Assignee");
    expect(picker).not.toHaveAttribute("multiple");
    fireEvent.change(picker, { target: { value: "owner" } });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.find(([path]) => path.includes("/tasks/row"))?.[1]?.body).toContain(
        '"assigneeId":"owner"',
      ),
    );
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.change(picker, { target: { value: "" } });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.filter(([path]) => path.includes("/tasks/row"))[1]?.[1]?.body).toContain(
        '"assigneeId":null',
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    expect(screen.getByText("Assignee · Fixed task property")).toBeInTheDocument();
    expect(screen.queryByLabelText("Type for Status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete property" })).toBeNull();
  });
  it("edits typed Grid cells with their source revision and displays authoritative formula values", async () => {
    show();
    const title = await screen.findByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Updated" } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "update_cells",
        payload: { rowId: "row", values: { Title: "Updated" }, expectedCellRevisions: { Title: 1 } },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Amount")).toBeEnabled());
    const amount = screen.getByLabelText("Amount");
    fireEvent.change(amount, { target: { value: "3" } });
    fireEvent.blur(amount);
    await waitFor(() => expect(writes[1]?.payload.values).toEqual({ Amount: 3 }));
    expect(screen.getByText("4", { selector: "output" })).toBeInTheDocument();
  });
  it("uses member names and retains a former collaborator without offering raw IDs", async () => {
    show();
    const picker = await screen.findByLabelText("People");
    expect((within(picker).getByRole("option", { name: "Pat (former member)" }) as HTMLOptionElement).selected).toBe(
      true,
    );
    expect(within(picker).getByRole("option", { name: "Alex" })).toBeEnabled();
    if (!(picker instanceof HTMLSelectElement)) throw new Error("Expected the people picker.");
    const options = [...picker.options];
    options[0]!.selected = true;
    fireEvent.change(picker);
    await waitFor(() => expect(writes[0]?.payload.values).toEqual({ People: ["owner", "former"] }));
  });
  it("adds a Board row to the explicit group in one command and opens its detail page", async () => {
    const select = vi.fn();
    show("board", member, select);
    fireEvent.change(await screen.findByLabelText("New row title"), { target: { value: "Grouped" } });
    fireEvent.click(screen.getByRole("button", { name: "Add in Done" }));
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "create_row",
        payload: { viewId: "board", groupId: "done", values: { Title: "Grouped" } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(select).toHaveBeenCalledWith("detail");
  });
  it("shows Calendar unscheduled rows and binds month reads to the viewer timezone", async () => {
    show("calendar");
    await screen.findByRole("heading", { name: "Unscheduled" });
    expect(vi.mocked(api).mock.calls[0]![0]).toContain("month=");
    expect(vi.mocked(api).mock.calls[0]![0]).toContain("timeZone=");
    fireEvent.change(screen.getByLabelText("Calendar month"), { target: { value: "2026-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.some(([path]) => path.includes("month=2026-10") && path.includes("timeZone=")),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add unscheduled" }));
    await waitFor(() => expect(writes[0]?.payload.viewId).toBe("calendar"));
  });
  it("clears a linked saved-view pointer only after successful deletion", async () => {
    data.views[0] = { ...grid, visibleColumnIds: data.columns.map((property) => property.id) };
    const changed = vi.fn();
    show("grid", member, vi.fn(), false, changed);
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    failure = new ApiClientError(409, "table_revision_conflict", "View changed.");
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete view" })).toBeEnabled());
    expect(screen.getByLabelText("Saved table view")).toHaveValue("grid");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(""));
    expect(screen.getByLabelText("Saved table view")).toHaveValue("");
  });
  it("previews conversion and requires explicit approval before clearing invalid values", async () => {
    show();
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    fireEvent.change(screen.getByLabelText("Type for Title"), { target: { value: "number" } });
    const commit = await screen.findByRole("button", { name: "Commit type change" });
    expect(commit).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Clear these values"));
    fireEvent.click(commit);
    await waitFor(() =>
      expect(writes[1]).toMatchObject({
        kind: "commit_type",
        payload: { columnId: "Title", conversionId: "conversion", clearInvalid: true },
      }),
    );
  });
  it("saves a shared view definition and keeps gated creation choices out of the editor", async () => {
    show("", { ...member, features: { expandedEmbeds: false, tableBoard: false, tableCalendar: false } });
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(within(screen.getByLabelText("Layout")).queryByRole("option", { name: "board" })).toBeNull();
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Team view" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "save_view",
        payload: { name: "Team view", kind: "grid", personal: false },
      }),
    );
  });
  it("retries a lost response with the identical operation ID and lets viewers read without editing", async () => {
    failure = new ApiClientError(503, "busy", "Retry shortly.");
    show();
    fireEvent.change(await screen.findByLabelText("New row title"), { target: { value: "Once" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved operation" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual(writes[0]);
  });
  it("renders viewers read-only and displays invalid view repair without retargeting", async () => {
    data.invalidView = true;
    show("board", { ...member, role: "viewer" });
    await screen.findByLabelText("Title");
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Showing all rows in Grid");
  });
});
