import { test } from "vitest";
import assert from "node:assert/strict";
import { contentIntegrityCheck, metadataIntegrityCheck } from "./integrity.mjs";
import { INTEGRITY_PAGE_COLUMNS } from "../src/shared/integrity.ts";

test("empty database is a valid fresh-install metadata precheck", () => {
  assert.equal(metadataIntegrityCheck(() => [{ name: "d1_migrations" }]).ok, true);
});

test("missing core schema and incomplete query coverage never pass", () => {
  assert.equal(metadataIntegrityCheck(() => [{ name: "user" }]).complete, false);
  const result = metadataIntegrityCheck((sql) => {
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
