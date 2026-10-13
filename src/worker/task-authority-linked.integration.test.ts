import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enrollAccount } from "../../tests/helpers/security";
import type { Page, Space } from "../shared/types";
import { taskColumns } from "../shared/tasks";
import type { TableQueryResult } from "../shared/table-protocol";
import type { Env } from "./env";
import worker from "./index";

function request(cookie: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`http://example.test${path}`, {
    method,
    headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
type TaskMutation = { rowId: string; detailPageId: string; revision: number; replayed: boolean };
async function fixture() {
  const installed = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Task authority",
      name: "Owner",
      email: "task-owner@example.test",
      password: "password123",
    }),
  });
  expect(installed.status).toBe(200);
  const owner = await enrollAccount(installed);
  const spaces = await (await SELF.fetch(request(owner, "/api/spaces"))).json<{ spaces: Space[] }>();
  const privateSpace = await (
    await SELF.fetch(request(owner, "/api/spaces", { name: "Task source", visibility: "private" }))
  ).json<{ space: Space }>();
  const page = async (title: string, spaceId: string, taskList: boolean) => {
    const response = await SELF.fetch(
      request(owner, "/api/pages", { title, spaceId, kind: taskList ? "table" : "document", taskList, parentId: null }),
    );
    expect(response.status).toBe(201);
    return (await response.json<{ page: Page }>()).page;
  };
  const host = await page("Linked host", spaces.spaces[0]!.id, false);
  const source = await page("Tasks", privateSpace.space.id, true);
  expect((await SELF.fetch(request(owner, `/api/tables/${source.id}/authority`, {}))).status).toBe(200);
  const invite = await (
    await SELF.fetch(request(owner, "/api/invites", { role: "editor" }))
  ).json<{ invite: { token: string } }>();
  const accepted = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      token: invite.invite.token,
      name: "Editor",
      email: "task-editor@example.test",
      password: "password123",
    }),
  });
  expect(accepted.status).toBe(200);
  const editor = await enrollAccount(accepted, invite.invite.token);
  const me = await (
    await SELF.fetch(request(editor, "/api/me"))
  ).json<{ user: { id: string }; workspace: { id: string } }>();
  await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES(?,?,'editor',1)")
    .bind(privateSpace.space.id, me.user.id)
    .run();
  const linked = `/api/pages/${host.id}/linked-tables/${source.id}`;
  const direct = `/api/task-lists/${source.id}/tasks`;
  const query = async () =>
    (await SELF.fetch(request(owner, `/api/tables/${source.id}/query`))).json<TableQueryResult>();
  const create = async (cookie: string, path: string, title: string, operationId: string, expectedRevision: number) => {
    const response = await SELF.fetch(request(cookie, path, { title, status: "todo", operationId, expectedRevision }));
    expect(response.status).toBe(201);
    return response.json<TaskMutation>();
  };
  return {
    owner,
    editor,
    editorId: me.user.id,
    workspaceId: me.workspace.id,
    host,
    source,
    sourceSpace: privateSpace.space.id,
    linked,
    direct,
    query,
    create,
  };
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("task authority and linked task writes", () => {
  it.each(["direct", "linked"] as const)(
    "blocks %s generic commands from bypassing task-owned fields or creating orphan rows",
    async (route) => {
      const f = await fixture(),
        columns = taskColumns(f.source.id);
      const task = await f.create(f.owner, f.direct, "Protected task", "protected-create", 1);
      const commands = route === "direct" ? `/api/tables/${f.source.id}/commands` : `${f.linked}/commands`;
      const send = (kind: string, payload: Record<string, unknown>) =>
        SELF.fetch(
          request(f.owner, commands, {
            operationId: crypto.randomUUID(),
            kind,
            payload,
            taskMutation: true,
            allowDeleteDetail: true,
          }),
        );
      expect((await send("create_column", { id: "extra-note", name: "Extra note", type: "text" })).status).toBe(200);
      expect(
        (await send("save_view", { id: "task-board", name: "Tasks board", kind: "board", columnId: columns.status }))
          .status,
      ).toBe(200);
      const before = await f.query();
      const attempts: Array<[string, Record<string, unknown>]> = [
        ["create_row", { id: "orphan-attempt", values: { [columns.title]: "Orphan" } }],
        ["delete_row", { rowId: task.rowId }],
        [
          "move_row",
          { rowId: task.rowId, viewId: "task-board", targetOptionId: `${f.source.id}-done`, expectedCellRevision: 2 },
        ],
        [
          "update_cells",
          { rowId: task.rowId, values: { [columns.title]: "Bypass", [columns.status]: `${f.source.id}-done` } },
        ],
        ["update_column", { columnId: columns.title, revision: 1, name: "Renamed task", type: "number" }],
        ["delete_column", { columnId: columns.assignee }],
        ["prepare_type", { columnId: columns.due, type: "text", revision: 1 }],
        ["add_option", { columnId: columns.status, id: "unsafe-status", label: "Unsafe status" }],
        ["delete_option", { columnId: columns.status, optionId: `${f.source.id}-todo` }],
        [
          "bulk",
          {
            commands: [
              { kind: "create_column", payload: { id: "bulk-extra", name: "Should roll back", type: "text" } },
              { kind: "update_cells", payload: { rowId: task.rowId, values: { [columns.title]: "Nested bypass" } } },
            ],
          },
        ],
      ];
      for (const [kind, payload] of attempts) {
        const response = await send(kind, payload);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ error: { code: "task_service_required" } });
      }
      const after = await f.query();
      expect(after.revision).toBe(before.revision);
      expect(after.rows).toEqual(before.rows);
      expect(after.columns.map((column) => column.id)).not.toContain("bulk-extra");
      expect(
        after.columns
          .find((column) => column.id === columns.status)
          ?.options.map((option) => option.id)
          .sort(),
      ).toEqual([`${f.source.id}-doing`, `${f.source.id}-done`, `${f.source.id}-todo`].sort());
      expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(task.detailPageId).first()).toEqual({
        title: "Protected task",
      });
      expect(
        await env.DB.prepare(
          "SELECT count(*) count FROM table_row_pages WHERE row_id IN (SELECT id FROM table_rows WHERE page_id=?)",
        )
          .bind(f.source.id)
          .first(),
      ).toEqual({ count: 1 });
      expect(
        (await send("update_cells", { rowId: task.rowId, values: { "extra-note": "Safe additional property" } }))
          .status,
      ).toBe(200);
      expect((await f.query()).rows[0]?.cells).toMatchObject({
        [columns.title]: "Protected task",
        "extra-note": "Safe additional property",
      });
    },
  );

  it("creates and edits direct and linked tasks with stable detail pages and replayable receipts", async () => {
    const f = await fixture(),
      columns = taskColumns(f.source.id);
    expect(await (await SELF.fetch(request(f.editor, f.linked))).json()).toMatchObject({ taskList: true });
    const direct = await f.create(f.editor, f.direct, "Direct task", "direct-create", 1);
    const linked = await f.create(f.editor, `${f.linked}/tasks`, "Linked task", "linked-create", direct.revision);
    const patch = {
      title: "Edited through linked host",
      status: "done",
      dueDate: "2026-10-31",
      expectedRevision: linked.revision,
      operationId: "linked-edit",
    };
    const changed = await SELF.fetch(request(f.editor, `${f.linked}/tasks/${direct.rowId}`, patch, "PATCH"));
    expect(changed.status).toBe(200);
    const edited = await changed.json<TaskMutation>();
    expect(edited).toMatchObject({ rowId: direct.rowId, detailPageId: direct.detailPageId, replayed: false });
    const replay = await SELF.fetch(request(f.editor, `${f.linked}/tasks/${direct.rowId}`, patch, "PATCH"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      rowId: direct.rowId,
      detailPageId: direct.detailPageId,
      revision: edited.revision,
      replayed: true,
    });
    const directChanged = await SELF.fetch(
      request(
        f.editor,
        `${f.direct}/${linked.rowId}`,
        { title: "Edited in source", status: "doing", operationId: "direct-edit", expectedRevision: edited.revision },
        "PATCH",
      ),
    );
    expect(directChanged.status).toBe(200);
    const current = await f.query();
    expect(current.rowCount).toBe(2);
    expect(current.rows.find((row) => row.id === direct.rowId)?.cells).toMatchObject({
      [columns.title]: patch.title,
      [columns.status]: `${f.source.id}-done`,
      [columns.due]: "2026-10-31",
    });
    expect(current.rows.find((row) => row.id === linked.rowId)?.cells).toMatchObject({
      [columns.title]: "Edited in source",
      [columns.status]: `${f.source.id}-doing`,
    });
    const detail = await env.DB.prepare(
      "SELECT link.row_id,p.id,p.title,p.parent_id FROM table_row_pages link JOIN pages p ON p.id=link.page_id WHERE link.row_id IN (?,?) ORDER BY p.title",
    )
      .bind(direct.rowId, linked.rowId)
      .all<{ row_id: string; id: string; title: string; parent_id: string }>();
    expect(detail.results).toEqual([
      { row_id: linked.rowId, id: linked.detailPageId, title: "Edited in source", parent_id: f.source.id },
      { row_id: direct.rowId, id: direct.detailPageId, title: patch.title, parent_id: f.source.id },
    ]);
    expect(
      await env.DB.prepare("SELECT count(*) count FROM task_mutation_receipts WHERE actor_id=?")
        .bind(f.editorId)
        .first(),
    ).toEqual({ count: 4 });
    const archive = await SELF.fetch(
      request(
        f.editor,
        `${f.linked}/tasks/${direct.rowId}`,
        { archived: true, operationId: "linked-archive", expectedRevision: current.revision },
        "PATCH",
      ),
    );
    expect(archive.status).toBe(422);
    expect(await archive.json()).toMatchObject({ error: { code: "task_archive_requires_source" } });
    expect((await f.query()).revision).toBe(current.revision);
  });

  it("applies task defaults and selected Board groups to reserved and additional properties", async () => {
    const f = await fixture(),
      columns = taskColumns(f.source.id);
    const command = async (kind: string, payload: Record<string, unknown>) => {
      const response = await SELF.fetch(
        request(f.owner, `/api/tables/${f.source.id}/commands`, {
          operationId: crypto.randomUUID(),
          kind,
          payload,
        }),
      );
      expect(response.status).toBe(200);
    };
    await command("create_column", { id: "priority", name: "Priority", type: "select" });
    await command("add_option", { columnId: "priority", id: "priority-high", label: "High" });
    await command("add_option", { columnId: "priority", id: "priority-low", label: "Low" });
    const defaults = (status: string, extra: Record<string, string> = {}) => ({
      kind: "group",
      operator: "and",
      filters: Object.entries({
        [columns.status]: `${f.source.id}-${status}`,
        [columns.due]: "2026-10-20",
        [columns.assignee]: f.editorId,
        ...extra,
      }).map(([columnId, value]) => ({ kind: "condition", columnId, operator: "eq", value })),
    });
    await command("save_view", {
      id: "status-board",
      name: "Status board",
      kind: "board",
      columnId: columns.status,
      filters: defaults("todo"),
    });
    await command("save_view", {
      id: "priority-board",
      name: "Priority board",
      kind: "board",
      columnId: "priority",
      filters: defaults("doing", { priority: "priority-high" }),
    });
    const before = await f.query();
    const create = {
      title: "Selected done group",
      status: "todo",
      viewId: "status-board",
      groupId: `${f.source.id}-done`,
      expectedRevision: before.revision,
      operationId: "status-board-task",
    };
    const created = await SELF.fetch(request(f.editor, `${f.linked}/tasks`, create));
    expect(created.status).toBe(201);
    const first = await created.json<TaskMutation>();
    expect(first).toMatchObject({ visibleInView: false });
    const replay = await SELF.fetch(request(f.editor, `${f.linked}/tasks`, create));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ rowId: first.rowId, detailPageId: first.detailPageId, replayed: true });
    const changedGroup = await SELF.fetch(
      request(f.editor, `${f.linked}/tasks`, { ...create, groupId: `${f.source.id}-doing` }),
    );
    expect(changedGroup.status).toBe(409);
    expect(await changedGroup.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
    const additional = await SELF.fetch(
      request(f.editor, `${f.linked}/tasks`, {
        title: "Selected low priority",
        viewId: "priority-board",
        groupId: "priority-low",
        expectedRevision: first.revision,
        operationId: "priority-board-task",
      }),
    );
    expect(additional.status).toBe(201);
    const second = await additional.json<TaskMutation>();
    const result = await f.query();
    expect(result.rowCount).toBe(2);
    expect(result.rows.find((row) => row.id === first.rowId)?.cells).toMatchObject({
      [columns.title]: create.title,
      [columns.status]: `${f.source.id}-done`,
      [columns.due]: "2026-10-20",
      [columns.assignee]: f.editorId,
    });
    expect(result.rows.find((row) => row.id === second.rowId)?.cells).toMatchObject({
      [columns.title]: "Selected low priority",
      [columns.status]: `${f.source.id}-doing`,
      [columns.due]: "2026-10-20",
      priority: "priority-low",
    });
    expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(first.detailPageId).first()).toEqual({
      title: create.title,
    });
    expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(second.detailPageId).first()).toEqual({
      title: "Selected low priority",
    });
    expect(
      await env.DB.prepare("SELECT count(*) count FROM task_mutation_receipts WHERE actor_id=?")
        .bind(f.editorId)
        .first(),
    ).toEqual({ count: 2 });
  });

  it.each(["host archive", "host viewer", "source viewer", "source removed"] as const)(
    "rejects task publication after a concurrent %s change",
    async (change) => {
      const f = await fixture();
      const existing = await f.create(f.owner, f.direct, "Unchanged task", "race-existing", 1);
      const before = await f.query();
      let mutations = 0;
      const bindings = {
        ...env,
        TABLE: {
          getByName(pageId: string) {
            const room = env.TABLE.getByName(pageId);
            return {
              async fetch(input: Request) {
                if (new URL(input.url).pathname === "/commands") {
                  mutations++;
                  if (change === "host archive")
                    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(f.host.id).run();
                  else if (change === "host viewer")
                    await env.DB.prepare(
                      "INSERT OR REPLACE INTO space_members(space_id,user_id,role,created_at) VALUES(?,?,'viewer',1)",
                    )
                      .bind(f.host.spaceId, f.editorId)
                      .run();
                  else if (change === "source viewer")
                    await env.DB.prepare("UPDATE space_members SET role='viewer' WHERE space_id=? AND user_id=?")
                      .bind(f.sourceSpace, f.editorId)
                      .run();
                  else
                    await env.DB.prepare("DELETE FROM space_members WHERE space_id=? AND user_id=?")
                      .bind(f.sourceSpace, f.editorId)
                      .run();
                }
                return room.fetch(input);
              },
            };
          },
        } as unknown as Env["TABLE"],
      };
      const editing = change === "host viewer" || change === "source removed";
      const path = editing ? `${f.linked}/tasks/${existing.rowId}` : `${f.linked}/tasks`;
      const context = createExecutionContext();
      const response = await worker.fetch(
        request(
          f.editor,
          path,
          { title: "Denied change", status: "done", expectedRevision: before.revision, operationId: "race-denied" },
          editing ? "PATCH" : "POST",
        ),
        bindings,
        context,
      );
      await waitOnExecutionContext(context);
      expect(mutations).toBe(1);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: change === "source viewer" ? "read_only" : "table_forbidden" },
      });
      const after = await f.query();
      expect(after.revision).toBe(before.revision);
      expect(after.rows).toEqual(before.rows);
      expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(existing.detailPageId).first()).toEqual({
        title: "Unchanged task",
      });
      expect(
        await env.DB.prepare(
          "SELECT count(*) count FROM task_mutation_receipts WHERE operation_id='race-denied'",
        ).first(),
      ).toEqual({ count: 0 });
      expect(
        await env.DB.prepare("SELECT count(*) count FROM pages WHERE parent_id=?").bind(f.source.id).first(),
      ).toEqual({ count: 1 });
    },
  );
});
