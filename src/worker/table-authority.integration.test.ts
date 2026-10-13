import { applyD1Migrations, env, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemberContext } from "./env";
import {
  collaborativeTable,
  enableTableAuthority,
  queryTable,
  repairTableProjection,
  tableCommand,
  tableInternal,
  verifyTableProjection,
} from "./table-service";
import { mutateTask, taskListStatements, listTasks } from "./tasks";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM table_authority"),
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
  ]);
});
afterEach(async () => {
  await abortAllDurableObjects();
});
async function fixture(task = false) {
  const key = crypto.randomUUID(),
    pageId = `table-${key}`,
    userId = `owner-${key}`,
    workspaceId = `workspace-${key}`,
    spaceId = `space-${key}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,?,?,1,1)").bind(
      userId,
      "Owner",
      `${key}@example.test`,
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,1)").bind(workspaceId, "Notes"),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?,'owner',1)").bind(
      workspaceId,
      userId,
    ),
    env.DB.prepare(
      "INSERT INTO spaces(id,workspace_id,name,slug,visibility,position,created_by,created_at,updated_at) VALUES(?,?,'General','testing','workspace','a0',?,1,1)",
    ).bind(spaceId, workspaceId, userId),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,updated_by,created_at,updated_at,is_task_list) VALUES(?,?,?,'table','a0','Tasks',?,?,1,1,?)",
    ).bind(pageId, workspaceId, spaceId, userId, userId, Number(task)),
    env.DB.prepare("INSERT INTO table_state(page_id,revision) VALUES(?,1)").bind(pageId),
    ...(task ? taskListStatements(env.DB, pageId) : []),
  ]);
  const member: MemberContext = {
    user: { id: userId, name: "Owner", email: `${key}@example.test` },
    session: { id: `session-${key}`, expiresAt: new Date(Date.now() + 3600000) },
    workspace: { id: workspaceId, name: "Notes", locationHint: null },
    role: "owner",
  };
  return { pageId, member };
}
async function write(
  pageId: string,
  member: MemberContext,
  kind: Parameters<typeof tableCommand>[3]["kind"],
  payload: Record<string, unknown>,
  operationId = crypto.randomUUID(),
) {
  return tableCommand(env, member, pageId, { operationId, kind, payload });
}

describe("per-table authority", () => {
  it("seeds once, fences every legacy writer, and replays receipts after reconnect", async () => {
    const { pageId, member } = await fixture();
    await env.DB.prepare("INSERT INTO table_columns(id,page_id,name,type,position) VALUES('legacy',?,'Title','text',0)")
      .bind(pageId)
      .run();
    await enableTableAuthority(env, member, pageId);
    expect(await collaborativeTable(env, pageId)).toBe(true);
    await expect(
      env.DB.prepare(
        "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) VALUES('bypass',?,0,?,1,1)",
      )
        .bind(pageId, member.user.id)
        .run(),
    ).rejects.toThrow("table_authority_required");
    const operationId = crypto.randomUUID();
    const first = await write(pageId, member, "create_row", { values: { legacy: "Hello" } }, operationId);
    expect(first.projectionPending).toBe(false);
    const replay = await write(pageId, member, "create_row", { values: { legacy: "Hello" } }, operationId);
    expect(replay).toMatchObject({ revision: first.revision, replayed: true });
    await expect(
      write(pageId, member, "create_row", { values: { legacy: "Different" } }, operationId),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect((await queryTable(env, member, pageId)).rows).toHaveLength(1);
  });
  it("renames normalized collisions deterministically before cutover", async () => {
    const { pageId, member } = await fixture();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,position,type,property_revision) VALUES(?,?,'Name',0,'text',1)",
      ).bind(`a-${pageId}`, pageId),
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,position,type,property_revision) VALUES(?,?,' name ',1,'text',1)",
      ).bind(`b-${pageId}`, pageId),
    ]);
    await enableTableAuthority(env, member, pageId);
    expect((await queryTable(env, member, pageId)).columns.map((column) => column.name)).toEqual([
      "Name",
      " name  (2)",
    ]);
    await expect(write(pageId, member, "create_column", { name: "NAME", type: "text" })).rejects.toMatchObject({
      status: 422,
    });
  });
  it("inserts Board grouping and filter defaults in one revision, and rejects stale moves", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "state", name: "State", type: "select" });
    await write(pageId, member, "add_option", { columnId: "state", id: "todo", label: "Todo" });
    await write(pageId, member, "add_option", { columnId: "state", id: "done", label: "Done" });
    await write(pageId, member, "save_view", {
      id: "board",
      name: "Board",
      kind: "board",
      columnId: "state",
      filters: {
        kind: "group",
        operator: "and",
        filters: [{ kind: "condition", columnId: "state", operator: "eq", value: "todo" }],
      },
    });
    const before = await queryTable(env, member, pageId);
    const result = await write(pageId, member, "create_row", {
      viewId: "board",
      groupId: "done",
      values: { state: "todo" },
    });
    expect(result.revision).toBe(before.revision + 1);
    expect(result.result.visibleInView).toBe(false);
    const row = (await queryTable(env, member, pageId)).rows[0]!;
    expect(row.cells.state).toBe("done");
    await expect(
      write(pageId, member, "move_row", {
        viewId: "board",
        rowId: row.id,
        targetOptionId: "todo",
        expectedCellRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "cell_revision_conflict" });
    await write(pageId, member, "move_row", {
      viewId: "board",
      rowId: row.id,
      targetOptionId: "todo",
      expectedCellRevision: row.cellRevisions.state,
    });
    expect((await queryTable(env, member, pageId, "viewId=board")).groupCounts.todo).toBe(1);
    const inferred = await write(pageId, member, "create_row", { viewId: "board", values: {} });
    expect(inferred.result.visibleInView).toBe(true);
    expect(
      (await queryTable(env, member, pageId)).rows.find((item) => item.id === inferred.result.rowId)?.cells.state,
    ).toBe("todo");
    const unassigned = await write(pageId, member, "create_row", { viewId: "board", groupId: null });
    expect(unassigned.result.visibleInView).toBe(false);
  });
  it("stages conversion, blocks conflicting writes, and invalidates broken saved views", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "amount", name: "Amount", type: "text" });
    const row = await write(pageId, member, "create_row", { values: { amount: "abc" } });
    const prepared = await write(pageId, member, "prepare_type", { columnId: "amount", type: "number", revision: 1 });
    const conversion = prepared.result.conversion as { id: string; failures: number };
    expect(conversion.failures).toBe(1);
    await expect(
      write(pageId, member, "update_cells", { rowId: row.result.rowId, values: { amount: "123" } }),
    ).rejects.toMatchObject({ code: "property_conversion_pending" });
    await expect(
      write(pageId, member, "commit_type", { columnId: "amount", conversionId: conversion.id }),
    ).rejects.toMatchObject({ status: 409 });
    await write(pageId, member, "commit_type", { columnId: "amount", conversionId: conversion.id, clearInvalid: true });
    expect((await queryTable(env, member, pageId)).rows[0]!.cells.amount).toBeNull();
    await write(pageId, member, "save_view", {
      id: "sorted",
      name: "Sorted",
      sorts: [{ columnId: "amount", direction: "asc" }],
    });
    await write(pageId, member, "delete_column", { columnId: "amount" });
    expect((await queryTable(env, member, pageId, "viewId=sorted")).invalidView).toBe(true);
  });
  it("stores formula results and revisions atomically and aggregates all filtered rows", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "amount", name: "Amount", type: "number" });
    await write(pageId, member, "bulk", {
      commands: [
        { kind: "create_row", payload: { values: { amount: 2 } } },
        { kind: "create_row", payload: { values: { amount: 3 } } },
      ],
    });
    const rowRevision = (await queryTable(env, member, pageId)).rows[0]!.revision;
    await write(pageId, member, "create_column", {
      id: "twice",
      name: "Twice",
      type: "formula",
      source: 'prop("Amount") * 2',
      config: { ast: { t: "num", v: 999 } },
    });
    await write(pageId, member, "save_view", {
      id: "grid",
      name: "Totals",
      calculations: { twice: "sum", amount: "average" },
    });
    const data = await queryTable(env, member, pageId, "viewId=grid&limit=1");
    expect(data.rows).toHaveLength(1);
    expect(data.calculations?.twice?.value).toBe(10);
    expect(data.calculations?.amount?.value).toBe(2.5);
    expect(data.rows[0]!.computedCells?.twice?.source).toMatchObject({
      tableId: pageId,
      rowId: data.rows[0]!.id,
      schemaRevision: 2,
      rowRevision,
    });
    await expect(
      write(pageId, member, "update_cells", { rowId: data.rows[0]!.id, values: { twice: 100 } }),
    ).rejects.toMatchObject({ code: "computed_property" });
    await expect(
      write(pageId, member, "update_column", { columnId: "twice", revision: 1, source: 'prop("Twice") + 1' }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    await write(pageId, member, "update_column", { columnId: "amount", name: "Cost", revision: 1 });
    await write(pageId, member, "create_column", { id: "reused-name", name: "Amount", type: "number" });
    const renamed = await queryTable(env, member, pageId);
    await write(pageId, member, "update_column", {
      columnId: "twice",
      name: "Total",
      revision: renamed.columns.find((property) => property.id === "twice")!.revision,
    });
    expect(
      (await queryTable(env, member, pageId)).rows
        .map((row) => row.computedCells?.twice?.value)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([4, 6]);
    const pending = await write(pageId, member, "prepare_type", { columnId: "amount", type: "text", revision: 2 });
    await write(pageId, member, "commit_type", {
      columnId: "amount",
      conversionId: (pending.result.conversion as { id: string }).id,
    });
    const retyped = await queryTable(env, member, pageId, "viewId=grid");
    expect(retyped.invalidView).toBe(true);
    expect(retyped.columns.find((property) => property.id === "twice")!.config?.validationError).toBeTruthy();
    expect(retyped.rows[0]!.computedCells?.twice?.value).toMatchObject({ __err: "DEPENDENCY_ERROR" });
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it("validates property configuration versions, typed calculations and duplicate option identities", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await expect(
      write(pageId, member, "create_column", {
        id: "unsupported",
        name: "Unsupported",
        type: "text",
        config: { version: 2 },
      }),
    ).rejects.toMatchObject({ code: "property_config_version" });
    await write(pageId, member, "create_column", { id: "labels", name: "Labels", type: "multi_select" });
    await write(pageId, member, "create_column", { id: "state", name: "State", type: "select" });
    await write(pageId, member, "add_option", { columnId: "labels", id: "option", label: "One" });
    await expect(
      write(pageId, member, "add_option", { columnId: "state", id: "option", label: "Two" }),
    ).rejects.toMatchObject({ code: "table_id_collision" });
    await expect(
      write(pageId, member, "save_view", { name: "Invalid", calculations: { labels: "unique_count" } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      write(pageId, member, "save_view", { name: "Invalid", calculations: { state: "sum" } }),
    ).rejects.toMatchObject({ status: 422 });
    const view = await write(pageId, member, "save_view", {
      id: "counts",
      name: "Count",
      calculations: { labels: "empty_count" },
    });
    expect(view.result.view).toBeDefined();
    expect((await queryTable(env, member, pageId)).columns.every((property) => property.config?.version === 1)).toBe(
      true,
    );
    await write(pageId, member, "delete_column", { columnId: "labels" });
    expect((await queryTable(env, member, pageId, "viewId=counts")).invalidView).toBe(true);
  });
  it("replays a committed cell update after the row was deleted without validating mutable references", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "person", name: "Person", type: "person" });
    const created = await write(pageId, member, "create_row", {});
    const operationId = crypto.randomUUID();
    const payload = { rowId: created.result.rowId, values: { person: [member.user.id] } };
    const committed = await write(pageId, member, "update_cells", payload, operationId);
    await write(pageId, member, "delete_row", { rowId: created.result.rowId });
    expect(await write(pageId, member, "update_cells", payload, operationId)).toMatchObject({
      replayed: true,
      revision: committed.revision,
    });
    expect((await queryTable(env, member, pageId)).rows).toEqual([]);
  });
  it("rejects array-to-scalar guessing during staged conversion", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "people", name: "People", type: "person" });
    await write(pageId, member, "create_row", { values: { people: [member.user.id] } });
    const preview = await write(pageId, member, "prepare_type", { columnId: "people", type: "text", revision: 1 });
    expect(preview.result.conversion).toMatchObject({ failures: 1 });
    expect((await queryTable(env, member, pageId)).rows[0]!.cells.people).toEqual([member.user.id]);
  });
  it("persists a converted generation across restart, stages new rows and removes deleted rows", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "convert-number", name: "Number", type: "text" });
    const original = await write(pageId, member, "create_row", { values: { "convert-number": "123" } });
    const prepared = await write(pageId, member, "prepare_type", {
      columnId: "convert-number",
      type: "number",
      revision: 1,
    });
    expect(prepared.result.conversion).toMatchObject({ converted: 1, empty: 0, failures: 0, total: 1, generation: 2 });
    await abortAllDurableObjects();
    expect((await queryTable(env, member, pageId)).rows[0]!.cells["convert-number"]).toBe("123");
    await write(pageId, member, "create_row", { values: { "convert-number": "456" } });
    await write(pageId, member, "create_row", {});
    await write(pageId, member, "delete_row", { rowId: original.result.rowId });
    const conversion = (await queryTable(env, member, pageId)).columns[0]!.conversion!;
    expect(conversion).toMatchObject({ converted: 1, empty: 1, total: 2 });
    await write(pageId, member, "commit_type", { columnId: "convert-number", conversionId: conversion.id });
    const final = await queryTable(env, member, pageId);
    expect(final.columns[0]).toMatchObject({ type: "number", generation: 2 });
    expect(final.rows.map((row) => row.cells["convert-number"])).toEqual([456, null]);
    expect(
      await env.DB.prepare("SELECT property_generation FROM table_columns WHERE page_id=?").bind(pageId).first(),
    ).toEqual({ property_generation: 2 });
  });
  it("cancels staged conversion without changing original values and can prepare again", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "cancel-type", name: "Original", type: "text" });
    await write(pageId, member, "create_row", { values: { "cancel-type": "abc" } });
    const first = await write(pageId, member, "prepare_type", { columnId: "cancel-type", type: "number", revision: 1 });
    await write(pageId, member, "cancel_type", {
      columnId: "cancel-type",
      conversionId: (first.result.conversion as { id: string }).id,
    });
    const current = await queryTable(env, member, pageId);
    expect(current.rows[0]!.cells["cancel-type"]).toBe("abc");
    expect(current.columns[0]!.type).toBe("text");
    const next = await write(pageId, member, "prepare_type", {
      columnId: "cancel-type",
      type: "number",
      revision: current.columns[0]!.revision,
    });
    expect((next.result.conversion as { id: string }).id).not.toBe((first.result.conversion as { id: string }).id);
  });
  it("retains former member labels but rejects assigning removed people to another row", async () => {
    const { pageId, member } = await fixture();
    const formerId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,'Former colleague',?,1,1)").bind(
        formerId,
        `${formerId}@test.example`,
      ),
      env.DB.prepare("INSERT INTO workspace_members VALUES(?,?,'editor',1)").bind(member.workspace.id, formerId),
    ]);
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "retained-person", name: "People", type: "person" });
    const row = await write(pageId, member, "create_row", { values: { "retained-person": [formerId] } });
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(member.workspace.id, formerId)
      .run();
    expect((await queryTable(env, member, pageId)).people).toContainEqual({
      id: formerId,
      name: "Former colleague",
      active: false,
    });
    await write(pageId, member, "update_cells", {
      rowId: row.result.rowId,
      values: { "retained-person": [formerId, member.user.id] },
    });
    await expect(
      write(pageId, member, "create_row", { values: { "retained-person": [formerId] } }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("groups timestamp months in the viewer timezone and preserves the instant's local clock on drag", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "timestamp", name: "Date", type: "date" });
    await write(pageId, member, "create_row", { values: { timestamp: "2026-03-01T01:00:00.125+00:00" } });
    await write(pageId, member, "save_view", { id: "month", name: "Month", kind: "calendar", columnId: "timestamp" });
    const february = await queryTable(env, member, pageId, "viewId=month&month=2026-02&timeZone=America%2FLos_Angeles");
    expect(february.rowCount).toBe(1);
    expect(
      (await queryTable(env, member, pageId, "viewId=month&month=2026-03&timeZone=America%2FLos_Angeles")).rowCount,
    ).toBe(0);
    await write(pageId, member, "move_row", {
      rowId: february.rows[0]!.id,
      viewId: "month",
      targetDate: "2026-04-01",
      expectedCellRevision: february.rows[0]!.cellRevisions.timestamp,
    });
    expect((await queryTable(env, member, pageId)).rows[0]!.cells.timestamp).toBe("2026-04-01T01:00:00.125+00:00");
  });
  it("projects a bounded 2,000-cell bulk atomically and rejects cross-table identity claims", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    const commands = [
      ...Array.from({ length: 10 }, (_unused, index) => ({
        kind: "create_column",
        payload: { id: `bulk-column-${index}`, name: `Value ${index}`, type: "number" },
      })),
      ...Array.from({ length: 200 }, (_unused, index) => ({
        kind: "create_row",
        payload: {
          values: Object.fromEntries(Array.from({ length: 10 }, (_item, column) => [`bulk-column-${column}`, index])),
        },
      })),
    ];
    const result = await write(pageId, member, "bulk", { commands });
    expect(result.projectionPending).toBe(false);
    expect((await queryTable(env, member, pageId, "limit=1")).rowCount).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT count(*) count FROM table_cells c JOIN table_rows r ON r.id=c.row_id WHERE r.page_id=?",
      )
        .bind(pageId)
        .first(),
    ).toEqual({ count: 2000 });
    const other = await fixture();
    await enableTableAuthority(env, other.member, other.pageId);
    await expect(
      write(other.pageId, other.member, "create_column", { id: "bulk-column-0", name: "Collision", type: "text" }),
    ).rejects.toMatchObject({ code: "table_id_collision" });
  });
  it("cancels the canonical row when its guarded task publication destination changes", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    const command = {
      operationId: crypto.randomUUID(),
      kind: "create_row" as const,
      payload: { id: "cancelled-publication-row" },
    };
    const effects = [{ sql: "INSERT INTO table_publication_guards(page_id,ok) VALUES(?,0)", binds: [pageId] }];
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        tableCommand(env, member, pageId, command, {
          effects,
          cancelRowOnPublicationFailure: "cancelled-publication-row",
        }),
      ).rejects.toMatchObject({ code: "table_publication_conflict" });
    }
    expect((await queryTable(env, member, pageId)).rowCount).toBe(0);
    expect(await env.DB.prepare("SELECT id FROM table_rows WHERE page_id=?").bind(pageId).first()).toBeNull();
  });
  it("revokes writer access against current D1 membership and binds cursors to revision/query", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "bulk", {
      commands: [
        { kind: "create_row", payload: {} },
        { kind: "create_row", payload: {} },
      ],
    });
    const data = await queryTable(env, member, pageId, "limit=1");
    await expect(
      queryTable(env, member, pageId, `limit=1&q=x&cursor=${encodeURIComponent(data.nextCursor!)}`),
    ).rejects.toMatchObject({ code: "table_cursor_stale" });
    const viewerId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?, 'Reader',?,1,1)").bind(
        viewerId,
        `${viewerId}@example.test`,
      ),
      env.DB.prepare("INSERT INTO workspace_members VALUES(?,?,'viewer',1)").bind(member.workspace.id, viewerId),
    ]);
    await expect(
      write(pageId, { ...member, user: { ...member.user, id: viewerId }, role: "viewer" }, "create_row", {}),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("projects migrated task writes with their page, notifications and stable receipt", async () => {
    const { pageId, member } = await fixture(true);
    await enableTableAuthority(env, member, pageId);
    const op = crypto.randomUUID();
    const result = await mutateTask(env, member, pageId, null, {
      operationId: op,
      expectedRevision: 1,
      title: "Collaborative task",
      status: "todo",
    });
    expect((await listTasks(env, member, { listId: pageId })).tasks[0]).toMatchObject({
      id: result.rowId,
      title: "Collaborative task",
      detailPageId: result.detailPageId,
    });
    expect(
      await mutateTask(env, member, pageId, null, {
        operationId: op,
        expectedRevision: 1,
        title: "Collaborative task",
        status: "todo",
      }),
    ).toMatchObject({ rowId: result.rowId, replayed: true });
    expect(
      await env.DB.prepare("SELECT count(*) count FROM task_mutation_receipts WHERE row_id=?")
        .bind(result.rowId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
  it("repairs a D1 projection from authority and purges durable state", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await write(pageId, member, "create_row", { values: { title: "Original" } });
    const registry = await env.DB.prepare("SELECT generation FROM table_authority WHERE page_id=?")
      .bind(pageId)
      .first<{ generation: number }>();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO table_projection_context VALUES(?,?)").bind(pageId, registry!.generation),
      env.DB.prepare("UPDATE table_cells SET text_value='Corrupt',json_value='\"Corrupt\"' WHERE column_id='title'"),
      env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(pageId),
    ]);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(false);
    await repairTableProjection(env, member, pageId);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    expect(await env.DB.prepare("SELECT text_value FROM table_cells WHERE column_id='title'").first()).toEqual({
      text_value: "Original",
    });
    await tableInternal(env, pageId, "/purge", {});
    await expect(queryTable(env, member, pageId)).rejects.toMatchObject({ code: "table_purged" });
  });
});
