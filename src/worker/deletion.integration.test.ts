import {
  abortAllDurableObjects,
  applyD1Migrations,
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterD1 } from "../../tests/helpers/d1-races";
import type { Env, MemberContext } from "./env";
import {
  acceptPageDeletion,
  pendingPageDeletion,
  processDeletionJob,
  processDueDeletionJobs,
  requireTaskRestorable,
} from "./cleanup";
import { enableTableAuthority, queryTable, tableInternal } from "./table-service";
import { mutateTask, taskListStatements } from "./tasks";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deletion_jobs"),
    env.DB.prepare("DELETE FROM table_authority"),
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
  ]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
});

async function fixture(collaborative = true) {
  const key = crypto.randomUUID();
  const listId = `list-${key}`,
    userId = `owner-${key}`,
    workspaceId = `workspace-${key}`,
    spaceId = `space-${key}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,?,?,1,1)").bind(
      userId,
      "Owner",
      `${key}@test.invalid`,
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,'Notes',1)").bind(workspaceId),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?,'owner',1)").bind(
      workspaceId,
      userId,
    ),
    env.DB.prepare(
      "INSERT INTO spaces(id,workspace_id,name,slug,visibility,position,created_by,created_at,updated_at) VALUES(?,?,'General','deletion-test','workspace','a0',?,1,1)",
    ).bind(spaceId, workspaceId, userId),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,updated_by,created_at,updated_at,is_task_list) VALUES(?,?,?,'table','a0','Tasks',?,?,1,1,1)",
    ).bind(listId, workspaceId, spaceId, userId, userId),
    env.DB.prepare("INSERT INTO table_state(page_id,revision) VALUES(?,1)").bind(listId),
    ...taskListStatements(env.DB, listId),
  ]);
  const member: MemberContext = {
    user: { id: userId, name: "Owner", email: `${key}@test.invalid` },
    session: { id: key, expiresAt: new Date(Date.now() + 3_600_000) },
    workspace: { id: workspaceId, name: "Notes", locationHint: null },
    role: "owner",
  };
  if (collaborative) await enableTableAuthority(env, member, listId);
  const created = await mutateTask(env, member, listId, null, {
    operationId: crypto.randomUUID(),
    expectedRevision: 1,
    title: "Keep ownership",
  });
  await mutateTask(env, member, listId, created.rowId, {
    operationId: crypto.randomUUID(),
    expectedRevision: created.revision,
    archived: true,
  });
  return { member, listId, rowId: created.rowId, detailId: created.detailPageId };
}

async function retry(jobId: string) {
  await env.DB.prepare("UPDATE deletion_jobs SET next_attempt_at=0 WHERE id=?").bind(jobId).run();
  await processDeletionJob(env, jobId);
}

async function archiveTable(f: Awaited<ReturnType<typeof fixture>>, repairing = false) {
  await env.DB.prepare(`WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT page.id FROM pages page JOIN subtree ON page.parent_id=subtree.id)
    UPDATE pages SET archived_at=COALESCE(archived_at,1) WHERE id IN subtree`)
    .bind(f.listId)
    .run();
  if (repairing)
    await env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(f.listId).run();
}

function beforeBatch(matches: (sql: string) => boolean, compete: () => Promise<void>) {
  const queries = new WeakMap<object, string>();
  let fired = false;
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
            const proxy = new Proxy(statement, {
              get(prepared, method) {
                if (method === "bind") return (...values: unknown[]) => wrap(prepared.bind(...values));
                const value = Reflect.get(prepared, method, prepared);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
            queries.set(proxy, sql);
            return proxy;
          };
          return wrap(target.prepare(sql));
        };
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => matches(queries.get(statement) ?? ""))) {
            fired = true;
            await compete();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("whole-table deletion recovery", () => {
  it.each(["absent", "d1"])("rejects stale seed acquisition from an %s registry snapshot", async (mode) => {
    const f = await fixture(false);
    if (mode === "d1")
      await env.DB.prepare("INSERT INTO table_authority(page_id,state,generation) VALUES(?,'d1',1)")
        .bind(f.listId)
        .run();
    const db = beforeBatch(
      (sql) => sql.startsWith("INSERT INTO table_authority"),
      async () => {
        await env.DB.prepare(
          "INSERT INTO table_authority(page_id,state,generation) VALUES(?,'d1',2) ON CONFLICT(page_id) DO UPDATE SET generation=2",
        )
          .bind(f.listId)
          .run();
      },
    );
    await expect(enableTableAuthority({ ...env, DB: db } as Env, f.member, f.listId)).rejects.toMatchObject({
      code: "table_generation_conflict",
      status: 409,
    });
    expect(
      await env.DB.prepare("SELECT state,generation FROM table_authority WHERE page_id=?").bind(f.listId).first(),
    ).toEqual({ state: "d1", generation: 2 });
  });

  it("rejects seed acquisition after its source page moves to another workspace", async () => {
    const f = await fixture(false),
      foreign = await fixture(false);
    const db = beforeBatch(
      (sql) => sql.startsWith("INSERT INTO table_authority"),
      async () => {
        await env.DB.prepare(
          "UPDATE pages SET workspace_id=?,space_id=(SELECT space_id FROM pages WHERE id=?) WHERE id=?",
        )
          .bind(foreign.member.workspace.id, foreign.listId, f.listId)
          .run();
      },
    );
    await expect(enableTableAuthority({ ...env, DB: db } as Env, f.member, f.listId)).rejects.toMatchObject({
      code: "table_generation_conflict",
      status: 409,
    });
    expect(await env.DB.prepare("SELECT state FROM table_authority WHERE page_id=?").bind(f.listId).first()).toBeNull();
  });

  it.each(
    ["seed revision", "row revisions", "column rename", "cutover"].flatMap((stage) => [
      { stage, replacement: "generation" },
      { stage, replacement: "state" },
    ]),
  )("atomically fences seed $stage after its $replacement changes", async ({ stage, replacement }) => {
    const f = await fixture(false);
    if (stage === "seed revision")
      await env.DB.prepare(
        "INSERT INTO table_authority(page_id,state,generation,seed_revision) VALUES(?,'seeding',1,1)",
      )
        .bind(f.listId)
        .run();
    if (stage === "column rename")
      await env.DB.prepare("UPDATE table_columns SET name='Repeated' WHERE page_id=?").bind(f.listId).run();
    const prefixes: Record<string, string> = {
      "seed revision": "UPDATE table_authority SET seed_revision",
      "row revisions": "UPDATE table_rows SET row_revision",
      "column rename": "UPDATE table_columns SET name",
      cutover: "UPDATE table_authority SET state='do'",
    };
    const snapshot = async () => ({
      columns: (
        await env.DB.prepare("SELECT id,name,property_revision FROM table_columns WHERE page_id=? ORDER BY id")
          .bind(f.listId)
          .all()
      ).results,
      rows: (
        await env.DB.prepare("SELECT id,row_revision FROM table_rows WHERE page_id=? ORDER BY id").bind(f.listId).all()
      ).results,
      revision: await env.DB.prepare("SELECT seed_revision FROM table_authority WHERE page_id=?")
        .bind(f.listId)
        .first(),
    });
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    const db = beforeBatch(
      (sql) => sql.startsWith(prefixes[stage]!),
      async () => {
        before = await snapshot();
        await env.DB.prepare(
          replacement === "generation"
            ? "UPDATE table_authority SET generation=2 WHERE page_id=?"
            : "UPDATE table_authority SET state='do' WHERE page_id=?",
        )
          .bind(f.listId)
          .run();
      },
    );
    await expect(enableTableAuthority({ ...env, DB: db } as Env, f.member, f.listId)).rejects.toMatchObject({
      code: "table_generation_conflict",
      status: 409,
    });
    expect(before).toBeDefined();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a stale migration after another request cuts over and commits a task", async () => {
    const f = await fixture(false);
    const db = beforeBatch(
      (sql) => sql.startsWith("UPDATE table_rows SET row_revision"),
      async () => {
        await enableTableAuthority(env, f.member, f.listId);
        await mutateTask(env, f.member, f.listId, null, {
          operationId: crypto.randomUUID(),
          expectedRevision: 3,
          title: "Concurrent task",
        });
      },
    );
    await expect(enableTableAuthority({ ...env, DB: db } as Env, f.member, f.listId)).rejects.toMatchObject({
      code: "table_generation_conflict",
      status: 409,
    });
    const latest = await queryTable(env, f.member, f.listId);
    expect(latest.revision).toBe(4);
    expect(latest.rows).toHaveLength(2);
    expect(latest.rows.map((row) => row.cells[`${f.listId}-title`])).toContain("Concurrent task");
  });

  it.each(["lost finish", "cutover"])("resumes a completed same-generation seed after %s fails", async (stage) => {
    const f = await fixture(false);
    const bindings =
      stage === "cutover"
        ? ({
            ...env,
            DB: beforeBatch(
              (sql) => sql.startsWith("UPDATE table_authority SET state='do'"),
              async () => {
                throw new Error("interrupted cutover");
              },
            ),
          } as Env)
        : ({
            ...env,
            TABLE: {
              getByName: (name: string) => ({
                fetch: async (request: Request) => {
                  const response = await env.TABLE.getByName(name).fetch(request);
                  if (new URL(request.url).pathname === "/seed-finish") throw new Error("lost finish response");
                  return response;
                },
              }),
            },
          } as unknown as Env);
    await expect(enableTableAuthority(bindings, f.member, f.listId)).rejects.toThrow(
      stage === "cutover" ? "interrupted cutover" : "lost finish response",
    );
    expect(
      await env.DB.prepare("SELECT state,generation FROM table_authority WHERE page_id=?").bind(f.listId).first(),
    ).toEqual({ state: "seeding", generation: 1 });
    const paths: string[] = [];
    const retryBindings = {
      ...env,
      TABLE: {
        getByName: (name: string) => ({
          fetch: async (request: Request) => {
            paths.push(new URL(request.url).pathname);
            return env.TABLE.getByName(name).fetch(request);
          },
        }),
      },
    } as unknown as Env;
    await expect(enableTableAuthority(retryBindings, f.member, f.listId)).resolves.toMatchObject({
      state: "do",
      generation: 1,
    });
    expect(paths).toEqual(["/seed", "/seed-finish"]);
    expect((await queryTable(env, f.member, f.listId)).rows).toHaveLength(1);
  });
  it("quiesces nested owned tables before purging either actor", async () => {
    const f = await fixture();
    const nested = `nested-${f.listId}`;
    await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,created_at,updated_at,archived_at)
      SELECT ?,workspace_id,space_id,id,'table','a0','Nested',created_by,1,1,1 FROM pages WHERE id=?`)
      .bind(nested, f.listId)
      .run();
    await archiveTable(f, true);
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    const stages: string[] = [];
    const bindings = {
      ...env,
      TABLE: {
        getByName: (name: string) => ({
          fetch: async (request: Request) => {
            stages.push(new URL(request.url).pathname);
            return env.TABLE.getByName(name).fetch(request);
          },
        }),
      },
    } as unknown as Env;
    await processDeletionJob(bindings, accepted.jobId);
    expect(stages).toEqual(["/stop-repair-for-deletion", "/stop-repair-for-deletion", "/purge", "/purge"]);
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("keeps an external repairing ancestor protected when the target is itself a whole table", async () => {
    const f = await fixture();
    const parent = `parent-${f.listId}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,archived_at)
        SELECT ?,workspace_id,space_id,'table','a0','Parent',created_by,1,1,1 FROM pages WHERE id=?`).bind(
        parent,
        f.listId,
      ),
      env.DB.prepare("INSERT INTO table_authority(page_id,state,generation) VALUES(?,'repairing',1)").bind(parent),
      env.DB.prepare("UPDATE pages SET parent_id=? WHERE id=?").bind(parent, f.listId),
    ]);
    await archiveTable(f, true);
    await expect(acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId)).rejects.toMatchObject({
      code: "table_repairing",
      status: 409,
    });
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs").first()).toBeNull();
  });
  it.each(["acquisition", "seed revision", "row revisions", "column rename", "cutover"])(
    "atomically fences seed %s when whole-table deletion wins the race",
    async (stage) => {
      const f = await fixture(false);
      if (stage === "seed revision")
        await env.DB.prepare(
          "INSERT INTO table_authority(page_id,state,generation,seed_revision) VALUES(?,'seeding',1,1)",
        )
          .bind(f.listId)
          .run();
      if (stage === "column rename")
        await env.DB.prepare("UPDATE table_columns SET name='Repeated' WHERE page_id=?").bind(f.listId).run();
      const prefixes: Record<string, string> = {
        acquisition: "INSERT INTO table_authority",
        "seed revision": "UPDATE table_authority SET seed_revision",
        "row revisions": "UPDATE table_rows SET row_revision",
        "column rename": "UPDATE table_columns SET name",
        cutover: "UPDATE table_authority SET state='do'",
      };
      let accepted: Awaited<ReturnType<typeof acceptPageDeletion>> | undefined;
      const db = beforeBatch(
        (sql) => sql.startsWith(prefixes[stage]!),
        async () => {
          await archiveTable(f);
          accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
        },
      );
      await expect(enableTableAuthority({ ...env, DB: db } as Env, f.member, f.listId)).rejects.toMatchObject({
        code: "deletion_pending",
        status: 409,
      });
      expect(accepted).toBeDefined();
      const registry = await env.DB.prepare("SELECT state FROM table_authority WHERE page_id=?").bind(f.listId).first();
      expect(registry).toEqual(stage === "acquisition" ? null : { state: "seeding" });
      await processDeletionJob(env, accepted!.jobId);
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).toBeNull();
    },
  );
  it.each(["repairing", "ready", "legacy"])("stops and purges an entire %s table", async (mode) => {
    const f = await fixture(mode !== "legacy");
    await archiveTable(f, mode === "repairing");
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    const targets = await env.DB.prepare(
      "SELECT target FROM deletion_targets WHERE job_id=? AND kind='table_do' ORDER BY target",
    )
      .bind(accepted.jobId)
      .all<{ target: string }>();
    expect(targets.results.map(({ target }) => JSON.parse(target))).toEqual(
      expect.arrayContaining([
        {
          version: 1,
          pageId: f.listId,
          workspaceId: f.member.workspace.id,
          generation: mode === "legacy" ? null : 1,
          stage: "stop",
        },
        {
          version: 1,
          pageId: f.listId,
          workspaceId: f.member.workspace.id,
          generation: mode === "legacy" ? null : 1,
          stage: "purge",
        },
      ]),
    );
    const paths: string[] = [];
    const bindings = {
      ...env,
      TABLE: {
        getByName: (name: string) => ({
          fetch: async (request: Request) => {
            paths.push(new URL(request.url).pathname);
            return env.TABLE.getByName(name).fetch(request);
          },
        }),
      },
    } as unknown as Env;
    await processDeletionJob(bindings, accepted.jobId);
    expect(paths).toEqual(["/stop-repair-for-deletion", "/purge"]);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
    await evictDurableObject(env.TABLE.getByName(f.listId));
    await expect(tableInternal(env, f.listId, "/repair", {})).rejects.toMatchObject({ status: 410 });
  });

  it("preserves metadata and purge target when stopping fails", async () => {
    const f = await fixture();
    await archiveTable(f, true);
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 503 }));
    await processDeletionJob({ ...env, TABLE: { getByName: () => ({ fetch }) } } as unknown as Env, accepted.jobId);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0]![0]?.url ?? "https://unexpected").pathname).toBe("/stop-repair-for-deletion");
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first(),
    ).toEqual({ phase: "rows", last_error: "Table stop failed with 503" });
    await processDeletionJob(env, accepted.jobId, { retryFailedRows: true });
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("repeats a durable stop after losing its completion write and evicting the actor", async () => {
    const f = await fixture();
    await archiveTable(f, true);
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    let failed = false;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(prepared, method) {
                  if (method === "bind") return (...values: unknown[]) => wrap(prepared.bind(...values));
                  if (method === "run" && sql.includes("SET completed_at") && !failed)
                    return () => {
                      failed = true;
                      throw new Error("lost stop completion");
                    };
                  const value = Reflect.get(prepared, method, prepared);
                  return typeof value === "function" ? value.bind(prepared) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await processDeletionJob({ ...env, DB: db } as Env, accepted.jobId);
    expect(failed).toBe(true);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).not.toBeNull();
    await evictDurableObject(env.TABLE.getByName(f.listId));
    await processDeletionJob(env, accepted.jobId, { retryFailedRows: true });
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("resumes physical purge after metadata committed without repeating the stop", async () => {
    const f = await fixture();
    await archiveTable(f, true);
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    const paths: string[] = [];
    let failPurge = true;
    const bindings = {
      ...env,
      TABLE: {
        getByName: (name: string) => ({
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            paths.push(path);
            if (path === "/purge" && failPurge) {
              failPurge = false;
              throw new Error("purge interrupted");
            }
            return env.TABLE.getByName(name).fetch(request);
          },
        }),
      },
    } as unknown as Env;
    await processDeletionJob(bindings, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT phase FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toEqual({
      phase: "cleanup",
    });
    await evictDurableObject(env.TABLE.getByName(f.listId));
    await env.DB.prepare("UPDATE deletion_jobs SET next_attempt_at=0 WHERE id=?").bind(accepted.jobId).run();
    await processDeletionJob(bindings, accepted.jobId);
    expect(paths).toEqual(["/stop-repair-for-deletion", "/purge", "/purge"]);
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("retains metadata if the generation changes after stopping", async () => {
    const f = await fixture();
    await archiveTable(f, true);
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    const db = afterD1(
      env.DB,
      (sql) => sql.includes("SET completed_at"),
      async () => {
        await env.DB.prepare("UPDATE table_authority SET generation=2 WHERE page_id=?").bind(f.listId).run();
      },
    );
    await processDeletionJob({ ...env, DB: db } as Env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT phase FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toEqual({
      phase: "rows",
    });
  });

  it("upgrades an accepted legacy whole-table target before stopping repair", async () => {
    const f = await fixture();
    await archiveTable(f);
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deletion_targets WHERE job_id=? AND kind='table_do'").bind(accepted.jobId),
      env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'table_do',?)").bind(
        accepted.jobId,
        f.listId,
      ),
      env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(f.listId),
    ]);
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("retains the legacy rows target when its upgrade generation CAS loses", async () => {
    const f = await fixture();
    await archiveTable(f);
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deletion_targets WHERE job_id=? AND kind='table_do'").bind(accepted.jobId),
      env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'table_do',?)").bind(
        accepted.jobId,
        f.listId,
      ),
    ]);
    const db = beforeBatch(
      (sql) => sql.includes("SELECT ?,'table_do',? WHERE"),
      async () => {
        await env.DB.prepare("UPDATE table_authority SET generation=2 WHERE page_id=?").bind(f.listId).run();
      },
    );
    await processDeletionJob({ ...env, DB: db } as Env, accepted.jobId);
    expect(
      await env.DB.prepare("SELECT target FROM deletion_targets WHERE job_id=? AND kind='table_do'")
        .bind(accepted.jobId)
        .all(),
    ).toMatchObject({ results: [{ target: f.listId }] });
    expect(
      await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first(),
    ).toEqual({ phase: "rows", last_error: "Deletion table target ownership changed" });
  });

  it("upgrades a legacy plain page ID even when it is valid JSON", async () => {
    const f = await fixture(false);
    const pageId = "123";
    await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,archived_at)
      SELECT ?,workspace_id,space_id,'table','a0','Numeric',created_by,1,1,1 FROM pages WHERE id=?`)
      .bind(pageId, f.listId)
      .run();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, pageId);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deletion_targets WHERE job_id=? AND kind='table_do'").bind(accepted.jobId),
      env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'table_do',?)").bind(
        accepted.jobId,
        pageId,
      ),
    ]);
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(pageId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("atomically rejects a changed generation during whole-table activation", async () => {
    const f = await fixture();
    await archiveTable(f);
    const db = afterD1(
      env.DB,
      (sql) => sql.startsWith("INSERT INTO deletion_jobs"),
      async () => {
        await env.DB.prepare("UPDATE table_authority SET generation=2 WHERE page_id=?").bind(f.listId).run();
      },
    );
    await expect(
      acceptPageDeletion({ ...env, DB: db } as Env, f.member.workspace.id, f.member.user.id, f.listId),
    ).rejects.toMatchObject({ code: "deletion_pending" });
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs").first()).toBeNull();
  });

  it.each(["absent", "live"])("reserves only an %s identity for legacy cleanup purge", async (mode) => {
    const f = await fixture(false);
    const jobId = `legacy-cleanup-${f.listId}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO deletion_jobs(id,workspace_id,root_page_id,phase,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'cleanup',0,1,1)",
      ).bind(jobId, f.member.workspace.id, f.listId),
      env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'table_do',?)").bind(jobId, f.listId),
    ]);
    if (mode === "absent") await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(f.listId).run();
    const fetch = vi.fn(async (request: Request) => {
      await expect(
        env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
        VALUES(?,?,?,'table','a0','Reused',?,1,1)`)
          .bind(f.listId, f.member.workspace.id, `space-${f.member.session.id}`, f.member.user.id)
          .run(),
      ).rejects.toThrow("deletion_pending");
      return env.TABLE.getByName(f.listId).fetch(request);
    });
    await processDeletionJob({ ...env, TABLE: { getByName: () => ({ fetch }) } } as unknown as Env, jobId);
    expect(fetch).toHaveBeenCalledTimes(mode === "absent" ? 1 : 0);
    expect(await env.DB.prepare("SELECT last_error FROM deletion_jobs WHERE id=?").bind(jobId).first()).toEqual(
      mode === "absent" ? null : { last_error: "Legacy table purge identity is unavailable" },
    );
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).toEqual(
      mode === "absent" ? null : { id: f.listId },
    );
  });
});

describe("fair deletion scheduling", () => {
  it("breaks equal due and creation timestamps by job ID while honoring the limit", async () => {
    const f = await fixture();
    const jobs = ["c", "a", "b"].map((prefix) => `${prefix}-${f.listId}`);
    await env.DB.batch(
      jobs.flatMap((jobId) => [
        env.DB.prepare(
          "INSERT INTO deletion_jobs(id,workspace_id,root_page_id,phase,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'cleanup',0,1,1)",
        ).bind(jobId, f.member.workspace.id, `root-${jobId}`),
        env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'r2_object',?)").bind(jobId, jobId),
      ]),
    );
    const deleted = vi.fn(async (_target: string) => {});
    await processDueDeletionJobs({ ...env, BUCKET: { delete: deleted } } as unknown as Env, 2);
    expect(deleted.mock.calls.map(([target]) => target)).toEqual([...jobs].sort().slice(0, 2));
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs").all()).toMatchObject({ results: [{ id: jobs[0] }] });
  });
  it("keeps a ten-job bound and advances past recurring row failures", async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const jobs = Array.from({ length: 12 }, (_, index) => `fair-${index}-${f.listId}`);
    await env.DB.batch(
      jobs.flatMap((jobId, index) => [
        env.DB.prepare(
          "INSERT INTO deletion_jobs(id,workspace_id,root_page_id,phase,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,0,?,0)",
        ).bind(jobId, f.member.workspace.id, `root-${jobId}`, index < 10 ? "rows" : "cleanup", index),
        env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,?,?)").bind(
          jobId,
          index < 10 ? "table_row" : "r2_object",
          index < 10 ? JSON.stringify({ tableId: f.listId }) : jobId,
        ),
      ]),
    );
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const deleted = vi.fn(async (_target: string) => {});
    const bindings = { ...env, TABLE: { getByName: () => ({ fetch }) }, BUCKET: { delete: deleted } } as unknown as Env;
    await processDueDeletionJobs(bindings);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(deleted).not.toHaveBeenCalled();
    clock.mockReturnValue(1_900_000);
    await processDueDeletionJobs(bindings);
    expect(deleted.mock.calls.map(([target]) => target)).toEqual(jobs.slice(10));
    expect(
      await env.DB.prepare("SELECT count(*) count FROM deletion_jobs WHERE id IN (?,?)")
        .bind(...jobs.slice(10))
        .first(),
    ).toEqual({ count: 0 });
  });
});

async function subtreeFixture() {
  const f = await fixture();
  const second = await mutateTask(env, f.member, f.listId, null, {
    operationId: crypto.randomUUID(),
    expectedRevision: 3,
    title: "Second task",
  });
  await mutateTask(env, f.member, f.listId, second.rowId, {
    operationId: crypto.randomUUID(),
    expectedRevision: second.revision,
    archived: true,
  });
  const root = `folder-${f.detailId}`;
  await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,created_at,updated_at,archived_at)
    SELECT ?,workspace_id,space_id,id,'document','a0','Folder',created_by,1,1,1 FROM pages WHERE id=?`)
    .bind(root, f.listId)
    .run();
  await env.DB.prepare("UPDATE pages SET parent_id=? WHERE id IN (?,?)")
    .bind(root, f.detailId, second.detailPageId)
    .run();
  const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, root);
  await env.DB.prepare(
    "DELETE FROM deletion_targets WHERE job_id=? AND kind='table_row' AND json_extract(target,'$.rowId')=?",
  )
    .bind(accepted.jobId, second.rowId)
    .run();
  return { ...f, root, second, accepted };
}

