// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
let commandDelay: Promise<void> | null;
beforeEach(() => {
  writes = [];
  failure = null;
  deniedRead = false;
  commandDelay = null;
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
      { ...column("Twice", "formula"), config: { resultType: "number", source: 'prop("Amount") * 2' } },
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
        if (commandDelay) {
          const pending = commandDelay;
          commandDelay = null;
          await pending;
        }
        if (failure) {
          const problem = failure;
          failure = null;
          throw problem;
        }
        if (command.kind === "update_cells") Object.assign(data.rows[0]!.cells, command.payload.values);
        if (command.kind === "save_view") {
          if (
            (command.payload.visibleColumnIds as string[]).some(
              (id) => !data.columns.some((property) => property.id === id),
            )
          )
            throw new ApiClientError(400, "invalid_input", "Invalid visible properties.");
          const previous = data.views.find((view) => view.id === command.payload.id);
          if (previous && previous.revision !== command.payload.revision)
            throw new ApiClientError(409, "table_revision_conflict", "View changed.");
          const saved = {
            ...grid,
            ...previous,
            ...command.payload,
            id: previous?.id ?? "saved-view",
            revision: (previous?.revision ?? 0) + 1,
          } as TableView;
          data.views = [...data.views.filter((view) => view.id !== saved.id), saved];
        }
        if (command.kind === "update_column") {
          const previous = data.columns.find((property) => property.id === command.payload.columnId)!;
          if (previous.revision !== command.payload.revision)
            throw new ApiClientError(409, "table_revision_conflict", "Property changed.");
          data.columns = data.columns.map((property) =>
            property.id === previous.id
              ? {
                  ...property,
                  name: String(command.payload.name ?? property.name),
                  revision: property.revision + 1,
                  config:
                    command.payload.source === undefined
                      ? property.config
                      : { ...property.config, source: command.payload.source },
                }
              : property,
          );
        }
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
function delayNextCommand() {
  let release!: () => void;
  commandDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}
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
  it("keeps a view draft's revision through refresh and conflict until explicitly reloaded", async () => {
    show("grid");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "My draft" } });
    data.views = data.views.map((view) => (view.id === "grid" ? { ...view, name: "Remote view", revision: 2 } : view));
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("View name")).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ name: "My draft", revision: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeEnabled());
    expect(screen.getByLabelText("View name")).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Reload latest settings" }));
    expect(screen.getByLabelText("View name")).toHaveValue("Remote view");
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Reviewed view" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(screen.queryByLabelText("View name")).toBeNull());
    expect(writes[1]?.payload).toMatchObject({ name: "Reviewed view", revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByLabelText("View name")).toHaveValue("Reviewed view");
  });
  it("updates pristine view settings when a collaborator changes them", async () => {
    show("grid");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    data.views = data.views.map((view) => (view.id === "grid" ? { ...view, name: "Remote view", revision: 2 } : view));
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("View name")).toHaveValue("Remote view");
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ name: "Remote view", revision: 2 }));
  });
  it("copies an edited view after a collaborator removes a visible property without discarding the draft", async () => {
    data.views[0] = { ...grid, visibleColumnIds: ["Title", "Amount"] };
    show("grid");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "My draft" } });
    data.columns = data.columns.filter((property) => property.id !== "Amount");
    data.views[0] = { ...data.views[0]!, visibleColumnIds: ["Title"], revision: 2 };
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("View name")).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Save as new view" }));
    await waitFor(() => expect(screen.queryByLabelText("View name")).toBeNull());
    expect(writes[0]?.payload).toMatchObject({ name: "My draft copy", visibleColumnIds: ["Title"] });
    expect(writes[0]?.payload).not.toHaveProperty("id");
    expect(writes[0]?.payload).not.toHaveProperty("revision");
  });
  it("disables every view authoring control until the submitted settings finish saving", async () => {
    const user = userEvent.setup();
    show("board");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    const name = screen.getByLabelText("View name");
    fireEvent.change(name, { target: { value: "Submitted view" } });
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: "Title" } });
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.change(screen.getByLabelText("Add sort property"), { target: { value: "Title" } });
    const release = delayNextCommand();
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    for (const control of name.closest("form")!.querySelectorAll("input,select,button")) expect(control).toBeDisabled();
    await user.type(name, " later edit");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(name).toHaveValue("Submitted view");
    expect(writes[0]?.payload).toMatchObject({
      name: "Submitted view",
      filters: { filters: [{ columnId: "Title", value: "Alpha" }] },
      sorts: [{ columnId: "Title", direction: "asc" }],
    });
    await act(async () => release());
    await waitFor(() => expect(screen.queryByLabelText("View name")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByLabelText("View name")).toHaveValue("Submitted view");
  });
  it("protects new property fields while creation is pending and clears only the submitted draft", async () => {
    const user = userEvent.setup();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    const name = screen.getByLabelText("New property name"),
      type = screen.getByLabelText("New property type");
    fireEvent.change(name, { target: { value: "Submitted property" } });
    fireEvent.change(type, { target: { value: "formula" } });
    const source = screen.getByLabelText("New formula");
    fireEvent.change(source, { target: { value: "1" } });
    const release = delayNextCommand();
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    for (const control of [name, type, source]) expect(control).toBeDisabled();
    await user.type(name, " later edit");
    await user.type(source, " + 2");
    expect(name).toHaveValue("Submitted property");
    expect(source).toHaveValue("1");
    expect(writes[0]?.payload).toEqual({ name: "Submitted property", type: "formula", source: "1" });
    await act(async () => release());
    await waitFor(() => expect(name).toBeEnabled());
    expect(name).toHaveValue("");
    expect(source).toHaveValue("");
    await user.type(name, "Next property");
    expect(name).toHaveValue("Next property");
  });
  it("protects the option draft while adding an option and re-enables it after success", async () => {
    const user = userEvent.setup();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    const input = screen.getByLabelText("New option for State");
    fireEvent.change(input, { target: { value: "Submitted option" } });
    const release = delayNextCommand();
    fireEvent.click(within(input.parentElement!).getByRole("button", { name: "Add option" }));
    expect(input).toBeDisabled();
    await user.type(input, " later edit");
    expect(input).toHaveValue("Submitted option");
    expect(writes[0]?.payload).toEqual({ columnId: "State", label: "Submitted option" });
    await act(async () => release());
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue("");
    await user.type(input, "Next option");
    expect(input).toHaveValue("Next option");
  });
  it("keeps property names and their base revision together across conflicts and successful edits", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    fireEvent.change(screen.getByLabelText("Name for Title"), { target: { value: "My name" } });
    data.columns = data.columns.map((property) =>
      property.id === "Title" ? { ...property, name: "Remote name", revision: 2 } : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    const input = screen.getByLabelText("Name for Remote name");
    expect(input).toHaveValue("My name");
    fireEvent.blur(input);
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ name: "My name", revision: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reload latest settings" }));
    expect(input).toHaveValue("Remote name");
    fireEvent.blur(input);
    expect(writes).toHaveLength(1);
    fireEvent.change(input, { target: { value: "Reviewed name" } });
    fireEvent.blur(input);
    const renamed = await screen.findByLabelText("Name for Reviewed name");
    await waitFor(() => expect(renamed).toBeEnabled());
    fireEvent.change(renamed, { target: { value: "Second name" } });
    fireEvent.blur(renamed);
    await screen.findByLabelText("Name for Second name");
    expect(writes[1]?.payload).toMatchObject({ name: "Reviewed name", revision: 2 });
    expect(writes[2]?.payload).toMatchObject({ name: "Second name", revision: 3 });
  });
  it("syncs pristine property fields without writing and retains unsaved formula fields", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    data.columns = data.columns.map((property) =>
      property.id === "Title" ? { ...property, name: "Remote name", revision: 2 } : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    const pristine = screen.getByLabelText("Name for Remote name");
    expect(pristine).toHaveValue("Remote name");
    fireEvent.blur(pristine);
    expect(writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "8" } });
    data.columns = data.columns.map((property) =>
      property.id === "Twice" ? { ...property, config: { ...property.config, source: "6" }, revision: 2 } : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("Formula for Twice")).toHaveValue("8");
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ source: "8", revision: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeEnabled());
    expect(screen.getByLabelText("Formula for Twice")).toHaveValue("8");
    fireEvent.click(screen.getByRole("button", { name: "Reload latest settings" }));
    expect(screen.getByLabelText("Formula for Twice")).toHaveValue("6");
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[1]?.payload).toMatchObject({ source: "10", revision: 2 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Update formula" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[2]?.payload).toMatchObject({ source: "12", revision: 3 }));
  });
  it.each([
    ["Twice", "number", "gt", "4", 4],
    ["Twice", "boolean", "eq", "true", true],
    ["Check", "checkbox", "neq", "false", false],
    ["Due", "date", "gte", "2026-10-13", "2026-10-13"],
    ["Created", "created_time", "lt", "2026-10-13T02:00:00Z", Date.parse("2026-10-13T02:00:00Z")],
  ] as const)("serializes %s %s filters with their effective type", async (id, type, operator, input, value) => {
    if (id === "Created") data.columns.push(column(id, type));
    if (id === "Twice")
      data.columns = data.columns.map((property) =>
        property.id === id ? { ...property, config: { ...property.config, resultType: type } } : property,
      );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: id } });
    fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: operator } });
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: input } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.payload.filters).toEqual({
      kind: "group",
      operator: "and",
      filters: [{ kind: "condition", columnId: id, operator, value }],
    });
  });
  it.each(["People", "Tags"])("uses labeled collection arrays for %s equality and scalar membership", async (id) => {
    if (id === "Tags")
      data.columns.push({
        ...column(id, "multi_select"),
        options: [
          { id: "red", label: "Red", position: 0 },
          { id: "blue", label: "Blue", position: 1 },
        ],
      });
    const ids = id === "People" ? ["owner", "former"] : ["red", "blue"];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: id } });
    expect(within(screen.getByLabelText("Filter operator")).queryByRole("option", { name: "gt" })).toBeNull();
    for (const operator of ["eq", "neq", "contains"]) {
      fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: operator } });
      const picker = screen.getByLabelText("Filter value");
      expect(
        within(picker).getByRole("option", { name: id === "People" ? "Pat (former member)" : "Red" }),
      ).toBeInTheDocument();
      if (!(picker instanceof HTMLSelectElement)) throw new Error("Expected the filter picker.");
      expect(picker.multiple).toBe(operator !== "contains");
      if (operator === "contains") {
        fireEvent.change(picker, { target: { value: ids[0] } });
      } else {
        for (const option of picker.options) option.selected = ids.includes(option.value);
        fireEvent.change(picker);
      }
      fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.payload.filters).toEqual({
      kind: "group",
      operator: "and",
      filters: [
        { kind: "condition", columnId: id, operator: "eq", value: [...ids].sort() },
        { kind: "condition", columnId: id, operator: "neq", value: [...ids].sort() },
        { kind: "condition", columnId: id, operator: "contains", value: ids[0] },
      ],
    });
  });
  it("rejects invalid filter input locally and omits values for empty conditions", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: "Twice" } });
    expect(within(screen.getByLabelText("Filter operator")).queryByRole("option", { name: "contains" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a finite number");
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: "Due" } });
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "not a date" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an ISO date");
    fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: "empty" } });
    expect(screen.queryByLabelText("Filter value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.payload.filters).toEqual({
      kind: "group",
      operator: "and",
      filters: [{ kind: "condition", columnId: "Due", operator: "empty" }],
    });
  });
  it("sends the viewer timezone with calendar drops", async () => {
    data.rows[0]!.cells.Due = "2026-10-13";
    data.rows[0]!.cellRevisions.Due = 7;
    show("calendar");
    fireEvent.change(await screen.findByLabelText("Calendar month"), { target: { value: "2026-10" } });
    await screen.findByRole("button", { name: "Alpha" });
    const target = screen.getByRole("heading", { name: "14" }).parentElement!;
    fireEvent.drop(target, { dataTransfer: { getData: () => "row" } });
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "move_row",
        payload: {
          rowId: "row",
          viewId: "calendar",
          expectedCellRevision: 7,
          targetDate: "2026-10-14",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
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
