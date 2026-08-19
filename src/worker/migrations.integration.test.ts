import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => reset());

describe("D1 migrations", () => {
  it("applies the complete migration history to an empty database and is idempotent", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);

    const objects = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name`,
    ).all<{ name: string }>();
    const names = objects.results.map((object) => object.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "archive_disconnect_targets",
        "deletion_jobs",
        "member_mentions",
        "page_references",
        "prevent_final_owner_demotion",
        "prevent_final_owner_removal",
        "attachment_upload_parts",
        "attachment_uploads",
        "table_bulk_writes",
      ]),
    );

    // Sorting a table joins table_cells on column_id, which the primary key cannot serve.
    const indexes = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toContain("idx_table_cells_column");

    const applied = await env.DB.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all<{ name: string }>();
    expect(applied.results.map((migration) => migration.name)).toEqual(
      env.TEST_MIGRATIONS!.map((migration) => migration.name),
    );
  });

  it("enforces the owner guards and workspace cascade on a fresh database", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES ('workspace', 'owner', 'owner', ?)`,
      ).bind(timestamp),
    ]);

    await expect(
      env.DB.prepare(`UPDATE workspace_members SET role = 'viewer' WHERE user_id = 'owner'`).run(),
    ).rejects.toThrow(/final_owner/);
    await expect(env.DB.prepare(`DELETE FROM workspace_members WHERE user_id = 'owner'`).run()).rejects.toThrow(
      /final_owner/,
    );

    // Deleting the workspace itself must still cascade through the final owner.
    await env.DB.prepare(`DELETE FROM workspaces WHERE id = 'workspace'`).run();
    expect(await env.DB.prepare(`SELECT 1 FROM workspace_members WHERE user_id = 'owner'`).first()).toBeNull();
  });
});