async function seededFixture() {
  const f = await fixture(false);
  await enableTableAuthority(env, f.member, f.listId);
  expect(
    await env.DB.prepare("SELECT id FROM table_id_claims WHERE kind='row' AND id=?").bind(f.rowId).first(),
  ).toBeNull();
  return f;
}

async function deletionTarget(jobId: string) {
  const stored = await env.DB.prepare("SELECT target FROM deletion_targets WHERE job_id=? AND kind='table_row'")
    .bind(jobId)
    .first<{ target: string }>();
  if (!stored) throw new Error("Missing deletion test target");
  return JSON.parse(stored.target) as { tableId: string; rowId: string; detailPageId: string; generation: number };
}

describe("accepted permanent deletion", () => {
  it.each(["explicit", "due"])(
    "retries persisted row failures with %s recovery after preserving automatic backoff",
    async (mode) => {
      const f = await fixture();
      const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const failed = vi.fn(async () => new Response(null, { status: 503 }));
      const bindings = { ...env, TABLE: { getByName: () => ({ fetch: failed }) } } as unknown as Env;
      await processDeletionJob(bindings, accepted.jobId);
      expect(
        await env.DB.prepare("SELECT next_attempt_at,last_error FROM deletion_jobs WHERE id=?")
          .bind(accepted.jobId)
          .first(),
      ).toEqual({
        next_attempt_at: now + 60_000,
        last_error: "Canonical row deletion failed with 503",
      });
      await processDeletionJob(bindings, accepted.jobId);
      expect(failed).toHaveBeenCalledOnce();
      if (mode === "due") clock.mockReturnValue(now + 60_000);
      await processDeletionJob(env, accepted.jobId, { retryFailedRows: mode === "explicit" });
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
      expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
    },
  );

  it.each(["legacy", "current"])("does not take over a live %s lease during an explicit retry", async (mode) => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const now = Date.now();
    await env.DB.prepare("UPDATE deletion_jobs SET next_attempt_at=?,updated_at=?,last_error=? WHERE id=?")
      .bind(now + 15 * 60_000, now, mode === "legacy" ? "previous failure" : null, accepted.jobId)
      .run();
    const dispatched = vi.fn();
    await processDeletionJob(
      { ...env, TABLE: { getByName: () => ({ fetch: dispatched }) } } as unknown as Env,
      accepted.jobId,
      { retryFailedRows: true },
    );
    expect(dispatched).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT next_attempt_at,last_error FROM deletion_jobs WHERE id=?")
        .bind(accepted.jobId)
        .first(),
    ).toEqual({
      next_attempt_at: now + 15 * 60_000,
      last_error: mode === "legacy" ? "previous failure" : null,
    });
  });

  it("claims a repeated row retry once and clears its failure marker before dispatch", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    await env.DB.prepare("UPDATE deletion_jobs SET next_attempt_at=?,last_error='previous failure' WHERE id=?")
      .bind(Date.now() + 60_000, accepted.jobId)
      .run();
    let started!: () => void, release!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (request: Request) => {
      expect(
        await env.DB.prepare("SELECT last_error FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first(),
      ).toEqual({ last_error: null });
      started();
      await resume;
      return env.TABLE.getByName(f.listId).fetch(request);
    });
    const bindings = { ...env, TABLE: { getByName: () => ({ fetch }) } } as unknown as Env;
    const first = processDeletionJob(bindings, accepted.jobId, { retryFailedRows: true });
    await dispatched;
    await processDeletionJob(bindings, accepted.jobId, { retryFailedRows: true });
    release();
    await first;
    expect(fetch).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it.each(["staging", "cleanup"])("does not bypass %s backoff for an explicit row retry", async (phase) => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    await env.DB.prepare("UPDATE deletion_jobs SET phase=?,next_attempt_at=?,last_error='previous failure' WHERE id=?")
      .bind(phase, Date.now() + 60_000, accepted.jobId)
      .run();
    const dispatched = vi.fn();
    await processDeletionJob(
      { ...env, TABLE: { getByName: () => ({ fetch: dispatched }) } } as unknown as Env,
      accepted.jobId,
      { retryFailedRows: true },
    );
    expect(dispatched).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first(),
    ).toEqual({ phase, last_error: "previous failure" });
  });

  it.each(["detail", "descendant"])(
    "atomically rejects deletion of a %s beneath a repairing table without row links",
    async (kind) => {
      const f = await fixture();
      let root = f.detailId;
      if (kind === "descendant") {
        root = `child-${f.detailId}`;
        await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,created_at,updated_at,archived_at)
        SELECT ?,workspace_id,space_id,id,'document','a0','Child',created_by,1,1,1 FROM pages WHERE id=?`)
          .bind(root, f.detailId)
          .run();
      }
      const db = afterD1(
        env.DB,
        (sql) => sql.startsWith("INSERT INTO deletion_jobs"),
        async () => {
          await env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(f.listId).run();
          await env.DB.prepare("DELETE FROM table_row_pages WHERE page_id=?").bind(f.detailId).run();
        },
      );
      await expect(
        acceptPageDeletion({ ...env, DB: db } as Env, f.member.workspace.id, f.member.user.id, root),
      ).rejects.toMatchObject({ code: "table_repairing" });
      expect(await env.DB.prepare("SELECT id FROM deletion_jobs").first()).toBeNull();
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(root).first()).not.toBeNull();
    },
  );

  it("atomically retains accepted metadata when an ancestor repair starts before finalization", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    let changed = false;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!changed) {
              changed = true;
              await env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(f.listId).run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await processDeletionJob({ ...env, DB: db } as Env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT phase FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toEqual({
      phase: "rows",
    });
    await env.DB.prepare("UPDATE table_authority SET state='do' WHERE page_id=?").bind(f.listId).run();
    await processDeletionJob(env, accepted.jobId, { retryFailedRows: true });
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
  });

  it.each(["exact", "null job", "different job", "different path", "ordinary page", "different workspace"])(
    "matches repairing import ancestry only through exact row-detail provenance: %s",
    async (mode) => {
      const f = await fixture();
      const parent = mode === "different workspace" ? await fixture() : f;
      const root = `imported-${f.detailId}`;
      const firstJob = `first-${root}`,
        secondJob = `second-${root}`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO jobs(id,workspace_id,type,status,requested_by,created_at,updated_at)
          VALUES(?,?,'import','succeeded',?,1,1),(?,?,'import','succeeded',?,1,1)`).bind(
          firstJob,
          f.member.workspace.id,
          f.member.user.id,
          secondJob,
          f.member.workspace.id,
          f.member.user.id,
        ),
        env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,archived_at)
          SELECT ?,workspace_id,space_id,'document','a0','Imported',created_by,1,1,1 FROM pages WHERE id=?`).bind(
          root,
          f.listId,
        ),
        env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(parent.listId),
      ]);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO page_import_sources(page_id,job_id,source_path,source_role,created_at)
          VALUES(?,?,'table','page',1)`).bind(parent.listId, firstJob),
        env.DB.prepare(`INSERT INTO page_import_sources(page_id,job_id,source_path,parent_source_path,source_role,created_at)
          VALUES(?,?,'table/row',?,?,1)`).bind(
          root,
          mode === "null job" ? null : mode === "different job" ? secondJob : firstJob,
          mode === "different path" ? "table-other" : "table",
          mode === "ordinary page" ? "page" : "table_row_detail",
        ),
      ]);
      const result = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, root).catch(
        (error: unknown) => error,
      );
      const accepted = { jobId: expect.any(String) };
      expect(result).toMatchObject(mode === "exact" ? { code: "table_repairing" } : accepted);
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(root).first()).not.toBeNull();
    },
  );

  it("reconciles an exactly restored detail link using this job's original table generation", async () => {
    const f = await subtreeFixture();
    await env.DB.prepare("DELETE FROM table_row_pages WHERE page_id=?").bind(f.second.detailPageId).run();
    await env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(f.listId).run();
    await processDeletionJob(env, f.accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.root).first()).not.toBeNull();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO table_row_pages(row_id,page_id,created_at) VALUES(?,?,1)").bind(
        f.second.rowId,
        f.second.detailPageId,
      ),
      env.DB.prepare("UPDATE table_authority SET state='do' WHERE page_id=?").bind(f.listId),
    ]);
    await processDeletionJob(env, f.accepted.jobId, { retryFailedRows: true });
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(f.accepted.jobId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.root).first()).toBeNull();
    expect((await tableInternal<{ rows: unknown[] }>(env, f.listId, "/export")).rows).toHaveLength(0);
  });

  it.each(["missing", "different generation", "foreign job", "conflicting generations"])(
    "retains deletion locks with %s original generation evidence",
    async (mode) => {
      const f = await subtreeFixture();
      if (mode === "conflicting generations") {
        await env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,'table_row',?)")
          .bind(
            f.accepted.jobId,
            JSON.stringify({ tableId: f.listId, rowId: "foreign-row", detailPageId: "foreign-page", generation: 2 }),
          )
          .run();
      } else if (mode === "different generation") {
        await env.DB.prepare("UPDATE table_authority SET generation=generation+1 WHERE page_id=?").bind(f.listId).run();
      } else {
        if (mode === "foreign job") {
          const foreign = crypto.randomUUID();
          await env.DB.prepare(`INSERT INTO deletion_jobs(id,workspace_id,root_page_id,next_attempt_at,created_at,updated_at,phase)
          VALUES(?,?,?,0,1,1,'cleanup')`)
            .bind(foreign, f.member.workspace.id, "foreign-root")
            .run();
          await env.DB.prepare(`INSERT INTO deletion_targets(job_id,kind,target)
          SELECT ?,kind,target FROM deletion_targets WHERE job_id=? AND kind='table_row'`)
            .bind(foreign, f.accepted.jobId)
            .run();
        }
        await env.DB.prepare("DELETE FROM deletion_targets WHERE job_id=? AND kind='table_row'")
          .bind(f.accepted.jobId)
          .run();
      }
      await processDeletionJob(env, f.accepted.jobId);
      expect(
        await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(f.accepted.jobId).first(),
      ).toEqual({
        phase: "rows",
        last_error: "Deletion row target generation is unavailable",
      });
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.root).first()).not.toBeNull();
      expect(await pendingPageDeletion(env, f.second.detailPageId)).toEqual({ id: f.accepted.jobId });
      expect(
        await env.DB.prepare(
          "SELECT completed_at FROM deletion_targets WHERE job_id=? AND kind='table_row' AND json_extract(target,'$.rowId')=?",
        )
          .bind(f.accepted.jobId, f.second.rowId)
          .first(),
      ).toBeNull();
    },
  );

  it("does not adopt a restored target after losing its generation CAS", async () => {
    const f = await subtreeFixture();
    const db = afterD1(
      env.DB,
      (sql) => sql.startsWith("SELECT DISTINCT json_extract(target,'$.generation')"),
      async () => {
        await env.DB.prepare("UPDATE table_authority SET generation=generation+1 WHERE page_id=?").bind(f.listId).run();
      },
    );
    await processDeletionJob({ ...env, DB: db } as Env, f.accepted.jobId);
    expect(
      await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(f.accepted.jobId).first(),
    ).toEqual({
      phase: "rows",
      last_error: "Deletion row target ownership changed",
    });
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.second.detailPageId).first()).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT completed_at FROM deletion_targets WHERE job_id=? AND kind='table_row' AND json_extract(target,'$.rowId')=?",
      )
        .bind(f.accepted.jobId, f.second.rowId)
        .first(),
    ).toBeNull();
  });

  it.each(["immediate retry", "alarm after eviction"] as const)(
    "completes seeded legacy row deletion after projection failure with %s",
    async (recovery) => {
      const f = await seededFixture();
      const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
      await env.DB.prepare(
        "CREATE TRIGGER failed_seeded_row_deletion BEFORE DELETE ON table_rows BEGIN SELECT RAISE(ABORT,'temporary_delete_failure'); END",
      ).run();
      const stub = env.TABLE.getByName(f.listId);
      try {
        await processDeletionJob(env, accepted.jobId);
        expect((await queryTable(env, f.member, f.listId)).rows).toHaveLength(0);
        expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id=?").bind(f.rowId).first()).not.toBeNull();
        expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
        expect(
          await env.DB.prepare("SELECT completed_at FROM deletion_targets WHERE job_id=? AND kind='table_row'")
            .bind(accepted.jobId)
            .first(),
        ).toEqual({ completed_at: null });
        await runInDurableObject(stub, (_instance, state) => {
          const receipt = state.storage.sql
            .exec<{ result: string }>(
              "SELECT result FROM receipts WHERE actor_id=? AND operation_id=?",
              `deletion-job:${accepted.jobId}`,
              `permanent-delete:${accepted.jobId}:${f.rowId}`,
            )
            .one();
          expect(JSON.parse(receipt.result)).toMatchObject({ projectionPending: true });
        });
        await env.DB.prepare("DROP TRIGGER failed_seeded_row_deletion").run();
        if (recovery === "alarm after eviction") {
          await evictDurableObject(stub);
          if (!(await runDurableObjectAlarm(stub))) throw new Error("Missing deletion retry alarm");
        }
        await retry(accepted.jobId);
        expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id=?").bind(f.rowId).first()).toBeNull();
        expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
        expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
      } finally {
        await env.DB.prepare("DROP TRIGGER IF EXISTS failed_seeded_row_deletion").run();
      }
    },
  );

  it("replays a seeded deletion receipt after a lost successful response and eviction", async () => {
    const f = await seededFixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const target = await deletionTarget(accepted.jobId);
    const table = {
      getByName: (name: string) => ({
        fetch: async (request: Request) => {
          const response = await env.TABLE.getByName(name).fetch(request);
          if (!response.ok) throw new Error("Unexpected deletion test dispatch failure");
          await response.text();
          throw new Error("lost_successful_response");
        },
      }),
    };
    await processDeletionJob({ ...env, TABLE: table } as unknown as Env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id=?").bind(f.rowId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first(),
    ).toMatchObject({ phase: "rows", last_error: "lost_successful_response" });
    await evictDurableObject(env.TABLE.getByName(f.listId));
    await expect(
      tableInternal(env, f.listId, "/delete-row", { ...target, jobId: "foreign-job" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      tableInternal(env, f.listId, "/delete-row", { ...target, jobId: accepted.jobId, detailPageId: f.listId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      tableInternal(env, f.listId, "/delete-row", { ...target, jobId: accepted.jobId, generation: 2 }),
    ).rejects.toMatchObject({ code: "table_generation_conflict" });
    await retry(accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it.each(["missing", "foreign actor", "foreign operation", "wrong hash"] as const)(
    "rejects absent seeded rows with %s deletion evidence",
    async (evidence) => {
      const f = await seededFixture();
      const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
      const target = await deletionTarget(accepted.jobId);
      expect(await tableInternal(env, f.listId, "/delete-row", { ...target, jobId: accepted.jobId })).toMatchObject({
        ok: true,
        projectionPending: false,
      });
      await runInDurableObject(env.TABLE.getByName(f.listId), (_instance, state) => {
        const actorId = `deletion-job:${accepted.jobId}`;
        const operationId = `permanent-delete:${accepted.jobId}:${f.rowId}`;
        if (evidence === "missing")
          state.storage.sql.exec("DELETE FROM receipts WHERE actor_id=? AND operation_id=?", actorId, operationId);
        else if (evidence === "foreign actor")
          state.storage.sql.exec(
            "UPDATE receipts SET actor_id='deletion-job:foreign' WHERE actor_id=? AND operation_id=?",
            actorId,
            operationId,
          );
        else if (evidence === "foreign operation")
          state.storage.sql.exec(
            "UPDATE receipts SET operation_id='permanent-delete:foreign' WHERE actor_id=? AND operation_id=?",
            actorId,
            operationId,
          );
        else
          state.storage.sql.exec(
            "UPDATE receipts SET hash='wrong-hash' WHERE actor_id=? AND operation_id=?",
            actorId,
            operationId,
          );
      });
      await expect(
        tableInternal(env, f.listId, "/delete-row", { ...target, jobId: accepted.jobId }),
      ).rejects.toMatchObject({ status: evidence === "wrong hash" ? 409 : 403 });
      expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
      expect(
        await env.DB.prepare("SELECT completed_at FROM deletion_targets WHERE job_id=? AND kind='table_row'")
          .bind(accepted.jobId)
          .first(),
      ).toEqual({ completed_at: null });
    },
  );

  it("retains matching row-claim fallback when a deletion receipt is unavailable", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const target = await deletionTarget(accepted.jobId);
    expect(await tableInternal(env, f.listId, "/delete-row", { ...target, jobId: accepted.jobId })).toMatchObject({
      ok: true,
      projectionPending: false,
    });
    await runInDurableObject(env.TABLE.getByName(f.listId), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM receipts WHERE actor_id=?", `deletion-job:${accepted.jobId}`);
    });
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
  });

  it("persists intent before row removal, rejects restore and resumes one job", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    expect(await pendingPageDeletion(env, f.detailId)).toEqual({ id: accepted.jobId });
    expect((await queryTable(env, f.member, f.listId)).rows.map((row) => row.id)).toContain(f.rowId);
    await expect(requireTaskRestorable(env, f.rowId)).rejects.toMatchObject({ code: "deletion_pending" });
    await expect(
      mutateTask(env, f.member, f.listId, f.rowId, {
        operationId: crypto.randomUUID(),
        expectedRevision: 3,
        archived: false,
      }),
    ).rejects.toMatchObject({ code: "deletion_pending" });
    expect(await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId)).toEqual(accepted);
    await processDeletionJob(env, accepted.jobId);
    expect((await queryTable(env, f.member, f.listId)).rows).toHaveLength(0);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("retains accepted intent after metadata failure following canonical deletion", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("injected metadata failure");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await processDeletionJob({ ...env, DB: db } as Env, accepted.jobId);
    expect((await queryTable(env, f.member, f.listId)).rows).toHaveLength(0);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT phase,last_error FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first(),
    ).toMatchObject({ phase: "rows", last_error: "injected metadata failure" });
    await expect(requireTaskRestorable(env, f.rowId)).rejects.toMatchObject({ code: "deletion_pending" });
    await retry(accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
  });

  it("retries failed row dispatch before removing metadata", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const table = { getByName: () => ({ fetch: async () => new Response(null, { status: 503 }) }) };
    await processDeletionJob({ ...env, TABLE: table } as unknown as Env, accepted.jobId);
    expect((await queryTable(env, f.member, f.listId)).rows).toHaveLength(1);
    expect(await env.DB.prepare("SELECT archived_at FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
    await retry(accepted.jobId);
    expect((await queryTable(env, f.member, f.listId)).rows).toHaveLength(0);
  });

  it("does not remove metadata after losing its cleanup lease", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await env.DB.prepare("UPDATE deletion_jobs SET next_attempt_at=next_attempt_at+1000 WHERE id=?")
              .bind(accepted.jobId)
              .run();
            return env.DB.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await processDeletionJob({ ...env, DB: db } as Env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT phase FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toEqual({
      phase: "rows",
    });
    await retry(accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
  });

  it("keeps unaccepted staging disposable and deletes legacy linked rows atomically", async () => {
    const f = await fixture(false);
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("injected staging failure");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      acceptPageDeletion({ ...env, DB: db } as Env, f.member.workspace.id, f.member.user.id, f.detailId),
    ).rejects.toThrow("injected staging failure");
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id=?").bind(f.rowId).first()).not.toBeNull();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    await expect(
      mutateTask(env, f.member, f.listId, f.rowId, {
        operationId: crypto.randomUUID(),
        expectedRevision: 3,
        archived: false,
      }),
    ).rejects.toMatchObject({ code: "deletion_pending" });
    await expect(
      env.DB.prepare("INSERT INTO table_authority(page_id,state) VALUES(?,'seeding')").bind(f.listId).run(),
    ).rejects.toThrow("deletion_pending");
    await expect(enableTableAuthority(env, f.member, f.listId)).rejects.toMatchObject({ code: "deletion_pending" });
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id=?").bind(f.rowId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
  });

  it("permits deleting a task beneath an archived containing list", async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE pages SET archived_at=2,archive_operation_id='list-archive' WHERE id=?")
      .bind(f.listId)
      .run();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT archived_at FROM pages WHERE id=?").bind(f.listId).first()).toEqual({
      archived_at: 2,
    });
    expect((await tableInternal<{ rows: unknown[] }>(env, f.listId, "/export")).rows).toHaveLength(0);
  });

  it("captures a seeding target and waits for the same generation to become ready", async () => {
    const f = await fixture(false);
    const table = {
      getByName: (name: string) => ({
        fetch: (request: Request) => {
          if (new URL(request.url).pathname === "/seed-rows") throw new Error("interrupted_seed");
          return env.TABLE.getByName(name).fetch(request);
        },
      }),
    };
    await expect(enableTableAuthority({ ...env, TABLE: table } as unknown as Env, f.member, f.listId)).rejects.toThrow(
      "interrupted_seed",
    );
    const initial = await env.DB.prepare("SELECT state,generation FROM table_authority WHERE page_id=?")
      .bind(f.listId)
      .first();
    expect(initial).toEqual({ state: "seeding", generation: 1 });
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    expect(
      await env.DB.prepare("SELECT target FROM deletion_targets WHERE job_id=? AND kind='table_row'")
        .bind(accepted.jobId)
        .first(),
    ).not.toBeNull();
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT phase FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toEqual({
      phase: "rows",
    });
    await expect(enableTableAuthority(env, f.member, f.listId)).resolves.toMatchObject({ state: "do", generation: 1 });
    expect((await queryTable(env, f.member, f.listId)).rows.map((row) => row.id)).toContain(f.rowId);
    await retry(accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).toBeNull();
    expect((await queryTable(env, f.member, f.listId)).rows).toHaveLength(0);
  });

  it("reserves deleted page identities until physical cleanup completes", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const bucket = new Proxy(env.BUCKET, {
      get(target, key) {
        if (key === "list")
          return async () => {
            throw new Error("injected physical cleanup failure");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = Date.now();
    await processDeletionJob({ ...env, BUCKET: bucket } as Env, accepted.jobId);
    const backoff = await env.DB.prepare("SELECT attempts,next_attempt_at FROM deletion_jobs WHERE id=?")
      .bind(accepted.jobId)
      .first<{ attempts: number; next_attempt_at: number }>();
    expect(backoff?.attempts).toBe(1);
    expect(backoff?.next_attempt_at).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(backoff?.next_attempt_at).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(await env.DB.prepare("SELECT phase FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toEqual({
      phase: "cleanup",
    });
    await expect(
      env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,updated_by,created_at,updated_at)
      SELECT ?,workspace_id,space_id,id,'document','a1','New page',created_by,updated_by,1,1 FROM pages WHERE id=?`)
        .bind(f.detailId, f.listId)
        .run(),
    ).rejects.toThrow("deletion_pending");
    await retry(accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toBeNull();
  });

  it("rejects overlapping jobs and prevents old queued restores from unlocking ownership", async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE pages SET archived_at=2,archive_operation_id='list-archive' WHERE id=?")
      .bind(f.listId)
      .run();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.listId);
    await expect(acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId)).rejects.toMatchObject({
      code: "deletion_pending",
    });
    const before = await env.DB.prepare("SELECT archived_at,archive_operation_id FROM pages WHERE id=?")
      .bind(f.detailId)
      .first();
    await env.DB.prepare("DELETE FROM archive_disconnect_targets WHERE page_id=?").bind(f.detailId).run();
    await env.DB.prepare("UPDATE pages SET archived_at=NULL,archive_operation_id=NULL WHERE id=?")
      .bind(f.detailId)
      .run();
    expect(
      await env.DB.prepare("SELECT archived_at,archive_operation_id FROM pages WHERE id=?").bind(f.detailId).first(),
    ).toEqual(before);
    expect(
      await env.DB.prepare("SELECT page_id FROM archive_disconnect_targets WHERE page_id=?").bind(f.detailId).first(),
    ).not.toBeNull();
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.listId).first()).toBeNull();
  });

  it("preserves newer generations and rejects foreign-job target identities", async () => {
    const f = await fixture();
    const accepted = await acceptPageDeletion(env, f.member.workspace.id, f.member.user.id, f.detailId);
    const target = await env.DB.prepare("SELECT target FROM deletion_targets WHERE job_id=? AND kind='table_row'")
      .bind(accepted.jobId)
      .first<{ target: string }>();
    const tuple = JSON.parse(target!.target) as { generation: number };
    await expect(tableInternal(env, f.listId, "/delete-row", { ...tuple, jobId: "foreign-job" })).rejects.toMatchObject(
      { status: 403 },
    );
    await env.DB.prepare("UPDATE table_authority SET generation=generation+1 WHERE page_id=?").bind(f.listId).run();
    await processDeletionJob(env, accepted.jobId);
    expect(await env.DB.prepare("SELECT id FROM table_rows WHERE id=?").bind(f.rowId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(f.detailId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT phase FROM deletion_jobs WHERE id=?").bind(accepted.jobId).first()).toEqual({
      phase: "rows",
    });
  });
});
