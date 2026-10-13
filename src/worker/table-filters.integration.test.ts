import { abortAllDurableObjects, applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemberContext } from "./env";
import type { TableCommand, TableFilter, TableQueryResult } from "../shared/table-protocol";
import { enableTableAuthority, queryTable, tableCommand } from "./table-service";

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

async function fixture() {
  const key = crypto.randomUUID(),
    workspaceId = `workspace-${key}`,
    spaceId = `space-${key}`,
    pageId = `table-${key}`;
  const owner = `owner-${key}`,
    editor = `editor-${key}`,
    viewer = `viewer-${key}`;
  await env.DB.batch([
    ...[owner, editor, viewer].map((userId) =>
      env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,?,?,1,1)").bind(
        userId,
        userId === editor ? "Former editor" : userId === viewer ? "Viewer" : "Owner",
        `${userId}@example.test`,
      ),
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,'Filters',1)").bind(workspaceId),
    ...[
      [owner, "owner"],
      [editor, "editor"],
      [viewer, "viewer"],
    ].map(([userId, role]) =>
      env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?,?,1)").bind(
        workspaceId,
        userId!,
        role!,
      ),
    ),
    env.DB.prepare(
      "INSERT INTO spaces(id,workspace_id,name,slug,visibility,position,created_by,created_at,updated_at) VALUES(?,?,'General','filters','workspace','a0',?,1,1)",
    ).bind(spaceId, workspaceId, owner),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'table','a0','Filters',?,?,1,1)",
    ).bind(pageId, workspaceId, spaceId, owner, owner),
    env.DB.prepare("INSERT INTO table_state(page_id,revision) VALUES(?,1)").bind(pageId),
  ]);
  const member: MemberContext = {
    user: { id: owner, name: "Owner", email: `${owner}@example.test` },
    session: { id: `session-${key}`, expiresAt: new Date(Date.now() + 3600000) },
    workspace: { id: workspaceId, name: "Filters", locationHint: null },
    role: "owner",
  };
  await enableTableAuthority(env, member, pageId);
  const write = (kind: TableCommand["kind"], payload: Record<string, unknown>) =>
    tableCommand(env, member, pageId, { operationId: crypto.randomUUID(), kind, payload });
  await write("bulk", {
    commands: [
      ...[
        ["title", "Title", "text"],
        ["amount", "Amount", "number"],
        ["checked", "Checked", "checkbox"],
        ["due", "Due", "date"],
        ["state", "State", "select"],
        ["tags", "Tags", "multi_select"],
        ["people", "People", "person"],
        ["creator", "Creator", "created_by"],
      ].map(([id, name, type]) => ({ kind: "create_column", payload: { id, name, type } })),
      {
        kind: "create_column",
        payload: { id: "reciprocal", name: "Reciprocal", type: "formula", source: '10 / prop("Amount")' },
      },
      {
        kind: "create_column",
        payload: { id: "formula-text", name: "Formula text", type: "formula", source: 'concat(10 / prop("Amount"))' },
      },
      ...[
        ["state", "todo", "Todo"],
        ["state", "done", "Done"],
        ["tags", "blue", "Blue"],
        ["tags", "red", "Red"],
        ["tags", "green", "Green"],
      ].map(([columnId, id, label]) => ({ kind: "add_option", payload: { columnId, id, label } })),
    ],
  });
  await write("bulk", {
    commands: [
      {
        kind: "create_row",
        payload: {
          id: "a",
          values: {
            title: "Alpha",
            amount: 2,
            checked: true,
            due: "2026-10-13",
            state: "todo",
            tags: ["red", "blue"],
            people: [owner, editor],
          },
        },
      },
      {
        kind: "create_row",
        payload: {
          id: "b",
          values: {
            title: "Beta",
            amount: 4,
            checked: false,
            due: "2026-10-15",
            state: "done",
            tags: ["blue"],
            people: [owner],
          },
        },
      },
      {
        kind: "create_row",
        payload: {
          id: "c",
          values: {
            title: "Gamma",
            amount: 0,
            checked: true,
            due: "2026-10-31",
            state: "todo",
            tags: ["red"],
            people: [editor],
          },
        },
      },
      {
        kind: "create_row",
        payload: {
          id: "d",
          values: { title: "Delta", amount: 1, checked: false, due: null, state: "done", tags: [], people: [] },
        },
      },
      { kind: "create_row", payload: { id: "e", values: {} } },
      {
        kind: "create_row",
        payload: {
          id: "f",
          values: {
            title: "Future",
            amount: 10,
            checked: false,
            due: "2026-11-10",
            state: "todo",
            tags: ["green"],
            people: [viewer],
          },
        },
      },
    ],
  });
  let nextView = 0;
  const save = async (filters: unknown, kind = "grid") => {
    const viewId = `filter-${++nextView}`;
    await write("save_view", {
      id: viewId,
      name: viewId,
      kind,
      columnId: kind === "board" ? "state" : kind === "calendar" ? "due" : null,
      filters,
    });
    return viewId;
  };
  const query = (params = "") => queryTable(env, member, pageId, params);
  return { member, owner, editor, viewer, workspaceId, pageId, save, query };
}

