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
        "page_move_receipts",
        "prevent_final_owner_demotion",
        "prevent_final_owner_removal",
        "attachment_upload_parts",
        "attachment_uploads",
        "table_bulk_writes",
        "spaces",
        "space_members",
        "document_projections",
        "page_search_v2",
        "jobs",
        "outbox",
        "notifications",
        "digest_delivery_cursors",
        "comment_migrations",
        "slack_installations",
        "slack_user_links",
        "slack_channel_subscriptions",
        "slack_unfurls",
        "slack_request_replays",
      ]),
    );

    // Sorting a table joins table_cells on column_id, which the primary key cannot serve.
    const indexes = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toContain("idx_table_cells_column");
    expect(indexes.results.map((index) => index.name)).not.toContain("idx_page_create_receipts_page");
    expect(indexes.results.map((index) => index.name)).toContain("idx_page_move_receipts_page");
    expect(indexes.results.map((index) => index.name)).toContain("idx_page_move_receipts_created");
    expect(indexes.results.map((index) => index.name)).toContain("idx_pages_workspace_page");
    expect(indexes.results.map((index) => index.name)).toContain("idx_slack_channels_unique");

    const slackColumns = await env.DB.prepare(`PRAGMA table_info(slack_installations)`).all<{ name: string }>();
    expect(slackColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["bot_token_ciphertext", "bot_refresh_token_ciphertext", "token_expires_at"]),
    );
    const channelEventColumns = await env.DB.prepare(`PRAGMA table_info(slack_channel_events)`).all<{ name: string }>();
    expect(channelEventColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["claimed_at", "claim_token"]),
    );
    const unfurlColumns = await env.DB.prepare(`PRAGMA table_info(slack_unfurls)`).all<{ name: string }>();
    expect(unfurlColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["message_ts", "claimed_at", "claim_token", "retired_at", "retirement_reason"]),
    );
    const deliveryColumns = await env.DB.prepare(`PRAGMA table_info(deliveries)`).all<{ name: string }>();
    expect(deliveryColumns.results.map((column) => column.name)).toContain("claim_token");
    const digestCursorColumns = await env.DB.prepare(`PRAGMA table_info(digest_delivery_cursors)`).all<{
      name: string;
      pk: number;
    }>();
    expect(digestCursorColumns.results.filter((column) => column.pk).map((column) => [column.name, column.pk])).toEqual(
      [
        ["channel", 1],
        ["timezone", 2],
      ],
    );

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
    const pageMoveReceiptColumns = await env.DB.prepare(`PRAGMA table_info(page_move_receipts)`).all<{
      name: string;
    }>();
    expect(pageMoveReceiptColumns.results.map((column) => column.name)).toEqual([
      "workspace_id",
      "operation_id",
      "page_id",
      "request_hash",
      "response_json",
      "created_at",
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

  it("migrates digest cursors to independent channel and timezone keys", async () => {
    const migration = env.TEST_MIGRATIONS!.find((candidate) => candidate.name === "0020_digest_timezone_cursors.sql");
    expect(migration).toBeTruthy();
    const migrationIndex = env.TEST_MIGRATIONS!.indexOf(migration!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, migrationIndex));
    await env.DB.prepare(
      `INSERT INTO digest_delivery_cursors (channel, user_id, workspace_id, timezone, updated_at)
       VALUES ('email', 'utc-user', 'workspace', 'UTC', 123)`,
    ).run();

    await applyD1Migrations(env.DB, [migration!]);
    await env.DB.prepare(
      `INSERT INTO digest_delivery_cursors (channel, user_id, workspace_id, timezone, updated_at)
       VALUES ('email', 'la-user', 'workspace', 'America/Los_Angeles', 456)`,
    ).run();

    expect(
      await env.DB.prepare(
        `SELECT channel, user_id, timezone, updated_at FROM digest_delivery_cursors ORDER BY timezone`,
      ).all(),
    ).toMatchObject({
      results: [
        { channel: "email", user_id: "la-user", timezone: "America/Los_Angeles", updated_at: 456 },
        { channel: "email", user_id: "utc-user", timezone: "UTC", updated_at: 123 },
      ],
    });
  });

  it("explicitly retires legacy Slack unfurls that have no recoverable message timestamp", async () => {
    const retirement = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0019_retire_legacy_slack_unfurls.sql",
    );
    expect(retirement).toBeTruthy();
    const retirementIndex = env.TEST_MIGRATIONS!.indexOf(retirement!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, retirementIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', 1, ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO slack_installations
          (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
           installed_by, created_at, updated_at)
         VALUES ('installation', 'workspace', 'T123', 'Team', 'B123', 'ciphertext', '', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_unfurls
          (id, installation_id, workspace_id, user_id, channel_id, unfurls_json, created_at)
         VALUES ('legacy-unfurl', 'installation', 'workspace', 'owner', 'C123', '{}', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         VALUES ('outbox:legacy-unfurl', 'workspace', 'slack_unfurl',
                 json_object('unfurlId', 'legacy-unfurl'), ?, ?)`,
      ).bind(timestamp, timestamp),
    ]);

    await applyD1Migrations(env.DB, [retirement!]);

    expect(
      await env.DB.prepare(
        `SELECT delivered_at, retired_at IS NOT NULL retired, retirement_reason
           FROM slack_unfurls WHERE id = 'legacy-unfurl'`,
      ).first(),
    ).toEqual({ delivered_at: null, retired: 1, retirement_reason: "legacy_missing_message_ts" });
    expect(await env.DB.prepare(`SELECT last_error FROM outbox WHERE id = 'outbox:legacy-unfurl'`).first()).toEqual({
      last_error: "legacy_unfurl_missing_message_ts",
    });
  });

  it("applies review follow-ups through a new migration after the old history was recorded", async () => {
    const followup = env.TEST_MIGRATIONS!.find((migration) => migration.name === "0018_delivery_and_search_fences.sql");
    expect(followup).toBeTruthy();
    const followupIndex = env.TEST_MIGRATIONS!.indexOf(followup!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, followupIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', 1, ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES ('workspace', 'owner', 'owner', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, is_template, created_by, created_at, updated_at)
         VALUES ('template', 'workspace', 'workspace-general', 'document', 'a0', 'Template', 1, 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO page_search_v2
          (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
         VALUES ('template', 'workspace', 'workspace-general', 'Template', '', '', '', '')`,
      ),
    ]);

    await applyD1Migrations(env.DB, [followup!]);

    expect(await env.DB.prepare(`SELECT page_id FROM page_search_v2 WHERE page_id = 'template'`).first()).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT id, type, status FROM jobs WHERE id = 'workspace-search-reindex-v2-followup'`,
      ).first(),
    ).toEqual({ id: "workspace-search-reindex-v2-followup", type: "search_reindex", status: "queued" });
    expect(
      (await env.DB.prepare(`PRAGMA table_info(slack_channel_events)`).all<{ name: string }>()).results.map(
        (column) => column.name,
      ),
    ).toEqual(expect.arrayContaining(["claimed_at", "claim_token"]));
  });

  it("marks legacy comment migrations separately and enrolls existing page creators as watchers", async () => {
    const commentsMigration = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0013_comments_notifications.sql",
    );
    expect(commentsMigration).toBeTruthy();
    const migrationIndex = env.TEST_MIGRATIONS!.indexOf(commentsMigration!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, migrationIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES ('workspace', 'owner', 'owner', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('page', 'workspace', 'workspace-general', 'document', 'a0', 'Page', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
    ]);

    await applyD1Migrations(env.DB, [commentsMigration!]);

    expect(
      await env.DB.prepare(
        `SELECT user_id, resource_type, resource_id, muted_at FROM subscriptions WHERE resource_id = 'page'`,
      ).first(),
    ).toEqual({ user_id: "owner", resource_type: "page", resource_id: "page", muted_at: null });
    expect(await env.DB.prepare(`SELECT page_id FROM comment_migrations`).first()).toBeNull();

    const scanMigration = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0014_comment_migration_jobs.sql",
    );
    expect(scanMigration).toBeTruthy();
    await applyD1Migrations(env.DB, [scanMigration!]);
    expect(
      await env.DB.prepare(
        `SELECT workspace_id, requested_by, type, status FROM jobs WHERE workspace_id = 'workspace'`,
      ).first(),
    ).toEqual({ workspace_id: "workspace", requested_by: "owner", type: "comment_migration", status: "queued" });

    await env.DB.batch([
      env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = 'page'`).bind(timestamp),
      env.DB.prepare(`DELETE FROM page_search_v2 WHERE page_id = 'page'`),
    ]);
    const searchMigration = env.TEST_MIGRATIONS!.find((migration) => migration.name === "0015_search_v2_rollout.sql");
    expect(searchMigration).toBeTruthy();
    await applyD1Migrations(env.DB, [searchMigration!]);
    expect(await env.DB.prepare(`SELECT page_id, title FROM page_search_v2 WHERE page_id = 'page'`).first()).toEqual({
      page_id: "page",
      title: "Page",
    });
    expect(
      await env.DB.prepare(
        `SELECT workspace_id, requested_by, type, status FROM jobs
          WHERE workspace_id = 'workspace' AND type = 'search_reindex'`,
      ).first(),
    ).toEqual({ workspace_id: "workspace", requested_by: "owner", type: "search_reindex", status: "queued" });
  });

  it("preserves reserved Slack integration records while upgrading their schema", async () => {
    const slackMigration = env.TEST_MIGRATIONS!.find((migration) => migration.name === "0016_slack_integration.sql");
    expect(slackMigration).toBeTruthy();
    const migrationIndex = env.TEST_MIGRATIONS!.indexOf(slackMigration!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, migrationIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES ('workspace', 'owner', 'owner', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('page', 'workspace', 'workspace-general', 'document', 'a0', 'Page', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_installations
          (workspace_id, team_id, team_name, bot_user_id, encrypted_bot_token, installed_by, created_at, updated_at)
         VALUES ('workspace', 'T123', 'Legacy Slack', 'B123', 'encrypted-token', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_user_links (workspace_id, user_id, slack_user_id, created_at)
         VALUES ('workspace', 'owner', 'U123', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO slack_link_tokens (token_hash, workspace_id, slack_user_id, expires_at)
         VALUES ('token', 'workspace', 'U123', ?)`,
      ).bind(timestamp + 600_000),
      env.DB.prepare(
        `INSERT INTO slack_channel_subscriptions
          (id, workspace_id, space_id, page_id, channel_id, channel_name, events_json, cadence, created_by, created_at)
         VALUES ('channel', 'workspace', 'workspace-general', 'page', 'C123', 'notes', '["page_edit"]', 'digest', 'owner', ?)`,
      ).bind(timestamp),
    ]);

    await applyD1Migrations(env.DB, [slackMigration!]);
    expect(
      await env.DB.prepare(`SELECT id, workspace_id, team_id, bot_token_ciphertext FROM slack_installations`).first(),
    ).toEqual({ id: "workspace", workspace_id: "workspace", team_id: "T123", bot_token_ciphertext: "encrypted-token" });
    expect(await env.DB.prepare(`SELECT installation_id, slack_user_id FROM slack_user_links`).first()).toEqual({
      installation_id: "workspace",
      slack_user_id: "U123",
    });
    expect(
      await env.DB.prepare(
        `SELECT installation_id, event_types_json, cadence FROM slack_channel_subscriptions`,
      ).first(),
    ).toEqual({ installation_id: "workspace", event_types_json: '["page_edit"]', cadence: "digest" });
  });

  it("backfills every legacy page into a General space and guards cross-space parents", async () => {
    const foundation = env.TEST_MIGRATIONS!.find((migration) => migration.name === "0012_parity_foundations.sql");
    expect(foundation).toBeTruthy();
    const foundationIndex = env.TEST_MIGRATIONS!.indexOf(foundation!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, foundationIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES ('workspace', 'owner', 'owner', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('parent', 'workspace', 'document', 'a0', 'Parent', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, parent_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('child', 'workspace', 'parent', 'document', 'a1', 'Child', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
    ]);

    await applyD1Migrations(env.DB, [foundation!]);

    expect(await env.DB.prepare(`SELECT id FROM spaces WHERE workspace_id = 'workspace'`).first()).toEqual({
      id: "workspace-general",
    });
    expect(
      await env.DB.prepare(`SELECT id, space_id FROM pages ORDER BY id`).all<{ id: string; space_id: string }>(),
    ).toMatchObject({
      results: [
        { id: "child", space_id: "workspace-general" },
        { id: "parent", space_id: "workspace-general" },
      ],
    });

    await env.DB.prepare(
      `INSERT INTO spaces (id, workspace_id, name, slug, position, created_at, updated_at)
       VALUES ('private', 'workspace', 'Private', 'private', 'a1', ?, ?)`,
    )
      .bind(timestamp, timestamp)
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, parent_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('invalid', 'workspace', 'private', 'parent', 'document', 'a2', 'Invalid', 'owner', ?, ?)`,
      )
        .bind(timestamp, timestamp)
        .run(),
    ).rejects.toThrow(/cross_space_parent/);
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
      env.DB.prepare(
        `INSERT INTO page_move_receipts
           (workspace_id, operation_id, page_id, request_hash, response_json, created_at)
         VALUES ('workspace', 'move', 'page', 'request', '{}', ?)`,
      ).bind(timestamp),
    ]);
    await env.DB.prepare(`DELETE FROM pages WHERE id = 'page'`).run();
    expect(await env.DB.prepare(`SELECT 1 FROM page_create_receipts WHERE page_id = 'page'`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 FROM page_move_receipts WHERE page_id = 'page'`).first()).toBeNull();

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

  it("normalizes legacy page-move snapshots into versioned envelopes", async () => {
    const envelopes = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0011_page_move_receipt_envelopes.sql",
    );
    expect(envelopes).toBeTruthy();
    const envelopeIndex = env.TEST_MIGRATIONS!.indexOf(envelopes!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, envelopeIndex));
    const timestamp = Date.now();
    const page = {
      id: "page",
      workspaceId: "workspace",
      parentId: null,
      kind: "document",
      position: "a",
      title: "Page",
      icon: null,
      revision: 1,
      contentEpoch: 1,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const versioned = { pageMoveReceiptVersion: 1, page };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO pages
           (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES ('page', 'workspace', 'document', 'a', 'Page', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      ...[
        ["bare", JSON.stringify(page)],
        ["non-object", "[]"],
        ["versioned", JSON.stringify(versioned)],
        ["malformed", "{"],
      ].map(([operationId, responseJson]) =>
        env.DB.prepare(
          `INSERT INTO page_move_receipts
             (workspace_id, operation_id, page_id, request_hash, response_json, created_at)
           VALUES ('workspace', ?, 'page', 'request', ?, ?)`,
        ).bind(operationId, responseJson, timestamp),
      ),
    ]);

    await applyD1Migrations(env.DB, [envelopes!]);

    const receipts = await env.DB.prepare(
      `SELECT operation_id, response_json FROM page_move_receipts ORDER BY operation_id`,
    ).all<{ operation_id: string; response_json: string }>();
    expect(receipts.results.map(({ operation_id, response_json }) => [operation_id, response_json])).toEqual([
      ["bare", JSON.stringify(versioned)],
      ["malformed", "{"],
      ["non-object", "[]"],
      ["versioned", JSON.stringify(versioned)],
    ]);
  });
});
