import {
  applyD1Migrations,
  env,
  abortAllDurableObjects,
  runInDurableObject,
  runDurableObjectAlarm,
  evictDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, MemberContext } from "./env";
import {
  collaborativeTable,
  enableTableAuthority,
  queryTable,
  repairTableProjection as requestRepairTableProjection,
  tableRepairStatus,
  tableCommand,
  tableInternal,
  verifyTableProjection,
} from "./table-service";
import { mutateTask, taskListStatements, listTasks } from "./tasks";
import { acceptPageDeletion, processDeletionJob } from "./cleanup";
import type { ProjectionStatement, TableActor } from "./table-authority";

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

async function repairTableProjection(
  ...args: Parameters<typeof requestRepairTableProjection>
): ReturnType<typeof verifyTableProjection> {
  const initial = await requestRepairTableProjection(...args);
  if (!("repair" in initial)) return initial;
  for (let attempt = 0; attempt < 100; attempt++) {
    await runDurableObjectAlarm(args[0].TABLE.getByName(args[2]));
    const status = await tableRepairStatus(args[0], args[2]);
    if (status.state === "complete") return verifyTableProjection(args[0], args[2]);
    if (status.state === "blocked")
      throw Object.assign(new Error(status.reason), { status: 503, code: "table_projection_blocked" });
  }
  throw new Error("Repair did not finish within its bounded continuations.");
}
async function finishAlarmRepair(pageId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await runDurableObjectAlarm(env.TABLE.getByName(pageId));
    const status = await tableRepairStatus(env, pageId);
    if (status.state === "complete" || status.state === "blocked") return;
  }
  throw new Error("Alarm repair did not finish.");
}
async function writeRows(
  pageId: string,
  member: MemberContext,
  commands: { kind: string; payload: Record<string, unknown> }[],
) {
  for (let offset = 0; offset < commands.length; offset += 200)
    await write(pageId, member, "bulk", { commands: commands.slice(offset, offset + 200) });
}
async function changeProjection(pageId: string, statements: ProjectionStatement[]) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO table_projection_context SELECT page_id,generation FROM table_authority WHERE page_id=?",
    ).bind(pageId),
    ...statements.map((statement) => env.DB.prepare(statement.sql).bind(...statement.binds)),
    env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(pageId),
  ]);
}
async function addEffect(pageId: string, revision: number) {
  await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
    const step = state.storage.sql
      .exec<{ position: number; value: string }>(
        "SELECT position,value FROM projection_steps WHERE revision=? AND position>=0 ORDER BY position DESC LIMIT 1",
        revision,
      )
      .one();
    state.storage.sql.exec(
      "UPDATE projection_steps SET value=? WHERE revision=? AND position=?",
      JSON.stringify([
        ...JSON.parse(step.value),
        { sql: "UPDATE pages SET title=title||' effect' WHERE id=?", binds: [pageId] },
      ]),
      revision,
      step.position,
    );
  });
}

