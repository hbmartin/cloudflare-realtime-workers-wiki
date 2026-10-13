import {
  applyD1Migrations,
  env,
  abortAllDurableObjects,
  runInDurableObject,
  runDurableObjectAlarm,
  evictDurableObject,
} from "cloudflare:test";
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
import type { ProjectionStatement } from "./table-authority";

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
  operationId: string = crypto.randomUUID(),
) {
  return tableCommand(env, member, pageId, { operationId, kind, payload });
}

describe("per-table authority", () => {
  it("preserves dependencies when a bulk updates old cells before adding new properties", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "old", name: "Old", type: "text" });
    const row = await write(pageId, member, "create_row", { values: { old: "Before" } });
    const result = await write(pageId, member, "bulk", {
      commands: [
        { kind: "update_cells", payload: { rowId: row.result.rowId, values: { old: "After" } } },
        { kind: "create_column", payload: { id: "new", name: "New", type: "text" } },
        { kind: "update_cells", payload: { rowId: row.result.rowId, values: { new: "New value" } } },
      ],
    });
    expect(result.projectionPending).toBe(false);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it("recovers an already compacted unfinished event across chunks without replaying completed effects", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "old", name: "Old", type: "text" });
    const row = await write(pageId, member, "create_row", { values: { old: "Before" } });
    await env.DB.prepare(
      "CREATE TRIGGER legacy_projection_failure BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "bulk", {
        commands: [
          { kind: "update_cells", payload: { rowId: row.result.rowId, values: { old: "After" } } },
          { kind: "create_column", payload: { id: "new", name: "New", type: "text" } },
          { kind: "update_cells", payload: { rowId: row.result.rowId, values: { new: "New value" } } },
        ],
      });
      expect(pending.projectionPending).toBe(true);
      const stub = env.TABLE.getByName(pageId);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAlarm();
        const statements = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? ORDER BY position",
            pending.revision,
          )
          .toArray()
          .flatMap((step) => JSON.parse(step.value) as ProjectionStatement[]);
        const cells = statements.filter((statement) => statement.sql.startsWith("INSERT INTO table_cells("));
        const parents = statements.filter((statement) => /^INSERT INTO table_(rows|columns)\(/.test(statement.sql));
        const remaining = statements.filter((statement) => !cells.includes(statement) && !parents.includes(statement));
        const completed = { sql: "UPDATE pages SET title=title||' completed' WHERE id=?", binds: [pageId] };
        await env.DB.prepare(completed.sql)
          .bind(...completed.binds)
          .run();
        state.storage.sql.exec("DELETE FROM projection_steps WHERE revision=?", pending.revision);
        for (const [position, step] of [[completed], cells, parents, remaining].entries())
          state.storage.sql.exec(
            "INSERT INTO projection_steps VALUES(?,?,?)",
            pending.revision,
            position,
            JSON.stringify(step),
          );
        state.storage.sql.exec("UPDATE events SET value='[]',next_step=1 WHERE revision=?", pending.revision);
      });
      await env.DB.prepare("DROP TRIGGER legacy_projection_failure").run();
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
      expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(pageId).first()).toEqual({
        title: "Tasks completed",
      });
      expect((await queryTable(env, member, pageId)).rows[0]?.cells).toMatchObject({ old: "After", new: "New value" });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS legacy_projection_failure").run();
    }
  });
  it("appends options after surviving positions and repairs legacy ties in canonical order", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "choices", name: "Choices", type: "select" });
    for (const [optionId, label] of [
      ["first", "First"],
      ["middle", "Middle"],
      ["z-last", "Last"],
    ])
      await write(pageId, member, "add_option", { columnId: "choices", id: optionId, label });
    await write(pageId, member, "delete_option", { columnId: "choices", optionId: "first" });
    await write(pageId, member, "add_option", { columnId: "choices", id: "a-new", label: "New" });
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
      const column = JSON.parse(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM properties WHERE id='choices'").one().value,
      );
      column.options.at(-1).position = 2;
      state.storage.sql.exec("UPDATE properties SET value=? WHERE id='choices'", JSON.stringify(column));
    });
    const before = (await queryTable(env, member, pageId)).revision;
    expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
    const repaired = await queryTable(env, member, pageId);
    expect(repaired.revision).toBe(before + 1);
    expect(repaired.columns[0]?.options.map((option) => [option.id, option.position])).toEqual([
      ["middle", 0],
      ["z-last", 1],
      ["a-new", 2],
    ]);
    expect((await repairTableProjection(env, member, pageId)).revision).toBe(repaired.revision);
  });
  it("removes deleted visibility references and heals inherited legacy view defaults", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "old", name: "Old", type: "text" });
    await write(pageId, member, "create_column", { id: "keep", name: "Keep", type: "text" });
    await write(pageId, member, "save_view", { id: "grid", name: "Grid" });
    await write(pageId, member, "delete_column", { columnId: "old" });
    const current = await queryTable(env, member, pageId, "viewId=grid");
    expect(current.invalidView).toBe(false);
    expect(current.view!.visibleColumnIds).toEqual(["keep"]);
    await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
      const view = JSON.parse(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM views WHERE id='grid'").one().value,
      );
      view.visibleColumnIds.push("legacy-missing");
      state.storage.sql.exec("UPDATE views SET value=? WHERE id='grid'", JSON.stringify(view));
    });
    await write(pageId, member, "save_view", { id: "grid", revision: current.view!.revision, name: "Renamed" });
    expect((await queryTable(env, member, pageId, "viewId=grid")).view!.visibleColumnIds).toEqual(["keep"]);
  });
  it("converts selected options to displayed labels and reports deleted option failures", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "status", name: "Status", type: "status" });
    await write(pageId, member, "add_option", { columnId: "status", id: "opaque-done", label: "Done" });
    await write(pageId, member, "add_option", { columnId: "status", id: "opaque-gone", label: "Gone" });
    await write(pageId, member, "create_row", { id: "done-row", values: { status: "opaque-done" } });
    await write(pageId, member, "create_row", { id: "gone-row", values: { status: "opaque-gone" } });
    await write(pageId, member, "delete_option", { columnId: "status", optionId: "opaque-gone" });
    const property = (await queryTable(env, member, pageId)).columns.find((column) => column.id === "status")!;
    const preview = await write(pageId, member, "prepare_type", {
      columnId: "status",
      type: "text",
      revision: property.revision,
    });
    expect(preview.result.conversion).toMatchObject({ converted: 1, failures: 1 });
    await expect(write(pageId, member, "add_option", { columnId: "status", label: "Later" })).rejects.toMatchObject({
      code: "property_conversion_pending",
    });
    await expect(
      write(pageId, member, "delete_option", { columnId: "status", optionId: "opaque-done" }),
    ).rejects.toMatchObject({ code: "property_conversion_pending" });
    const conversion = preview.result.conversion as { id: string };
    await write(pageId, member, "commit_type", { columnId: "status", conversionId: conversion.id, clearInvalid: true });
    const rows = (await queryTable(env, member, pageId)).rows;
    expect(rows.find((row) => row.id === "done-row")?.cells.status).toBe("Done");
    expect(rows.find((row) => row.id === "gone-row")?.cells.status).toBeNull();
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it("refreshes explicit option-label formulas including literal IDs on option changes", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "status", name: "Status", type: "status" });
    await write(pageId, member, "create_column", {
      id: "label",
      name: "Label",
      type: "formula",
      source: 'OptionLabel("later")',
    });
    await write(pageId, member, "create_row", { values: {} });
    expect((await queryTable(env, member, pageId)).rows[0]?.computedCells?.label?.value).toMatchObject({
      __err: "MISSING_PROP",
    });
    await write(pageId, member, "add_option", { columnId: "status", id: "later", label: "Done" });
    expect((await queryTable(env, member, pageId)).rows[0]?.computedCells?.label?.value).toBe("Done");
    await write(pageId, member, "delete_option", { columnId: "status", optionId: "later" });
    expect((await queryTable(env, member, pageId)).rows[0]?.computedCells?.label?.value).toMatchObject({
      __err: "MISSING_PROP",
    });
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it.each(["fence", "headers", "rows", "verify"] as const)(
    "resumes interrupted repair %s from an alarm after eviction",
    async (phase) => {
      const { pageId, member } = await fixture();
      await enableTableAuthority(env, member, pageId);
      await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
      await write(pageId, member, "create_row", { id: "row-a", values: { title: "First" } });
      await write(pageId, member, "create_row", { id: "row-b", values: { title: "Second" } });
      const trigger =
        phase === "fence"
          ? "BEFORE UPDATE OF state ON table_authority WHEN NEW.state='repairing'"
          : phase === "headers"
            ? "BEFORE INSERT ON table_columns"
            : phase === "rows"
              ? "BEFORE INSERT ON table_cells WHEN NEW.row_id='row-b'"
              : "BEFORE UPDATE OF state ON table_authority WHEN NEW.state='do'";
      await env.DB.prepare(
        `CREATE TRIGGER interrupted_repair ${trigger} BEGIN SELECT RAISE(ABORT,'temporary_repair_failure'); END`,
      ).run();
      try {
        await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
        await expect(write(pageId, member, "save_view", { name: "Blocked" })).rejects.toMatchObject({
          code: "table_projection_repairing",
        });
        await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
          const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
          expect(meta.repairIntent).toMatchObject({ phase, generation: 1 });
        });
        await env.DB.prepare("DROP TRIGGER interrupted_repair").run();
        if (phase === "rows" || phase === "verify")
          await env.DB.prepare(
            "CREATE TRIGGER completed_repair_row BEFORE DELETE ON table_rows WHEN OLD.id='row-a' BEGIN SELECT RAISE(ABORT,'completed_row_must_not_reset'); END",
          ).run();
        const stub = env.TABLE.getByName(pageId);
        await evictDurableObject(stub);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
        expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "do", projected_revision: 4 });
      } finally {
        await env.DB.prepare("DROP TRIGGER IF EXISTS interrupted_repair").run();
        await env.DB.prepare("DROP TRIGGER IF EXISTS completed_repair_row").run();
      }
    },
  );
  it("keeps repair fenced after a parity mismatch and rebuilds from the same snapshot", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { title: "Canonical" } });
    await env.DB.prepare(
      "CREATE TRIGGER corrupt_repair_projection AFTER INSERT ON table_cells WHEN NEW.row_id='row-a' BEGIN UPDATE table_cells SET text_value='Corrupt',json_value=json_quote('Corrupt') WHERE row_id=NEW.row_id AND column_id=NEW.column_id; END",
    ).run();
    const stub = env.TABLE.getByName(pageId);
    try {
      await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_mismatch",
      });
      expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing", generation: 1 });
      await runInDurableObject(stub, (_instance, state) => {
        const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
        expect(meta.repairIntent).toEqual({ generation: 1, phase: "headers", revision: 3, headerStep: 0 });
        expect(state.storage.sql.exec("SELECT count(*) count FROM receipts").one()).toEqual({ count: 2 });
      });
      await expect(write(pageId, member, "save_view", { name: "Blocked" })).rejects.toMatchObject({
        code: "table_projection_repairing",
      });
      expect((await queryTable(env, member, pageId)).rows[0]?.cells.title).toBe("Canonical");
      await env.DB.prepare("DROP TRIGGER corrupt_repair_projection").run();
      await evictDurableObject(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
      expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "do", generation: 1 });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS corrupt_repair_projection").run();
    }
  });
  it("does not release another generation's fence when an interrupted repair resumes", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { title: "Canonical" } });
    await env.DB.prepare(
      "CREATE TRIGGER hold_repair_verification BEFORE UPDATE OF state ON table_authority WHEN NEW.state='do' BEGIN SELECT RAISE(ABORT,'temporary_verification_failure'); END",
    ).run();
    const stub = env.TABLE.getByName(pageId);
    try {
      await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
      await env.DB.prepare("DROP TRIGGER hold_repair_verification").run();
      await env.DB.prepare("UPDATE table_authority SET generation=2 WHERE page_id=?").bind(pageId).run();
      await evictDurableObject(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing", generation: 2 });
      await expect(tableInternal(env, pageId, "/repair", {})).rejects.toMatchObject({
        code: "table_generation_conflict",
      });
      await runInDurableObject(stub, (_instance, state) => {
        const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
        expect(meta.repairIntent).toMatchObject({ generation: 1, phase: "verify", revision: 3 });
        expect(state.storage.sql.exec("SELECT count(*) count FROM receipts").one()).toEqual({ count: 2 });
      });
      expect(await env.DB.prepare("SELECT text_value FROM table_cells WHERE row_id='row-a'").first()).toEqual({
        text_value: "Canonical",
      });
      await env.DB.prepare("UPDATE table_authority SET generation=1 WHERE page_id=?").bind(pageId).run();
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_repair_verification").run();
    }
  });
  it("continues repair row batches without publishing a partial rebuild", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await write(pageId, member, "bulk", {
      commands: Array.from({ length: 105 }, (_value, index) => ({
        kind: "create_row",
        payload: { id: `row-${String(index).padStart(3, "0")}`, values: { title: String(index) } },
      })),
    });
    await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({
      code: "table_projection_repairing",
    });
    expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing" });
    expect(await env.DB.prepare("SELECT count(*) count FROM table_rows WHERE page_id=?").bind(pageId).first()).toEqual({
      count: 100,
    });
    expect(await runDurableObjectAlarm(env.TABLE.getByName(pageId))).toBe(true);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "do" });
  });
  it("retains the recent event window and pending events while lifetime receipts remain replayable", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" }, "old-receipt");
    const stub = env.TABLE.getByName(pageId);
    await runInDurableObject(stub, async (_instance, state) => {
      const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
      meta.revision = 250;
      meta.projectedRevision = 250;
      state.storage.sql.exec("UPDATE meta SET value=?", JSON.stringify(meta));
      for (let revision = 3; revision <= 250; revision++) {
        state.storage.sql.exec(
          "INSERT INTO events(revision,operation_id,value) VALUES(?,?,'[]')",
          revision,
          `history-${revision}`,
        );
        state.storage.sql.exec("INSERT INTO projection_steps VALUES(?,0,'[]')", revision);
      }
      await state.storage.setAlarm(Date.now() + 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count(*) count FROM events").one()).toEqual({ count: 100 });
      expect(state.storage.sql.exec("SELECT count(*) count FROM projection_steps").one()).toEqual({ count: 0 });
    });
    await env.DB.prepare(
      "CREATE TRIGGER retained_pending_projection BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT,'temporary_projection_failure'); END",
    ).run();
    try {
      expect((await write(pageId, member, "save_view", { name: "Pending view" })).projectionPending).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT count(*) count FROM events").one()).toEqual({ count: 101 });
        expect(state.storage.sql.exec("SELECT count(*) count FROM projection_steps WHERE revision=251").one()).toEqual({
          count: 1,
        });
        expect(
          state.storage.sql.exec("SELECT count(*) count FROM receipts WHERE operation_id='old-receipt'").one(),
        ).toEqual({ count: 1 });
      });
      expect(
        await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" }, "old-receipt"),
      ).toMatchObject({ revision: 2, replayed: true });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS retained_pending_projection").run();
    }
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count(*) count FROM events").one()).toEqual({ count: 100 });
      expect(state.storage.sql.exec("SELECT count(*) count FROM projection_steps").one()).toEqual({ count: 0 });
    });
  });
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
    await write(pageId, member, "create_column", { name: "Unrelated", type: "text" });
    const unchangedError = await queryTable(env, member, pageId, "viewId=grid");
    expect(unchangedError.view?.revision).toBe(retyped.view?.revision);
    await write(pageId, member, "update_column", {
      columnId: "twice",
      revision: unchangedError.columns.find((property) => property.id === "twice")!.revision,
      source: "1",
    });
    expect((await queryTable(env, member, pageId, "viewId=grid")).invalidView).toBe(true);
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
  it.each(["create", "rename", "archive"] as const)(
    "drains pending task %s effects before repairing and preserves failed retries",
    async (kind) => {
      const { pageId, member } = await fixture(true);
      await enableTableAuthority(env, member, pageId);
      const original = await mutateTask(env, member, pageId, null, {
        title: "Original task",
        operationId: "repair-original",
        expectedRevision: 1,
      });
      const trigger =
        kind === "create"
          ? "BEFORE INSERT ON pages WHEN NEW.title='Pending task'"
          : kind === "rename"
            ? "BEFORE UPDATE OF title ON pages WHEN NEW.title='Pending task'"
            : "BEFORE UPDATE OF archived_at ON pages WHEN NEW.archived_at IS NOT NULL";
      await env.DB.prepare(
        `CREATE TRIGGER pending_task_failure ${trigger} BEGIN SELECT RAISE(ABORT,'transient_publication_failure'); END`,
      ).run();
      const body = {
        operationId: "repair-pending",
        expectedRevision: 2,
        ...(kind === "archive" ? { archived: true } : { title: "Pending task" }),
      };
      await expect(
        mutateTask(env, member, pageId, kind === "create" ? null : original.rowId, body),
      ).rejects.toMatchObject({ code: "task_projection_pending" });
      for (let retry = 0; retry < 2; retry++) {
        await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
        expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing", projected_revision: 2 });
        expect(await tableInternal(env, pageId, "/verify")).toMatchObject({ revision: 3, projectedRevision: 2 });
      }
      await env.DB.prepare("DROP TRIGGER pending_task_failure").run();
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
      const replay = await mutateTask(env, member, pageId, kind === "create" ? null : original.rowId, body);
      expect(replay.replayed).toBe(true);
      const detail = await env.DB.prepare("SELECT title,archived_at FROM pages WHERE id=?")
        .bind(replay.detailPageId)
        .first<{ title: string; archived_at: number | null }>();
      expect(detail!.title).toBe(kind === "archive" ? "Original task" : "Pending task");
      expect(detail!.archived_at !== null).toBe(kind === "archive");
      expect(
        await env.DB.prepare(
          "SELECT count(*) count FROM task_mutation_receipts WHERE operation_id='repair-pending'",
        ).first(),
      ).toEqual({ count: 1 });
      expect(
        await env.DB.prepare("SELECT count(*) count FROM archive_disconnect_targets WHERE page_id=?")
          .bind(replay.detailPageId)
          .first(),
      ).toEqual({ count: Number(kind === "archive") });
      expect((await queryTable(env, member, pageId)).rows).toHaveLength(kind === "create" ? 2 : 1);
    },
  );
  it("advances the seed watermark only after the complete rebuild and resumes a failed seed", async () => {
    const { pageId, member } = await fixture();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('seed-title',?,'Title','text',0)",
      ).bind(pageId),
      env.DB.prepare(
        "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) VALUES('seed-row',?,0,?,1,1)",
      ).bind(pageId, member.user.id),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,text_value,updated_at) VALUES('seed-row','seed-title','Captured',1)",
      ),
      env.DB.prepare(
        "CREATE TRIGGER failed_seed_projection BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'transient_seed_failure'); END",
      ),
    ]);
    await expect(enableTableAuthority(env, member, pageId)).rejects.toMatchObject({ status: 500 });
    expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "seeding", projected_revision: 0 });
    expect(await tableInternal(env, pageId, "/verify")).toMatchObject({ revision: 1, projectedRevision: 0 });
    await expect(tableInternal(env, pageId, "/repair", {})).rejects.toMatchObject({
      status: 503,
      code: "table_projection_pending",
    });
    await env.DB.prepare("DROP TRIGGER failed_seed_projection").run();
    await enableTableAuthority(env, member, pageId);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    expect((await queryTable(env, member, pageId)).rows[0]).toMatchObject({
      id: "seed-row",
      cells: { "seed-title": "Captured" },
    });
    await write(pageId, member, "create_column", { name: "Committed property", type: "text" });
    await expect(tableInternal(env, pageId, "/seed-finish", {})).rejects.toMatchObject({
      status: 409,
      code: "table_seed_conflict",
    });
  });
  it("invalidates direct and transitive formula views when the edited formula changes result type", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "source", name: "Source", type: "formula", source: "1" });
    await write(pageId, member, "create_column", {
      id: "dependent",
      name: "Dependent",
      type: "formula",
      source: 'prop("Source")',
    });
    await write(pageId, member, "create_column", {
      id: "transitive",
      name: "Transitive",
      type: "formula",
      source: 'prop("Dependent")',
    });
    await write(pageId, member, "create_row", { values: {} });
    for (const columnId of ["source", "transitive"])
      await write(pageId, member, "save_view", {
        id: `${columnId}-view`,
        name: columnId,
        filters: { kind: "condition", columnId, operator: "gt", value: 0 },
        calculations: { [columnId]: "sum" },
      });
    const sameTypeBefore = await queryTable(env, member, pageId, "viewId=source-view");
    await write(pageId, member, "update_column", {
      columnId: "source",
      revision: sameTypeBefore.columns.find((column) => column.id === "source")!.revision,
      source: "2",
    });
    const sameTypeAfter = await queryTable(env, member, pageId, "viewId=source-view");
    expect(sameTypeAfter.invalidView).toBe(false);
    expect(sameTypeAfter.view?.revision).toBe(sameTypeBefore.view?.revision);
    const before = await queryTable(env, member, pageId);
    await write(pageId, member, "update_column", {
      columnId: "source",
      revision: before.columns.find((column) => column.id === "source")!.revision,
      source: '"done"',
    });
    for (const columnId of ["source", "transitive"]) {
      const data = await queryTable(env, member, pageId, `viewId=${columnId}-view`);
      expect(data.invalidView).toBe(true);
      expect(data.rows).toHaveLength(1);
      expect(data.columns.find((column) => column.id === columnId)!.config?.resultType).toBe("string");
    }
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it.each([false, true])(
    "adds rows through computed equality filters without writing read-only defaults (task=%s)",
    async (task) => {
      const { pageId, member } = await fixture(task);
      await enableTableAuthority(env, member, pageId);
      const titleId = task ? `${pageId}-title` : "default-title";
      if (!task) await write(pageId, member, "create_column", { id: titleId, name: "Title", type: "text" });
      await write(pageId, member, "create_column", {
        id: "default-formula",
        name: "Computed",
        type: "formula",
        source: "1",
      });
      await write(pageId, member, "create_column", { id: "default-creator", name: "Creator", type: "created_by" });
      await write(pageId, member, "save_view", {
        id: "computed-defaults",
        name: "Computed defaults",
        filters: {
          kind: "group",
          operator: "and",
          filters: [
            { kind: "condition", columnId: titleId, operator: "eq", value: "Default title" },
            { kind: "condition", columnId: "default-formula", operator: "eq", value: 1 },
            { kind: "condition", columnId: "default-creator", operator: "eq", value: member.user.id },
          ],
        },
      });
      if (task)
        await mutateTask(env, member, pageId, null, {
          operationId: "computed-default-task",
          expectedRevision: (await queryTable(env, member, pageId)).revision,
          viewId: "computed-defaults",
        });
      else await write(pageId, member, "create_row", { values: {}, viewId: "computed-defaults" });
      const data = await queryTable(env, member, pageId, "viewId=computed-defaults");
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0]!.cells[titleId]).toBe("Default title");
      expect(data.rows[0]!.cells["default-creator"]).toBe(member.user.id);
      expect(data.rows[0]!.computedCells?.["default-formula"]?.value).toBe(1);
    },
  );
  it.each(["select", "status", "multi_select"] as const)(
    "searches normalized %s option labels and keeps pagination/filter counts consistent",
    async (type) => {
      const { pageId, member } = await fixture();
      await enableTableAuthority(env, member, pageId);
      await write(pageId, member, "create_column", { id: "searched-state", name: "State", type });
      await write(pageId, member, "create_column", { id: "searched-title", name: "Title", type: "text" });
      await write(pageId, member, "add_option", {
        columnId: "searched-state",
        id: "selected-option-id",
        label: "Ｒｅａｄｙ  for review",
      });
      const value = type === "multi_select" ? ["selected-option-id"] : "selected-option-id";
      for (const name of ["First", "Second"])
        await write(pageId, member, "create_row", { values: { "searched-state": value, "searched-title": name } });
      const params = new URLSearchParams({ q: "READY for review", limit: "1" });
      const first = await queryTable(env, member, pageId, params.toString());
      expect(first.rowCount).toBe(2);
      expect(first.rows).toHaveLength(1);
      params.set("cursor", first.nextCursor!);
      const second = await queryTable(env, member, pageId, params.toString());
      expect(second.rowCount).toBe(2);
      expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
      expect(second.nextCursor).toBeNull();
      expect((await queryTable(env, member, pageId, "q=selected-option-id")).rowCount).toBe(0);
      await write(pageId, member, "save_view", {
        id: "search-filter",
        name: "Search filter",
        filters: { kind: "condition", columnId: "searched-title", operator: "eq", value: "First" },
      });
      expect((await queryTable(env, member, pageId, "viewId=search-filter&q=ready")).rowCount).toBe(1);
      await write(pageId, member, "delete_option", { columnId: "searched-state", optionId: "selected-option-id" });
      expect((await queryTable(env, member, pageId, "q=ready")).rowCount).toBe(0);
    },
  );
  it("moves timestamp rows to the selected viewer month while preserving their source clock", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "viewer-date", name: "Date", type: "date" });
    const row = await write(pageId, member, "create_row", {
      values: { "viewer-date": "2026-10-02T00:15:00.125+09:00" },
    });
    await write(pageId, member, "save_view", {
      id: "viewer-calendar",
      name: "Calendar",
      kind: "calendar",
      columnId: "viewer-date",
    });
    await write(pageId, member, "move_row", {
      rowId: row.result.rowId,
      viewId: "viewer-calendar",
      targetDate: "2026-11-01",
    });
    expect((await queryTable(env, member, pageId)).rows[0]!.cells["viewer-date"]).toBe("2026-11-01T00:15:00.125+09:00");
    await write(pageId, member, "move_row", {
      rowId: row.result.rowId,
      viewId: "viewer-calendar",
      targetDate: "2026-11-01",
      timeZone: "America/Los_Angeles",
    });
    const data = await queryTable(
      env,
      member,
      pageId,
      "viewId=viewer-calendar&month=2026-11&timeZone=America%2FLos_Angeles",
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.cells["viewer-date"]).toBe("2026-11-02T00:15:00.125+09:00");
    await expect(
      write(pageId, member, "move_row", {
        rowId: row.result.rowId,
        viewId: "viewer-calendar",
        targetDate: "2026-11-02",
        timeZone: "Unknown/Zone",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

async function tableRegistryForTest(pageId: string) {
  return env.DB.prepare("SELECT state,generation,projected_revision FROM table_authority WHERE page_id=?")
    .bind(pageId)
    .first();
}