const condition = (
  columnId: string,
  operator: Extract<TableFilter, { kind: "condition" }>["operator"],
  value?: Extract<TableFilter, { kind: "condition" }>["value"],
): TableFilter => ({ kind: "condition", columnId, operator, ...(value === undefined ? {} : { value }) });
const rowIds = (result: TableQueryResult) => result.rows.map((row) => row.id).sort();

describe("typed table filters", () => {
  it.each(["grid", "board", "calendar"])(
    "applies collection overlap consistently to %s pagination and group counts",
    async (kind) => {
      const f = await fixture();
      const viewId = await f.save(
        {
          kind: "group",
          operator: "and",
          filters: [condition("tags", "in", ["blue"]), condition("people", "in", [f.owner])],
        },
        kind,
      );
      const params = new URLSearchParams({ viewId, limit: "1" });
      if (kind === "calendar") {
        params.set("month", "2026-10");
        params.set("timeZone", "UTC");
        params.set("includeUnscheduled", "true");
      }
      const first = await f.query(params.toString());
      expect(first.rowCount).toBe(2);
      expect(first.rows).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      expect(first.groupCounts).toEqual(kind === "board" ? { todo: 1, done: 1 } : {});
      params.set("cursor", first.nextCursor!);
      const second = await f.query(params.toString());
      expect(second.rowCount).toBe(2);
      expect(second.groupCounts).toEqual(first.groupCounts);
      expect(second.nextCursor).toBeNull();
      expect([...rowIds(first), ...rowIds(second)].sort()).toEqual(["a", "b"]);
    },
  );

  it("matches empty collections and order-independent set equality without guessing scalar membership", async () => {
    const f = await fixture();
    const cases: Array<[TableFilter, string[]]> = [
      [condition("tags", "empty"), ["d", "e"]],
      [condition("people", "empty"), ["d", "e"]],
      [condition("tags", "not_empty"), ["a", "b", "c", "f"]],
      [condition("tags", "eq", ["red", "blue", "blue"]), ["a"]],
      [condition("tags", "neq", ["blue"]), ["a", "c", "d", "e", "f"]],
      [condition("tags", "eq", []), ["d", "e"]],
      [condition("tags", "eq", null), ["d", "e"]],
      [condition("tags", "contains", "blue"), ["a", "b"]],
      [condition("tags", "in", []), []],
    ];
    for (const [filter, expected] of cases)
      expect(rowIds(await f.query(`viewId=${await f.save(filter)}`))).toEqual(expected);
  });

  it("retains exact person ID membership and former labels across authority restart", async () => {
    const f = await fixture();
    const formerView = await f.save(condition("people", "in", [f.editor]));
    const viewerView = await f.save(condition("people", "in", [f.viewer]));
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(f.workspaceId, f.editor)
      .run();
    await abortAllDurableObjects();
    const result = await f.query(`viewId=${formerView}`);
    expect(rowIds(result)).toEqual(["a", "c"]);
    expect(result.people).toEqual(expect.arrayContaining([{ id: f.editor, name: "Former editor", active: false }]));
    expect(rowIds(await f.query(`viewId=${viewerView}`))).toEqual(["f"]);
  });

  it("compares typed scalars and ISO instants while excluding formula errors from normal predicates", async () => {
    const f = await fixture();
    const scalarView = await f.save({
      kind: "group",
      operator: "and",
      filters: [
        condition("amount", "gt", 1),
        condition("checked", "eq", true),
        condition("title", "contains", "ALP"),
        condition("due", "eq", "2026-10-13T03:00:00+03:00"),
        condition("creator", "eq", f.owner),
      ],
    });
    expect(rowIds(await f.query(`viewId=${scalarView}`))).toEqual(["a"]);
    const cases: Array<[TableFilter, string[]]> = [
      [condition("reciprocal", "gt", 2), ["a", "b", "d"]],
      [condition("reciprocal", "neq", 0), ["a", "b", "d", "e", "f"]],
      [condition("formula-text", "contains", "DIV_BY_ZERO"), []],
      [condition("formula-text", "neq", "5"), ["b", "d", "e", "f"]],
      [condition("formula-text", "empty"), ["e"]],
    ];
    for (const [filter, expected] of cases)
      expect(rowIds(await f.query(`viewId=${await f.save(filter)}`))).toEqual(expected);
    expect((await f.query()).rows.find((row) => row.id === "c")?.computedCells?.reciprocal?.value).toMatchObject({
      __err: "DIV_BY_ZERO",
    });
  });

  it("rejects incompatible values and operators without committing a view or revision", async () => {
    const f = await fixture();
    const before = await f.query();
    for (const filter of [
      condition("amount", "eq", "2"),
      condition("checked", "eq", 1),
      condition("amount", "contains", "2"),
      condition("due", "gt", "invalid date"),
      condition("title", "gt", "Z"),
      condition("tags", "eq", "blue"),
      condition("tags", "gt", 1),
      condition("reciprocal", "eq", "5"),
      { kind: "condition", columnId: "people", operator: "in", value: [5] },
      { kind: "condition", columnId: "title", operator: "in", value: [true] },
      { kind: "group", operator: "and", filters: [null] },
    ])
      await expect(f.save(filter)).rejects.toMatchObject({ status: 422, code: "table_validation" });
    const after = await f.query();
    expect(after.revision).toBe(before.revision);
    expect(after.views).toEqual([]);
  });

  it("enforces a shared 200-clause budget and nesting depth eight across groups", async () => {
    const f = await fixture();
    const repeated = (count: number) => ({
      kind: "group",
      operator: "and",
      filters: Array.from({ length: count }, () => condition("amount", "gte", 0)),
    });
    const budget = (last: number) => ({
      kind: "group",
      operator: "and",
      filters: [repeated(50), repeated(50), repeated(50), repeated(last)],
    });
    const valid = await f.save(budget(45));
    expect((await f.query(`viewId=${valid}`)).rowCount).toBe(5);
    await expect(f.save(budget(46))).rejects.toThrow("Too many filter clauses");
    const nested = (depth: number): TableFilter =>
      depth ? { kind: "group", operator: "and", filters: [nested(depth - 1)] } : condition("amount", "gte", 0);
    const deep = await f.save(nested(8));
    expect((await f.query(`viewId=${deep}`)).rowCount).toBe(5);
    await expect(f.save(nested(9))).rejects.toThrow("Filter nesting is too deep");
  });
});
