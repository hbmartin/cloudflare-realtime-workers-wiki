import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => reset());

const evidence = (
  index = 0,
  records: unknown[] = [{ detailPageId: "detail", rowId: "row", kind: "row" }],
  generation: number | null = 1,
) =>
  JSON.stringify({
    version: 1,
    stage: "evidence",
    pageId: "table",
    workspaceId: "workspace",
    generation,
    index,
    records,
    sealed: true,
  });

async function foundation(phase = "rows") {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0092"),
  );
  await env.DB.prepare(`INSERT INTO deletion_jobs(id,workspace_id,root_page_id,next_attempt_at,created_at,updated_at,phase)
    VALUES('job','workspace','table',0,1,1,?)`)
    .bind(phase)
    .run();
}
const upgrade = () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
const insert = (target: string) =>
  env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES('job','table_do',?)").bind(target).run();
const lookup = () =>
  env.DB.prepare(
    "SELECT job_id,table_id,workspace_id,generation,detail_page_id,row_id,source_kind FROM deletion_evidence_lookup ORDER BY detail_page_id",
  ).all();

describe("indexed deletion evidence migration", () => {
  it("backfills nullable generations and deduplicates identical legacy chunks without changing their bytes", async () => {
    await foundation();
    const first = evidence(0, [{ detailPageId: "detail", kind: "provenance" }], null);
    const duplicate = evidence(1, [{ detailPageId: "detail", kind: "provenance" }], null);
    await insert(first);
    await insert(duplicate);
    await insert("legacy-table");
    await upgrade();
    expect((await lookup()).results).toEqual([
      {
        job_id: "job",
        table_id: "table",
        workspace_id: "workspace",
        generation: null,
        detail_page_id: "detail",
        row_id: null,
        source_kind: "provenance",
      },
    ]);
    expect(
      (await env.DB.prepare("SELECT target FROM deletion_targets ORDER BY target").all<{ target: string }>()).results
        .map((row) => row.target)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([first, duplicate, "legacy-table"].sort((a, b) => a.localeCompare(b)));
    await env.DB.prepare("DELETE FROM deletion_targets WHERE target=?").bind(first).run();
    expect((await lookup()).results).toHaveLength(1);
    await env.DB.prepare("DELETE FROM deletion_targets WHERE target=?").bind(duplicate).run();
    expect((await lookup()).results).toHaveLength(0);
  });

  it.each(["conflicting rows", "generation", "workspace", "unknown source", "primitive"])(
    "fails closed on accepted %s during upgrade",
    async (problem) => {
      await foundation();
      await insert(evidence());
      const value = JSON.parse(evidence(1));
      if (problem === "conflicting rows") value.records[0].rowId = "foreign-row";
      if (problem === "generation") value.generation = 2;
      if (problem === "workspace") value.workspaceId = "foreign";
      if (problem === "unknown source") value.records[0].kind = "unknown";
      if (problem === "primitive") value.records = ["unsupported"];
      await insert(JSON.stringify(value));
      await expect(upgrade()).rejects.toThrow("CHECK constraint failed");
      expect((await env.DB.prepare("SELECT target FROM deletion_targets").all()).results).toHaveLength(2);
    },
  );

  it.each(["disjoint generation", "captured generation", "captured workspace"])(
    "rejects %s conflicts during upgrade and older-format writes",
    async (problem) => {
      await foundation();
      await insert(evidence());
      const incompatible =
        problem === "disjoint generation"
          ? evidence(1, [{ detailPageId: "other", rowId: "other-row", kind: "row" }], 2)
          : JSON.stringify({
              version: 1,
              stage: "stop",
              pageId: "table",
              workspaceId: problem === "captured workspace" ? "foreign" : "workspace",
              generation: 2,
            });
      await insert(incompatible);
      await expect(upgrade()).rejects.toThrow("CHECK constraint failed");
    },
  );

  it("checks generations for future disjoint chunks and captured targets", async () => {
    await foundation();
    await upgrade();
    await insert(
      JSON.stringify({ version: 1, stage: "stop", pageId: "table", workspaceId: "workspace", generation: 1 }),
    );
    await expect(insert(evidence(0, [{ detailPageId: "other", rowId: "other-row", kind: "row" }], 2))).rejects.toThrow(
      "deletion_evidence_incompatible",
    );
    await insert(evidence());
    await expect(insert(evidence(1, [{ detailPageId: "other", rowId: "other-row", kind: "row" }], 2))).rejects.toThrow(
      "deletion_evidence_incompatible",
    );
  });

  it("ignores invalid unaccepted staging artifacts but prevents later activation", async () => {
    await foundation("staging");
    await insert(evidence(0, ["unsupported"]));
    await upgrade();
    expect((await lookup()).results).toHaveLength(0);
    await expect(env.DB.prepare("UPDATE deletion_jobs SET phase='rows' WHERE id='job'").run()).rejects.toThrow(
      "deletion_evidence_incompatible",
    );
  });

  it("maintains older-format inserts and updates, rejecting changed protected identities and incompatible records", async () => {
    await foundation();
    await upgrade();
    const initial = evidence();
    await insert(initial);
    const added = evidence(0, [
      { detailPageId: "detail", rowId: "row", kind: "row" },
      { detailPageId: "second", kind: "provenance" },
    ]);
    await env.DB.prepare("UPDATE deletion_targets SET target=? WHERE target=?").bind(added, initial).run();
    expect((await lookup()).results).toHaveLength(2);
    await env.DB.prepare("UPDATE deletion_targets SET target=? WHERE target=?").bind(initial, added).run();
    expect((await lookup()).results).toHaveLength(1);
    await expect(insert(evidence(1, [{ detailPageId: "detail", rowId: "foreign", kind: "row" }]))).rejects.toThrow(
      "deletion_evidence_conflict",
    );
    await expect(insert(evidence(2, [{ detailPageId: "other", kind: "unknown" }]))).rejects.toThrow(
      "deletion_evidence_incompatible",
    );
    await expect(insert(evidence(3, ["unsupported"]))).rejects.toThrow("deletion_evidence_incompatible");
    expect((await lookup()).results).toHaveLength(1);
    await env.DB.prepare("DELETE FROM deletion_jobs WHERE id='job'").run();
    expect((await lookup()).results).toHaveLength(0);
  });

  it("indexes detail protection and all supported target identity forms", async () => {
    await foundation();
    await upgrade();
    const queries = [
      [
        "SELECT 1 FROM deletion_evidence_lookup WHERE workspace_id=? AND detail_page_id=?",
        "idx_deletion_evidence_detail",
      ],
      [
        "SELECT 1 FROM deletion_targets WHERE kind='table_do' AND substr(target,1,1)<>'{' AND target=?",
        "idx_deletion_targets_table_plain",
      ],
      [
        "SELECT 1 FROM deletion_targets WHERE kind='table_do' AND json_valid(target) AND json_extract(target,'$.pageId')=?",
        "idx_deletion_targets_table_identity",
      ],
      [
        "SELECT 1 FROM deletion_targets WHERE kind='table_row' AND json_valid(target) AND json_extract(target,'$.tableId')=? AND json_type(target,'$.generation')='integer'",
        "idx_deletion_targets_row_identity",
      ],
    ];
    for (const [query, index] of queries) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`)
        .bind(...(query!.includes("workspace_id") ? ["workspace", "detail"] : ["table"]))
        .all<{ detail: string }>();
      expect(
        plan.results.some(
          (row) => row.detail.includes(`USING INDEX ${index}`) || row.detail.includes(`USING COVERING INDEX ${index}`),
        ),
      ).toBe(true);
      expect(plan.results.every((row) => !row.detail.startsWith("SCAN "))).toBe(true);
    }
  });
});
