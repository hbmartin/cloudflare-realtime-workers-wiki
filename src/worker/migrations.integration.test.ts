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

    const uploadColumns = await env.DB.prepare(`PRAGMA table_info(attachment_uploads)`).all<{ name: string }>();
    expect(uploadColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["state", "request_hash", "content_sha256"]),
    );
    const attachmentColumns = await env.DB.prepare(`PRAGMA table_info(attachments)`).all<{ name: string }>();
    expect(attachmentColumns.results.map((column) => column.name)).toContain("content_sha256");
    const receiptColumns = await env.DB.prepare(`PRAGMA table_info(table_bulk_writes)`).all<{ name: string }>();
    expect(receiptColumns.results.map((column) => column.name)).toContain("request_hash");

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

  it("adopts legacy uploads and discards receipts that cannot be bound to a request", async () => {
    const reliability = env.TEST_MIGRATIONS!.find((migration) => migration.name === "0005_import_reliability.sql");
    expect(reliability).toBeTruthy();
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration !== reliability),
    );
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO account
           (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES ('credential', 'owner', 'credential', 'owner', 'hash', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('table-page', 'workspace', 'table', 'a', 'Table', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO table_state (page_id) VALUES ('table-page')`),
      env.DB.prepare(
        `INSERT INTO table_bulk_writes
           (page_id, client_request_id, revision, response_json, created_at)
         VALUES ('table-page', 'legacy', 2, '{}', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO attachment_uploads
           (id, workspace_id, page_id, r2_key, r2_upload_id, name, mime, size, part_size,
            part_count, created_by, created_at, updated_at, next_attempt_at)
         VALUES ('upload', 'workspace', 'table-page', 'assets/upload', 'r2-upload', 'file.bin',
                 'application/octet-stream', 1, 5242880, 1, 'owner', ?, ?, ?)`,
      ).bind(timestamp, timestamp, timestamp),
    ]);

    await applyD1Migrations(env.DB, [reliability!]);

    expect(
      await env.DB.prepare(
        `SELECT state, request_hash, content_sha256 FROM attachment_uploads WHERE id = 'upload'`,
      ).first(),
    ).toEqual({ state: "active", request_hash: null, content_sha256: null });
    expect(await env.DB.prepare(`SELECT 1 FROM table_bulk_writes`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT issuer FROM account WHERE id = 'credential'`).first()).toEqual({
      issuer: "local:credential",
    });
  });
});