describe("per-table authority", () => {
  it("captures 20,000 linked identities in 20 indexed manifest pages without table-content reads", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    const jobId = crypto.randomUUID(),
      target = JSON.stringify({ version: 1, pageId, workspaceId: member.workspace.id, generation: 1, stage: "stop" });
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(pageId),
      env.DB.prepare(
        "INSERT INTO deletion_jobs(id,workspace_id,root_page_id,created_at,updated_at,next_attempt_at,phase) VALUES(?,?,?,1,1,0,'staging')",
      ).bind(jobId, member.workspace.id, pageId),
      env.DB.prepare("INSERT INTO deletion_job_pages(job_id,page_id,archived_at) VALUES(?,?,1)").bind(jobId, pageId),
      env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'table_do',?)").bind(jobId, target),
    ]);
    const stub = env.TABLE.getByName(pageId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let index = 0; index < 20_000; index++)
          state.storage.sql.exec(
            "INSERT INTO rows VALUES(?,?,1,NULL,1,NULL,?)",
            `linked-${String(index).padStart(5, "0")}`,
            index,
            `detail-${index}`,
          );
        state.storage.sql.exec("INSERT INTO rows VALUES('unlinked',20001,1,NULL,1,NULL,NULL)");
      });
      expect(
        state.storage.sql
          .exec(
            "EXPLAIN QUERY PLAN SELECT id,detail_page_id FROM rows WHERE detail_page_id IS NOT NULL AND id>? ORDER BY id LIMIT 1001",
            "",
          )
          .toArray()
          .some((row) => String(row.detail).includes("rows_linked")),
      ).toBe(true);
    });
    let after: string | null = null,
      calls = 0;
    const ids: string[] = [];
    do {
      const params = new URLSearchParams({ deletionJob: jobId, generation: "1", stopTarget: target, revision: "1" });
      if (after) params.set("after", after);
      const response = await runInDurableObject(stub, async (instance, state) => {
        const exec = state.storage.sql.exec.bind(state.storage.sql),
          statements: string[] = [];
        const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...binds) => {
          statements.push(sql);
          return exec(sql, ...binds);
        });
        try {
          const result = await instance.fetch(
            new Request(`https://table.internal/deletion-evidence?${params}`, {
              headers: { "x-table-internal": env.BETTER_AUTH_SECRET },
            }),
          );
          expect(statements.every((sql) => !/\b(cells|computed|properties|views|people)\b/.test(sql))).toBe(true);
          return result;
        } finally {
          spy.mockRestore();
        }
      });
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(1_000_000);
      const manifest = JSON.parse(raw);
      expect(manifest).toMatchObject({ pageId, workspaceId: member.workspace.id, generation: 1, revision: 1 });
      expect(manifest.rows).toHaveLength(1000);
      expect(Object.keys(manifest.rows[0])).toEqual(["id", "detailPageId"]);
      ids.push(...manifest.rows.map((row: { id: string }) => row.id));
      after = manifest.nextCursor;
      calls++;
    } while (after);
    expect(calls).toBe(20);
    expect(new Set(ids).size).toBe(20_000);
    await expect(
      tableInternal(
        env,
        pageId,
        `/deletion-evidence?${new URLSearchParams({
          deletionJob: jobId,
          generation: "1",
          stopTarget: target,
          revision: "2",
        })}`,
      ),
    ).rejects.toMatchObject({ code: "table_snapshot_changed" });
  });
  it("permits exact accepted unfinished deletion evidence after eviction without stopping or advancing", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(pageId).run();
    const { jobId } = await acceptPageDeletion(env, member.workspace.id, member.user.id, pageId);
    const { target } = (await env.DB.prepare(
      "SELECT target FROM deletion_targets WHERE job_id=? AND kind='table_do' AND json_extract(target,'$.stage')='stop'",
    )
      .bind(jobId)
      .first<{ target: string }>())!;
    const stub = env.TABLE.getByName(pageId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO meta VALUES(2,?)",
        JSON.stringify({
          jobId,
          pageId,
          workspaceId: member.workspace.id,
          generation: 1,
          stopped: false,
          purged: false,
        }),
      );
    });
    await evictDurableObject(stub);
    const params = new URLSearchParams({ deletionJob: jobId, generation: "1", stopTarget: target });
    expect(await tableInternal(env, pageId, `/deletion-evidence?${params}`)).toMatchObject({ rows: [], revision: 1 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=2").one().value),
      ).toMatchObject({ stopped: false, purged: false });
      expect(
        JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value),
      ).toMatchObject({ revision: 1, projectedRevision: 1 });
    });
    params.set("deletionJob", crypto.randomUUID());
    await expect(tableInternal(env, pageId, `/deletion-evidence?${params}`)).rejects.toMatchObject({ status: 403 });
  });
  it("replays exact purged-row proof after eviction and rejects unknown generations or changed archive ownership", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    const source = (await env.DB.prepare("SELECT space_id FROM pages WHERE id=?")
        .bind(pageId)
        .first<{ space_id: string }>())!,
      detailPageId = `proof-detail-${crypto.randomUUID()}`,
      jobId = crypto.randomUUID(),
      purgeJobId = crypto.randomUUID(),
      leaseUntil = Date.now() + 900_000,
      rowId = "purged-proof-row",
      target = JSON.stringify({ tableId: pageId, rowId, detailPageId, generation: 1, preservedField: "exact" });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,archived_at,archive_operation_id) VALUES(?,?,?,'document','a1','Detail',?,1,1,2,'detail-archive')",
      ).bind(detailPageId, member.workspace.id, source.space_id, member.user.id),
      env.DB.prepare(
        "INSERT INTO deletion_jobs(id,workspace_id,root_page_id,created_at,updated_at,next_attempt_at,phase) VALUES(?,?,?,1,1,?,'rows')",
      ).bind(jobId, member.workspace.id, detailPageId, leaseUntil),
      env.DB.prepare(
        "INSERT INTO deletion_job_pages(job_id,page_id,archived_at,archive_operation_id) VALUES(?,?,2,'detail-archive')",
      ).bind(jobId, detailPageId),
      env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'table_row',?)").bind(jobId, target),
      env.DB.prepare("INSERT INTO table_projection_context VALUES(?,1)").bind(pageId),
      env.DB.prepare("DELETE FROM pages WHERE id=?").bind(pageId),
      env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(pageId),
    ]);
    const stub = env.TABLE.getByName(pageId),
      tombstone = {
        jobId: purgeJobId,
        pageId,
        workspaceId: member.workspace.id,
        generation: 1,
        stopped: true,
        purged: true,
      };
    const setTombstone = async (generation: number | null) => {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM meta");
        state.storage.sql.exec("INSERT INTO meta VALUES(2,?)", JSON.stringify({ ...tombstone, generation }));
      });
      await evictDurableObject(stub);
    };
    const body = {
      jobId,
      pageId,
      workspaceId: member.workspace.id,
      generation: 1,
      rowId,
      detailPageId,
      target,
      leaseUntil,
    };
    await setTombstone(1);
    const proof = await tableInternal(env, pageId, "/row-deletion-proof", body);
    expect(proof).toEqual({
      purged: true,
      pageId,
      workspaceId: member.workspace.id,
      generation: 1,
      purgeJobId,
      archivedAt: 2,
      archiveOperationId: "detail-archive",
    });
    await evictDurableObject(stub);
    expect(await tableInternal(env, pageId, "/row-deletion-proof", body)).toEqual(proof);
    await expect(tableInternal(env, pageId, "/row-deletion-proof", { ...body, generation: 2 })).rejects.toMatchObject({
      code: "table_generation_conflict",
    });
    await expect(
      tableInternal(env, pageId, "/row-deletion-proof", { ...body, leaseUntil: leaseUntil + 1 }),
    ).rejects.toMatchObject({ code: "deletion_pending" });
    await expect(
      tableInternal(env, pageId, "/row-deletion-proof", { ...body, target: `${target} ` }),
    ).rejects.toMatchObject({ code: "deletion_pending" });
    await env.DB.prepare("UPDATE pages SET archive_operation_id='new-archive' WHERE id=?").bind(detailPageId).run();
    await expect(tableInternal(env, pageId, "/row-deletion-proof", body)).rejects.toMatchObject({
      code: "deletion_pending",
    });
    await env.DB.prepare("UPDATE pages SET archive_operation_id='detail-archive' WHERE id=?").bind(detailPageId).run();
    await setTombstone(null);
    await expect(tableInternal(env, pageId, "/row-deletion-proof", body)).rejects.toMatchObject({
      status: 503,
      code: "table_deletion_proof_unavailable",
    });
    await setTombstone(1);
    expect(await tableInternal(env, pageId, "/row-deletion-proof", body)).toEqual(proof);
    await env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES(?,?,?,'table','a2','New table',?,1,1)",
    )
      .bind(pageId, member.workspace.id, source.space_id, member.user.id)
      .run();
    await expect(tableInternal(env, pageId, "/row-deletion-proof", body)).rejects.toMatchObject({
      code: "deletion_pending",
    });
  });
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
            "SELECT value FROM projection_steps WHERE revision=? AND position>=0 ORDER BY position",
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
  it("drains historical missing option and column parents before later impure effects", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "choice", name: "Original", type: "select" });
    await write(pageId, member, "add_option", { columnId: "choice", id: "original-option", label: "Original label" });
    await write(pageId, member, "create_row", { id: "row-a" });
    await env.DB.prepare(
      "CREATE TRIGGER hold_parent_recovery BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "update_cells", {
        rowId: "row-a",
        values: { choice: "original-option" },
      });
      expect(pending.projectionPending).toBe(true);
      const later = await write(pageId, member, "delete_column", { columnId: "choice" });
      await addEffect(pageId, later.revision);
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_columns WHERE id='choice' AND page_id=?", binds: [pageId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_parent_recovery").run();
      await env.DB.prepare("CREATE TABLE historical_recovery_log(value TEXT)").run();
      await env.DB.prepare(
        "CREATE TRIGGER check_historical_option AFTER INSERT ON table_cells WHEN NEW.select_value='original-option' BEGIN INSERT INTO historical_recovery_log(value) SELECT o.label||':'||c.name FROM table_select_options o JOIN table_columns c ON c.id=o.column_id WHERE o.id=NEW.select_value; END",
      ).run();
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
      expect((await queryTable(env, member, pageId)).columns).toEqual([]);
      expect((await env.DB.prepare("SELECT value FROM historical_recovery_log").all()).results).toEqual([
        { value: "Original label:Original" },
      ]);
      expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(pageId).first()).toEqual({
        title: "Tasks effect",
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_parent_recovery").run();
      await env.DB.prepare("DROP TRIGGER IF EXISTS check_historical_option").run();
      await env.DB.prepare("DROP TABLE IF EXISTS historical_recovery_log").run();
    }
  });
  it("materializes a legacy all-pure suffix and completes publication after a lost D1 response", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "old", name: "Old", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { old: "Before" } });
    await env.DB.prepare(
      "CREATE TRIGGER hold_pure_suffix BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    const stub = env.TABLE.getByName(pageId);
    try {
      const pending = await write(pageId, member, "update_cells", { rowId: "row-a", values: { old: "After" } });
      const later = await write(pageId, member, "delete_column", { columnId: "old" });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM projection_steps WHERE revision=? AND position<0", pending.revision);
        state.storage.sql.exec("UPDATE events SET value='[]' WHERE revision=?", pending.revision);
      });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_columns WHERE id='old' AND page_id=?", binds: [pageId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_pure_suffix").run();
      await runInDurableObject(stub, async (instance, state) => {
        const internal = instance as unknown as { env: Env; resumeRepair(): Promise<unknown> };
        const original = internal.env;
        let lost = false;
        internal.env = {
          ...original,
          DB: new Proxy(original.DB, {
            get(target, property) {
              if (property === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  const result = await target.batch(statements);
                  const meta = JSON.parse(
                    state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value,
                  );
                  if (
                    !lost &&
                    meta.repairIntent?.phase === "publish" &&
                    (await tableRegistryForTest(pageId))?.state === "do"
                  ) {
                    lost = true;
                    throw new Error("lost_successful_publication_response");
                  }
                  return result;
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
        try {
          expect(await internal.resumeRepair()).toEqual({ pending: true });
          expect(await internal.resumeRepair()).toEqual({ pending: true });
          await expect(internal.resumeRepair()).rejects.toThrow("lost_successful_publication_response");
          const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
          expect(meta).toMatchObject({
            projectedRevision: pending.revision - 1,
            repairIntent: { mode: "pure", phase: "publish", revision: later.revision },
          });
          expect(
            state.storage.sql
              .exec("SELECT count(*) count FROM projection_steps WHERE revision>?", meta.projectedRevision)
              .one(),
          ).toMatchObject({ count: expect.any(Number) });
        } finally {
          internal.env = original;
        }
      });
      expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "do", projected_revision: later.revision });
      await evictDurableObject(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await finishAlarmRepair(pageId);
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT count(*) count FROM projection_steps").one()).toEqual({ count: 0 });
        expect(
          JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value).repairIntent,
        ).toBeUndefined();
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_pure_suffix").run();
    }
  });
  it.each([
    "legacy",
    "guarded insert",
    "null packet",
    "null record",
    "wrong bind",
    "inconsistent fragments",
    "missing chunk",
  ])("blocks unrecoverable mixed artifacts with %s evidence and permits an explicit owner retry", async (evidence) => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "old", name: "Old", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { old: "Before" } });
    await env.DB.prepare(
      "CREATE TRIGGER hold_mixed_suffix BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    const stub = env.TABLE.getByName(pageId);
    try {
      const pending = await write(pageId, member, "update_cells", { rowId: "row-a", values: { old: "After" } });
      const later = await write(pageId, member, "save_view", { id: "grid", name: "Grid" });
      if (evidence !== "guarded insert") await addEffect(pageId, later.revision);
      await runInDurableObject(stub, (_instance, state) => {
        const chunk = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position=-1",
            pending.revision,
          )
          .one();
        if (evidence === "legacy" || evidence === "guarded insert") {
          state.storage.sql.exec("DELETE FROM projection_steps WHERE revision=? AND position<0", pending.revision);
          state.storage.sql.exec("UPDATE events SET value='[]' WHERE revision=?", pending.revision);
          if (evidence === "guarded insert") {
            const step = state.storage.sql
              .exec<{ value: string }>(
                "SELECT value FROM projection_steps WHERE revision=? AND position=0",
                pending.revision,
              )
              .one();
            const statements = JSON.parse(step.value) as ProjectionStatement[];
            const cell = statements.find((statement) => statement.sql.startsWith("INSERT INTO table_cells("))!;
            cell.sql = cell.sql.replace(
              "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              "SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM pages WHERE id=?)",
            );
            cell.binds.push(pageId);
            state.storage.sql.exec(
              "UPDATE projection_steps SET value=? WHERE revision=? AND position=0",
              JSON.stringify(statements),
              pending.revision,
            );
          }
        } else if (evidence === "missing chunk") {
          state.storage.sql.exec("DELETE FROM projection_steps WHERE revision=? AND position=-1", pending.revision);
        } else if (evidence === "inconsistent fragments") {
          const record = JSON.stringify(JSON.parse(chunk.value).records[0]);
          state.storage.sql.exec(
            "UPDATE projection_steps SET value=? WHERE revision=? AND position=-1",
            JSON.stringify({ entry: 0, part: 0, parts: 3, data: record.slice(0, 20) }),
            pending.revision,
          );
          state.storage.sql.exec(
            "INSERT INTO projection_steps VALUES(?,-2,?)",
            pending.revision,
            JSON.stringify({ entry: 0, part: 1, parts: 2, data: record.slice(20) }),
          );
          state.storage.sql.exec(
            "UPDATE events SET value=? WHERE revision=?",
            JSON.stringify({ projectionFormat: 2, prerequisiteFormat: 1, prerequisiteChunks: 2 }),
            pending.revision,
          );
        } else {
          const packet = JSON.parse(chunk.value);
          if (evidence === "wrong bind") packet.records[0].binds[2] = "not-a-number";
          state.storage.sql.exec(
            "UPDATE projection_steps SET value=? WHERE revision=? AND position=-1",
            evidence === "null packet"
              ? "null"
              : evidence === "null record"
                ? '{"records":[null]}'
                : JSON.stringify(packet),
            pending.revision,
          );
        }
      });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_columns WHERE id='old' AND page_id=?", binds: [pageId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_mixed_suffix").run();
      await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_blocked",
      });
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value).repairIntent,
        ).toMatchObject({ phase: "blocked", blocked: { resumePhase: "drain" } });
        expect(await state.storage.getAlarm()).toBeNull();
      });
      expect(await runDurableObjectAlarm(stub)).toBe(false);
      await changeProjection(pageId, [
        {
          sql: "INSERT INTO table_columns(id,page_id,name,type,position,config_json,property_revision,property_generation,name_key) VALUES('old',?,'Old','text',0,?,1,1,'old')",
          binds: [pageId, JSON.stringify({ version: 1 })],
        },
      ]);
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
      expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(pageId).first()).toEqual({
        title: evidence === "guarded insert" ? "Tasks" : "Tasks effect",
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_mixed_suffix").run();
    }
  });
  it("preserves task detail links during an interrupted rebuild and keeps successful continuations at one second", async () => {
    const { pageId, member } = await fixture(true);
    await enableTableAuthority(env, member, pageId);
    const task = await mutateTask(env, member, pageId, null, {
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      title: "Task",
    });
    await env.DB.prepare(
      "CREATE TRIGGER hold_link_repair BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      await requestRepairTableProjection(env, member, pageId);
      await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
      expect(
        await env.DB.prepare("SELECT page_id FROM table_row_pages WHERE row_id=?").bind(task.rowId).first(),
      ).toEqual({ page_id: task.detailPageId });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_link_repair").run();
    }
    expect(await runDurableObjectAlarm(env.TABLE.getByName(pageId))).toBe(true);
    await finishAlarmRepair(pageId);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);

    const next = await fixture();
    await enableTableAuthority(env, next.member, next.pageId);
    await writeRows(
      next.pageId,
      next.member,
      Array.from({ length: 205 }, (_v, index) => ({
        kind: "create_row",
        payload: { id: `continuation-${index.toString().padStart(3, "0")}` },
      })),
    );
    const now = Date.now() + 24 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(requestRepairTableProjection(env, next.member, next.pageId)).resolves.toMatchObject({
        repair: { state: "pending" },
        verification: null,
      });
      expect(await runDurableObjectAlarm(env.TABLE.getByName(next.pageId))).toBe(true);
      await runInDurableObject(env.TABLE.getByName(next.pageId), async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBe(now + 1000);
      });
      expect(await runDurableObjectAlarm(env.TABLE.getByName(next.pageId))).toBe(true);
      await finishAlarmRepair(next.pageId);
      expect((await verifyTableProjection(env, next.pageId)).projectionMatches).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
  it("batches computed refresh deletes and stores aggregated byte-bounded prerequisite chunks", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "value", name: "Value", type: "number" });
    await writeRows(
      pageId,
      member,
      Array.from({ length: 205 }, (_v, index) => ({
        kind: "create_row",
        payload: { id: `computed-${index}`, values: { value: index } },
      })),
    );
    await env.DB.prepare(
      "CREATE TRIGGER hold_computed_batch BEFORE INSERT ON table_computed_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "create_column", {
        id: "formula",
        name: "Formula",
        type: "formula",
        source: 'prop("Value") * 2',
      });
      expect(pending.projectionPending).toBe(true);
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const positives = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position>=0",
            pending.revision,
          )
          .toArray()
          .flatMap((step) => JSON.parse(step.value) as ProjectionStatement[]);
        const deletes = positives.filter((statement) => statement.sql.startsWith("DELETE FROM table_computed_cells"));
        expect(deletes).toHaveLength(3);
        expect(deletes.every((statement) => statement.binds[1] === pageId)).toBe(true);
        const chunks = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position<0",
            pending.revision,
          )
          .toArray();
        expect(chunks).toHaveLength(1);
        expect(JSON.parse(chunks[0]!.value).records).toHaveLength(205);
        expect(new TextEncoder().encode(chunks[0]!.value).byteLength).toBeLessThanOrEqual(1000000);
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_computed_batch").run();
    }
    expect(await runDurableObjectAlarm(env.TABLE.getByName(pageId))).toBe(true);
    await finishAlarmRepair(pageId);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it("does not resurrect a cancelled publication from a dependent event's preimage", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await env.DB.prepare(
      "CREATE TRIGGER delay_publication_guard BEFORE INSERT ON table_publication_guards WHEN NEW.ok=0 BEGIN SELECT RAISE(ABORT,'temporary_guard_failure'); END",
    ).run();
    try {
      const created = await tableCommand(
        env,
        member,
        pageId,
        {
          kind: "create_row",
          operationId: "cancelled-create",
          payload: { id: "cancelled-row", values: { title: "Created" } },
        },
        {
          effects: [{ sql: "INSERT INTO table_publication_guards(page_id,ok) VALUES(?,0)", binds: [pageId] }],
          cancelRowOnPublicationFailure: "cancelled-row",
        },
      );
      expect(created.projectionPending).toBe(true);
      const pending = await write(pageId, member, "update_cells", {
        rowId: "cancelled-row",
        values: { title: "Dependent" },
      });
      await addEffect(pageId, pending.revision);
      await env.DB.prepare("DROP TRIGGER delay_publication_guard").run();
      await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_blocked",
      });
      expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id='cancelled-row'").first()).toBeNull();
      expect((await queryTable(env, member, pageId)).rows).toEqual([]);
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const receipt = JSON.parse(
          state.storage.sql
            .exec<{ result: string }>("SELECT result FROM receipts WHERE operation_id='cancelled-create'")
            .one().result,
        );
        expect(receipt.result.publicationFailed).toBe(true);
        expect(
          JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value).repairIntent
            .blocked.reason,
        ).toBe("Publication denied this row.");
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS delay_publication_guard").run();
    }
  });
  it("uses fresh alarm metadata after an interleaved command during the registry read", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(pageId).run();
    await runInDurableObject(env.TABLE.getByName(pageId), async (instance, state) => {
      const internal = instance as unknown as {
        env: Env;
        alarm(): Promise<void>;
        command(
          actor: TableActor,
          command: { kind: "create_row"; operationId: string; payload: Record<string, unknown> },
          hash: string,
        ): unknown;
      };
      const original = internal.env;
      let interleaved = false;
      internal.env = {
        ...original,
        DB: new Proxy(original.DB, {
          get(target, property) {
            if (property === "prepare")
              return (sql: string) => {
                const prepared = target.prepare(sql);
                if (sql !== "SELECT generation,state FROM table_authority WHERE page_id=?") return prepared;
                return new Proxy(prepared, {
                  get(statement, method) {
                    if (method === "bind")
                      return (...binds: unknown[]) => {
                        const bound = statement.bind(...binds);
                        return new Proxy(bound, {
                          get(result, action) {
                            if (action === "first")
                              return async () => {
                                const registry = await result.first();
                                if (!interleaved) {
                                  interleaved = true;
                                  internal.command(
                                    {
                                      pageId,
                                      workspaceId: member.workspace.id,
                                      userId: member.user.id,
                                      generation: 1,
                                      expiresAt: Date.now() + 60000,
                                    },
                                    {
                                      kind: "create_row",
                                      operationId: "interleaved-row",
                                      payload: { id: "interleaved-row" },
                                    },
                                    "test-hash",
                                  );
                                }
                                return registry;
                              };
                            const value = Reflect.get(result, action);
                            return typeof value === "function" ? value.bind(result) : value;
                          },
                        });
                      };
                    const value = Reflect.get(statement, method);
                    return typeof value === "function" ? value.bind(statement) : value;
                  },
                });
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
      try {
        await internal.alarm();
        const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
        expect(meta).toMatchObject({ revision: 2, projectedRevision: 2 });
        expect(meta.repairIntent).toMatchObject({ phase: "rows" });
      } finally {
        internal.env = original;
      }
    });
    await finishAlarmRepair(pageId);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    expect((await queryTable(env, member, pageId)).rows.map((row) => row.id)).toEqual(["interleaved-row"]);
  });
  it("keeps bounded link reconciliation atomic under byte pressure and checkpoints only complete row work", async () => {
    const { pageId, member } = await fixture();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('large-a',?,'A','text',0),('large-b',?,'B','text',1)",
      ).bind(pageId, pageId),
      env.DB.prepare(
        "WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM n WHERE value<79) INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,updated_by,created_at,updated_at) SELECT list.id||'-'||variant.name||'-'||printf('%03d',n.value),list.workspace_id,list.space_id,list.id,'document',printf('a%03d',n.value),variant.name,?,?,1,1 FROM n CROSS JOIN (SELECT 'desired' name UNION ALL SELECT 'old') variant JOIN pages list ON list.id=?",
      ).bind(member.user.id, member.user.id, pageId),
      env.DB.prepare(
        "WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM n WHERE value<79) INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) SELECT printf('repair-row%03d',value),?,value,?,1,1 FROM n",
      ).bind(pageId, member.user.id),
      env.DB.prepare(
        "INSERT INTO table_row_pages(row_id,page_id,created_at) SELECT id,?||'-desired-'||substr(id,-3),1 FROM table_rows WHERE page_id=?",
      ).bind(pageId, pageId),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,text_value,json_value,updated_at) SELECT row.id,col.id,printf('%08000d',0),json_quote(printf('%08000d',0)),1 FROM table_rows row JOIN table_columns col ON col.page_id=row.page_id WHERE row.page_id=?",
      ).bind(pageId),
    ]);
    await enableTableAuthority(env, member, pageId);
    await changeProjection(pageId, [
      {
        sql: "UPDATE table_row_pages SET page_id=?||'-old-'||substr(row_id,-3) WHERE row_id IN (SELECT id FROM table_rows WHERE page_id=?)",
        binds: [pageId, pageId],
      },
    ]);
    await runInDurableObject(env.TABLE.getByName(pageId), async (instance, state) => {
      const internal = instance as unknown as {
        rowProjection(...args: unknown[]): ProjectionStatement[];
        rowRevision(id: string): number;
        repairRowsStatements(rows: unknown[]): Promise<ProjectionStatement[][]>;
      };
      const projection = internal.rowProjection,
        revision = internal.rowRevision;
      let projections = 0,
        revisions = 0;
      internal.rowProjection = (...args) => {
        projections++;
        return projection.apply(internal, args);
      };
      internal.rowRevision = (rowId) => {
        revisions++;
        return revision.call(internal, rowId);
      };
      try {
        const batches = await internal.repairRowsStatements(
          state.storage.sql.exec("SELECT * FROM rows ORDER BY id").toArray(),
        );
        const links = batches.filter((batch) =>
          batch.some((statement) => /^(?:DELETE FROM|INSERT INTO) table_row_pages/.test(statement.sql)),
        );
        expect(links).toHaveLength(1);
        expect(links[0]!.at(0)!.sql).toContain("INSERT OR REPLACE INTO table_publication_guards");
        expect(links[0]!.at(-1)!.sql).toContain("INSERT OR REPLACE INTO table_publication_guards");
        expect(batches.length).toBeGreaterThan(3);
        expect(projections).toBe(80);
        expect(revisions).toBe(80);
      } finally {
        internal.rowProjection = projection;
        internal.rowRevision = revision;
      }
    });
    await env.DB.prepare(
      "CREATE TRIGGER fail_link_transaction BEFORE INSERT ON table_row_pages BEGIN SELECT RAISE(ABORT,'temporary_link_failure'); END",
    ).run();
    try {
      await requestRepairTableProjection(env, member, pageId);
      await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
      expect(
        await env.DB.prepare("SELECT count(*) count FROM table_row_pages WHERE instr(page_id,?)=1")
          .bind(`${pageId}-old-`)
          .first(),
      ).toEqual({ count: 80 });
      await env.DB.prepare("DROP TRIGGER fail_link_transaction").run();
      await env.DB.prepare(
        "CREATE TRIGGER fail_late_cells BEFORE INSERT ON table_cells WHEN NEW.row_id='repair-row079' BEGIN SELECT RAISE(ABORT,'temporary_late_cell_failure'); END",
      ).run();
      await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
      expect(
        await env.DB.prepare("SELECT count(*) count FROM table_row_pages WHERE instr(page_id,?)=1")
          .bind(`${pageId}-desired-`)
          .first(),
      ).toEqual({ count: 80 });
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const intent = JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value,
        ).repairIntent;
        expect(intent).toMatchObject({ phase: "rows" });
        expect(intent.rowCursor).toBeUndefined();
      });
      await env.DB.prepare("DROP TRIGGER fail_late_cells").run();
      await finishAlarmRepair(pageId);
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_link_transaction").run();
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_late_cells").run();
    }
  });
  it.each(["row", "option", "detail"])(
    "retains foreign %s ownership when it changes between repair reads and writes",
    async (kind) => {
      const { pageId, member } = await fixture(kind === "detail");
      const foreign = await fixture();
      await enableTableAuthority(env, member, pageId);
      let rowId = "owned-row",
        detailPageId: string | null = null;
      if (kind === "detail") {
        const task = await mutateTask(env, member, pageId, null, {
          operationId: "ownership-task",
          expectedRevision: 1,
          title: "Owned task",
        });
        rowId = task.rowId;
        detailPageId = task.detailPageId;
      } else {
        await write(pageId, member, "create_column", { id: "owned-column", name: "Owned", type: "select" });
        await write(pageId, member, "add_option", {
          columnId: "owned-column",
          id: "owned-option",
          label: "Owned label",
        });
        await write(pageId, member, "create_row", { id: rowId, values: { "owned-column": "owned-option" } });
      }
      await env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('foreign-column',?,'Foreign','select',0)",
      )
        .bind(foreign.pageId)
        .run();
      const stub = env.TABLE.getByName(pageId);
      await runInDurableObject(stub, async (instance, state) => {
        const internal = instance as unknown as { env: Env; resumeRepair(): Promise<unknown> };
        const original = internal.env;
        let moved = false;
        internal.env = {
          ...original,
          DB: new Proxy(original.DB, {
            get(target, property) {
              if (property === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  const phase = JSON.parse(
                    state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value,
                  ).repairIntent?.phase;
                  if (!moved && (kind === "option" || phase === "rows")) {
                    moved = true;
                    if (kind === "option")
                      await changeProjection(pageId, [
                        {
                          sql: "UPDATE table_select_options SET column_id='foreign-column',label='Foreign label' WHERE id='owned-option'",
                          binds: [],
                        },
                      ]);
                    else if (kind === "row")
                      await changeProjection(pageId, [
                        { sql: "DELETE FROM table_id_claims WHERE kind='row' AND id=?", binds: [rowId] },
                        { sql: "UPDATE table_rows SET page_id=? WHERE id=?", binds: [foreign.pageId, rowId] },
                      ]);
                    else
                      await original.DB.prepare("UPDATE pages SET workspace_id=? WHERE id=?")
                        .bind(foreign.member.workspace.id, detailPageId)
                        .run();
                  }
                  return target.batch(statements);
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
        try {
          const first = kind === "option" ? null : await internal.resumeRepair();
          expect(first).toEqual(kind === "option" ? null : { pending: true });
          await expect(internal.resumeRepair()).rejects.toMatchObject({ code: "table_projection_blocked" });
        } finally {
          internal.env = original;
        }
      });
      const actual =
        kind === "row"
          ? await env.DB.prepare("SELECT page_id FROM table_rows WHERE id=?").bind(rowId).first()
          : kind === "option"
            ? await env.DB.prepare("SELECT column_id,label FROM table_select_options WHERE id='owned-option'").first()
            : await env.DB.prepare("SELECT workspace_id FROM pages WHERE id=?").bind(detailPageId).first();
      const expected =
        kind === "row"
          ? { page_id: foreign.pageId }
          : kind === "option"
            ? { column_id: "foreign-column", label: "Foreign label" }
            : { workspace_id: foreign.member.workspace.id };
      expect(actual).toEqual(expected);
      expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing", generation: 1 });
    },
  );
  it("recovers newly created parents from steps completed earlier in the same drain", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "new-column", name: "New", type: "select" });
    await env.DB.prepare(
      "CREATE TRIGGER hold_new_parents BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    const stub = env.TABLE.getByName(pageId);
    try {
      const pending = await write(pageId, member, "bulk", {
        commands: [
          { kind: "add_option", payload: { columnId: "new-column", id: "new-option", label: "New option" } },
          { kind: "create_row", payload: { id: "new-row", values: { "new-column": "new-option" } } },
        ],
      });
      await runInDurableObject(stub, (_instance, state) => {
        const statements = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position>=0 ORDER BY position",
            pending.revision,
          )
          .toArray()
          .flatMap((step) => JSON.parse(step.value) as ProjectionStatement[]);
        const parents = statements.filter((statement) =>
          /^INSERT INTO table_(columns|select_options|rows)\(/.test(statement.sql),
        );
        const remaining = statements.filter((statement) => !parents.includes(statement));
        state.storage.sql.exec("DELETE FROM projection_steps WHERE revision=? AND position>=0", pending.revision);
        state.storage.sql.exec("INSERT INTO projection_steps VALUES(?,0,?)", pending.revision, JSON.stringify(parents));
        state.storage.sql.exec(
          "INSERT INTO projection_steps VALUES(?,1,?)",
          pending.revision,
          JSON.stringify(remaining),
        );
      });
      await env.DB.prepare("DROP TRIGGER hold_new_parents").run();
      await runInDurableObject(stub, async (instance) => {
        const internal = instance as unknown as { env: Env; project(recover: boolean): Promise<void> };
        const original = internal.env;
        let lost = false;
        internal.env = {
          ...original,
          DB: new Proxy(original.DB, {
            get(target, property) {
              if (property === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  const result = await target.batch(statements);
                  if (!lost) {
                    lost = true;
                    await changeProjection(pageId, [
                      { sql: "DELETE FROM table_columns WHERE id='new-column' AND page_id=?", binds: [pageId] },
                      { sql: "DELETE FROM table_rows WHERE id='new-row' AND page_id=?", binds: [pageId] },
                    ]);
                  }
                  return result;
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
        try {
          await internal.project(true);
        } finally {
          internal.env = original;
        }
      });
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
      expect((await queryTable(env, member, pageId)).rows[0]?.cells["new-column"]).toBe("new-option");
      expect((await queryTable(env, member, pageId)).columns[0]?.revision).toBe(2);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_new_parents").run();
    }
  });
  it("fragments an oversized Unicode preimage below the byte limit and reconstructs it exactly", async () => {
    const { pageId, member } = await fixture();
    const note = "雪".repeat(350000);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position,config_json) VALUES('large-column',?,'Large','text',0,?)",
      ).bind(pageId, JSON.stringify({ version: 1, note })),
      env.DB.prepare(
        "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) VALUES('large-row',?,0,?,1,1)",
      ).bind(pageId, member.user.id),
    ]);
    await enableTableAuthority(env, member, pageId);
    await env.DB.prepare(
      "CREATE TRIGGER hold_large_preimage BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "update_cells", {
        rowId: "large-row",
        values: { "large-column": "After" },
      });
      expect(pending.projectionPending).toBe(true);
      await addEffect(pageId, pending.revision);
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const chunks = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position<0 ORDER BY position DESC",
            pending.revision,
          )
          .toArray();
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => new TextEncoder().encode(chunk.value).byteLength <= 1000000)).toBe(true);
        const fragments = chunks
          .map((chunk) => JSON.parse(chunk.value))
          .filter((chunk) => typeof chunk.data === "string");
        const column = JSON.parse(fragments.map((chunk) => chunk.data).join(""));
        expect(JSON.parse(column.binds[column.columns.indexOf("config_json")]).note).toBe(note);
      });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_columns WHERE id='large-column' AND page_id=?", binds: [pageId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_large_preimage").run();
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
      expect((await queryTable(env, member, pageId)).rows[0]?.cells["large-column"]).toBe("After");
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_large_preimage").run();
    }
  });
  it("resumes a blocked pure rebuild without replaying completed bookkeeping", async () => {
    const { pageId, member } = await fixture();
    const foreign = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "old", name: "Old", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { old: "Before" } });
    await env.DB.prepare(
      "CREATE TRIGGER hold_pure_bookkeeping BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "update_cells", { rowId: "row-a", values: { old: "After" } });
      await write(pageId, member, "delete_column", { columnId: "old" });
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        state.storage.sql.exec("DELETE FROM projection_steps WHERE revision=? AND position<0", pending.revision);
        state.storage.sql.exec("UPDATE events SET value='[]' WHERE revision=?", pending.revision);
      });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_columns WHERE id='old' AND page_id=?", binds: [pageId] },
        { sql: "UPDATE table_rows SET page_id=? WHERE id='row-a'", binds: [foreign.pageId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_pure_bookkeeping").run();
      await env.DB.prepare("CREATE TABLE repair_bookkeeping_calls(value INTEGER)").run();
      await env.DB.prepare("INSERT INTO repair_bookkeeping_calls VALUES(0)").run();
      await env.DB.prepare(
        `CREATE TRIGGER count_pure_bookkeeping AFTER UPDATE OF updated_at ON pages WHEN NEW.id='${pageId}' BEGIN UPDATE repair_bookkeeping_calls SET value=value+1; END`,
      ).run();
      await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_blocked",
      });
      const count = await env.DB.prepare("SELECT value FROM repair_bookkeeping_calls").first();
      expect(count).toEqual({ value: 2 });
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const intent = JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value,
        ).repairIntent;
        expect(intent).toMatchObject({
          phase: "blocked",
          mode: "pure",
          generation: 1,
          blocked: { resumePhase: "rows" },
        });
        expect(intent.bookkeeping).toBeDefined();
      });
      await env.DB.prepare("DELETE FROM table_rows WHERE id='row-a' AND page_id=?").bind(foreign.pageId).run();
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
      expect(await env.DB.prepare("SELECT value FROM repair_bookkeeping_calls").first()).toEqual(count);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_pure_bookkeeping").run();
      await env.DB.prepare("DROP TRIGGER IF EXISTS count_pure_bookkeeping").run();
      await env.DB.prepare("DROP TABLE IF EXISTS repair_bookkeeping_calls").run();
    }
  });
  it.each([false, true])(
    "restores task links before the original status activity checkpoint (missing row=%s)",
    async (missingRow) => {
      const { pageId, member } = await fixture(true);
      await enableTableAuthority(env, member, pageId);
      const task = await mutateTask(env, member, pageId, null, {
        operationId: "activity-original",
        expectedRevision: 1,
        title: "Task",
      });
      const checkpoint = Date.now() + 86400000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(checkpoint);
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at) VALUES('status-installation',?,'STATUS','Status','STATUS-BOT','unused','chat:write',?,1,1)",
        ).bind(member.workspace.id, member.user.id),
        env.DB.prepare(
          "INSERT INTO slack_channel_subscriptions(id,installation_id,space_id,channel_id,event_types_json,cadence,created_by,created_at,updated_at,round2_initialized) SELECT 'status-mapping','status-installation',space_id,'STATUS-CHANNEL','[\"task_status_changed\"]','immediate',?,1,1,1 FROM pages WHERE id=?",
        ).bind(member.user.id, pageId),
      ]);
      await env.DB.prepare("UPDATE round2_runtime SET activity_enabled=1 WHERE id=1").run();
      await env.DB.prepare(
        "CREATE TRIGGER hold_status_recovery BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
      ).run();
      try {
        await expect(
          mutateTask(env, member, pageId, task.rowId, {
            operationId: "activity-pending",
            expectedRevision: 2,
            status: "doing",
          }),
        ).rejects.toMatchObject({ code: "task_projection_pending" });
        await changeProjection(
          pageId,
          missingRow
            ? [{ sql: "DELETE FROM table_rows WHERE id=? AND page_id=?", binds: [task.rowId, pageId] }]
            : [
                { sql: "DELETE FROM table_row_pages WHERE row_id=?", binds: [task.rowId] },
                { sql: "DELETE FROM table_select_options WHERE id=?", binds: [`${pageId}-doing`] },
              ],
        );
        await env.DB.prepare("DROP TRIGGER hold_status_recovery").run();
        clock.mockReturnValue(checkpoint + 1000);
        await runInDurableObject(env.TABLE.getByName(pageId), (instance) =>
          (instance as unknown as { project(recover: boolean): Promise<boolean> }).project(true),
        );
        expect(
          (
            await env.DB.prepare(
              "SELECT event_type FROM workspace_activity WHERE page_id=? AND event_type='task_status_changed'",
            )
              .bind(task.detailPageId)
              .all()
          ).results,
        ).toEqual([{ event_type: "task_status_changed" }]);
        const deliveries = await env.DB.prepare(
          "SELECT a.id,a.created_at,e.id AS delivery,o.id AS queued FROM workspace_activity a JOIN slack_channel_events e ON e.id='activity:'||a.id||':status-mapping' JOIN outbox o ON o.id='outbox:'||e.id WHERE a.page_id=? AND a.event_type='task_status_changed' ORDER BY a.created_at",
        )
          .bind(task.detailPageId)
          .all<{ id: string; created_at: number; delivery: string; queued: string }>();
        expect(deliveries.results).toHaveLength(1);
        expect(deliveries.results[0]!.created_at).toBe(checkpoint);
        expect(
          await env.DB.prepare("SELECT page_id FROM table_row_pages WHERE row_id=?").bind(task.rowId).first(),
        ).toEqual({ page_id: task.detailPageId });
        await mutateTask(env, member, pageId, task.rowId, {
          operationId: "activity-later",
          expectedRevision: 3,
          title: "Task",
          status: "done",
        });
        expect(
          await env.DB.prepare("SELECT id,created_at FROM workspace_activity WHERE id=?")
            .bind(deliveries.results[0]!.id)
            .first(),
        ).toEqual({ id: deliveries.results[0]!.id, created_at: checkpoint });
        expect(
          await env.DB.prepare(
            "SELECT count(*) count FROM workspace_activity a JOIN slack_channel_events e ON e.id='activity:'||a.id||':status-mapping' JOIN outbox o ON o.id='outbox:'||e.id WHERE a.page_id=? AND a.event_type='task_status_changed'",
          )
            .bind(task.detailPageId)
            .first(),
        ).toEqual({ count: 2 });
        if (missingRow) await repairTableProjection(env, member, pageId);
        expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
      } finally {
        clock.mockRestore();
        await env.DB.prepare("DROP TRIGGER IF EXISTS hold_status_recovery").run();
        await env.DB.prepare("UPDATE round2_runtime SET activity_enabled=0 WHERE id=1").run();
      }
    },
  );
  it("finishes link prerequisites across continuations and revalidates lost prefixes before status activity", async () => {
    const { pageId, member } = await fixture(true);
    await env.DB.prepare("UPDATE round2_runtime SET activity_enabled=0 WHERE id=1").run();
    await env.DB.batch([
      env.DB.prepare(
        "WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM n WHERE value<99) INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,updated_by,created_at,updated_at) SELECT list.id||'-recovery-'||printf('%03d',n.value),list.workspace_id,list.space_id,list.id,'document',printf('a%03d',n.value),'Task',?,?,1,1 FROM n JOIN pages list ON list.id=?",
      ).bind(member.user.id, member.user.id, pageId),
      env.DB.prepare(
        "WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM n WHERE value<99) INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) SELECT printf('recovery-row%03d',value),?,value,?,1,1 FROM n",
      ).bind(pageId, member.user.id),
      env.DB.prepare(
        "INSERT INTO table_row_pages(row_id,page_id,created_at) SELECT id,?||'-recovery-'||substr(id,-3),1 FROM table_rows WHERE page_id=?",
      ).bind(pageId, pageId),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,select_value,json_value,updated_at) SELECT id,?||'-status',?||'-todo',json_quote(?||'-todo'),1 FROM table_rows WHERE page_id=?",
      ).bind(pageId, pageId, pageId, pageId),
    ]);
    await enableTableAuthority(env, member, pageId);
    await env.DB.prepare(
      "CREATE TRIGGER hold_many_statuses BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    const stub = env.TABLE.getByName(pageId);
    try {
      const pending = await tableCommand(
        env,
        member,
        pageId,
        {
          kind: "bulk",
          operationId: "many-statuses",
          payload: {
            commands: Array.from({ length: 100 }, (_v, i) => ({
              kind: "update_cells",
              payload: {
                rowId: `recovery-row${i.toString().padStart(3, "0")}`,
                values: { [`${pageId}-status`]: `${pageId}-doing` },
              },
            })),
          },
        },
        { taskMutation: true },
      );
      const checkpoint = (await queryTable(env, member, pageId)).rows[0]!.editedAt;
      await changeProjection(pageId, [{ sql: "DELETE FROM table_rows WHERE page_id=?", binds: [pageId] }]);
      await env.DB.prepare("DROP TRIGGER hold_many_statuses").run();
      await env.DB.prepare("UPDATE round2_runtime SET activity_enabled=1 WHERE id=1").run();
      expect(
        await runInDurableObject(stub, (instance) =>
          (instance as unknown as { project(recover: boolean): Promise<boolean> }).project(true),
        ),
      ).toBe(false);
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_row_pages WHERE row_id='recovery-row000'", binds: [] },
      ]);
      await expect(
        runInDurableObject(stub, (instance) =>
          (instance as unknown as { project(recover: boolean): Promise<boolean> }).project(true),
        ),
      ).rejects.toMatchObject({ code: "table_projection_blocked" });
      await runInDurableObject(stub, (_instance, state) => {
        const event = state.storage.sql
          .exec<{ value: string; next_step: number }>(
            "SELECT value,next_step FROM events WHERE revision=?",
            pending.revision,
          )
          .one();
        expect(JSON.parse(event.value).recovery).toBeUndefined();
        expect(JSON.parse(event.value).recoveryRequired).toEqual({
          generation: 1,
          revision: pending.revision,
          position: 0,
        });
        expect(event.next_step).toBe(0);
      });
      expect(
        await env.DB.prepare(
          "SELECT count(*) count FROM workspace_activity WHERE workspace_id=? AND event_type='task_status_changed'",
        )
          .bind(member.workspace.id)
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await runInDurableObject(stub, (instance) =>
          (instance as unknown as { project(recover: boolean): Promise<boolean> }).project(true),
        ),
      ).toBe(false);
      expect(
        await runInDurableObject(stub, (instance) =>
          (instance as unknown as { project(recover: boolean): Promise<boolean> }).project(true),
        ),
      ).toBe(true);
      expect(
        await env.DB.prepare(
          "SELECT count(*) count FROM workspace_activity WHERE workspace_id=? AND event_type='task_status_changed' AND created_at=?",
        )
          .bind(member.workspace.id, checkpoint)
          .first(),
      ).toEqual({ count: 100 });
      expect(
        await env.DB.prepare(
          "SELECT count(*) count FROM table_row_pages WHERE row_id IN (SELECT id FROM table_rows WHERE page_id=?)",
        )
          .bind(pageId)
          .first(),
      ).toEqual({ count: 100 });
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_many_statuses").run();
      await env.DB.prepare("UPDATE round2_runtime SET activity_enabled=0 WHERE id=1").run();
    }
  });
  it("rejects a foreign row claim even when the recovered task's parent row exists", async () => {
    const { pageId, member } = await fixture(true);
    const foreign = await fixture();
    await enableTableAuthority(env, member, pageId);
    const task = await mutateTask(env, member, pageId, null, {
      operationId: "claim-task",
      expectedRevision: 1,
      title: "Task",
    });
    await env.DB.prepare(
      "CREATE TRIGGER hold_claim_recovery BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      await expect(
        mutateTask(env, member, pageId, task.rowId, {
          operationId: "claim-status",
          expectedRevision: 2,
          status: "doing",
        }),
      ).rejects.toMatchObject({ code: "task_projection_pending" });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_row_pages WHERE row_id=?", binds: [task.rowId] },
        { sql: "DELETE FROM table_select_options WHERE id=?", binds: [`${pageId}-doing`] },
        { sql: "UPDATE table_id_claims SET page_id=? WHERE kind='row' AND id=?", binds: [foreign.pageId, task.rowId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_claim_recovery").run();
      await expect(repairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_blocked",
      });
      expect(await env.DB.prepare("SELECT page_id FROM table_rows WHERE id=?").bind(task.rowId).first()).toEqual({
        page_id: pageId,
      });
      expect(
        await env.DB.prepare("SELECT page_id FROM table_id_claims WHERE kind='row' AND id=?").bind(task.rowId).first(),
      ).toEqual({ page_id: foreign.pageId });
      expect(
        await env.DB.prepare("SELECT page_id FROM table_row_pages WHERE row_id=?").bind(task.rowId).first(),
      ).toBeNull();
      expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing", projected_revision: 2 });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_claim_recovery").run();
    }
  });
  it("cancels an atomic publication when its original guard fails after foreign-key recovery", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "choice", name: "Choice", type: "select" });
    await write(pageId, member, "add_option", { columnId: "choice", id: "done", label: "Done" });
    await env.DB.prepare(
      "CREATE TRIGGER hold_cancellable_fk BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await tableCommand(
        env,
        member,
        pageId,
        {
          kind: "create_row",
          operationId: "cancellable-fk",
          payload: { id: "unpublished-row", values: { choice: "done" } },
        },
        {
          effectsAfter: [
            { sql: "INSERT OR REPLACE INTO table_publication_guards(page_id,ok) VALUES(?,0)", binds: [pageId] },
          ],
          cancelRowOnPublicationFailure: "unpublished-row",
        },
      );
      expect(pending.projectionPending).toBe(true);
      await changeProjection(pageId, [{ sql: "DELETE FROM table_select_options WHERE id='done'", binds: [] }]);
      await env.DB.prepare("DROP TRIGGER hold_cancellable_fk").run();
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
      expect((await queryTable(env, member, pageId)).rowCount).toBe(0);
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const receipt = JSON.parse(
          state.storage.sql
            .exec<{ result: string }>("SELECT result FROM receipts WHERE operation_id='cancellable-fk'")
            .one().result,
        );
        expect(receipt.result.publicationFailed).toBe(true);
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_cancellable_fk").run();
    }
  });
  it("promotes a joined ordinary drain to recovery after the original foreign-key failure", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { title: "Before" } });
    await env.DB.prepare(
      "CREATE TRIGGER hold_joined_drain BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      await write(pageId, member, "update_cells", { rowId: "row-a", values: { title: "After" } });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_columns WHERE id='title' AND page_id=?", binds: [pageId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_joined_drain").run();
      await runInDurableObject(env.TABLE.getByName(pageId), async (instance) => {
        const internal = instance as unknown as { env: Env; project(recover?: boolean): Promise<boolean> };
        const original = internal.env;
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const resumed = new Promise<void>((resolve) => {
          release = resolve;
        });
        let delayed = false;
        internal.env = {
          ...original,
          DB: new Proxy(original.DB, {
            get(target, property) {
              if (property === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  if (!delayed) {
                    delayed = true;
                    entered();
                    await resumed;
                  }
                  return target.batch(statements);
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
        try {
          const ordinary = internal.project();
          await started;
          const recovery = internal.project(true);
          release();
          const outcomes = await Promise.allSettled([ordinary, recovery]);
          expect(outcomes[0]).toMatchObject({ status: "rejected" });
          expect(outcomes[1]).toEqual({ status: "fulfilled", value: true });
        } finally {
          internal.env = original;
        }
      });
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_joined_drain").run();
    }
  });
  it("continues missing-parent recovery in durable batches before advancing the event", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "number", name: "Number", type: "number" });
    await writeRows(
      pageId,
      member,
      Array.from({ length: 205 }, (_v, index) => ({
        kind: "create_row",
        payload: { id: `bounded-${index.toString().padStart(3, "0")}`, values: { number: index } },
      })),
    );
    await env.DB.prepare(
      "CREATE TRIGGER hold_bounded_parents BEFORE INSERT ON table_computed_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "create_column", {
        id: "formula",
        name: "Formula",
        type: "formula",
        source: 'prop("Number") * 2',
      });
      await addEffect(pageId, pending.revision);
      await changeProjection(pageId, [{ sql: "DELETE FROM table_rows WHERE page_id=?", binds: [pageId] }]);
      await env.DB.prepare("DROP TRIGGER hold_bounded_parents").run();
      const requests = await runInDurableObject(env.TABLE.getByName(pageId), async (instance) => {
        const internal = instance as unknown as { env: Env; resumeRepair(): Promise<unknown> };
        const original = internal.env;
        let prepared = 0;
        internal.env = {
          ...original,
          DB: new Proxy(original.DB, {
            get(target, property) {
              if (property === "prepare")
                return (sql: string) => {
                  prepared++;
                  return target.prepare(sql);
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
        try {
          expect(await internal.resumeRepair()).toEqual({ pending: true });
          return prepared;
        } finally {
          internal.env = original;
        }
      });
      expect(requests).toBeLessThan(50);
      expect(
        await env.DB.prepare("SELECT count(*) count FROM table_rows WHERE page_id=?").bind(pageId).first(),
      ).toEqual({ count: 100 });
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const event = state.storage.sql
          .exec<{ value: string; next_step: number }>(
            "SELECT value,next_step FROM events WHERE revision=?",
            pending.revision,
          )
          .one();
        expect(event.next_step).toBe(0);
        expect(JSON.parse(event.value).recovery).toMatchObject({
          generation: 1,
          revision: pending.revision,
          position: 0,
          table: "table_rows",
        });
        expect(
          JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value)
            .projectedRevision,
        ).toBe(pending.revision - 1);
      });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_rows WHERE id='bounded-000' AND page_id=?", binds: [pageId] },
      ]);
      await requestRepairTableProjection(env, member, pageId);
      await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_blocked",
      });
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const event = state.storage.sql
          .exec<{ value: string; next_step: number }>(
            "SELECT value,next_step FROM events WHERE revision=?",
            pending.revision,
          )
          .one();
        expect(JSON.parse(event.value).recovery).toBeUndefined();
        expect(event.next_step).toBe(0);
      });
      await expect(requestRepairTableProjection(env, member, pageId)).resolves.toMatchObject({
        repair: { state: "pending" },
        verification: null,
      });
      await finishAlarmRepair(pageId);
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_bounded_parents").run();
    }
  });
  it.each(["generation", "revision", "position"] as const)(
    "blocks a recovery cursor with a mismatched %s and clears it on owner retry",
    async (field) => {
      const { pageId, member } = await fixture();
      await enableTableAuthority(env, member, pageId);
      await write(pageId, member, "create_column", { id: "cursor-title", name: "Title", type: "text" });
      await write(pageId, member, "create_row", { id: "cursor-row", values: { "cursor-title": "Before" } });
      await env.DB.prepare(
        "CREATE TRIGGER hold_cursor_validation BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
      ).run();
      try {
        const pending = await write(pageId, member, "update_cells", {
          rowId: "cursor-row",
          values: { "cursor-title": "After" },
        });
        await addEffect(pageId, pending.revision);
        await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
          const event = state.storage.sql
            .exec<{ value: string }>("SELECT value FROM events WHERE revision=?", pending.revision)
            .one();
          const recovery = {
            generation: 1,
            revision: pending.revision,
            position: 0,
            table: "table_rows",
            key: "table_rows:cursor-row",
          };
          recovery[field]++;
          state.storage.sql.exec(
            "UPDATE events SET value=? WHERE revision=?",
            JSON.stringify({ ...JSON.parse(event.value), recovery }),
            pending.revision,
          );
        });
        await changeProjection(pageId, [
          { sql: "DELETE FROM table_columns WHERE id='cursor-title' AND page_id=?", binds: [pageId] },
        ]);
        await env.DB.prepare("DROP TRIGGER hold_cursor_validation").run();
        await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({
          code: "table_projection_blocked",
        });
        expect(await tableRepairStatus(env, pageId)).toMatchObject({ state: "blocked", phase: "blocked" });
        expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(pageId).first()).toEqual({
          title: "Tasks",
        });
        expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
        expect(await env.DB.prepare("SELECT title FROM pages WHERE id=?").bind(pageId).first()).toEqual({
          title: "Tasks effect",
        });
      } finally {
        await env.DB.prepare("DROP TRIGGER IF EXISTS hold_cursor_validation").run();
      }
    },
  );
  it("does not cancel a row for an unrelated error mentioning the publication constraint", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "error-title", name: "Title", type: "text" });
    await env.DB.prepare(
      "CREATE TRIGGER unrelated_publication_error BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary table_publication_conflict from another subsystem'); END",
    ).run();
    try {
      const result = await tableCommand(
        env,
        member,
        pageId,
        {
          kind: "create_row",
          operationId: "unrelated-error",
          payload: { id: "unrelated-row", values: { "error-title": "Keep" } },
        },
        { cancelRowOnPublicationFailure: "unrelated-row" },
      );
      expect(result.projectionPending).toBe(true);
      expect(result.result.publicationFailed).toBeUndefined();
      expect((await queryTable(env, member, pageId)).rowCount).toBe(1);
      await env.DB.prepare("DROP TRIGGER unrelated_publication_error").run();
      await runDurableObjectAlarm(env.TABLE.getByName(pageId));
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS unrelated_publication_error").run();
    }
  });
  it("blocks a multi-step cancellable artifact before legacy normalization can merge it", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "atomic-title", name: "Title", type: "text" });
    await env.DB.prepare(
      "CREATE TRIGGER hold_atomic_artifact BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await tableCommand(
        env,
        member,
        pageId,
        {
          kind: "create_row",
          operationId: "multi-step-cancel",
          payload: { id: "atomic-row", values: { "atomic-title": "Keep" } },
        },
        { cancelRowOnPublicationFailure: "atomic-row" },
      );
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const step = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position=0",
            pending.revision,
          )
          .one();
        const statements = JSON.parse(step.value) as ProjectionStatement[];
        state.storage.sql.exec(
          "UPDATE projection_steps SET value=? WHERE revision=? AND position=0",
          JSON.stringify(statements.slice(0, 1)),
          pending.revision,
        );
        state.storage.sql.exec(
          "INSERT INTO projection_steps VALUES(?,1,?)",
          pending.revision,
          JSON.stringify(statements.slice(1)),
        );
        state.storage.sql.exec("UPDATE events SET value='[]' WHERE revision=?", pending.revision);
      });
      await env.DB.prepare("DROP TRIGGER hold_atomic_artifact").run();
      await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_blocked",
      });
      expect((await queryTable(env, member, pageId)).rowCount).toBe(1);
      expect(await tableRegistryForTest(pageId)).toMatchObject({ projected_revision: pending.revision - 1 });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_atomic_artifact").run();
    }
  });
  it("blocks an originally atomic cancellable artifact that normalization splits before any D1 effects", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "split-title", name: "Title", type: "text" });
    await env.DB.prepare(
      "CREATE TRIGGER hold_split_artifact BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await tableCommand(
        env,
        member,
        pageId,
        {
          kind: "create_row",
          operationId: "split-cancel",
          payload: { id: "split-row", values: { "split-title": "Keep" } },
        },
        { cancelRowOnPublicationFailure: "split-row" },
      );
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const statements = JSON.parse(
          state.storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM projection_steps WHERE revision=? AND position=0",
              pending.revision,
            )
            .one().value,
        ) as ProjectionStatement[];
        const sql = statements.find((statement) => statement.sql.startsWith("INSERT INTO table_cells("))!.sql;
        const content = '"'.repeat(1000);
        const expanded = Array.from({ length: 100 }, () => ({
          sql,
          binds: ["split-row", "split-title", content, content, null, null, null, null, JSON.stringify(content), 1, 1],
        }));
        expect(new TextEncoder().encode(JSON.stringify(expanded)).byteLength).toBeLessThan(1_000_000);
        state.storage.sql.exec(
          "UPDATE projection_steps SET value=? WHERE revision=? AND position=0",
          JSON.stringify(expanded),
          pending.revision,
        );
        state.storage.sql.exec("UPDATE events SET value='[]' WHERE revision=?", pending.revision);
      });
      await env.DB.prepare("DROP TRIGGER hold_split_artifact").run();
      await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({
        code: "table_projection_blocked",
      });
      expect((await queryTable(env, member, pageId)).rows[0]?.cells["split-title"]).toBe("Keep");
      expect(await tableRegistryForTest(pageId)).toMatchObject({ projected_revision: pending.revision - 1 });
      expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id='split-row'").first()).toBeNull();
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT count(*) count FROM projection_steps WHERE revision=? AND position>=0", pending.revision)
            .one(),
        ).toEqual({ count: 2 });
        expect(state.storage.sql.exec("SELECT next_step FROM events WHERE revision=?", pending.revision).one()).toEqual(
          { next_step: 0 },
        );
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_split_artifact").run();
    }
  });
  it("preserves a published canonical row when an atomic commit acknowledgment reports a conflict", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await env.DB.prepare(
      "CREATE TRIGGER hold_lost_publication BEFORE INSERT ON table_rows BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await tableCommand(
        env,
        member,
        pageId,
        {
          kind: "create_row",
          operationId: "lost-publication",
          payload: { id: "published-row" },
        },
        { cancelRowOnPublicationFailure: "published-row" },
      );
      await env.DB.prepare("DROP TRIGGER hold_lost_publication").run();
      await runInDurableObject(env.TABLE.getByName(pageId), async (instance, state) => {
        const internal = instance as unknown as { env: Env; project(): Promise<boolean> },
          original = internal.env;
        let committed = false;
        internal.env = {
          ...original,
          DB: new Proxy(original.DB, {
            get(target, property) {
              if (property === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  const result = await target.batch(statements);
                  if (!committed) {
                    committed = true;
                    throw Object.assign(new Error("Lost committed publication acknowledgment"), {
                      status: 409,
                      code: "table_publication_conflict",
                    });
                  }
                  return result;
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
        try {
          await expect(internal.project()).rejects.toMatchObject({ code: "table_publication_conflict" });
          expect(state.storage.sql.exec("SELECT id FROM rows WHERE id='published-row'").one()).toEqual({
            id: "published-row",
          });
          expect(
            state.storage.sql.exec("SELECT next_step FROM events WHERE revision=?", pending.revision).one(),
          ).toEqual({ next_step: 0 });
          const receipt = JSON.parse(
            state.storage.sql
              .exec<{ result: string }>("SELECT result FROM receipts WHERE operation_id='lost-publication'")
              .one().result,
          );
          expect(receipt.result.publicationFailed).toBeUndefined();
          expect(await tableRegistryForTest(pageId)).toMatchObject({ projected_revision: pending.revision });
        } finally {
          internal.env = original;
        }
      });
      expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id='published-row'").first()).toEqual({
        id: "published-row",
      });
      expect((await queryTable(env, member, pageId)).rowCount).toBe(1);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_lost_publication").run();
    }
  });
  it("bounds header validation and publication to100 entities per repair turn", async () => {
    const { pageId, member } = await fixture();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position,config_json) VALUES('many-options',?,'Options','select',0,'{}')",
      ).bind(pageId),
      env.DB.prepare(
        "WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM n WHERE value<249) INSERT INTO table_select_options(id,column_id,label,color,position) SELECT printf('header-option-%03d',value),'many-options',printf('Option %d',value),'gray',value FROM n",
      ),
    ]);
    await enableTableAuthority(env, member, pageId);
    const requests = await runInDurableObject(env.TABLE.getByName(pageId), async (instance, state) => {
      const internal = instance as unknown as { env: Env; resumeRepair(): Promise<unknown> };
      const original = internal.env;
      let prepared = 0;
      internal.env = {
        ...original,
        DB: new Proxy(original.DB, {
          get(target, property) {
            if (property === "prepare")
              return (sql: string) => {
                prepared++;
                return target.prepare(sql);
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
      try {
        expect(await internal.resumeRepair()).toEqual({ pending: true });
        const meta = JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value,
        );
        expect(meta).toMatchObject({
          projectedRevision: 1,
          repairIntent: { phase: "headers", headerFormat: 1, headerStep: 1 },
        });
        return prepared;
      } finally {
        internal.env = original;
      }
    });
    expect(requests).toBeLessThan(30);
    expect(
      await env.DB.prepare("SELECT count(*) count FROM table_select_options WHERE column_id='many-options'").first(),
    ).toEqual({ count: 96 });
    await finishAlarmRepair(pageId);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it("checkpoints discarded pure SQL only at bounded traversal boundaries", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "old", name: "Old", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { old: "Before" } });
    await env.DB.prepare(
      "CREATE TRIGGER hold_pure_quantum BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "update_cells", { rowId: "row-a", values: { old: "After" } });
      await write(pageId, member, "delete_column", { columnId: "old" });
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const step = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position=0",
            pending.revision,
          )
          .one();
        const statements = JSON.parse(step.value) as ProjectionStatement[];
        const cell = statements.find((statement) => statement.sql.startsWith("INSERT INTO table_cells("))!;
        const effects = statements.filter(
          (statement) =>
            statement.sql.startsWith("INSERT INTO page_contributors") ||
            statement.sql.startsWith("UPDATE pages SET updated_by="),
        );
        state.storage.sql.exec("DELETE FROM projection_steps WHERE revision=?", pending.revision);
        state.storage.sql.exec(
          "INSERT INTO projection_steps VALUES(?,0,?)",
          pending.revision,
          JSON.stringify([...Array.from({ length: 110 }, () => cell), ...effects]),
        );
        state.storage.sql.exec(
          "UPDATE events SET value=? WHERE revision=?",
          JSON.stringify({ projectionFormat: 2 }),
          pending.revision,
        );
      });
      await changeProjection(pageId, [
        { sql: "DELETE FROM table_columns WHERE id='old' AND page_id=?", binds: [pageId] },
      ]);
      await env.DB.prepare("DROP TRIGGER hold_pure_quantum").run();
      const writes = await runInDurableObject(env.TABLE.getByName(pageId), async (instance, state) => {
        const internal = instance as unknown as { putMeta(meta: unknown): void; resumeRepair(): Promise<unknown> };
        const original = internal.putMeta;
        let count = 0;
        internal.putMeta = (meta) => {
          count++;
          original.call(internal, meta);
        };
        try {
          expect(await internal.resumeRepair()).toEqual({ pending: true });
          const meta = JSON.parse(
            state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value,
          );
          expect(meta).toMatchObject({
            projectedRevision: pending.revision - 1,
            repairIntent: {
              mode: "pure",
              phase: "bookkeeping",
              bookkeeping: { revision: pending.revision, position: 0, statement: 99 },
            },
          });
          return count;
        } finally {
          internal.putMeta = original;
        }
      });
      expect(writes).toBeLessThan(8);
      await finishAlarmRepair(pageId);
      expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_pure_quantum").run();
    }
  });
  it("captures only touched-row preimages for a bulk without formulas", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await writeRows(
      pageId,
      member,
      Array.from({ length: 150 }, (_v, index) => ({
        kind: "create_row",
        payload: { id: `untouched-${index}`, values: { title: "Before" } },
      })),
    );
    await env.DB.prepare(
      "CREATE TRIGGER hold_sparse_bulk BEFORE INSERT ON table_cells BEGIN SELECT RAISE(ABORT,'temporary_failure'); END",
    ).run();
    try {
      const pending = await write(pageId, member, "bulk", {
        commands: [{ kind: "update_cells", payload: { rowId: "untouched-0", values: { title: "After" } } }],
      });
      await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
        const records = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM projection_steps WHERE revision=? AND position<0",
            pending.revision,
          )
          .toArray()
          .flatMap((chunk) => JSON.parse(chunk.value).records);
        expect(records.filter((record: { table: string }) => record.table === "table_rows")).toHaveLength(1);
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS hold_sparse_bulk").run();
    }
  });
  it("parks repair after one automatic rebuild and permits an explicit owner reset", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    await write(pageId, member, "create_column", { id: "title", name: "Title", type: "text" });
    await write(pageId, member, "create_row", { id: "row-a", values: { title: "Canonical" } });
    await env.DB.prepare(
      "CREATE TRIGGER permanent_parity_mismatch AFTER INSERT ON table_cells BEGIN UPDATE table_cells SET text_value='Corrupt',json_value=json_quote('Corrupt') WHERE row_id=NEW.row_id AND column_id=NEW.column_id; END",
    ).run();
    const stub = env.TABLE.getByName(pageId);
    try {
      await expect(requestRepairTableProjection(env, member, pageId)).resolves.toMatchObject({
        repair: { state: "pending" },
        verification: null,
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        const intent = JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value,
        ).repairIntent;
        expect(intent).toMatchObject({ phase: "headers", mismatches: 1 });
        expect(intent.hashes.canonicalHash).not.toBe(intent.hashes.projectionHash);
      });
      // An explicit owner retry resets the budget even before repair is parked.
      await expect(requestRepairTableProjection(env, member, pageId)).resolves.toMatchObject({
        repair: { state: "pending" },
        verification: null,
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value)
            .repairIntent,
        ).toMatchObject({ phase: "headers", mismatches: 1 });
      });
      await finishAlarmRepair(pageId);
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (_instance, state) => {
        const intent = JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value,
        ).repairIntent;
        expect(intent).toMatchObject({ phase: "blocked", mismatches: 2, blocked: { resumePhase: "headers" } });
        expect(await state.storage.getAlarm()).toBeNull();
      });
      expect(await runDurableObjectAlarm(stub)).toBe(false);
      await env.DB.prepare("DROP TRIGGER permanent_parity_mismatch").run();
      expect((await repairTableProjection(env, member, pageId)).projectionMatches).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS permanent_parity_mismatch").run();
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
        if (phase === "rows" || phase === "verify") await requestRepairTableProjection(env, member, pageId);
        if (phase === "verify") await runDurableObjectAlarm(env.TABLE.getByName(pageId));
        await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
        await expect(write(pageId, member, "save_view", { name: "Blocked" })).rejects.toMatchObject({
          code: "table_projection_repairing",
        });
        await runInDurableObject(env.TABLE.getByName(pageId), (_instance, state) => {
          const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
          expect(meta.repairIntent).toMatchObject({ phase: phase === "verify" ? "publish" : phase, generation: 1 });
        });
        await env.DB.prepare("DROP TRIGGER interrupted_repair").run();
        if (phase === "rows" || phase === "verify")
          await env.DB.prepare(
            "CREATE TRIGGER completed_repair_row BEFORE DELETE ON table_rows WHEN OLD.id='row-a' BEGIN SELECT RAISE(ABORT,'completed_row_must_not_reset'); END",
          ).run();
        const stub = env.TABLE.getByName(pageId);
        await evictDurableObject(stub);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        await finishAlarmRepair(pageId);
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
      await requestRepairTableProjection(env, member, pageId);
      await runDurableObjectAlarm(stub);
      await runInDurableObject(stub, async (instance, state) => {
        const clock = Date.now() + 1_000_000,
          now = vi.spyOn(Date, "now").mockReturnValue(clock);
        try {
          const response = await instance.fetch(
            new Request("https://table.internal/repair", {
              method: "POST",
              headers: { "x-table-internal": env.BETTER_AUTH_SECRET },
              body: "{}",
            }),
          );
          expect(response.status).toBe(202);
          expect(await response.json()).toMatchObject({
            repair: { state: "pending", phase: "headers" },
            verification: null,
          });
          expect(await state.storage.getAlarm()).toBe(clock + 1000);
        } finally {
          now.mockRestore();
        }
      });
      expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing", generation: 1 });
      await runInDurableObject(stub, (_instance, state) => {
        const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta").one().value);
        expect(meta.repairIntent).toMatchObject({ generation: 1, phase: "headers", revision: 3, headerStep: 0 });
        expect(state.storage.sql.exec("SELECT count(*) count FROM receipts").one()).toEqual({ count: 2 });
      });
      await expect(write(pageId, member, "save_view", { name: "Blocked" })).rejects.toMatchObject({
        code: "table_projection_repairing",
      });
      expect((await queryTable(env, member, pageId)).rows[0]?.cells.title).toBe("Canonical");
      await env.DB.prepare("DROP TRIGGER corrupt_repair_projection").run();
      await evictDurableObject(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await finishAlarmRepair(pageId);
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
      await requestRepairTableProjection(env, member, pageId);
      await runDurableObjectAlarm(stub);
      await expect(requestRepairTableProjection(env, member, pageId)).rejects.toMatchObject({ status: 500 });
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
        expect(meta.repairIntent).toMatchObject({ generation: 1, phase: "publish", revision: 3 });
        expect(state.storage.sql.exec("SELECT count(*) count FROM receipts").one()).toEqual({ count: 2 });
      });
      expect(await env.DB.prepare("SELECT text_value FROM table_cells WHERE row_id='row-a'").first()).toEqual({
        text_value: "Canonical",
      });
      await env.DB.prepare("UPDATE table_authority SET generation=1 WHERE page_id=?").bind(pageId).run();
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await finishAlarmRepair(pageId);
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
    await expect(requestRepairTableProjection(env, member, pageId)).resolves.toMatchObject({
      repair: { state: "pending" },
      verification: null,
    });
    expect(await tableRegistryForTest(pageId)).toMatchObject({ state: "repairing" });
    expect(await env.DB.prepare("SELECT count(*) count FROM table_rows WHERE page_id=?").bind(pageId).first()).toEqual({
      count: 105,
    });
    expect(await runDurableObjectAlarm(env.TABLE.getByName(pageId))).toBe(true);
    await finishAlarmRepair(pageId);
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
    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(pageId).run();
    const deletion = await acceptPageDeletion(env, member.workspace.id, member.user.id, pageId);
    await processDeletionJob(env, deletion.jobId);
    await expect(tableInternal(env, pageId, "/verify")).rejects.toMatchObject({ code: "table_purged" });
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
  it("rejects stale seed uploads and leaves committed cells and computed stamps unchanged", async () => {
    const { pageId, member } = await fixture();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('seed-number',?,'Number','number',0)",
      ).bind(pageId),
      env.DB.prepare(
        "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) VALUES('seed-row',?,0,?,1,1)",
      ).bind(pageId, member.user.id),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,number_value,updated_at) VALUES('seed-row','seed-number',1,1)",
      ),
    ]);
    await enableTableAuthority(env, member, pageId);
    const baseline = (await queryTable(env, member, pageId)).rows;
    await write(pageId, member, "create_column", {
      id: "seed-formula",
      name: "Formula",
      type: "formula",
      source: 'prop("Number") * 2',
    });
    await write(pageId, member, "update_cells", { rowId: "seed-row", values: { "seed-number": 7 } });
    const current = await queryTable(env, member, pageId);
    await expect(tableInternal(env, pageId, "/seed-rows", { generation: 1, rows: baseline })).rejects.toMatchObject({
      status: 409,
      code: "table_seed_conflict",
    });
    await expect(tableInternal(env, pageId, "/seed-finish", {})).rejects.toMatchObject({
      status: 409,
      code: "table_seed_conflict",
    });
    expect(await queryTable(env, member, pageId)).toEqual(current);
    expect((await verifyTableProjection(env, pageId)).projectionMatches).toBe(true);
  });
  it("verifies a completed event-free seed without performing another projection write", async () => {
    const { pageId, member } = await fixture();
    await enableTableAuthority(env, member, pageId);
    const before = await tableInternal(env, pageId, "/verify");
    await env.DB.prepare(
      "CREATE TRIGGER completed_seed_readonly BEFORE INSERT ON table_projection_context BEGIN SELECT RAISE(ABORT,'completed_seed_must_be_readonly'); END",
    ).run();
    try {
      expect(await tableInternal(env, pageId, "/seed-finish", {})).toEqual(before);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS completed_seed_readonly").run();
    }
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
