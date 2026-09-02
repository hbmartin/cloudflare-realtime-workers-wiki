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
        "page_create_receipts",
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
    expect(indexes.results.map((index) => index.name)).not.toContain("idx_page_create_receipts_page");
    expect(indexes.results.map((index) => index.name)).toContain("idx_pages_workspace_page");

    const uploadColumns = await env.DB.prepare(`PRAGMA table_info(attachment_uploads)`).all<{ name: string }>();
    expect(uploadColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["state", "request_hash", "content_sha256"]),
    );
    const attachmentColumns = await env.DB.prepare(`PRAGMA table_info(attachments)`).all<{ name: string }>();
    expect(attachmentColumns.results.map((column) => column.name)).toContain("content_sha256");
    const receiptColumns = await env.DB.prepare(`PRAGMA table_info(table_bulk_writes)`).all<{ name: string }>();
    expect(receiptColumns.results.map((column) => column.name)).toContain("request_hash");
    const pageCreateReceiptColumns = await env.DB.prepare(`PRAGMA table_info(page_create_receipts)`).all<{
      name: string;
    }>();
    expect(pageCreateReceiptColumns.results.map((column) => column.name)).toEqual([
      "workspace_id",
      "page_id",
      "request_hash",
    ]);
    const receiptPageForeignKey = await env.DB.prepare(`PRAGMA foreign_key_list(page_create_receipts)`).all<{
      seq: number;
      table: string;
      from: string;
      to: string;
    }>();
    expect(
      receiptPageForeignKey.results
        .filter((foreignKey) => foreignKey.table === "pages")
        .toSorted((left, right) => left.seq - right.seq)
        .map((foreignKey) => [foreignKey.from, foreignKey.to]),
    ).toEqual([
      ["workspace_id", "workspace_id"],
      ["page_id", "id"],
    ]);

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

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('page', 'workspace', 'document', 'a0', 'Page', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO page_create_receipts (workspace_id, page_id, request_hash)
         VALUES ('workspace', 'page', 'request')`,
      ),
    ]);
    await env.DB.prepare(`DELETE FROM pages WHERE id = 'page'`).run();
    expect(await env.DB.prepare(`SELECT 1 FROM page_create_receipts WHERE page_id = 'page'`).first()).toBeNull();

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

  it("adopts only page-create receipts that still match a live page", async () => {
    const lifecycle = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0007_page_create_receipt_lifecycle.sql",
    );
    expect(lifecycle).toBeTruthy();
    const lifecycleIndex = env.TEST_MIGRATIONS!.indexOf(lifecycle!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, lifecycleIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('page', 'workspace', 'document', 'a', 'Page', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO page_create_receipts
           (workspace_id, page_id, request_hash, response_json, created_at)
         VALUES ('workspace', 'page', 'live-request', '{}', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO page_create_receipts
           (workspace_id, page_id, request_hash, response_json, created_at)
         VALUES ('workspace', 'deleted-page', 'orphan-request', '{}', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO page_create_receipts
           (workspace_id, page_id, request_hash, response_json, created_at)
         VALUES ('other', 'page', 'wrong-workspace-request', '{}', ?)`,
      ).bind(timestamp),
    ]);

    await applyD1Migrations(env.DB, [lifecycle!]);

    expect(
      await env.DB.prepare(
        `SELECT workspace_id, page_id, request_hash FROM page_create_receipts ORDER BY workspace_id, page_id`,
      ).all(),
    ).toMatchObject({
      results: [{ workspace_id: "workspace", page_id: "page", request_hash: "live-request" }],
    });
    await env.DB.prepare(`DELETE FROM pages WHERE id = 'page'`).run();
    expect(await env.DB.prepare(`SELECT 1 FROM page_create_receipts`).first()).toBeNull();
  });

  it("strengthens an applied page-create receipt lifecycle without retaining the redundant page index", async () => {
    const integrity = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0008_page_create_receipt_integrity.sql",
    );
    expect(integrity).toBeTruthy();
    const integrityIndex = env.TEST_MIGRATIONS!.indexOf(integrity!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, integrityIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('page', 'workspace', 'document', 'a', 'Page', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO page_create_receipts (workspace_id, page_id, request_hash)
         VALUES ('workspace', 'page', 'live-request')`,
      ),
      env.DB.prepare(
        `INSERT INTO page_create_receipts (workspace_id, page_id, request_hash)
         VALUES ('other', 'page', 'wrong-workspace-request')`,
      ),
    ]);
    // Some preview databases may have received the abandoned in-place 0007
    // edit before this forward migration replaced it.
    await env.DB.prepare(`CREATE UNIQUE INDEX idx_pages_workspace_page ON pages(workspace_id, id)`).run();

    await applyD1Migrations(env.DB, [integrity!]);

    expect(
      await env.DB.prepare(
        `SELECT workspace_id, page_id, request_hash FROM page_create_receipts ORDER BY workspace_id, page_id`,
      ).all(),
    ).toMatchObject({
      results: [{ workspace_id: "workspace", page_id: "page", request_hash: "live-request" }],
    });
    await expect(
      env.DB.prepare(
        `INSERT INTO page_create_receipts (workspace_id, page_id, request_hash)
         VALUES ('other', 'page', 'wrong-workspace-request')`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      env.DB.prepare(`UPDATE page_create_receipts SET workspace_id = 'other' WHERE page_id = 'page'`).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    const indexes = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toContain("idx_pages_workspace_page");
    expect(indexes.results.map((index) => index.name)).not.toContain("idx_page_create_receipts_page");
    await env.DB.prepare(`DELETE FROM pages WHERE id = 'page'`).run();
    expect(await env.DB.prepare(`SELECT 1 FROM page_create_receipts`).first()).toBeNull();
  });
});
