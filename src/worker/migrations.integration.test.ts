import {
  legacyShareRecoverySelectSql,
  blockedShareRecoverySelectSql,
  shareRecoveryPreflightSql,
} from "../shared/slack-share-recovery";
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./env";
import { createAuth } from "./auth";
import { redriveRound2Outbox } from "./slack-recovery";

beforeEach(() => reset());

describe("D1 migrations", () => {
  it.each(["0001", "0067", "0068", "0069", "0072", "0073", "0075", "0076", "0077", "0078"])(
    "upgrades a database before %s through the additive follow-up",
    async (foundation) => {
      await applyD1Migrations(
        env.DB,
        env.TEST_MIGRATIONS!.filter((migration) => migration.name < foundation),
      );
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
      expect(
        await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='slack_digest_reservations_message'").first(),
      ).toEqual({ name: "slack_digest_reservations_message" });
      expect(
        await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name='slack_digest_unsent_children'").first<{
          sql: string;
        }>(),
      ).toEqual({
        sql: expect.stringMatching(
          /ON slack_digest_messages\(receipt_id,id\)\s+WHERE state='pending' AND attempted_at IS NULL/,
        ),
      });
    },
  );
  it("0078 repairs only missing owned channel deadlines and preserves protected schedules", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((m) => m.name < "0078"),
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@example.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
      env.DB.prepare(
        "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at,generation) VALUES('installation','workspace','T123','Slack','B123','unused','chat:write','owner',1,1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES('page','workspace','workspace-general','document','a0','Page','owner',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO slack_channel_subscriptions(id,installation_id,space_id,channel_id,channel_name,event_types_json,cadence,created_by,created_at,updated_at,round2_initialized) VALUES('owned','installation','workspace-general','C123','notes','[]','immediate','owner',1,1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO slack_channel_subscriptions(id,installation_id,space_id,channel_id,channel_name,event_types_json,cadence,created_by,created_at,updated_at,round2_initialized) VALUES('legacy','installation','workspace-general','C456','legacy','[]','immediate','owner',1,1,0)",
      ),
    ]);
    const cases = [
      "pending",
      "sending",
      "blocked",
      "canonical",
      "completed",
      "suppressed",
      "scope",
      "fresh_claim",
      "due",
      "claim_recheck",
      "unowned",
      "unenqueued",
      "enqueue_retry",
      "repair_signature",
      "coordination",
    ];
    for (const kind of cases) {
      const id = kind === "canonical" ? "activity:canonical" : kind;
      await env.DB.prepare(`INSERT INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at,round2_state,attempted_at,claimed_at,delivered_at,suppressed_at)
        VALUES(?,?,'workspace','page_edit','owner','page','immediate',1,?,?,?,?,?)`)
        .bind(
          id,
          kind === "canonical" || kind === "unowned" ? "legacy" : "owned",
          kind === "sending" || kind === "blocked" ? kind : kind === "completed" ? "sent" : "pending",
          kind === "sending" || kind === "blocked" ? 1 : null,
          kind === "fresh_claim" ? Date.now() : null,
          kind === "completed" ? 1 : null,
          kind === "suppressed" ? 1 : null,
        )
        .run();
      await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,attempts,slack_redrive_count,slack_scope_paused_at,slack_redrive_due_at,slack_claim_recheck_at,slack_enqueue_redrive_pending,last_error)
        VALUES(?,'workspace','slack_channel',?,1,1,?,7,8,?,?,?,?,?)`)
        .bind(
          kind,
          JSON.stringify({ eventId: id }),
          kind === "unenqueued" ? null : 1,
          kind === "scope" ? 1 : null,
          kind === "due" ? 777 : null,
          kind === "claim_recheck" ? 888 : null,
          kind === "enqueue_retry" ? 1 : 0,
          kind === "repair_signature"
            ? "Invalid Slack redrive payload"
            : kind === "coordination"
              ? "slack_validation_stale"
              : null,
        )
        .run();
    }
    const before = (await env.DB.prepare("SELECT * FROM outbox ORDER BY id").all<Record<string, unknown>>()).results;
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const after = (await env.DB.prepare("SELECT * FROM outbox ORDER BY id").all<Record<string, unknown>>()).results;
    for (const row of after) {
      const original = before.find((r) => r.id === row.id)!;
      const repaired = ["pending", "sending", "blocked", "canonical"].includes(row.id as string);
      const deadline = expect.any(Number);
      expect(row).toEqual(repaired ? { ...original, slack_redrive_due_at: deadline } : original);
      expect(repaired && Number(row.slack_redrive_due_at) <= 1).toBe(false);
    }
  });
  it.each([
    { preflight: false, foundation: "0074" },
    { preflight: true, foundation: "0074" },
    { preflight: true, foundation: "0072" },
    { preflight: true, foundation: "0071" },
    { preflight: true, foundation: "0073" },
    { preflight: true, foundation: "0067" },
    { preflight: true, foundation: "0068" },
    { preflight: true, foundation: "0069" },
  ])(
    "repairs only proven work through 0078 with $foundation foundation and preflight=$preflight",
    async ({ preflight, foundation }) => {
      await applyD1Migrations(
        env.DB,
        env.TEST_MIGRATIONS!.filter((migration) => migration.name < foundation),
      );
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@example.test',1,1)",
        ),
        env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
        env.DB.prepare(
          "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',1)",
        ),
        env.DB.prepare(
          "INSERT INTO twoFactor(id,userId,secret,backupCodes,verified) VALUES('factor','owner','secret','[]',1)",
        ),
        env.DB.prepare("UPDATE account_security SET codes_saved=1 WHERE user_id='owner'"),
        env.DB.prepare(
          "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at,generation) VALUES('installation','workspace','T123','Slack','B123','unused','chat:write','owner',1,1,1)",
        ),
        env.DB.prepare(
          "INSERT INTO account(id,userId,providerId,accountId,createdAt,updatedAt) VALUES('oauth','owner','slack','T123:UOWNER',1,1)",
        ),
        env.DB.prepare(
          `INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,better_auth_account_id,verification_method,migration_state,verified_at,installation_generation
          ${foundation > "0071" ? ",security_generation" : ""}${foundation > "0072" ? ",authorization_started_at" : ""})
          VALUES('installation','owner','UOWNER',1,'oauth','slack_openid','verified',1,1${foundation > "0071" ? ",0" : ""}${foundation > "0072" ? ",1" : ""})`,
        ),
        env.DB.prepare(
          "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES('page','workspace','workspace-general','document','a0','Page','owner',1,1)",
        ),
        env.DB.prepare(
          "INSERT INTO slack_channel_subscriptions(id,installation_id,space_id,channel_id,channel_name,event_types_json,cadence,created_by,created_at,updated_at) VALUES('mapping','installation','workspace-general','C123','notes','[]','immediate','owner',1,1)",
        ),
      ]);
      const activityModes = ["pending", "sending", "blocked", "retired", "scope", "claimed", "newer"];
      for (const mode of activityModes) {
        const id = `activity:${mode}`;
        await env.DB.prepare(`INSERT INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at,round2_state,claimed_at)
        VALUES(?,'mapping','workspace','page_created','owner','page','immediate',1,?,?)`)
          .bind(
            id,
            ["sending", "blocked", "retired"].includes(mode) ? mode : "pending",
            mode === "claimed" ? Date.now() : null,
          )
          .run();
        await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,last_error,slack_scope_paused_at)
        VALUES(?,'workspace','slack_channel',?,1,1,1,?,?)`)
          .bind(
            id,
            JSON.stringify({ eventId: id }),
            mode === "newer" ? "newer_schedule" : "Invalid Slack redrive payload",
            mode === "scope" ? 1 : null,
          )
          .run();
      }
      const modes = [
        "pending",
        "blocked_identity",
        "scope",
        "sending",
        "sent",
        "uncertain",
        "future",
        "generation",
        "user",
        "malformed",
        "denied",
      ];
      for (const mode of modes) {
        const state =
          mode === "pending" || ["scope", "future", "generation", "user", "malformed", "denied"].includes(mode)
            ? "pending"
            : mode === "blocked_identity" || mode === "uncertain"
              ? "blocked"
              : mode;
        await env.DB.prepare(`INSERT INTO slack_interaction_receipts(id,installation_id,interaction_id,callback_id,received_at,processed_at,outcome,response_delivery_state,response_delivery_error)
        VALUES(?,'installation',?,'share',?,1,?,?,?)`)
          .bind(
            mode,
            mode,
            mode === "future" ? 0 : 10,
            mode === "denied" ? "denied" : "accepted",
            state,
            mode === "blocked_identity"
              ? "request_identity_unavailable"
              : mode === "uncertain"
                ? "send_unconfirmed"
                : null,
          )
          .run();
        const payload = {
          receiptId: mode,
          installationId: "installation",
          generation: mode === "generation" ? 2 : 1,
          userId: mode === "user" ? "OTHER" : "UOWNER",
          ...(mode === "malformed" ? { identity: null } : {}),
        };
        await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_scope_paused_at)
        VALUES(?,'workspace','slack_share_response',?,1,1,1,?)`)
          .bind(`share:${mode}`, JSON.stringify(payload), mode === "scope" ? 1 : null)
          .run();
      }
      if (preflight && foundation === "0074")
        await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<5000)
        INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
        SELECT 'unrelated:'||n,'workspace','slack_unfurl','{}',1,1 FROM numbers`).run();
      if (preflight)
        await env.DB.prepare(
          "UPDATE outbox SET slack_redrive_count=7,slack_eligible_started_at=1 WHERE id='share:blocked_identity'",
        ).run();
      let preflightPlan: string[] = [];
      if (preflight) {
        const statements = shareRecoveryPreflightSql(
          env.TEST_MIGRATIONS!.filter((migration) => migration.name >= foundation).map((migration) => migration.name),
        )
          .split(";")
          .map((sql) => sql.trim())
          .filter(Boolean);
        const update = statements.findIndex((sql) => sql.startsWith("UPDATE outbox"));
        await env.DB.batch(statements.slice(0, update).map((sql) => env.DB.prepare(sql)));
        const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statements[update]}`).all<{ detail: string }>();
        preflightPlan = plan.results.map((row) => row.detail);
        await env.DB.batch(statements.slice(update).map((sql) => env.DB.prepare(sql)));
        await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
      }
      expect(
        preflightPlan.some((detail) => detail.includes("SEARCH outbox USING INDEX sqlite_autoindex_outbox_1")),
      ).toBe(preflight);
      expect(preflightPlan.some((detail) => detail.includes("sqlite_autoindex_slack_share_recovery_preflight_1"))).toBe(
        preflight,
      );
      expect(preflightPlan.some((detail) => detail.includes("SCAN repair"))).toBe(false);
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
      expect(await env.DB.prepare("SELECT max(slack_enqueue_failure_count) failures FROM outbox").first()).toEqual({
        failures: 0,
      });
      const indexes = (
        await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index'").all<{ name: string }>()
      ).results.map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "slack_digest_receipts_subscription_window",
          "slack_digest_pending_cleanup",
          "slack_activity_legacy_repair",
          "slack_share_response_receipt",
          "slack_digest_pending_subscription",
          "slack_digest_reservations_message",
          "slack_share_recoverable_receipts",
        ]),
      );
      const sharePlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${legacyShareRecoverySelectSql}`).all<{
        detail: string;
      }>();
      expect(sharePlan.results.some((row) => row.detail.includes("slack_share_response_receipt (<expr>=?)"))).toBe(
        true,
      );
      const blockedPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${blockedShareRecoverySelectSql}`).all<{
        detail: string;
      }>();
      expect(blockedPlan.results.some((row) => row.detail.includes("slack_share_recoverable_receipts"))).toBe(true);
      const receiptPlan = await env.DB.prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM slack_digest_receipts WHERE subscription_id=? AND window_start<=? AND window_end>?",
      )
        .bind("mapping", 1, 1)
        .all<{ detail: string }>();
      expect(receiptPlan.results.some((row) => row.detail.includes("slack_digest_receipts_subscription_window"))).toBe(
        true,
      );
      for (const mode of activityModes) {
        const row = await env.DB.prepare(
          "SELECT enqueued_at,last_error,slack_enqueue_redrive_pending,attempts FROM outbox WHERE id=?",
        )
          .bind(`activity:${mode}`)
          .first();
        expect(row).toMatchObject({
          enqueued_at: mode === "pending" ? null : 1,
          last_error: mode === "pending" ? null : mode === "newer" ? "newer_schedule" : "Invalid Slack redrive payload",
          slack_enqueue_redrive_pending: 0,
          attempts: mode === "pending" ? 1 : 0,
        });
      }
      for (const mode of modes) {
        const repaired = ["pending", "blocked_identity"].includes(mode);
        const row = await env.DB.prepare(
          "SELECT enqueued_at,attempts,json_extract(payload_json,'$.identity') identity FROM outbox WHERE id=?",
        )
          .bind(`share:${mode}`)
          .first<{ identity: string | null }>();
        expect(row).toMatchObject({ enqueued_at: repaired ? null : 1, attempts: repaired ? 1 : 0 });
        expect(row!.identity === null).toBe(!repaired);
        expect(row!.identity ? JSON.parse(row!.identity) : null).toEqual(
          repaired
            ? {
                userId: "owner",
                accountId: "oauth",
                verifiedAt: 1,
                slackUserId: "UOWNER",
              }
            : null,
        );
      }
      const clock = await env.DB.prepare(
        "SELECT slack_redrive_count,slack_eligible_started_at FROM outbox WHERE id='share:blocked_identity'",
      ).first();
      expect(clock).toEqual({ slack_redrive_count: 0, slack_eligible_started_at: null });
      expect(
        await env.DB.prepare(
          "SELECT response_delivery_state,response_delivery_error FROM slack_interaction_receipts WHERE id='blocked_identity'",
        ).first(),
      ).toEqual({ response_delivery_state: "pending", response_delivery_error: null });
      expect(
        await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='slack_share_recovery_0074'").first(),
      ).toBeNull();
    },
  );

  it("applies 0075 after an already deployed 0074 without changing scheduling versions", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0075"),
    );
    await env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)").run();
    await env.DB.prepare(
      "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,attempts) VALUES('old','workspace','slack_share_response','{}',1,1,40)",
    ).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare("SELECT attempts,slack_enqueue_failure_count FROM outbox WHERE id='old'").first(),
    ).toEqual({ attempts: 40, slack_enqueue_failure_count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT digest_cleanup_created_at,digest_cleanup_event_id FROM round2_runtime WHERE id=1",
      ).first(),
    ).toEqual({ digest_cleanup_created_at: 0, digest_cleanup_event_id: "" });
  });

  it.each(["legacy", "verified"])(
    "revokes %s workspace links on removal without restoring them on rejoin",
    async (kind) => {
      await applyD1Migrations(
        env.DB,
        env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0073"),
      );
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('member','Member','member@example.test',1,1),('admin','Admin','admin@example.test',1,1),('orphan','Orphan','orphan@example.test',1,1)",
        ),
        env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('first','First',1),('second','Second',1)"),
        env.DB.prepare(
          "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('first','admin','owner',1),('second','admin','owner',1),('first','member','editor',1),('second','member','editor',1)",
        ),
        env.DB.prepare(
          "INSERT INTO twoFactor(id,userId,secret,backupCodes,verified) VALUES('factor','member','secret','[]',1)",
        ),
        env.DB.prepare("UPDATE account_security SET codes_saved=1 WHERE user_id='member'"),
        env.DB
          .prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at)
        VALUES('first-installation','first','TFIRST','First','B123','unused','users:read','admin',1,1),('second-installation','second','TSECOND','Second','B123','unused','users:read','admin',1,1)`),
        env.DB.prepare(
          "INSERT INTO account(id,userId,providerId,accountId,createdAt,updatedAt) VALUES('oauth','member','slack','TFIRST:UMEMBER',1,1),('second-oauth','member','slack','TSECOND:UMEMBER',1,1)",
        ),
        env.DB.prepare(`INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,authorization_started_at,security_generation,better_auth_account_id,verification_method,migration_state,verified_at)
        VALUES('first-installation','member','UMEMBER',1,1,0,'oauth',?,?,1),('second-installation','member','UMEMBER',1,1,0,'second-oauth',?,?,1),('first-installation','orphan','UORPHAN',1,1,0,NULL,'legacy_command','legacy',NULL)`).bind(
          kind === "verified" ? "slack_openid" : "legacy_command",
          kind,
          kind === "verified" ? "slack_openid" : "legacy_command",
          kind,
        ),
      ]);
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
      expect(await env.DB.prepare("SELECT 1 FROM slack_user_links WHERE user_id='orphan'").first()).toBeNull();
      expect(
        (await env.DB.prepare("SELECT installation_id FROM slack_authorized_user_links WHERE user_id='member'").all())
          .results,
      ).toHaveLength(2);
      await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id='first' AND user_id='member'").run();
      expect(
        (await env.DB.prepare("SELECT installation_id FROM slack_user_links WHERE user_id='member'").all()).results,
      ).toEqual([{ installation_id: "second-installation" }]);
      expect(await env.DB.prepare("SELECT 1 FROM account WHERE id='oauth'").first()).not.toBeNull();
      await env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('first','member','editor',2)",
      ).run();
      expect(
        await env.DB.prepare(
          "SELECT 1 FROM slack_authorized_user_links WHERE installation_id='first-installation' AND user_id='member'",
        ).first(),
      ).toBeNull();
      // Explicit relinking starts a new grant; historical work is outside that grant.
      await env.DB.prepare(`INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,authorization_started_at,security_generation,better_auth_account_id,verification_method,migration_state,verified_at)
      VALUES('first-installation','member','UMEMBER',10,10,0,'oauth','slack_openid','verified',10)`).run();
      expect(
        await env.DB.prepare(
          "SELECT authorization_started_at FROM slack_authorized_user_links WHERE installation_id='first-installation'",
        ).first(),
      ).toEqual({ authorization_started_at: 10 });
      expect(
        await env.DB.prepare(
          "SELECT 1 FROM slack_authorized_user_links WHERE installation_id='first-installation' AND authorization_started_at<=1",
        ).first(),
      ).toBeNull();
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    },
  );

  it("grandfathers protected bindings, rejects older writes and revokes access on reset or unlink", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((m) => m.name < "0071"),
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('protected','Protected','protected@example.test',1,1),('unprotected','Unprotected','unprotected@example.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
      env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','protected','owner',1),('workspace','unprotected','editor',1)",
      ),
      env.DB.prepare(
        "INSERT INTO twoFactor(id,userId,secret,backupCodes,verified) VALUES('factor','protected','secret','[]',1)",
      ),
      env.DB.prepare("UPDATE account_security SET codes_saved=1 WHERE user_id='protected'"),
      env.DB.prepare(
        "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at) VALUES('installation','workspace','T123','Slack','B123','cipher','users:read','protected',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at) VALUES('installation','protected','UPROTECTED',1),('installation','unprotected','UUNPROTECTED',1)",
      ),
      env.DB.prepare(
        "INSERT INTO account(id,userId,providerId,accountId,createdAt,updatedAt) VALUES('oauth','protected','slack','T123:UPROTECTED',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES('session','protected','session-token','2099-01-01T00:00:00.000Z',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO slack_primary_factor_proofs(session_id,user_id,account_id,team_id,slack_user_id,verified_at,expires_at) VALUES('session','protected','oauth','T123','UPROTECTED',1,9999999999999)",
      ),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect((await env.DB.prepare("SELECT user_id FROM slack_authorized_user_links").all()).results).toEqual([
      { user_id: "protected" },
    ]);
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    await env.DB.prepare("DELETE FROM slack_user_links WHERE user_id='protected'").run();
    await env.DB.prepare(
      "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at) VALUES('installation','protected','UPROTECTED',2)",
    ).run();
    expect(await env.DB.prepare("SELECT 1 FROM slack_authorized_user_links").first()).toBeNull();
    await env.DB.prepare(
      "UPDATE slack_user_links SET security_generation=0,better_auth_account_id='oauth',migration_state='verified',verification_method='slack_openid',verified_at=2 WHERE user_id='protected'",
    ).run();
    expect(await env.DB.prepare("SELECT 1 FROM slack_authorized_user_links").first()).not.toBeNull();
    await env.DB.prepare("DELETE FROM account WHERE id='oauth'").run();
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links WHERE user_id='protected'").first()).toBeNull();
    await env.DB.prepare(
      "INSERT INTO account(id,userId,providerId,accountId,createdAt,updatedAt) VALUES('oauth','protected','slack','T123:UPROTECTED',1,1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation) VALUES('installation','protected','UPROTECTED',3,0)",
    ).run();
    await env.DB.prepare(
      "UPDATE account_security SET generation=generation+1,recovery_required=1 WHERE user_id='protected'",
    ).run();
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links WHERE user_id='protected'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE id='oauth'").first()).not.toBeNull();
  });

  it("adds validation revisions without changing evidence and advances unchanged validation writes", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0070"),
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@example.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
      env.DB.prepare(
        "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at,generation) VALUES('installation','workspace','T123','Slack','B123','cipher','files:write','owner',1,1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO slack_channel_subscriptions(id,installation_id,space_id,channel_id,channel_name,event_types_json,cadence,created_by,created_at,updated_at,validation_state,validated_at) VALUES('mapping','installation','workspace-general','C123','notes','[]','immediate','owner',1,1,'valid',7)",
      ),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(
        "SELECT validation_revision,validation_state,validated_at FROM slack_channel_subscriptions WHERE id='mapping'",
      ).first(),
    ).toEqual({ validation_revision: 0, validation_state: "valid", validated_at: 7 });
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET validation_state='valid',validated_at=7 WHERE id='mapping'",
    ).run();
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET validation_state='valid',validated_at=7 WHERE id='mapping'",
    ).run();
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=NULL,notification_error=NULL WHERE id='mapping'",
    ).run();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET created_by='owner' WHERE id='mapping'").run();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET updated_at=8 WHERE id='mapping'").run();
    expect(
      await env.DB.prepare(
        "SELECT validation_revision,validation_state,validated_at FROM slack_channel_subscriptions WHERE id='mapping'",
      ).first(),
    ).toEqual({ validation_revision: 4, validation_state: "valid", validated_at: 7 });
  });

  it("backfills abandoned allocation ownership and retains cleanup independently with an indexed deadline", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0069"),
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@example.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
      env.DB.prepare(
        "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at,generation) VALUES('installation','workspace','T123','Slack','B123','cipher','files:write','owner',1,1,2)",
      ),
      env.DB.prepare(
        "INSERT INTO pages(id,workspace_id,position,title,created_by,updated_by,created_at,updated_at) VALUES('page','workspace','a0','Page','owner','owner',1,1)",
      ),
    ]);
    await env.DB.batch(
      [
        ["known", "failed", 2],
        ["unknown", "retired", 1],
        ["uploaded", "uploaded", 2],
      ].map(([id, state, generation]) =>
        env.DB.prepare(
          "INSERT INTO slack_file_artifacts(id,installation_id,installation_generation,page_id,content_epoch,content_sha256,thumbnail_r2_key,slack_file_id,state,created_at,updated_at) VALUES(?,'installation',?,'page',1,?,'key',?,?,1,1)",
        ).bind(id, generation, id, `F${id}`, state),
      ),
    );
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      (
        await env.DB.prepare(
          "SELECT artifact_id,state,team_id,bot_user_id,attempt_count FROM slack_file_cleanup_jobs ORDER BY artifact_id",
        ).all()
      ).results,
    ).toEqual([
      { artifact_id: "known", state: "pending", team_id: "T123", bot_user_id: "B123", attempt_count: 0 },
      { artifact_id: "unknown", state: "failed", team_id: null, bot_user_id: null, attempt_count: 0 },
    ]);
    expect(await env.DB.prepare("SELECT reason FROM slack_delivery_failures").first()).toEqual({
      reason: "cleanup_identity_unverified",
    });
    await env.DB.prepare("DELETE FROM pages WHERE id='page'").run();
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_file_cleanup_jobs").first()).toEqual({ n: 2 });
    await env.DB.prepare(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<20000)
      INSERT INTO slack_file_cleanup_jobs(id,workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,attempt_count,created_at,updated_at)
      SELECT 'history:'||n,'workspace','installation',2,'T123','B123','history-file:'||n,'history','completed',1,1,1 FROM history`).run();
    const plan = (
      await env.DB.prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM slack_file_cleanup_jobs WHERE state='pending' AND next_attempt_at<=? AND (claimed_at IS NULL OR claimed_at<=?) ORDER BY next_attempt_at,id LIMIT 25",
      )
        .bind(Date.now(), Date.now() - 60000)
        .all<{ detail: string }>()
    ).results
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("slack_file_cleanup_due");
    expect(plan).not.toContain("SCAN slack_file_cleanup_jobs");
    await env.DB.prepare("DELETE FROM workspaces WHERE id='workspace'").run();
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_file_cleanup_jobs").first()).toEqual({ n: 0 });
  });
  it("upgrades guarded receipt identities and uses bounded deadline indexes across large history", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0068"),
    );
    await env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)").run();
    const examples = [
      ["slack_digest", '{"digestId":"digest"}', "digest"],
      ["slack_bulk", '{"summaryId":"bulk"}', "bulk"],
      ["slack_channel", '{"eventId":"channel"}', "channel"],
      ["slack_share_refresh", '{"refreshId":"share"}', "share"],
      ["slack_file_upload", '{"artifactId":"file"}', "file"],
      ["slack_digest", "not JSON", null],
      ["slack_digest", '{"digestId":3}', null],
      ["slack_digest", '{"eventId":"wrong-key"}', null],
    ];
    await env.DB.batch(
      examples.map(([topic, payload], n) =>
        env.DB.prepare(
          "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES(?,'workspace',?,?,1,1,1,1,7)",
        ).bind(`example-${n}`, topic, payload),
      ),
    );
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const rows = (
      await env.DB.prepare(
        "SELECT payload_json,slack_round2_receipt_id,slack_redrive_count,slack_scope_required_json FROM outbox ORDER BY id",
      ).all()
    ).results;
    expect(rows).toEqual(
      examples.map(([, payload, id]) => ({
        payload_json: payload,
        slack_round2_receipt_id: id,
        slack_redrive_count: 7,
        slack_scope_required_json: null,
      })),
    );
    await env.DB.prepare(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<20000)
      INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at)
      SELECT 'history:'||n,'workspace','slack_digest',json_object('digestId','history:'||n),1,1,1 FROM history`).run();
    const queries: string[] = [];
    const database = {
      prepare(sql: string) {
        queries.push(sql);
        return env.DB.prepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    } as Env["DB"];
    await redriveRound2Outbox({
      ...env,
      DB: database,
      SLACK_CHANNEL_VALIDATION_ENABLED: "true",
      SLACK_SHARE_REFRESH_ENABLED: "true",
      SLACK_RICH_DIGESTS_ENABLED: "true",
      WORKSPACE_ACTIVITY_ENABLED: "true",
    } as unknown as Env);
    const plan = (
      await env.DB.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).bind(Date.now(), Date.now()).all<{ detail: string }>()
    ).results
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_outbox_round2_due");
    expect(plan).toContain("idx_outbox_round2_claim_due");
    expect(plan).not.toContain("SCAN outbox");
    const receiptPlan = (
      await env.DB.prepare(
        "EXPLAIN QUERY PLAN SELECT max(slack_redrive_count) FROM outbox WHERE topic='slack_digest' AND slack_round2_receipt_id='digest'",
      ).all<{ detail: string }>()
    ).results
      .map((row) => row.detail)
      .join("\n");
    expect(receiptPlan).toContain("idx_outbox_round2_receipt");
    expect(await env.DB.prepare("SELECT count(*) n FROM outbox WHERE id LIKE 'history:%'").first()).toEqual({
      n: 20000,
    });
  });
  it("upgrades and replays the MCP workspace generation migration without reviving grants or altering content", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0065"),
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('owner','Owner','owner@example.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at,mcp_enabled) VALUES ('workspace','Notes',1,1)"),
      env.DB.prepare("INSERT INTO workspace_members VALUES ('workspace','owner','owner',1)"),
      env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
        VALUES ('page','workspace','workspace-general','document','a0','Preserved link','owner',1,1)`),
      env.DB.prepare("INSERT INTO oauth_clients VALUES ('client','Client','[]',NULL,1,1)"),
      env.DB.prepare("INSERT INTO oauth_grants VALUES ('grant','client','owner','workspace','pages:read',0,1,123)"),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await env.DB.prepare("UPDATE workspaces SET mcp_generation=4 WHERE id='workspace'").run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare("SELECT mcp_enabled,mcp_generation FROM workspaces WHERE id='workspace'").first(),
    ).toEqual({ mcp_enabled: 1, mcp_generation: 4 });
    expect(await env.DB.prepare("SELECT revoked_at FROM oauth_grants WHERE id='grant'").first()).toEqual({
      revoked_at: 123,
    });
    expect(await env.DB.prepare("SELECT title FROM pages WHERE id='page'").first()).toEqual({
      title: "Preserved link",
    });
  });
  it("replays the reminder absence migration after the original reminder table", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0059"),
    );
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const columns = await env.DB.prepare(`PRAGMA table_info(date_reminders)`).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("missing_since");
  });
  it("repairs a stale recovery claim after its pending key was pruned", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0046"),
    );
    await env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
      VALUES ('owner','Owner','owner@example.test',1,1)`).run();
    await env.DB.prepare(`UPDATE account_security SET recovery_resume_key_hash='saved',
      recovery_resume_claim_session_id='stranded' WHERE user_id='owner'`).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(`SELECT recovery_resume_key_hash saved,recovery_resume_claim_session_id claim
        FROM account_security WHERE user_id='owner'`).first(),
    ).toEqual({ saved: "saved", claim: null });
    expect(
      await env.DB.prepare(`SELECT slack_scope_paused_at,slack_scope_paused_ms FROM outbox LIMIT 1`).all(),
    ).toMatchObject({ success: true });
  });
  it("repairs legacy Slack scope pauses, stranded claims, and blocked redrive markers", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0045"),
    );
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
        VALUES ('owner','Owner','owner@example.test',1,1)`),
      env.DB.prepare(`INSERT INTO workspaces(id,name,created_at) VALUES ('workspace','Notes',1)`),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
        VALUES ('workspace','owner','owner',1)`),
      env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
        VALUES ('page','workspace','workspace-general','document','a0','Page','owner',1,1)`),
      env.DB.prepare(`INSERT INTO comment_threads(id,workspace_id,space_id,page_id,created_by,created_at,updated_at)
        VALUES ('thread','workspace','workspace-general','page','owner',1,1)`),
      env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,
        bot_token_ciphertext,scopes,installed_by,created_at,updated_at,auth_error,auth_error_at)
        VALUES ('installation','workspace','T123','Slack','UBOT','cipher','chat:write','owner',1,1,'missing_scope',?)`).bind(
        now - 1000,
      ),
      env.DB.prepare(`INSERT OR IGNORE INTO account_security(user_id) VALUES ('owner')`),
      env.DB.prepare(`UPDATE account_security SET recovery_resume_key_hash='saved',
        recovery_resume_claim_session_id='stranded',recovery_pending_key_hash='unsaved' WHERE user_id='owner'`),
      env.DB.prepare(`INSERT INTO slack_thread_links(id,installation_id,workspace_id,page_id,thread_id,
        channel_id,root_message_ts,state,created_at,updated_at)
        VALUES ('link','installation','workspace','page','thread','C123','1700000000.000001','active',1,1)`),
      env.DB.prepare(`INSERT INTO slack_thread_deliveries
        (id,link_id,operation,source_id,actor_id,state,attempted_at,created_at,updated_at)
        VALUES ('blocked','link','reply','blocked','owner','blocked',? ,1,1),
          ('waiting','link','reply','waiting','owner','pending',NULL,2,2),
          ('root-a','link','root','root-a','owner','pending',NULL,3,3),
          ('root-b','link','root','root-b','owner','pending',NULL,4,4)`).bind(now - 25 * 60 * 60_000),
      env.DB.prepare(`UPDATE slack_thread_deliveries SET failure_reason='reconciliation_inconclusive'
        WHERE id='blocked'`),
      env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,enqueued_at,created_at,
        slack_redrive_due_at) VALUES
        ('outbox:blocked','workspace','slack_thread_reply',json_object('deliveryId','blocked'),1,1,1,NULL),
        ('outbox:waiting','workspace','slack_thread_reply',json_object('deliveryId','waiting'),1,1,1,1)`),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(`SELECT auth_error,auth_error_at,auth_paused_ms FROM slack_installations
      WHERE id='installation'`).first(),
    ).toMatchObject({ auth_error: null, auth_error_at: null, auth_paused_ms: expect.any(Number) });
    expect(
      await env.DB.prepare(`SELECT recovery_resume_claim_session_id claim FROM account_security
      WHERE user_id='owner'`).first(),
    ).toEqual({ claim: null });
    expect(
      await env.DB.prepare(`SELECT slack_redrive_due_at IS NOT NULL due FROM outbox
      WHERE id='outbox:blocked'`).first(),
    ).toEqual({ due: 1 });
    expect(
      await env.DB.prepare(`SELECT slack_redrive_due_at>? deferred FROM outbox
      WHERE id='outbox:waiting'`)
        .bind(Date.now())
        .first(),
    ).toEqual({ deferred: 1 });
    expect(
      (
        await env.DB.prepare(`SELECT id FROM slack_thread_delivery_runnable
      WHERE id IN ('root-a','root-b') ORDER BY id`).all()
      ).results,
    ).toEqual([{ id: "root-a" }, { id: "root-b" }]);
  });
  it("repairs mention introduction epochs from matching projections after a restore", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0042"),
    );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
        VALUES ('owner','Owner','owner@example.test',1,1),('target','Target','target@example.test',1,1)`),
      env.DB.prepare(`INSERT INTO workspaces(id,name,created_at) VALUES ('workspace','Notes',1)`),
      env.DB
        .prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,content_epoch)
        VALUES ('document','workspace','workspace-general','document','a0','Document','owner',1,1,2),
          ('diagram','workspace','workspace-general','diagram','a1','Diagram','owner',1,1,2),
          ('unknown','workspace','workspace-general','document','a2','Unknown','owner',1,1,2)`),
      env.DB.prepare(`INSERT INTO document_projections
        (page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,updated_at)
        VALUES ('document',1,7,1,'r2-document','hash',1,1)`),
      env.DB.prepare(`INSERT INTO diagram_projections
        (page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,
         thumbnail_r2_key,thumbnail_hash,thumbnail_byte_size,updated_at)
        VALUES ('diagram',1,9,1,'r2-diagram','hash',1,'thumbnail','hash',1,1)`),
      env.DB.prepare(`INSERT INTO member_mentions
        (workspace_id,source_page_id,target_user_id,first_seen_at,projection_seq,introduction_epoch,introduction_seq)
        VALUES ('workspace','document','target',1,7,2,7),('workspace','diagram','target',1,9,2,9),
          ('workspace','unknown','target',1,11,2,11)`),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      (
        await env.DB.prepare(`SELECT source_page_id,introduction_epoch,introduction_seq
      FROM member_mentions ORDER BY source_page_id`).all()
      ).results,
    ).toEqual([
      { source_page_id: "diagram", introduction_epoch: 1, introduction_seq: 9 },
      { source_page_id: "document", introduction_epoch: 1, introduction_seq: 7 },
      { source_page_id: "unknown", introduction_epoch: null, introduction_seq: null },
    ]);
  });
  it("repairs only unedited imported Slack comments and indexes pending redrive", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0040"),
    );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
        VALUES ('owner','Owner','owner@example.test',1,1)`),
      env.DB.prepare(`INSERT INTO workspaces(id,name,created_at) VALUES ('workspace','Notes',1)`),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
        VALUES ('workspace','owner','owner',1)`),
      env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
        VALUES ('page','workspace','workspace-general','document','a0','Page','owner',1,1)`),
      env.DB.prepare(`INSERT INTO comment_threads(id,workspace_id,space_id,page_id,created_by,created_at,updated_at)
        VALUES ('thread','workspace','workspace-general','page','owner',1,1)`),
      env.DB
        .prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,
        scopes,installed_by,created_at,updated_at) VALUES ('installation','workspace','T123','Slack','UBOT','cipher','', 'owner',1,1)`),
      env.DB.prepare(`INSERT INTO slack_inbound_receipts(id,installation_id,event_id,channel_id,message_ts,event_type,
        received_at,processed_at) VALUES ('receipt-1','installation','Ev1','C123','1700000000.000001','message',1,2000),
        ('receipt-2','installation','Ev2','C123','1700000000.000002','message',1,3000)`),
      env.DB.prepare(`INSERT INTO comments(id,thread_id,user_id,body_json,plain_text,created_at,updated_at,
        slack_source_receipt_id) VALUES ('original','thread','owner','[]','one',1000,2000,'receipt-1'),
        ('edited','thread','owner','[]','two',1001,4000,'receipt-2')`),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect((await env.DB.prepare(`SELECT id,created_at,updated_at FROM comments ORDER BY id`).all()).results).toEqual([
      { id: "edited", created_at: 1001, updated_at: 4000 },
      { id: "original", created_at: 1000, updated_at: 1000 },
    ]);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM outbox
      WHERE slack_redrive_due_at IS NOT NULL AND slack_redrive_due_at <= ?
      ORDER BY slack_redrive_due_at,id LIMIT 50`)
      .bind(Date.now())
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("idx_outbox_slack_redrive_due"))).toBe(true);
  });
  it("backfills scheduler tokens without renewing grace for never-successful tasks", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0032"),
    );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO observability_task_runs (task_name, last_started_at, last_failed_at, last_error)
        VALUES ('never_succeeded', 1000, 1100, 'failure')`),
      env.DB.prepare(`INSERT INTO observability_task_runs (task_name, last_started_at, last_succeeded_at)
        VALUES ('succeeded', 2000, 2100)`),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const rows = await env.DB.prepare(`SELECT task_name, execution_token, run_id, first_observed_at
      FROM observability_task_runs WHERE task_name IN ('never_succeeded', 'succeeded') ORDER BY task_name`).all<{
      task_name: string;
      execution_token: number;
      run_id: string | null;
      first_observed_at: number;
    }>();
    expect(rows.results).toEqual([
      { task_name: "never_succeeded", execution_token: 1000, run_id: null, first_observed_at: 0 },
      { task_name: "succeeded", execution_token: 2000, run_id: null, first_observed_at: 2000 },
    ]);
    const columns = await env.DB.prepare(`PRAGMA table_info(observability_task_runs)`).all<{
      name: string;
      notnull: number;
    }>();
    expect(
      columns.results.filter((column) => ["execution_token", "run_id", "first_observed_at"].includes(column.name)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "execution_token", notnull: 0 }),
        expect.objectContaining({ name: "run_id", notnull: 0 }),
        expect.objectContaining({ name: "first_observed_at", notnull: 0 }),
      ]),
    );
  });

  it("fences a legacy token update after a UUID run owns the row", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    try {
      await env.DB.prepare(`INSERT INTO observability_task_runs
        (task_name, last_started_at, execution_token, run_id, first_observed_at)
        VALUES ('legacy_fence', 200, NULL, 'worker-run', 200)`).run();

      // This is the exact start statement issued by the Worker immediately
      // before UUID run ownership was introduced.
      const legacy = await env.DB.prepare(
        `INSERT INTO observability_task_runs (task_name, last_started_at)
          VALUES (?, ?)
          ON CONFLICT(task_name) DO UPDATE SET
            last_started_at = MAX(observability_task_runs.last_started_at + 1, excluded.last_started_at)
          RETURNING last_started_at`,
      )
        .bind("legacy_fence", 300)
        .all();
      expect(legacy.results).toEqual([]);

      const current = await env.DB.prepare(
        `INSERT INTO observability_task_runs (task_name, last_started_at, run_id, first_observed_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(task_name) DO UPDATE SET
            last_started_at = MAX(observability_task_runs.last_started_at, excluded.last_started_at),
            run_id = CASE WHEN excluded.last_started_at >= observability_task_runs.last_started_at
              THEN excluded.run_id ELSE observability_task_runs.run_id END,
            execution_token = CASE WHEN excluded.last_started_at >= observability_task_runs.last_started_at
              THEN NULL ELSE observability_task_runs.execution_token END,
            first_observed_at = COALESCE(observability_task_runs.first_observed_at,
              observability_task_runs.last_started_at)
          RETURNING last_started_at, run_id`,
      )
        .bind("legacy_fence", 300, "next-run", 300)
        .all();
      expect(current.results).toEqual([{ last_started_at: 300, run_id: "next-run" }]);

      await env.DB.prepare(`UPDATE observability_task_runs SET last_succeeded_at = 350
        WHERE task_name = 'legacy_fence' AND run_id = 'next-run'`).run();
      expect(
        await env.DB.prepare(`SELECT last_started_at, run_id, execution_token, last_succeeded_at
        FROM observability_task_runs WHERE task_name = 'legacy_fence'`).first(),
      ).toEqual({
        last_started_at: 300,
        run_id: "next-run",
        execution_token: null,
        last_succeeded_at: 350,
      });
    } finally {
      await env.DB.prepare(`DELETE FROM observability_task_runs WHERE task_name = 'legacy_fence'`).run();
    }
  });

  it("fences an execution-token takeover without a newer legacy start time", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    try {
      await env.DB.prepare(`INSERT INTO observability_task_runs
        (task_name, last_started_at, execution_token, run_id, first_observed_at)
        VALUES ('legacy_token_fence', 200, NULL, 'worker-run', 200)`).run();

      const legacy = await env.DB.prepare(`UPDATE observability_task_runs
        SET execution_token = 201
        WHERE task_name = 'legacy_token_fence'
        RETURNING execution_token`).all();

      expect(legacy.results).toEqual([]);
      expect(
        await env.DB.prepare(`SELECT last_started_at, run_id, execution_token
          FROM observability_task_runs WHERE task_name = 'legacy_token_fence'`).first(),
      ).toEqual({ last_started_at: 200, run_id: "worker-run", execution_token: null });
    } finally {
      await env.DB.prepare(`DELETE FROM observability_task_runs WHERE task_name = 'legacy_token_fence'`).run();
    }
  });

  it("invalidates existing password-only sessions during the mandatory protection cutover", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0028"),
    );
    await env.DB.prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES ('legacy','Legacy','legacy@example.test',0,1,1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES ('legacy-session','token','legacy',?,1,1)",
    )
      .bind(Date.now() + 60_000)
      .run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(await env.DB.prepare("SELECT id FROM session").first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id,codes_saved FROM account_security").first()).toMatchObject({
      user_id: "legacy",
      codes_saved: 0,
    });
  });
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
        "diagram_projections",
        "page_search_v2",
        "jobs",
        "outbox",
        "outbox_sweep_state",
        "notifications",
        "digest_delivery_cursors",
        "comment_migrations",
        "slack_installations",
        "slack_user_links",
        "slack_channel_subscriptions",
        "slack_unfurls",
        "slack_request_replays",
        "slack_primary_factor_proofs",
        "slack_thread_links",
        "slack_inbound_receipts",
        "slack_interaction_receipts",
        "slack_captures",
        "slack_share_references",
        "slack_file_artifacts",
        "slack_operations_destinations",
        "slack_incidents",
        "share_links",
        "integrations",
        "integration_tokens",
        "integration_grants",
        "pending_recovery_codes",
        "validate_invite_completion",
        "initialize_account_security",
        "prune_stale_rate_limit_on_insert",
        "api_page_ids",
        "api_blocks",
        "transclusion_sources",
        "transclusion_references",
        "webhook_subscriptions",
        "webhook_events",
        "webhook_deliveries",
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
    expect(indexes.results.map((index) => index.name)).toContain("idx_comment_threads_page_block");
    expect(indexes.results.map((index) => index.name)).toContain("idx_rate_limit_last_request");
    expect(indexes.results.map((index) => index.name)).toContain("idx_pending_recovery_expiry");
    expect(indexes.results.map((index) => index.name)).toContain("idx_slack_user_links_verified_account");
    expect(indexes.results.map((index) => index.name)).toContain("idx_slack_space_mirror_enabled");
    expect(indexes.results.map((index) => index.name)).toContain("idx_slack_page_mirror_enabled");

    const slackColumns = await env.DB.prepare(`PRAGMA table_info(slack_installations)`).all<{ name: string }>();
    expect(slackColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["bot_token_ciphertext", "bot_refresh_token_ciphertext", "token_expires_at"]),
    );
    const slackLinkColumns = await env.DB.prepare(`PRAGMA table_info(slack_user_links)`).all<{ name: string }>();
    expect(slackLinkColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["better_auth_account_id", "verification_method", "verified_at", "migration_state"]),
    );
    const slackChannelColumns = await env.DB.prepare(`PRAGMA table_info(slack_channel_subscriptions)`).all<{
      name: string;
    }>();
    expect(slackChannelColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "channel_type",
        "validation_state",
        "validated_at",
        "validation_error",
        "bot_is_member",
        "mirror_enabled",
        "muted_at",
        "snoozed_until",
      ]),
    );
    const accountColumns = await env.DB.prepare(`PRAGMA table_info(account)`).all<{ name: string }>();
    expect(accountColumns.results.map((column) => column.name)).toContain("issuer");
    expect(indexes.results.map((index) => index.name)).toContain("idx_account_issuer_account");
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

    const pagesSql = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pages'`,
    ).first<{ sql: string }>();
    expect(pagesSql?.sql).toContain("'diagram'");
    expect(pagesSql?.sql).toContain("archive_operation_id");
    await expect(env.DB.prepare(`SELECT * FROM outbox_sweep_state WHERE id = 1`).first()).resolves.toMatchObject({
      id: 1,
      lease_token: null,
      lease_until: 0,
      rescan_requested: 0,
    });
  });

  it("replays the Slack capture receipt migration with its destination and session link intact", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const captures = await env.DB.prepare("PRAGMA table_info(slack_captures)").all<{ name: string }>();
    const sessions = await env.DB.prepare("PRAGMA table_info(slack_product_sessions)").all<{ name: string }>();
    expect(captures.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "destination_space_id",
        "destination_parent_id",
        "target_kind",
        "title",
        "request_hash",
        "attempt",
        "error_category",
        "last_failed_job_attempt",
        "published_at",
      ]),
    );
    expect(sessions.results.map((column) => column.name)).toContain("capture_id");
  });

  it("backfills failed capture job attempts before replaying the migration", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0055"),
    );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
        VALUES ('owner','Owner','owner@example.test',1,1)`),
      env.DB.prepare(`INSERT INTO workspaces(id,name,created_at) VALUES ('workspace','Notes',1)`),
      env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,
        bot_token_ciphertext,scopes,installed_by,created_at,updated_at)
        VALUES ('installation','workspace','T123','Slack','UBOT','cipher','chat:write','owner',1,1)`),
      env.DB.prepare(`INSERT INTO jobs(id,workspace_id,type,status,requested_by,attempt,created_at,updated_at)
        VALUES ('capture','workspace','import','failed','owner',3,1,1)`),
      env.DB.prepare(`INSERT INTO slack_captures(id,installation_id,workspace_id,channel_id,source_ts,
        source_kind,requested_by,job_id,state,created_at,updated_at)
        VALUES ('capture','installation','workspace','C123','1700000000.000001',
          'message','owner','capture','failed',1,1)`),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(`SELECT last_failed_job_attempt FROM slack_captures WHERE id='capture'`).first(),
    ).toEqual({ last_failed_job_attempt: 3 });
  });

  it("corrects a failed capture whose next job attempt was already queued when 0055 ran", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0055"),
    );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
        VALUES ('owner','Owner','owner@example.test',1,1)`),
      env.DB.prepare(`INSERT INTO workspaces(id,name,created_at) VALUES ('workspace','Notes',1)`),
      env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,
        bot_token_ciphertext,scopes,installed_by,created_at,updated_at)
        VALUES ('installation','workspace','T123','Slack','UBOT','cipher','chat:write','owner',1,1)`),
      env.DB.prepare(`INSERT INTO jobs(id,workspace_id,type,status,requested_by,attempt,created_at,updated_at)
        VALUES ('capture','workspace','import','queued','owner',4,1,2)`),
      env.DB.prepare(`INSERT INTO slack_captures(id,installation_id,workspace_id,channel_id,source_ts,
        source_kind,requested_by,job_id,state,created_at,updated_at)
        VALUES ('capture','installation','workspace','C123','1700000000.000001',
          'message','owner','capture','failed',1,1)`),
    ]);
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0056"),
    );
    expect(
      await env.DB.prepare(`SELECT last_failed_job_attempt FROM slack_captures WHERE id='capture'`).first(),
    ).toEqual({ last_failed_job_attempt: 4 });
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(`SELECT last_failed_job_attempt FROM slack_captures WHERE id='capture'`).first(),
    ).toEqual({ last_failed_job_attempt: 3 });
  });

  it("does not infer the failed attempt from a later capture timestamp", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0055"),
    );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
        VALUES ('owner','Owner','owner@example.test',1,1)`),
      env.DB.prepare(`INSERT INTO workspaces(id,name,created_at) VALUES ('workspace','Notes',1)`),
      env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,
        bot_token_ciphertext,scopes,installed_by,created_at,updated_at)
        VALUES ('installation','workspace','T123','Slack','UBOT','cipher','chat:write','owner',1,1)`),
      env.DB.prepare(`INSERT INTO jobs(id,workspace_id,type,status,requested_by,attempt,created_at,updated_at)
        VALUES ('capture','workspace','import','running','owner',4,1,2)`),
      env.DB.prepare(`INSERT INTO slack_captures(id,installation_id,workspace_id,channel_id,source_ts,
        source_kind,requested_by,job_id,state,created_at,updated_at)
        VALUES ('capture','installation','workspace','C123','1700000000.000001',
          'message','owner','capture','failed',1,3)`),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(`SELECT last_failed_job_attempt FROM slack_captures WHERE id='capture'`).first(),
    ).toEqual({ last_failed_job_attempt: 3 });
  });

  it("preserves preloaded account security when a restore inserts the user row later", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const trigger = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='initialize_account_security'",
    ).first<{ sql: string }>();
    expect(trigger?.sql).toContain("INSERT OR IGNORE INTO account_security");

    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys=ON"),
      env.DB.prepare("INSERT INTO account_security(user_id,generation,codes_saved) VALUES ('restored-user',7,1)"),
      env.DB.prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt)
        VALUES ('restored-user','Restored','restored@example.test',1,1,1)`),
    ]);

    expect(
      await env.DB.prepare("SELECT generation,codes_saved FROM account_security WHERE user_id='restored-user'").first(),
    ).toEqual({
      generation: 7,
      codes_saved: 1,
    });
  });

  it("cleans abandoned, member-owned, and duplicate invite claims during the follow-up migration", async () => {
    const followup = env.TEST_MIGRATIONS!.find((migration) => migration.name === "0030_security_review_followups.sql");
    expect(followup).toBeTruthy();
    const followupIndex = env.TEST_MIGRATIONS!.indexOf(followup!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, followupIndex));
    await env.DB.batch([
      ...[
        ["owner", "owner@example.test"],
        ["member", "member@example.test"],
        ["guest", "guest@example.test"],
      ].map(([id, email]) =>
        env.DB.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,1,1)").bind(
          id,
          id,
          email,
        ),
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES ('workspace','Notes',1)"),
      env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES ('workspace','owner','owner',1)",
      ),
      env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES ('workspace','member','viewer',1)",
      ),
      ...[
        ["abandoned", "abandoned-token", 1, Date.now() + 60_000, "abandoned@example.test", null],
        ["member-claim", "member-token", 2, Date.now() + 60_000, "member@example.test", "member"],
        ["guest-old", "guest-old-token", 3, Date.now() + 60_000, "guest@example.test", "guest"],
        ["guest-new", "guest-new-token", 4, Date.now() - 1, "guest@example.test", "guest"],
      ].map(([id, token, createdAt, expiresAt, email, claimedBy]) =>
        env.DB.prepare(`INSERT INTO invites
          (id,workspace_id,token_hash,role,expires_at,created_by,created_at,claimed_email,claimed_by)
          VALUES (?,'workspace',?,'viewer',?,'owner',?,?,?)`).bind(id, token, expiresAt, createdAt, email, claimedBy),
      ),
    ]);

    await applyD1Migrations(env.DB, [followup!]);

    expect(await env.DB.prepare("SELECT claimed_email FROM invites WHERE id='abandoned'").first()).toEqual({
      claimed_email: null,
    });
    expect(await env.DB.prepare("SELECT 1 FROM invites WHERE id='member-claim'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM invites WHERE id='guest-new'").first()).toBeNull();
    const preserved = await env.DB.prepare("SELECT claim_expires_at FROM invites WHERE id='guest-old'").first<{
      claim_expires_at: number;
    }>();
    expect(preserved!.claim_expires_at).toBeGreaterThan(Date.now());
  });

  it("repairs a missing comment lookup index in the forward archive migration", async () => {
    const archiveMigration = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0024_archive_operation_identity.sql",
    );
    expect(archiveMigration).toBeTruthy();
    const archiveIndex = env.TEST_MIGRATIONS!.indexOf(archiveMigration!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, archiveIndex));

    // Simulate a database that recorded an earlier 0022 without this index.
    await env.DB.prepare(`DROP INDEX idx_comment_threads_page_block`).run();

    await applyD1Migrations(env.DB, [archiveMigration!]);
    await expect(
      env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_comment_threads_page_block'`,
      ).first(),
    ).resolves.toEqual({ name: "idx_comment_threads_page_block" });
    const columns = await env.DB.prepare(`PRAGMA table_info(pages)`).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("archive_operation_id");
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

  it("repairs legacy Slack unfurl retirement timestamps through a forward migration", async () => {
    const retirement = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0019_retire_legacy_slack_unfurls.sql",
    );
    const normalization = env.TEST_MIGRATIONS!.find(
      (migration) => migration.name === "0021_normalize_slack_unfurl_retirement.sql",
    );
    expect(retirement).toBeTruthy();
    expect(normalization).toBeTruthy();
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
    ).toEqual({
      delivered_at: null,
      retired: 1,
      retirement_reason: "legacy_missing_message_ts",
    });
    expect(await env.DB.prepare(`SELECT last_error FROM outbox WHERE id = 'outbox:legacy-unfurl'`).first()).toEqual({
      last_error: "legacy_unfurl_missing_message_ts",
    });
    // Reproduce a database where the already-recorded migration left REAL storage.
    await env.DB.prepare(`UPDATE slack_unfurls SET retired_at = retired_at + 0.5 WHERE id = 'legacy-unfurl'`).run();
    expect(
      await env.DB.prepare(
        `SELECT typeof(retired_at) retired_at_type FROM slack_unfurls WHERE id = 'legacy-unfurl'`,
      ).first(),
    ).toEqual({ retired_at_type: "real" });

    await applyD1Migrations(env.DB, [normalization!]);

    expect(
      await env.DB.prepare(
        `SELECT typeof(retired_at) retired_at_type FROM slack_unfurls WHERE id = 'legacy-unfurl'`,
      ).first(),
    ).toEqual({ retired_at_type: "integer" });
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

  it("backfills Slack links as legacy and keeps future behavior inert", async () => {
    const foundation = env.TEST_MIGRATIONS!.find((migration) => migration.name === "0035_slack_secure_foundation.sql");
    expect(foundation).toBeTruthy();
    const foundationIndex = env.TEST_MIGRATIONS!.indexOf(foundation!);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, foundationIndex));
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, createdAt, updatedAt)
         VALUES ('owner', 'Owner', 'owner@example.test', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt, issuer)
         VALUES ('slack-account', 'T123:U123', 'slack', 'owner', ?, ?, 'slack')`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES ('session', ?, 'token', ?, ?, 'owner')`,
      ).bind(new Date(timestamp + 60_000).toISOString(), timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('workspace', 'Notes', ?)`).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES ('workspace', 'owner', 'owner', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO slack_installations
          (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
           installed_by, created_at, updated_at)
         VALUES ('installation', 'workspace', 'T123', 'Slack', 'B123', 'ciphertext', 'commands',
                 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
         VALUES ('installation', 'owner', 'U123', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO slack_channel_subscriptions
          (id, installation_id, space_id, channel_id, channel_name, created_by, created_at, updated_at)
         VALUES ('mapping', 'installation', 'workspace-general', 'C123', 'notes', 'owner', ?, ?)`,
      ).bind(timestamp, timestamp),
    ]);

    await applyD1Migrations(env.DB, [foundation!]);

    expect(await env.DB.prepare(`SELECT issuer FROM account WHERE id = 'slack-account'`).first()).toEqual({
      issuer: "slack",
    });
    const auth = createAuth(env as unknown as Env, true);
    const authRequest = (path: string, body: object) =>
      new Request(`http://example.test/api/auth/${path}`, {
        method: "POST",
        headers: { origin: "http://example.test", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const email = "new-password-user@example.test";
    const password = "password123";
    expect((await auth.handler(authRequest("sign-up/email", { name: "New User", email, password }))).status).toBe(200);
    expect((await auth.handler(authRequest("sign-in/email", { email, password }))).status).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT issuer FROM account WHERE providerId = 'credential' AND accountId != 'owner'`,
      ).first(),
    ).toEqual({ issuer: "local:credential" });

    expect(
      await env.DB.prepare(
        `SELECT verification_method, migration_state, verified_at, better_auth_account_id
           FROM slack_user_links WHERE user_id = 'owner'`,
      ).first(),
    ).toEqual({
      verification_method: "legacy_command",
      migration_state: "legacy",
      verified_at: null,
      better_auth_account_id: null,
    });
    expect(
      await env.DB.prepare(
        `SELECT validation_state, mirror_enabled, muted_at, snoozed_until
           FROM slack_channel_subscriptions WHERE id = 'mapping'`,
      ).first(),
    ).toEqual({ validation_state: "unvalidated", mirror_enabled: 0, muted_at: null, snoozed_until: null });

    await env.DB.prepare(
      `INSERT INTO slack_primary_factor_proofs
        (session_id, user_id, account_id, team_id, slack_user_id, verified_at, expires_at)
       VALUES ('session', 'owner', 'slack-account', 'T123', 'U123', ?, ?)`,
    )
      .bind(timestamp, timestamp + 60_000)
      .run();
    await env.DB.prepare(`DELETE FROM session WHERE id = 'session'`).run();
    expect(await env.DB.prepare(`SELECT 1 FROM slack_primary_factor_proofs`).first()).toBeNull();
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
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!.slice(0, env.TEST_MIGRATIONS!.indexOf(reliability!)));
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
