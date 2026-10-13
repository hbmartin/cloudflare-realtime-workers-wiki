import { abortAllDurableObjects, applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, MemberContext } from "./env";
import { acceptPageDeletion, pendingPageDeletion, processDeletionJob, requireTaskRestorable } from "./cleanup";
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

describe("accepted permanent deletion", () => {
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
    await processDeletionJob({ ...env, BUCKET: bucket } as Env, accepted.jobId);
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
