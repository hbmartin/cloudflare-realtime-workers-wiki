import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { contentIntegrityCheck, metadataIntegrityCheck } from "./integrity.mjs";
import { INTEGRITY_PAGE_COLUMNS } from "../src/shared/integrity.ts";

test("empty database is a valid fresh-install metadata precheck", async () => {
  assert.equal((await metadataIntegrityCheck(() => [{ name: "d1_migrations" }])).ok, true);
});

test("missing core schema and incomplete query coverage never pass", async () => {
  assert.equal((await metadataIntegrityCheck(() => [{ name: "user" }])).complete, false);
  const result = await metadataIntegrityCheck((sql) => {
    if (sql.includes("sqlite_master")) return ["pages", "spaces", "workspaces"].map((name) => ({ name }));
    if (sql.includes("PRAGMA")) return INTEGRITY_PAGE_COLUMNS.split(",").map((name) => ({ name }));
    if (sql.includes(" UNION ALL "))
      return [
        { source: "pages", rows: 10 },
        { source: "spaces", rows: 0 },
        { source: "workspaces", rows: 0 },
      ];
    if (sql.includes("sum(revision)")) return [{ pages: 10, revisions: 10, epochs: 10, updates: 10 }];
    return [];
  });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
});

function metadataFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE spaces(id TEXT PRIMARY KEY,workspace_id TEXT);
    CREATE TABLE pages(id TEXT PRIMARY KEY,workspace_id TEXT,space_id TEXT,parent_id TEXT,kind TEXT,
      revision INTEGER,content_epoch INTEGER,indexed_seq INTEGER,updated_at INTEGER,archived_at INTEGER,
      is_template INTEGER,import_job_id TEXT);
    INSERT INTO workspaces VALUES('workspace'); INSERT INTO spaces VALUES('space','workspace');`);
  return db;
}

test("metadata pagination reads every page beyond the old 100000-row ceiling", async () => {
  const db = metadataFixture();
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO pages VALUES(?,'workspace','space',NULL,'document',1,1,0,1,NULL,0,NULL)");
    for (let i = 0; i < 100_001; i++) insert.run(String(i).padStart(6, "0"));
    db.exec("COMMIT");
    let batches = 0;
    const result = await metadataIntegrityCheck(async (sql) => {
      if (sql.startsWith("SELECT id,workspace_id,space_id")) batches++;
      return db.prepare(sql).all();
    });
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(result.checkedPages, 100_001);
    assert.equal(batches, 202);
  } finally {
    db.close();
  }
});

test("metadata fingerprint rejects same-count scope changes and nonadvancing batches", async () => {
  const db = metadataFixture();
  try {
    db.exec("INSERT INTO pages VALUES('page','workspace','space',NULL,'document',1,1,0,1,NULL,0,NULL)");
    let scans = 0;
    const result = await metadataIntegrityCheck((sql) => {
      if (sql.startsWith("SELECT id,workspace_id,space_id") && ++scans === 2)
        db.exec("UPDATE pages SET space_id='other'");
      return db.prepare(sql).all();
    });
    assert.equal(result.ok, false);
    assert.ok(result.incomplete.some((failure) => failure.code === "workspace_revision_changed"));
    await assert.rejects(
      () =>
        metadataIntegrityCheck((sql) => {
          if (sql.startsWith("SELECT id FROM workspaces")) return [{ id: "same" }, { id: "same" }];
          return db.prepare(sql).all();
        }),
      /did not advance/,
    );
  } finally {
    db.close();
  }
});

test("the final page watermark rejects late writes after pages have been fingerprinted", async () => {
  const db = metadataFixture();
  try {
    db.exec(`CREATE TABLE attachments(id TEXT PRIMARY KEY,page_id TEXT,workspace_id TEXT,r2_key TEXT,size INTEGER);
      INSERT INTO pages VALUES('page','workspace','space',NULL,'document',1,1,0,1,NULL,0,NULL)`);
    let scans = 0;
    const result = await metadataIntegrityCheck((sql) => {
      if (sql.startsWith("SELECT id,page_id,workspace_id,r2_key,size") && ++scans === 2)
        db.exec("UPDATE pages SET space_id='missing',revision=revision+1");
      return db.prepare(sql).all();
    });
    assert.equal(result.ok, false);
    assert.ok(result.incomplete.some((failure) => failure.code === "workspace_revision_changed"));
  } finally {
    db.close();
  }
});

test("content checker follows all cursors and verifies exact coverage", async () => {
  let calls = 0;
  const result = await contentIntegrityCheck("https://example.test", "session=private", {
    fetcher: async (url, init) => {
      assert.equal(init.headers.cookie, "session=private");
      calls++;
      return Response.json({
        scope: "stored_canonical_content",
        checkedPages: 1,
        totalPages: 2,
        failures: [],
        incomplete: [],
        classifications: { root: 1 },
        complete: calls === 2,
        nextCursor: calls === 1 ? "next" : null,
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.classifications.root, 2);
});

test("content checker never turns stale, truncated or failed results into success", async () => {
  for (const extra of [
    { incomplete: [{ code: "workspace_revision_changed" }] },
    { totalPages: 2 },
    { failures: [{ code: "invalid_space" }] },
    { complete: false },
  ]) {
    const result = await contentIntegrityCheck("https://example.test", "session=private", {
      fetcher: async () =>
        Response.json({
          scope: "stored_canonical_content",
          checkedPages: 1,
          totalPages: 1,
          failures: [],
          incomplete: [],
          classifications: {},
          complete: true,
          nextCursor: null,
          ...extra,
        }),
    });
    assert.equal(result.ok, false);
  }
});

test("repeated or invalid content cursors are rejected", async () => {
  await assert.rejects(
    contentIntegrityCheck("https://example.test", "session=private", {
      fetcher: async () =>
        Response.json({
          scope: "stored_canonical_content",
          checkedPages: 1,
          totalPages: 3,
          failures: [],
          incomplete: [],
          complete: false,
          nextCursor: "repeated",
        }),
    }),
    /did not advance/,
  );
});
