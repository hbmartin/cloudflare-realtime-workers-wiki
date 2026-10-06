import { protectSlackFixtureUsers } from "../../tests/helpers/security";
import { processSlackFileCleanup, processDueSlackFileCleanup, slackFileCleanupHealth } from "./slack-file-cleanup";
import {
  slackScopeRequirements,
  SLACK_PAUSED_SCOPES_SQL,
  slackScopesGrantedSql,
  resumeSlackFileCleanup,
} from "./slack-delivery-contracts";
import { activityMutationStart, activityMutationEnd } from "./activity-mutations";
import { deliverBulkSummary } from "./slack-bulk";
import { consumeDeliveryMessage, sweepOutbox, redriveStaleSlackOutbox } from "./jobs";
import { recordDeliveryError, wakeRound2Mapping } from "./slack-delivery";
import { StaleSlackValidationError, validateMapping } from "./slack-channels";
import { digestWindow } from "./slack-schedule";
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_EVENT_TYPES } from "../shared/activity";
import type { Env, MemberContext } from "./env";
import { channelDirectory, revalidateMappings, round2Installation, syncRound2Configuration } from "./slack-channels";
import { digestMapping, digestPages, deliverDigest, dueRound2Digests, type DigestReceipt } from "./slack-digests";
import { deliverRound2ChannelEvent } from "./slack-channel-events";
import { digestBlocks } from "./slack-blocks";
import {
  encryptSlackToken,
  createSlackOAuthUrl,
  finishSlackOAuth,
  SlackApiError,
  upsertSlackChannelSubscription,
  setSlackChannelPause,
  repairSlackChannelNotifications,
  handleSlackEvent,
  deliverSlackUnfurl,
  deliverSlackControlsExpiry,
  listSlackChannelSubscriptions,
  listSlackDeliveryFailureGroups,
  acknowledgeSlackDeliveryFailures,
  usableBotToken,
  slackApi,
  sendPersonalSlackNotification,
  SlackRateLimitError,
  slackWorkspaceStatus,
} from "./slack";
import { deliverShareRefresh } from "./slack-shares";
import { createShare, revokeShare } from "./shares";
import { listActivity } from "./activity";
import { notificationFanoutStatements } from "./notifications";
import { mutateTask, taskListStatements } from "./tasks";
import { deliverThumbnail } from "./slack-files";
import { DeliveryInProgressError } from "./notifications";
import {
  reconcileRound2Mapping,
  redriveRound2Outbox,
  round2DeliveryOutcome,
  enqueueRound2Outbox,
} from "./slack-recovery";

const runtime = () =>
  ({
    ...env,
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "test-slack-client-secret",
    SLACK_SIGNING_SECRET: "test-slack-signing-secret",
    SLACK_TOKEN_ENCRYPTION_KEY: "round-two-test-encryption-secret",
    WORKSPACE_ACTIVITY_ENABLED: "true",
    SLACK_CHANNEL_VALIDATION_ENABLED: "true",
    SLACK_SHARE_REFRESH_ENABLED: "true",
    SLACK_RICH_DIGESTS_ENABLED: "true",
    SLACK_DIGEST_DEFAULT_TIMEZONE: "America/Chicago",
  }) as unknown as Env;
const owner = {
  user: { id: "owner", name: "Owner", email: "owner@example.test" },
  workspace: { id: "workspace", name: "Notes" },
  role: "owner",
  session: { id: "test-session", expiresAt: new Date(Date.now() + 60000) },
} as MemberContext;
const channel = {
  id: "C123",
  name: "canonical-notes",
  is_channel: true,
  is_member: true,
  is_private: false,
  is_archived: false,
};
let calls: Array<{ method: string; body: Record<string, unknown> }>;
let responses: Record<string, unknown>;
function mockSlack() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = url.pathname.split("/").at(-1)!;
      if (url.hostname === "uploads.slack.test") {
        calls.push({ method: "upload", body: {} });
        return new Response("uploaded");
      }
      const body =
        init?.method === "GET"
          ? Object.fromEntries(url.searchParams)
          : new Headers(init?.headers).get("content-type")?.includes("application/x-www-form-urlencoded")
            ? Object.fromEntries(new URLSearchParams(String(init?.body)))
            : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      calls.push({ method, body });
      const response = responses[method];
      if (response instanceof Error) throw response;
      if (response instanceof Response) return response.clone();
      return Response.json(response ?? { ok: true });
    }),
  );
}
async function page(id = "page", extra: Partial<{ space: string; kind: string; staged: string; title: string }> = {}) {
  await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,plain_text,created_by,updated_by,created_at,updated_at,import_job_id)
    VALUES(?,'workspace',?,?,'a0',?,'Current excerpt','owner','owner',?,?,?)`)
    .bind(
      id,
      extra.space ?? "workspace-general",
      extra.kind ?? "document",
      extra.title ?? id,
      Date.now(),
      Date.now(),
      extra.staged ?? null,
    )
    .run();
  return id;
}
async function mapping(cadence: "digest" | "immediate" = "digest") {
  const result = await upsertSlackChannelSubscription(runtime(), owner, {
    spaceId: "workspace-general",
    pageId: null,
    channelId: "C123",
    channelName: "forged",
    eventTypes: [...CHANNEL_EVENT_TYPES],
    cadence,
  });
  await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_not_before=0 WHERE id=?").bind(result.id).run();
  return result;
}
async function thread(pageId = "page", id = "thread") {
  await env.DB.prepare(`INSERT INTO comment_threads(id,workspace_id,space_id,page_id,created_by,created_at,updated_at)
    VALUES(?,'workspace','workspace-general',?,'owner',?,?)`)
    .bind(id, pageId, Date.now(), Date.now())
    .run();
}
async function receipt(mappingId: string) {
  const window = digestWindow(Date.now(), "09:00", "America/Chicago");
  await env.DB.prepare(`INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,created_at)
    VALUES('digest-test','installation',1,?,?,?,'C123',?)`)
    .bind(mappingId, window.start, window.end, Date.now())
    .run();
  return (await env.DB.prepare("SELECT * FROM slack_digest_receipts WHERE id='digest-test'").first<DigestReceipt>())!;
}
async function event(
  mappingId: string,
  pageId: string,
  createdAt: number,
  type = "page_created",
  id: string = crypto.randomUUID(),
) {
  await env.DB.prepare(`INSERT INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at)
    VALUES(?,?,'workspace',?,'owner',?,'digest',?)`)
    .bind(id, mappingId, type, pageId, createdAt)
    .run();
}
async function reference(kind = "page", shareId: string | null = null, id = "reference") {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,installation_generation,security_generation,authorization_started_at) VALUES('installation','owner','U123',1,1,0,1)",
  ).run();
  await env.DB.prepare(`INSERT INTO slack_share_references(id,installation_id,installation_generation,page_id,channel_id,message_ts,url,share_link_id,observed_user_id,reference_kind,created_at,updated_at)
    VALUES(?,'installation',1,'page','C123',?,?,?, 'owner',?,?,?)`)
    .bind(
      id,
      id === "second" ? "123.457" : "123.456",
      kind === "page" ? "http://example.test/?page=page" : `http://example.test/share/${shareId}`,
      shareId,
      kind,
      Date.now(),
      Date.now(),
    )
    .run();
}
async function refreshes() {
  return (await env.DB.prepare("SELECT id FROM slack_share_refreshes ORDER BY revision,id").all<{ id: string }>())
    .results;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  calls = [];
  responses = {
    "conversations.info": { ok: true, channel },
    "conversations.list": { ok: true, channels: [channel] },
    "chat.postMessage": { ok: true, ts: "999.001" },
    "conversations.history": { ok: true, messages: [] },
    "conversations.replies": { ok: true, messages: [] },
  };
  mockSlack();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@example.test',1,1),('viewer','Viewer','viewer@example.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',1),('workspace','viewer','viewer',1)",
    ),
    env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at,generation)
      VALUES('installation','workspace','T123','Slack','B123',?,'chat:write,links:write,channels:read,groups:read,channels:history,groups:history,files:write','owner',1,1,1)`).bind(
      await encryptSlackToken(runtime(), "xoxb-test-token"),
    ),
  ]);
  await protectSlackFixtureUsers(["owner", "viewer"]);
  await syncRound2Configuration(runtime());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("channel validation and scheduling", () => {
  it.each([
    ["channel_not_found", "success"],
    ["missing_scope", "success"],
    ["invalid_auth", "success"],
    ["success", "channel_not_found"],
    ["success", "missing_scope"],
    ["success", "success"],
  ])(
    "rejects a stale %s validation after a newer %s commits at the same timestamp",
    async (olderResult, newerResult) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const m = await mapping();
      const installation = (await round2Installation(runtime(), "installation"))!;
      const before = await env.DB.prepare("SELECT validation_revision FROM slack_channel_subscriptions WHERE id=?")
        .bind(m.id)
        .first<{ validation_revision: number }>();
      let arrived!: () => void;
      const started = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let checks = 0;
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).includes("conversations.info") && ++checks === 1) {
          arrived();
          await held;
          return Response.json(olderResult === "success" ? { ok: true, channel } : { ok: false, error: olderResult });
        }
        return remote(input, init);
      });
      const older = validateMapping(runtime(), installation, m.id, m.channelId);
      await started;
      responses["conversations.info"] =
        newerResult === "success" ? { ok: true, channel } : { ok: false, error: newerResult };
      const newerOutcome = await validateMapping(runtime(), installation, m.id, m.channelId).catch(
        (error: unknown) => error,
      );
      expect(newerOutcome instanceof SlackApiError ? newerOutcome.code : newerOutcome).toBe(
        newerResult === "missing_scope" ? "missing_scope" : newerResult === "success",
      );
      const accepted = await env.DB.prepare(
        "SELECT validation_revision,validation_state,validation_error,validated_at,notification_error FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first();
      expect(accepted).toMatchObject({ validation_revision: before!.validation_revision + 1, validated_at: now });
      release();
      await expect(older).rejects.toBeInstanceOf(StaleSlackValidationError);
      expect(
        await env.DB.prepare(
          "SELECT validation_revision,validation_state,validation_error,validated_at,notification_error FROM slack_channel_subscriptions WHERE id=?",
        )
          .bind(m.id)
          .first(),
      ).toEqual(accepted);
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: null });
    },
  );

  it("rejects an authentication failure when validation changes immediately before its write", async () => {
    const m = await mapping();
    const installation = (await round2Installation(runtime(), "installation"))!;
    responses["conversations.info"] = { ok: false, error: "invalid_auth" };
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
          if (key === "run")
            return async () => {
              responses["conversations.info"] = { ok: true, channel };
              await validateMapping(runtime(), installation, m.id, m.channelId);
              return target.run();
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            sql.includes("UPDATE slack_installations SET auth_error") ? wrap(target.prepare(sql)) : target.prepare(sql);
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(validateMapping({ ...runtime(), DB: db }, installation, m.id, m.channelId)).rejects.toBeInstanceOf(
      StaleSlackValidationError,
    );
    expect(await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first()).toEqual({
      auth_error: null,
    });
    expect(
      await env.DB.prepare("SELECT validation_state,validation_error FROM slack_channel_subscriptions WHERE id=?")
        .bind(m.id)
        .first(),
    ).toEqual({ validation_state: "valid", validation_error: null });
  });

  it.each(["channel_not_found", "invalid_auth"])(
    "invalidates outstanding %s validation when an unblocked mapping is repaired",
    async (code) => {
      const m = await mapping();
      const installation = (await round2Installation(runtime(), "installation"))!;
      const remote = vi.mocked(fetch).getMockImplementation()!;
      let repaired = false;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (!repaired && String(input).includes("conversations.info")) {
          repaired = true;
          await repairSlackChannelNotifications(runtime(), owner, m.id);
          return Response.json({ ok: false, error: code });
        }
        return remote(input, init);
      });
      await expect(validateMapping(runtime(), installation, m.id, m.channelId)).rejects.toBeInstanceOf(
        StaleSlackValidationError,
      );
      expect(
        await env.DB.prepare(
          "SELECT validation_state,notification_blocked_at FROM slack_channel_subscriptions WHERE id=?",
        )
          .bind(m.id)
          .first(),
      ).toEqual({ validation_state: "valid", notification_blocked_at: null });
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: null });
    },
  );

  it.each([
    ["chat:write", ["text", "legacy-channel"]],
    ["chat:write,links:write", ["text", "legacy-channel", "unfurl"]],
    [
      "chat:write,channels:read,groups:read,channels:history,groups:history,users:read",
      ["text", "legacy-channel", "mirror", "legacy-digest"],
    ],
  ])("resumes only the operations supported by a partial grant: %s", async (scopes, resumed) => {
    const rows = [
      ["text", "slack_digest", '{"digestId":"text"}', '["chat:write"]'],
      ["legacy-channel", "slack_channel", '{"eventId":"legacy"}', null],
      ["mirror", "slack_thread_reply", "{}", '["chat:write"]'],
      ["unfurl", "slack_unfurl", "{}", null],
      ["reported-unfurl", "slack_unfurl", "{}", '["channels:history"]'],
      ["reported-mirror", "slack_thread_reply", "{}", '["links:write"]'],
      ["file", "slack_file_upload", '{"artifactId":"file"}', '["files:write"]'],
      ["legacy-digest", "slack_digest", '{"digestId":"legacy"}', null],
    ];
    await env.DB.batch(
      rows.map(([id, topic, payload, required]) =>
        env.DB.prepare(`INSERT INTO outbox
      (id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_scope_paused_at,slack_scope_required_json,slack_redrive_count)
      VALUES(?,'workspace',?,?,1,1,1,1,?,7)`).bind(id, topic, payload, required),
      ),
    );
    const testEnv: Env = { ...runtime(), SLACK_SHARE_REFRESH_ENABLED: "false" };
    const state = new URL(await createSlackOAuthUrl(testEnv, owner)).searchParams.get("state")!;
    responses["oauth.v2.access"] = {
      ok: true,
      access_token: "xoxb-new",
      scope: scopes,
      bot_user_id: "B123",
      team: { id: "T123" },
    };
    await finishSlackOAuth(testEnv, owner, "code", state);
    for (const [id, topic] of rows) {
      const row = await env.DB.prepare("SELECT slack_scope_paused_at,slack_redrive_count FROM outbox WHERE id=?")
        .bind(id)
        .first<{ slack_scope_paused_at: number | null; slack_redrive_count: number }>();
      expect(row?.slack_scope_paused_at === null).toBe(resumed.includes(String(id)));
      expect(row?.slack_redrive_count).toBe(
        resumed.includes(String(id)) && !["slack_digest", "slack_file_upload"].includes(String(topic)) ? 0 : 7,
      );
    }
  });

  it("caches channel scope failures until the credential revision changes", async () => {
    const m = await mapping();
    const installation = (await round2Installation(runtime(), "installation"))!;
    calls = [];
    responses["conversations.info"] = { ok: false, error: "missing_scope", needed: "channels:read" };
    await expect(validateMapping(runtime(), installation, m.id, m.channelId)).rejects.toMatchObject({
      code: "missing_scope",
    });
    await expect(validateMapping(runtime(), installation, m.id, m.channelId)).rejects.toMatchObject({
      code: "missing_scope",
    });
    await revalidateMappings(runtime());
    expect(calls).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT validation_state,bot_is_member,validation_error,validation_scope_error_revision FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first(),
    ).toEqual({
      validation_state: "valid",
      bot_is_member: 1,
      validation_error: "missing_scope",
      validation_scope_error_revision: installation.credential_revision,
    });
    await env.DB.prepare(
      "UPDATE slack_installations SET credential_revision=credential_revision+1 WHERE id='installation'",
    ).run();
    responses["conversations.info"] = { ok: true, channel };
    await revalidateMappings(runtime());
    expect(calls).toHaveLength(2);
    expect(
      await env.DB.prepare(
        "SELECT validation_scope_error_revision,validation_error FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first(),
    ).toEqual({ validation_scope_error_revision: null, validation_error: null });
  });

  it.each(["credentials", "destination"])(
    "does not cache a rejection after %s changed during validation",
    async (change) => {
      const m = await mapping();
      const installation = (await round2Installation(runtime(), "installation"))!;
      responses["conversations.info"] = { ok: false, error: "missing_scope" };
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        await env.DB.prepare(
          change === "credentials"
            ? "UPDATE slack_installations SET credential_revision=credential_revision+1 WHERE id='installation'"
            : "UPDATE slack_channel_subscriptions SET channel_id='C999' WHERE id=?",
        )
          .bind(...(change === "credentials" ? [] : [m.id]))
          .run();
        return remote(input, init);
      });
      await expect(validateMapping(runtime(), installation, m.id, m.channelId)).rejects.toBeInstanceOf(
        StaleSlackValidationError,
      );
      expect(
        await env.DB.prepare(
          "SELECT validation_error,validation_scope_error_revision FROM slack_channel_subscriptions WHERE id=?",
        )
          .bind(m.id)
          .first(),
      ).toEqual({ validation_error: null, validation_scope_error_revision: null });
    },
  );
  it.each([
    [
      "chat:write,links:read,links:write,channels:read,groups:read,channels:history,groups:history,users:read",
      true,
      true,
    ],
    [
      "chat:write,links:read,links:write,channels:read,groups:read,channels:history,groups:history,users:read,files:write",
      true,
      true,
    ],
    ["chat:write", false, true],
  ])("clears scope blocks independently of optional file permissions %#", async (scopes, enabled, cleared) => {
    const m = await mapping();
    await page();
    const other = await upsertSlackChannelSubscription(runtime(), owner, {
      ...m,
      pageId: "page",
      digestTimezone: m.digestTimezone ?? undefined,
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='missing_scope',muted_at=2,snoozed_until=3 WHERE id=?",
      ).bind(m.id),
      env.DB.prepare(
        "UPDATE slack_channel_subscriptions SET notification_blocked_at=4,notification_error='not_in_channel' WHERE id=?",
      ).bind(other.id),
      env.DB.prepare(
        "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_scope_paused_at,slack_redrive_count) VALUES('scope-budget','workspace','slack_digest','{\"digestId\":\"retained\"}',1,1,1,1,7)",
      ),
      env.DB.prepare(
        "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_scope_paused_at,slack_redrive_count) VALUES('legacy-scope-budget','workspace','slack_channel','{\"eventId\":\"legacy\"}',1,1,1,1,7)",
      ),
    ]);
    const oauthEnv: Env = enabled
      ? runtime()
      : {
          ...runtime(),
          WORKSPACE_ACTIVITY_ENABLED: "false",
          SLACK_CHANNEL_VALIDATION_ENABLED: "false",
          SLACK_SHARE_REFRESH_ENABLED: "false",
          SLACK_RICH_DIGESTS_ENABLED: "false",
        };
    const state = new URL(await createSlackOAuthUrl(oauthEnv, owner)).searchParams.get("state")!;
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === "https://slack.com/api/oauth.v2.access"
        ? Promise.resolve(
            Response.json({
              ok: true,
              access_token: "xoxb-new",
              scope: scopes,
              bot_user_id: "B123",
              team: { id: "T123" },
            }),
          )
        : remote(input, init),
    );
    await finishSlackOAuth(oauthEnv, owner, "code", state);
    expect(
      await env.DB.prepare(
        "SELECT notification_blocked_at,notification_error,muted_at,snoozed_until FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first(),
    ).toEqual({
      notification_blocked_at: cleared ? null : 1,
      notification_error: cleared ? null : "missing_scope",
      muted_at: 2,
      snoozed_until: 3,
    });
    expect(
      await env.DB.prepare("SELECT notification_error FROM slack_channel_subscriptions WHERE id=?")
        .bind(other.id)
        .first(),
    ).toEqual({ notification_error: "not_in_channel" });
    expect(await env.DB.prepare("SELECT slack_redrive_count FROM outbox WHERE id='scope-budget'").first()).toEqual({
      slack_redrive_count: 7,
    });
    expect(
      await env.DB.prepare(
        "SELECT slack_scope_paused_at IS NOT NULL paused FROM outbox WHERE id='scope-budget'",
      ).first(),
    ).toEqual({ paused: scopes.includes("channels:history") ? 0 : 1 });
    expect(
      await env.DB.prepare("SELECT slack_redrive_count FROM outbox WHERE id='legacy-scope-budget'").first(),
    ).toEqual({ slack_redrive_count: 0 });
  });

  it("clears legacy message-size blocks through validation while preserving owner pauses and other destination blocks", async () => {
    const m = await mapping();
    const installation = (await round2Installation(runtime(), "installation"))!;
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='msg_too_long',muted_at=2,snoozed_until=3 WHERE id=?",
    )
      .bind(m.id)
      .run();
    expect(await validateMapping(runtime(), installation, m.id, m.channelId)).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT notification_blocked_at,notification_error,muted_at,snoozed_until FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first(),
    ).toEqual({ notification_blocked_at: null, notification_error: null, muted_at: 2, snoozed_until: 3 });
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=4,notification_error='no_permission' WHERE id=?",
    )
      .bind(m.id)
      .run();
    expect(await validateMapping(runtime(), installation, m.id, m.channelId)).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT notification_blocked_at,notification_error FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first(),
    ).toEqual({ notification_blocked_at: 4, notification_error: "no_permission" });
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=5,notification_error='missing_scope',validation_error='missing_scope' WHERE id=?",
    )
      .bind(m.id)
      .run();
    await validateMapping(runtime(), installation, m.id, m.channelId);
    expect(
      await env.DB.prepare(
        "SELECT notification_blocked_at,notification_error FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first(),
    ).toEqual({ notification_blocked_at: 5, notification_error: "missing_scope" });
  });
  it("preserves an unchanged channel's canonical name without another lookup", async () => {
    const m = await mapping();
    calls = [];
    const saved = await upsertSlackChannelSubscription(runtime(), owner, {
      ...m,
      mappingId: m.id,
      channelName: "forged",
      digestTimezone: m.digestTimezone ?? undefined,
    });
    expect(saved.channelName).toBe("canonical-notes");
    expect(calls).toEqual([]);
    const legacy = await upsertSlackChannelSubscription(
      { ...runtime(), SLACK_CHANNEL_VALIDATION_ENABLED: "false" },
      owner,
      { ...m, mappingId: m.id, channelName: "Manual name", digestTimezone: m.digestTimezone ?? undefined },
    );
    expect(legacy.channelName).toBe("Manual name");
  });

  it.each(["invalid_auth", "token_revoked", "account_inactive", "invalid_refresh_token"])(
    "reauthorizes after %s without muting mappings or clearing channel blocks",
    async (code) => {
      const m = await mapping("immediate");
      await page();
      const blocked = await upsertSlackChannelSubscription(runtime(), owner, {
        ...m,
        pageId: "page",
        digestTimezone: m.digestTimezone ?? undefined,
      });
      const installation = (await round2Installation(runtime(), "installation"))!;
      responses["conversations.info"] = { ok: false, error: code };
      await expect(validateMapping(runtime(), installation, m.id, m.channelId)).rejects.toMatchObject({ code });
      expect(
        await env.DB.prepare(
          "SELECT validation_state,notification_blocked_at FROM slack_channel_subscriptions WHERE id=?",
        )
          .bind(m.id)
          .first(),
      ).toEqual({ validation_state: "valid", notification_blocked_at: null });
      await recordDeliveryError(
        runtime(),
        installation,
        new SlackApiError("chat.postMessage", code, 200, installation.credential_revision),
        m.id,
        m.channelId,
      );
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: code });
      expect(
        await env.DB.prepare("SELECT notification_blocked_at FROM slack_channel_subscriptions WHERE id=?")
          .bind(m.id)
          .first(),
      ).toEqual({ notification_blocked_at: null });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error=?,muted_at=2,snoozed_until=3 WHERE id=?",
        ).bind(code, m.id),
        env.DB.prepare(
          "UPDATE slack_channel_subscriptions SET notification_blocked_at=4,notification_error='not_in_channel' WHERE id=?",
        ).bind(blocked.id),
      ]);
      const state = new URL(await createSlackOAuthUrl(runtime(), owner)).searchParams.get("state")!;
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation((input, init) =>
        String(input) === "https://slack.com/api/oauth.v2.access"
          ? Promise.resolve(
              Response.json({
                ok: true,
                access_token: "xoxb-new",
                scope: installation.scopes,
                bot_user_id: "B123",
                team: { id: "T123" },
              }),
            )
          : remote(input, init),
      );
      await finishSlackOAuth(runtime(), owner, "code", state);
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: null });
      expect(
        await env.DB.prepare(
          "SELECT notification_blocked_at,notification_error,muted_at,snoozed_until FROM slack_channel_subscriptions WHERE id=?",
        )
          .bind(m.id)
          .first(),
      ).toEqual({ notification_blocked_at: null, notification_error: null, muted_at: 2, snoozed_until: 3 });
      expect(
        await env.DB.prepare(
          "SELECT notification_blocked_at,notification_error FROM slack_channel_subscriptions WHERE id=?",
        )
          .bind(blocked.id)
          .first(),
      ).toEqual({ notification_blocked_at: 4, notification_error: "not_in_channel" });
    },
  );
  it.each([
    [{ is_member: false }, "not_in_channel"],
    [{ is_archived: true }, "is_archived"],
    [{ is_shared: true }, "shared_channel"],
    [{ is_ext_shared: true }, "shared_channel"],
    [{ is_org_shared: true }, "shared_channel"],
    [{ pending_shared: ["T2"] }, "shared_channel"],
    [{ is_im: true }, "unsupported_channel_type"],
    [{ is_mpim: true }, "unsupported_channel_type"],
  ])("rejects unsupported channel state %j", async (properties, reason) => {
    responses["conversations.info"] = { ok: true, channel: { ...channel, ...properties } };
    await expect(mapping()).rejects.toMatchObject({ code: reason });
    expect((await env.DB.prepare("SELECT count(*) n FROM slack_channel_subscriptions").first<{ n: number }>())!.n).toBe(
      0,
    );
  });
  it("accepts joined private channels and takes their name from Slack", async () => {
    responses["conversations.info"] = {
      ok: true,
      channel: { ...channel, is_private: true, is_channel: false, is_group: true },
    };
    const m = await mapping();
    expect(m.channelName).toBe("canonical-notes");
    expect(m.channelType).toBe("private_channel");
  });
  it("paginates the directory and rejects nonowners", async () => {
    responses["conversations.list"] = {
      ok: true,
      channels: [channel, { ...channel, id: "D123", is_im: true }, { ...channel, id: "C999", is_shared: true }],
      response_metadata: { next_cursor: "page-two" },
    };
    expect(await channelDirectory(runtime(), owner)).toEqual({
      channels: [{ id: "C123", name: "canonical-notes", private: false }],
      nextCursor: "page-two",
    });
    await channelDirectory(runtime(), owner, "page-two");
    expect(calls.at(-1)!.body.cursor).toBe("page-two");
    await expect(channelDirectory(runtime(), { ...owner, role: "viewer" })).rejects.toMatchObject({ status: 403 });
  });
  it("automatically repairs validation while preserving pause and mirror controls", async () => {
    const m = await mapping();
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET muted_at=1,snoozed_until=9999999999999,mirror_enabled=1 WHERE id=?",
    )
      .bind(m.id)
      .run();
    responses["conversations.info"] = { ok: true, channel: { ...channel, is_member: false } };
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET validated_at=0 WHERE id=?").bind(m.id).run();
    await revalidateMappings(runtime());
    expect(
      await env.DB.prepare("SELECT validation_error FROM slack_channel_subscriptions WHERE id=?").bind(m.id).first(),
    ).toEqual({ validation_error: "not_in_channel" });
    responses["conversations.info"] = { ok: true, channel };
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET validated_at=0 WHERE id=?").bind(m.id).run();
    await revalidateMappings(runtime());
    expect(
      await env.DB.prepare(
        "SELECT validation_state,muted_at,snoozed_until,mirror_enabled FROM slack_channel_subscriptions WHERE id=?",
      )
        .bind(m.id)
        .first(),
    ).toEqual({ validation_state: "valid", muted_at: 1, snoozed_until: 9999999999999, mirror_enabled: 1 });
  });
  it("dry-run does not mutate validation health", async () => {
    const m = await mapping();
    responses["conversations.info"] = { ok: true, channel: { ...channel, is_archived: true } };
    expect(await revalidateMappings(runtime(), true, "workspace")).toEqual([
      { id: m.id, valid: false, reason: "is_archived" },
    ]);
    expect(
      await env.DB.prepare("SELECT validation_state FROM slack_channel_subscriptions WHERE id=?").bind(m.id).first(),
    ).toEqual({ validation_state: "valid" });
  });
  it("requires operator timezone and persists migrated defaults independently of later changes", async () => {
    await expect(
      upsertSlackChannelSubscription({ ...runtime(), SLACK_DIGEST_DEFAULT_TIMEZONE: "" }, owner, {
        spaceId: "workspace-general",
        pageId: null,
        channelId: "C123",
        channelName: "x",
        eventTypes: [...CHANNEL_EVENT_TYPES],
        cadence: "digest",
      }),
    ).rejects.toMatchObject({ code: "slack_timezone_not_configured" });
    const m = await mapping();
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET round2_initialized=0,digest_timezone=NULL,event_types_json='[\"mention\"]' WHERE id=?",
    )
      .bind(m.id)
      .run();
    await syncRound2Configuration(runtime());
    await syncRound2Configuration({ ...runtime(), SLACK_DIGEST_DEFAULT_TIMEZONE: "Europe/Paris" });
    const row = await env.DB.prepare(
      "SELECT digest_timezone,digest_time,digest_open_work,event_types_json FROM slack_channel_subscriptions WHERE id=?",
    )
      .bind(m.id)
      .first<{ digest_timezone: string; digest_time: string; digest_open_work: number; event_types_json: string }>();
    expect(row).toMatchObject({ digest_timezone: "America/Chicago", digest_time: "09:00", digest_open_work: 1 });
    expect(JSON.parse(row!.event_types_json)).toContain("task_status_changed");
  });
  it.each([
    ["2026-03-08T08:45:00Z", "02:30", "2026-03-08T08:00:00.000Z"],
    ["2026-11-01T07:45:00Z", "01:30", "2026-11-01T06:30:00.000Z"],
    ["2026-10-03T05:10:00Z", "00:00", "2026-10-03T05:00:00.000Z"],
  ])("resolves DST and midnight boundaries %s", (now, time, end) => {
    const window = digestWindow(Date.parse(now), time, "America/Chicago");
    expect(new Date(window.end).toISOString()).toBe(end);
    expect(window.next).toBeGreaterThan(Date.parse(now));
  });
  it("queues only the latest boundary and one logical receipt per boundary", async () => {
    const m = await mapping();
    const now = Date.parse("2026-10-03T15:15:00Z");
    await dueRound2Digests(runtime(), now);
    await dueRound2Digests(runtime(), now + 600000);
    const receipts = (
      await env.DB.prepare("SELECT window_start,window_end FROM slack_digest_receipts WHERE subscription_id=?")
        .bind(m.id)
        .all()
    ).results;
    expect(receipts).toEqual([
      { window_start: Date.parse("2026-10-02T14:00:00Z"), window_end: Date.parse("2026-10-03T14:00:00Z") },
    ]);
  });
});

describe("round-two recovery boundaries", () => {
  it.each([
    "actor access",
    "bulk summary",
    "mirrored thread",
    "template",
    "staged import",
    "mapping scope",
    "moved page with inaccessible actor",
    "immediate cadence",
    "reserved event",
  ])("does not reopen completed digests for an event excluded by %s", async (reason) => {
    const m = await mapping();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    await page();
    const window = digestWindow(Date.now(), "09:00", "America/Chicago");
    await event(m.id, "page", window.start + 1000, "page_edit", "excluded-event");
    await dueRound2Digests(runtime());
    const r = (await env.DB.prepare("SELECT * FROM slack_digest_receipts WHERE subscription_id=?")
      .bind(m.id)
      .first<DigestReceipt>())!;
    if (reason === "actor access") {
      await env.DB.prepare("UPDATE slack_channel_events SET actor_id='viewer' WHERE id='excluded-event'").run();
      await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'").run();
    } else if (reason === "bulk summary") {
      await env.DB.prepare(
        "UPDATE slack_channel_events SET summary_id='bulk-exception' WHERE id='excluded-event'",
      ).run();
    } else if (reason === "mirrored thread") {
      await thread();
      await env.DB.prepare("UPDATE slack_channel_events SET thread_id='thread' WHERE id='excluded-event'").run();
      await env.DB.prepare(`INSERT INTO slack_thread_links(id,installation_id,workspace_id,page_id,thread_id,channel_id,state,created_at,updated_at,subscription_id,installation_generation)
        VALUES('mirror','installation','workspace','page','thread','C123','pending',1,1,?,1)`)
        .bind(m.id)
        .run();
    } else if (reason === "template") {
      await env.DB.prepare("UPDATE pages SET is_template=1 WHERE id='page'").run();
    } else if (reason === "staged import") {
      await env.DB.prepare("UPDATE pages SET import_job_id='staged-job' WHERE id='page'").run();
    } else if (reason === "mapping scope") {
      await page("selected");
      await env.DB.prepare("UPDATE slack_channel_subscriptions SET page_id='selected' WHERE id=?").bind(m.id).run();
      await env.DB.prepare("UPDATE slack_channel_events SET suppressed_at=NULL WHERE id='excluded-event'").run();
    } else if (reason === "moved page with inaccessible actor") {
      await env.DB.prepare(
        "INSERT INTO spaces(id,workspace_id,name,slug,position,visibility,created_by,created_at,updated_at) VALUES('other-space','workspace','Other','other','a1','workspace','owner',1,1)",
      ).run();
      await upsertSlackChannelSubscription(runtime(), owner, {
        spaceId: "other-space",
        pageId: null,
        channelId: "C123",
        channelName: "notes",
        eventTypes: [...CHANNEL_EVENT_TYPES],
        cadence: "digest",
      });
      await env.DB.prepare("UPDATE pages SET space_id='other-space' WHERE id='page'").run();
      await env.DB.prepare(
        "UPDATE slack_channel_events SET actor_id='viewer',previous_space_id='workspace-general' WHERE id='excluded-event'",
      ).run();
      await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'").run();
      await env.DB.prepare("UPDATE slack_channel_events SET suppressed_at=1 WHERE id<>'excluded-event'").run();
    } else if (reason === "immediate cadence") {
      await env.DB.prepare("UPDATE slack_channel_events SET cadence='immediate' WHERE id='excluded-event'").run();
    } else {
      await env.DB.prepare(`INSERT INTO slack_digest_messages(id,receipt_id,sequence,state,page_ids_json,event_ids_json)
        VALUES('reserved-message',?,0,'sent','["page"]','["excluded-event"]')`)
        .bind(r.id)
        .run();
      await env.DB.prepare(
        "INSERT INTO slack_digest_message_events(event_id,message_id) VALUES('excluded-event','reserved-message')",
      ).run();
    }
    for (const state of ["sent", "skipped"]) {
      await env.DB.prepare("UPDATE slack_digest_receipts SET state=? WHERE id=?").bind(state, r.id).run();
      await env.DB.prepare("DELETE FROM outbox WHERE id=?").bind(`outbox:${r.id}`).run();
      for (let tick = 0; tick < 2; tick++) await dueRound2Digests(runtime());
      expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
        state,
      });
      expect(await env.DB.prepare("SELECT id FROM outbox WHERE id=?").bind(`outbox:${r.id}`).first()).toBeNull();
    }
    const suppressedTimestamp = expect.any(Number);
    expect(
      await env.DB.prepare("SELECT suppressed_at FROM slack_channel_events WHERE id='excluded-event'").first(),
    ).toEqual({
      suppressed_at: ["actor access", "template", "moved page with inaccessible actor"].includes(reason)
        ? suppressedTimestamp
        : null,
    });
  });

  it("requeues eligible late events once after the original outbox row was consumed", async () => {
    const m = await mapping();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    await page();
    const window = digestWindow(Date.now(), "09:00", "America/Chicago");
    await event(m.id, "page", window.start + 1000, "page_edit", "first-event");
    await dueRound2Digests(runtime());
    const r = (await env.DB.prepare("SELECT * FROM slack_digest_receipts WHERE subscription_id=?")
      .bind(m.id)
      .first<DigestReceipt>())!;
    await deliverDigest(runtime(), r.id);
    await env.DB.prepare("DELETE FROM outbox WHERE id=?").bind(`outbox:${r.id}`).run();
    const first = await env.DB.prepare("SELECT * FROM slack_digest_messages WHERE receipt_id=? AND sequence=0")
      .bind(r.id)
      .first();
    await event(m.id, "page", window.start + 1500, "page_edit", "late-event");
    await env.DB.prepare(
      "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES('stale-continuation','workspace','slack_digest',json_object('digestId',?),1,1,1,9999999999999,7)",
    )
      .bind(r.id)
      .run();
    await dueRound2Digests(runtime());
    expect(
      await env.DB.prepare("SELECT state,claim_token,claimed_at FROM slack_digest_receipts WHERE id=?")
        .bind(r.id)
        .first(),
    ).toEqual({
      state: "pending",
      claim_token: null,
      claimed_at: null,
    });
    expect(await env.DB.prepare("SELECT topic FROM outbox WHERE id=?").bind(`outbox:${r.id}`).first()).toEqual({
      topic: "slack_digest",
    });
    expect(
      await env.DB.prepare("SELECT enqueued_at,slack_redrive_count FROM outbox WHERE id='stale-continuation'").first(),
    ).toEqual({ enqueued_at: 1, slack_redrive_count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT slack_redrive_due_at,slack_claim_recheck_at FROM outbox WHERE id='stale-continuation'",
      ).first(),
    ).toEqual({ slack_redrive_due_at: null, slack_claim_recheck_at: null });
    await env.DB.prepare("UPDATE outbox SET slack_redrive_count=2 WHERE id='stale-continuation'").run();
    await dueRound2Digests(runtime());
    expect(
      await env.DB.prepare("SELECT slack_redrive_count FROM outbox WHERE id='stale-continuation'").first(),
    ).toEqual({ slack_redrive_count: 2 });
    await deliverDigest(runtime(), r.id);
    for (let tick = 0; tick < 2; tick++) await dueRound2Digests(runtime());
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "sent",
    });
    expect(
      await env.DB.prepare("SELECT * FROM slack_digest_messages WHERE receipt_id=? AND sequence=0").bind(r.id).first(),
    ).toEqual(first);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM slack_digest_messages WHERE receipt_id=? AND state='sent'")
        .bind(r.id)
        .first(),
    ).toEqual({ n: 2 });
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
  });
  it("uses the next future boundary after schedule edits or manual unmute", async () => {
    const m = await mapping();
    const now = Date.now();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_not_before=? WHERE id=?").bind(now, m.id).run();
    await dueRound2Digests(runtime(), now);
    expect((await env.DB.prepare("SELECT count(*) n FROM slack_digest_receipts").first<{ n: number }>())!.n).toBe(0);
    await setSlackChannelPause(runtime(), owner, m.id, "mute");
    await setSlackChannelPause(runtime(), owner, m.id, "unmute");
    await dueRound2Digests(runtime(), now + 60000);
    expect((await env.DB.prepare("SELECT count(*) n FROM slack_digest_receipts").first<{ n: number }>())!.n).toBe(0);
  });
  it("preserves saved schedules when the operator changes the default", async () => {
    const m = await mapping();
    const updated = await upsertSlackChannelSubscription(
      { ...runtime(), SLACK_DIGEST_DEFAULT_TIMEZONE: "Europe/Paris" },
      owner,
      {
        mappingId: m.id,
        spaceId: m.spaceId,
        pageId: null,
        channelId: m.channelId,
        channelName: "forged",
        cadence: "digest",
        eventTypes: m.eventTypes,
      },
    );
    expect(updated.digestTimezone).toBe("America/Chicago");
    expect(updated.digestTime).toBe("09:00");
  });
  it("rechecks mirror suppression after immediate activity is queued", async () => {
    const m = await mapping("immediate");
    await page();
    await thread();
    await env.DB.prepare("UPDATE slack_channel_events SET thread_id='thread',event_type='reply'").run();
    await env.DB.prepare(`INSERT INTO slack_thread_links(id,installation_id,workspace_id,page_id,thread_id,channel_id,state,created_at,updated_at,subscription_id,installation_generation)
      VALUES('mirror','installation','workspace','page','thread','C123','pending',1,1,?,1)`)
      .bind(m.id)
      .run();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
    await deliverRound2ChannelEvent(runtime(), e.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
  });
  it("keeps a blocked digest blocked when reconciliation finds no post", async () => {
    const m = await mapping();
    await page();
    await thread();
    const r = await receipt(m.id);
    await env.DB.prepare(
      "UPDATE slack_digest_receipts SET state='blocked',attempted_at=?,last_error='post_unconfirmed' WHERE id=?",
    )
      .bind(Date.now(), r.id)
      .run();
    await deliverDigest(runtime(), r.id, true);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "blocked",
    });
  });
  it("does not let concurrent consumers send the same digest", async () => {
    const m = await mapping();
    await page();
    await thread();
    const r = await receipt(m.id);
    const results = await Promise.allSettled([deliverDigest(runtime(), r.id), deliverDigest(runtime(), r.id)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });
  it("reports missing directory scopes and Retry-After clearly", async () => {
    responses["conversations.list"] = { ok: false, error: "missing_scope" };
    await expect(channelDirectory(runtime(), owner)).rejects.toMatchObject({ status: 409, code: "missing_scope" });
    responses["conversations.list"] = new Response("limited", { status: 429, headers: { "Retry-After": "45" } });
    await expect(channelDirectory(runtime(), owner)).rejects.toMatchObject({
      status: 429,
      details: { retryAfter: 45 },
    });
  });
  it("includes lifecycle activity by a content-writing integration bot", async () => {
    const m = await mapping();
    await page();
    const r = await receipt(m.id);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt,account_type) VALUES('bot','API Writer','bot@example.test',1,1,'bot')",
      ),
      env.DB.prepare(
        "INSERT INTO integrations(id,workspace_id,bot_user_id,name,read_content,insert_content,created_by,created_at,updated_at) VALUES('integration','workspace','bot','API Writer',1,1,'owner',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO integration_grants(integration_id,root_page_id,created_by,created_at) VALUES('integration','page','owner',1)",
      ),
    ]);
    await event(m.id, "page", r.window_end - 1);
    await env.DB.prepare("UPDATE slack_channel_events SET actor_id='bot'").run();
    const pages = await digestPages(
      runtime(),
      (await digestMapping(runtime(), m.id))!,
      r,
      (await round2Installation(runtime(), "installation"))!,
    );
    expect(pages).toEqual([expect.objectContaining({ actors: ["API Writer"], available: true })]);
  });
});

describe("canonical activity", () => {
  it("treats a task archive as one page when its child was already archived", async () => {
    await mapping("immediate");
    await page("tasks", { kind: "table" });
    await env.DB.prepare("UPDATE pages SET is_task_list=1 WHERE id='tasks'").run();
    await env.DB.prepare("INSERT INTO table_state(page_id) VALUES('tasks')").run();
    await env.DB.batch(taskListStatements(env.DB, "tasks"));
    const task = await mutateTask(runtime(), owner, "tasks", null, {
      operationId: "create-task",
      expectedRevision: 1,
      title: "Archive task",
      status: "todo",
    });
    await page("child");
    await env.DB.prepare("UPDATE pages SET parent_id=?,archived_at=1,archived_by='owner' WHERE id='child'")
      .bind(task.detailPageId)
      .run();
    await mutateTask(runtime(), owner, "tasks", task.rowId, {
      operationId: "archive-task",
      expectedRevision: task.revision,
      archived: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT operation_bulk FROM workspace_activity WHERE page_id=? AND event_type='page_archived'",
      )
        .bind(task.detailPageId)
        .first(),
    ).toEqual({ operation_bulk: 0 });
    expect(
      await env.DB.prepare(`SELECT e.summary_id,o.topic FROM slack_channel_events e JOIN outbox o ON json_extract(o.payload_json,'$.eventId')=e.id
      WHERE e.page_id=? AND e.event_type='page_archived'`)
        .bind(task.detailPageId)
        .first(),
    ).toEqual({ summary_id: null, topic: "slack_channel" });
    expect(
      await env.DB.prepare("SELECT id FROM slack_bulk_receipts WHERE operation_id='archive-task'").first(),
    ).toBeNull();
  });
  it("records publication, moves and archives atomically; staged pages and retries emit nothing", async () => {
    await page("page", { staged: "import:test" });
    expect((await listActivity(runtime(), owner, {})).items).toHaveLength(0);
    await env.DB.prepare("UPDATE pages SET import_job_id=NULL WHERE id='page'").run();
    await env.DB.prepare("UPDATE pages SET import_job_id=NULL WHERE id='page'").run();
    await page("parent");
    await env.DB.prepare("UPDATE pages SET parent_id='parent' WHERE id='page'").run();
    await env.DB.prepare("UPDATE pages SET archived_at=?,archived_by='owner' WHERE id='page'").bind(Date.now()).run();
    expect(
      (await listActivity(runtime(), owner, { pageId: "page" })).items
        .map((e) => e.eventType)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["page_archived", "page_created", "page_moved"]);
  });
  it("records comment events independently of recipients and deduplicates retries", async () => {
    await page();
    await thread();
    const statements = () =>
      notificationFanoutStatements(env.DB, {
        workspaceId: "workspace",
        spaceId: "workspace-general",
        pageId: "page",
        contentEpoch: 1,
        threadId: "thread",
        actorId: "owner",
        eventType: "reply",
        sourceId: "source",
        recipientIds: [],
        emitSlackChannel: true,
        createdAt: Date.now(),
      });
    await env.DB.batch(statements());
    await env.DB.batch(statements());
    expect((await listActivity(runtime(), owner, { eventType: "reply" })).items).toHaveLength(1);
    expect((await env.DB.prepare("SELECT count(*) n FROM notifications").first<{ n: number }>())!.n).toBe(0);
  });
  it("keeps workspace history during a channel pause and discards channel activity", async () => {
    const m = await mapping();
    await setSlackChannelPause(runtime(), owner, m.id, "mute");
    await page();
    expect((await listActivity(runtime(), owner, {})).items).toHaveLength(1);
    expect((await env.DB.prepare("SELECT count(*) n FROM slack_channel_events").first<{ n: number }>())!.n).toBe(0);
  });
  it("rechecks private-space access and does not grant it from a mapping ID", async () => {
    await env.DB.prepare("UPDATE spaces SET visibility='private' WHERE id='workspace-general'").run();
    await page();
    const m = await mapping();
    const viewer = { ...owner, user: { ...owner.user, id: "viewer" }, role: "viewer" } as MemberContext;
    expect((await listActivity(runtime(), viewer, {})).items).toHaveLength(0);
    await expect(listActivity(runtime(), viewer, { mappingId: m.id })).rejects.toMatchObject({ status: 404 });
  });
  it("paginates with deterministic tie breaks and bounds history to 30 days", async () => {
    await page("a");
    await page("b");
    await page("c");
    const first = await listActivity(runtime(), owner, { limit: 1 });
    const second = await listActivity(runtime(), owner, { limit: 1, cursor: first.nextCursor! });
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    await env.DB.prepare("UPDATE workspace_activity SET created_at=?")
      .bind(Date.now() - 31 * 86400000)
      .run();
    expect((await listActivity(runtime(), owner, { from: "0" })).items).toHaveLength(0);
    await expect(listActivity(runtime(), owner, { cursor: "bad" })).rejects.toMatchObject({ status: 422 });
  });
  it("records task status mutations exactly once and includes old unfinished tasks in open work", async () => {
    await page("tasks", { kind: "table" });
    await env.DB.prepare("UPDATE pages SET is_task_list=1 WHERE id='tasks'").run();
    await env.DB.prepare("INSERT INTO table_state(page_id) VALUES('tasks')").run();
    await env.DB.batch(taskListStatements(env.DB, "tasks"));
    const task = await mutateTask(runtime(), owner, "tasks", null, {
      operationId: "create-task",
      expectedRevision: 1,
      title: "Ship Slack",
      status: "todo",
    });
    await mutateTask(runtime(), owner, "tasks", task.rowId, {
      operationId: "advance-task",
      expectedRevision: task.revision,
      status: "doing",
    });
    await mutateTask(runtime(), owner, "tasks", task.rowId, {
      operationId: "advance-task",
      expectedRevision: task.revision,
      status: "doing",
    });
    expect((await listActivity(runtime(), owner, { eventType: "task_status_changed" })).items).toHaveLength(2);
    await env.DB.prepare("UPDATE pages SET updated_at=1 WHERE id=?").bind(task.detailPageId).run();
    expect((await listActivity(runtime(), owner, { mode: "open" })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Ship Slack", taskStatus: "doing" })]),
    );
  });
});

describe("digests and delivery receipts", () => {
  it("groups activity, prioritizes changed pages, then sorts current open work", async () => {
    const m = await mapping();
    await page("changed");
    await page("a-open");
    await page("b-open");
    await thread("a-open", "one");
    await thread("b-open", "two");
    await thread("b-open", "three");
    const r = await receipt(m.id);
    await event(m.id, "changed", r.window_end - 1);
    await event(m.id, "changed", r.window_end - 2, "page_edit");
    const pages = await digestPages(
      runtime(),
      (await digestMapping(runtime(), m.id))!,
      r,
      (await round2Installation(runtime(), "installation"))!,
    );
    expect(pages.map((p) => p.pageId)).toEqual(["changed", "b-open", "a-open"]);
    expect(pages[0]).toMatchObject({
      actors: ["Owner"],
      actorCount: 1,
      eventTypes: ["page_edit", "page_created"],
      excerpt: "Current excerpt",
    });
    expect(JSON.stringify(digestBlocks(pages, "https://notes.example", m.id))).toContain("No new activity");
  });
  it("limits pages to ten and escapes names, formatting and mentions within block limits", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    for (let i = 0; i < 12; i++) {
      await page(`p${String(i).padStart(2, "0")}`);
      await event(m.id, `p${String(i).padStart(2, "0")}`, r.window_end - 1);
    }
    const pages = await digestPages(
      runtime(),
      (await digestMapping(runtime(), m.id))!,
      r,
      (await round2Installation(runtime(), "installation"))!,
    );
    expect(pages.map((p) => p.pageId)).toEqual(Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, "0")}`));
    pages[0]!.title = "<@U123>*unsafe*";
    pages[0]!.actors = Array(5).fill("<".repeat(80));
    pages[0]!.actorCount = 7;
    pages[0]!.excerpt = "<".repeat(240);
    const blocks = digestBlocks(pages, "https://notes.example", m.id) as Array<{
      type: string;
      text?: { text: string };
    }>;
    expect(JSON.stringify(blocks)).not.toContain("<@U123>");
    expect(JSON.stringify(blocks)).toContain("and 2 others");
    expect(blocks.every((b) => !b.text || b.text.text.length <= 3000)).toBe(true);
    expect(JSON.stringify(blocks)).toContain("?view=activity&mapping=");
  });
  it("delivers unchanged open work and skips quiet days", async () => {
    const m = await mapping();
    await page();
    const r = await receipt(m.id);
    await deliverDigest(runtime(), r.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    await env.DB.prepare("DELETE FROM slack_digest_receipts").run();
    await thread();
    await receipt(m.id);
    await deliverDigest(runtime(), r.id);
    await deliverDigest(runtime(), r.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });
  it("uses generic departure notices after moves out of channel scope", async () => {
    const m = await mapping();
    await page();
    const r = await receipt(m.id);
    await event(m.id, "page", r.window_end - 1, "page_moved");
    await env.DB.prepare("UPDATE slack_channel_events SET previous_space_id='workspace-general'").run();
    await env.DB.prepare(
      "INSERT INTO spaces(id,workspace_id,name,slug,position,visibility,created_at,updated_at) VALUES('private','workspace','Private','private','b0','private',1,1)",
    ).run();
    await env.DB.prepare("UPDATE pages SET space_id='private' WHERE id='page'").run();
    expect(
      await digestPages(
        runtime(),
        (await digestMapping(runtime(), m.id))!,
        r,
        (await round2Installation(runtime(), "installation"))!,
      ),
    ).toEqual([
      expect.objectContaining({
        departure: true,
        available: false,
        excerpt: "",
        title: "A page is no longer available",
      }),
    ]);
  });
  it("reconciles a lost post response before retrying and blocks uncertain sends", async () => {
    const m = await mapping();
    await page();
    await thread();
    const r = await receipt(m.id);
    responses["chat.postMessage"] = new Error("response lost");
    await expect(deliverDigest(runtime(), r.id)).rejects.toThrow(/lost/);
    responses["conversations.history"] = {
      ok: true,
      messages: [
        {
          ts: "999.001",
          user: "B123",
          metadata: { event_type: "noteflare_digest", event_payload: { delivery_id: r.id } },
        },
      ],
    };
    await deliverDigest(runtime(), r.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT state,message_ts FROM slack_digest_receipts WHERE id=?").bind(r.id).first(),
    ).toEqual({ state: "sent", message_ts: "999.001" });
    await env.DB.prepare("UPDATE slack_digest_receipts SET state='sending' WHERE id=?").bind(r.id).run();
    await env.DB.prepare("UPDATE slack_digest_messages SET state='sending' WHERE receipt_id=?").bind(r.id).run();
    responses["conversations.history"] = { ok: true, messages: [] };
    await deliverDigest(runtime(), r.id);
    expect(
      await env.DB.prepare("SELECT state,last_error FROM slack_digest_receipts WHERE id=?").bind(r.id).first(),
    ).toEqual({ state: "blocked", last_error: "post_unconfirmed" });
  });
  it("honors Retry-After without treating a rejected post as delivered", async () => {
    const m = await mapping();
    await page();
    await thread();
    const r = await receipt(m.id);
    responses["chat.postMessage"] = new Response("limited", { status: 429, headers: { "Retry-After": "45" } });
    await expect(deliverDigest(runtime(), r.id)).rejects.toMatchObject({ retryAfter: 45 });
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "pending",
    });
  });
  it("reconciles a successful post when its database checkpoint fails", async () => {
    const m = await mapping();
    await page();
    await thread();
    const r = await receipt(m.id);
    const original = env.DB.batch.bind(env.DB);
    let failed = false;
    const batch = vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (!failed && calls.some((call) => call.method === "chat.postMessage")) {
        failed = true;
        throw new Error("checkpoint unavailable");
      }
      return original(statements);
    });
    await expect(deliverDigest(runtime(), r.id)).rejects.toThrow("checkpoint unavailable");
    batch.mockRestore();
    responses["conversations.history"] = {
      ok: true,
      messages: [{ ts: "999.001", user: "B123", metadata: { event_payload: { delivery_id: r.id } } }],
    };
    await deliverDigest(runtime(), r.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT state,message_ts FROM slack_digest_receipts WHERE id=?").bind(r.id).first(),
    ).toEqual({ state: "sent", message_ts: "999.001" });
  });
  it("reconciles immediate channel sends as well", async () => {
    await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
    responses["chat.postMessage"] = new Error("response lost");
    await expect(deliverRound2ChannelEvent(runtime(), e.id)).rejects.toThrow(/lost/);
    responses["conversations.history"] = {
      ok: true,
      messages: [{ ts: "999.001", user: "B123", metadata: { event_payload: { delivery_id: `channel:${e.id}` } } }],
    };
    await deliverRound2ChannelEvent(runtime(), e.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });
});

describe("queued share lifecycle", () => {
  it("updates every reference to current state despite reversed queue order", async () => {
    await mapping();
    await page();
    await reference();
    await reference("page", null, "second");
    await createShare(runtime(), owner, "page", "http://example.test", {});
    await revokeShare(runtime(), owner, "page");
    const jobs = await refreshes();
    expect(jobs).toHaveLength(4);
    for (const job of jobs.toReversed()) await deliverShareRefresh(runtime(), job.id);
    const effects = calls.filter((c) => c.method === "chat.unfurl");
    expect(effects).toHaveLength(2);
    expect(JSON.stringify(effects)).toContain("revoked");
    expect(JSON.stringify(effects)).toContain("Create public share");
    expect(calls.some((c) => c.method === "chat.update")).toBe(false);
  });
  it("unfurls authorized tracked links without bot membership and never posts a fallback there", async () => {
    await mapping();
    await page();
    await reference();
    await createShare(runtime(), owner, "page", "http://example.test", {});
    responses["conversations.info"] = { ok: true, channel: { ...channel, is_member: false } };
    await deliverShareRefresh(runtime(), (await refreshes())[0]!.id);
    expect(calls.filter((c) => c.method === "chat.unfurl")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    await revokeShare(runtime(), owner, "page");
    responses["chat.unfurl"] = { ok: false, error: "cannot_unfurl_message" };
    await deliverShareRefresh(runtime(), (await refreshes()).at(-1)!.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
  });
  it.each(["legacy relink", "legacy verification", "new grant"])(
    "renders historical previews after %s",
    async (mode) => {
      await mapping();
      await page();
      await reference();
      const timestamp = Date.now() + 1000;
      if (mode === "legacy verification") {
        await env.DB.prepare(
          "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('continuity-account','T123:U123','slack','owner',1,1)",
        ).run();
        await env.DB.prepare(
          "UPDATE slack_user_links SET migration_state='verified',verification_method='slack_openid',better_auth_account_id='continuity-account',verified_at=?,linked_at=?",
        )
          .bind(timestamp, timestamp)
          .run();
      } else
        await env.DB.prepare("UPDATE slack_user_links SET linked_at=?,authorization_started_at=?")
          .bind(timestamp, mode === "new grant" ? timestamp : 1)
          .run();
      await createShare(runtime(), owner, "page", "http://example.test", {});
      for (const job of await refreshes()) await deliverShareRefresh(runtime(), job.id);
      const effects = JSON.stringify(calls.filter((call) => call.method === "chat.unfurl"));
      expect(effects).toContain(mode === "new grant" ? "no longer available" : "Current excerpt");
      expect(effects.includes("no longer available")).toBe(mode === "new grant");
    },
  );

  it("delivers queued private unfurls under the unchanged grant start", async () => {
    await mapping();
    await page();
    await reference();
    await env.DB.prepare(`INSERT INTO slack_unfurls(id,workspace_id,installation_id,installation_generation,channel_id,message_ts,user_id,unfurls_json,created_at)
      VALUES('continuous-unfurl','workspace','installation',1,'C123','123.456','owner',?,?)`)
      .bind(
        JSON.stringify({
          "http://example.test/?page=page": {
            blocks: [{ type: "section", text: { type: "plain_text", text: "Earlier preview" } }],
          },
        }),
        Date.now(),
      )
      .run();
    await env.DB.prepare("UPDATE slack_user_links SET linked_at=?")
      .bind(Date.now() + 1000)
      .run();
    await deliverSlackUnfurl(
      { ...runtime(), SLACK_SHARE_REFRESH_ENABLED: "false" },
      "continuous-unfurl",
      "continuous-outbox",
    );
    expect(JSON.stringify(calls.filter((call) => call.method === "chat.unfurl"))).toContain("Earlier preview");
    expect(
      await env.DB.prepare("SELECT delivered_at,retired_at FROM slack_unfurls WHERE id='continuous-unfurl'").first(),
    ).toEqual({ delivered_at: expect.any(Number), retired_at: null });
  });

  it("re-observation invalidates rendering evidence and refreshes an edited message", async () => {
    await mapping();
    await page();
    await env.DB.prepare(
      "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,installation_generation,security_generation,authorization_started_at) VALUES('installation','owner','U123',1,1,0,1)",
    ).run();
    const linkEvent = {
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "link_shared",
        user: "U123",
        channel: "C123",
        message_ts: "123.456",
        links: [{ url: "http://example.test/?page=page" }],
      },
    };
    await handleSlackEvent(runtime(), { ...linkEvent, event_id: "initial-preview" });
    for (const job of await refreshes()) await deliverShareRefresh(runtime(), job.id);
    const before = calls.filter((c) => c.method === "chat.unfurl").length;
    await handleSlackEvent(runtime(), { ...linkEvent, event_id: "edited-preview" });
    for (const job of await refreshes()) await deliverShareRefresh(runtime(), job.id);
    expect(calls.filter((c) => c.method === "chat.unfurl")).toHaveLength(before + 1);
  });
  it("keeps direct old public URLs revoked after a replacement share", async () => {
    await mapping();
    await page();
    const old = await createShare(runtime(), owner, "page", "http://example.test", {});
    await reference("share", old.id);
    await reference("page", null, "page-reference");
    await revokeShare(runtime(), owner, "page");
    await createShare(runtime(), owner, "page", "http://example.test", {});
    for (const job of await refreshes()) await deliverShareRefresh(runtime(), job.id);
    const rendered = calls.filter((c) => c.method === "chat.unfurl").map((c) => JSON.stringify(c.body));
    expect(rendered.some((s) => s.includes(`/share/${old.id}`) && s.includes("revoked"))).toBe(true);
    expect(rendered.some((s) => s.includes("?page=page") && s.includes("View public share"))).toBe(true);
  });
  it.each(["mapping", "page", "membership"])("cleans up access loss after %s deletion", async (kind) => {
    const m = await mapping();
    await page();
    await reference();
    await createShare(runtime(), owner, "page", "http://example.test", {});
    if (kind === "mapping") await env.DB.prepare("DELETE FROM slack_channel_subscriptions WHERE id=?").bind(m.id).run();
    else if (kind === "page") await env.DB.prepare("DELETE FROM pages WHERE id='page'").run();
    else {
      await env.DB.prepare("UPDATE workspace_members SET role='owner' WHERE user_id='viewer'").run();
      await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='owner'").run();
    }
    for (const job of await refreshes()) await deliverShareRefresh(runtime(), job.id);
    const effects = JSON.stringify(calls.filter((c) => c.method === "chat.unfurl"));
    expect(effects).toContain("no longer available");
    expect(effects).not.toContain("Current excerpt");
    expect(effects).not.toContain('"actions"');
  });
  it("posts one fallback per transition, reconciles lost responses, and ignores deleted originals", async () => {
    await mapping();
    await page();
    await reference();
    await createShare(runtime(), owner, "page", "http://example.test", {});
    const job = (await refreshes())[0]!;
    responses["chat.unfurl"] = { ok: false, error: "cannot_unfurl_message" };
    responses["conversations.history"] = { ok: true, messages: [{ ts: "123.456" }] };
    responses["chat.postMessage"] = new Error("lost response");
    await expect(deliverShareRefresh(runtime(), job.id)).rejects.toThrow(/lost/);
    responses["conversations.replies"] = {
      ok: true,
      messages: [
        { user: "B123", ts: "999.001", thread_ts: "123.456", metadata: { event_payload: { delivery_id: job.id } } },
      ],
    };
    await deliverShareRefresh(runtime(), job.id);
    await deliverShareRefresh(runtime(), job.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    await revokeShare(runtime(), owner, "page");
    responses["conversations.history"] = { ok: true, messages: [] };
    await deliverShareRefresh(runtime(), (await refreshes()).at(-1)!.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });
  it("observes direct public URLs and prevents captured initial previews restoring revoked state", async () => {
    await mapping();
    await page();
    const share = await createShare(runtime(), owner, "page", "http://example.test", {});
    await env.DB.prepare(
      "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,installation_generation,security_generation,authorization_started_at) VALUES('installation','owner','U123',1,1,0,1)",
    ).run();
    const url = `http://example.test/share/${share.url.split("/").at(-1)}`;
    await handleSlackEvent(runtime(), {
      type: "event_callback",
      team_id: "T123",
      event_id: "link-event",
      event: { type: "link_shared", user: "U123", channel: "C123", message_ts: "123.456", links: [{ url }] },
    });
    await revokeShare(runtime(), owner, "page");
    for (const job of await refreshes()) await deliverShareRefresh(runtime(), job.id);
    await deliverSlackUnfurl(
      { ...runtime(), SLACK_SHARE_REFRESH_ENABLED: "false" },
      "link-event",
      "outbox:slack-unfurl:link-event",
    );
    expect(JSON.stringify(calls.filter((c) => c.method === "chat.unfurl"))).toContain("revoked");
    expect(calls.filter((c) => c.method === "chat.unfurl")).toHaveLength(1);
  });
  it("falls back for permanent attachment errors but retries transient failures", async () => {
    await mapping();
    await page();
    await reference();
    await createShare(runtime(), owner, "page", "http://example.test", {});
    const job = (await refreshes())[0]!;
    responses["chat.unfurl"] = { ok: false, error: "internal_error" };
    await expect(deliverShareRefresh(runtime(), job.id)).rejects.toMatchObject({ code: "internal_error" });
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    responses["chat.unfurl"] = { ok: false, error: "cannot_parse_attachment" };
    responses["conversations.history"] = { ok: true, messages: [{ ts: "123.456", thread_ts: "123.000" }] };
    await deliverShareRefresh(runtime(), job.id);
    await deliverShareRefresh(runtime(), job.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ thread_ts: "123.000" }) }),
    ]);
  });
  it("tracks diagram availability without offering unsupported public sharing", async () => {
    await mapping();
    await page("page", { kind: "diagram" });
    await reference();
    await env.DB.prepare(
      "UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE id='reference'",
    ).run();
    await deliverShareRefresh(runtime(), (await refreshes())[0]!.id);
    const rendered = JSON.stringify(calls.filter((c) => c.method === "chat.unfurl"));
    expect(rendered).toContain("Current excerpt");
    expect(rendered).not.toContain('"actions"');
  });
  it("rereads the current observing member when older reference jobs run last", async () => {
    await mapping();
    await page();
    await reference();
    await env.DB.prepare("UPDATE slack_share_references SET observed_user_id='viewer' WHERE id='reference'").run();
    await createShare(runtime(), owner, "page", "http://example.test", {});
    await env.DB.prepare(
      "UPDATE slack_share_references SET observed_user_id='owner',lifecycle_revision=lifecycle_revision+1 WHERE id='reference'",
    ).run();
    await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'").run();
    for (const job of (await refreshes()).toReversed()) await deliverShareRefresh(runtime(), job.id);
    const effects = calls.filter((c) => c.method === "chat.unfurl");
    expect(effects).toHaveLength(1);
    expect(JSON.stringify(effects)).toContain("View public share");
    expect(JSON.stringify(effects)).not.toContain("no longer available");
  });
  it("does not let an older fallback reconciliation overwrite a newer transition receipt", async () => {
    await mapping();
    await page();
    await createShare(runtime(), owner, "page", "http://example.test", {});
    await reference();
    await env.DB.prepare(
      "UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE id='reference'",
    ).run();
    const initial = (await refreshes())[0]!;
    await revokeShare(runtime(), owner, "page");
    const revoked = (await refreshes()).at(-1)!;
    responses["chat.unfurl"] = { ok: false, error: "cannot_unfurl_message" };
    responses["conversations.history"] = { ok: true, messages: [{ ts: "123.456" }] };
    responses["chat.postMessage"] = new Error("lost response");
    await expect(deliverShareRefresh(runtime(), revoked.id)).rejects.toThrow("lost response");
    await createShare(runtime(), owner, "page", "http://example.test", {});
    const replacement = (await refreshes()).at(-1)!;
    responses["chat.postMessage"] = { ok: true, ts: "999.003" };
    await deliverShareRefresh(runtime(), replacement.id);
    responses["conversations.replies"] = {
      ok: true,
      messages: [
        { user: "B123", ts: "999.002", thread_ts: "123.456", metadata: { event_payload: { delivery_id: revoked.id } } },
      ],
    };
    await deliverShareRefresh(runtime(), revoked.id);
    await deliverShareRefresh(runtime(), initial.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2);
    expect(
      await env.DB.prepare(`SELECT r.rendered_hash=latest.rendered_hash matches FROM slack_share_references r
      JOIN slack_share_refreshes latest ON latest.id=? WHERE r.id='reference'`)
        .bind(replacement.id)
        .first(),
    ).toEqual({ matches: 1 });
  });
});

describe("thumbnail uploads and queued recovery", () => {
  it("stores Slack's reported scope requirements for the failed operation", async () => {
    const m = await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events WHERE subscription_id=? AND page_id='page'")
      .bind(m.id)
      .first<{ id: string }>())!;
    responses["conversations.info"] = { ok: false, error: "missing_scope", needed: "channels:read" };
    const ack = vi.fn();
    await consumeDeliveryMessage(runtime(), {
      body: { outboxId: `outbox:${e.id}` },
      ack,
      retry: vi.fn(),
    } as unknown as Message<{ outboxId: string }>);
    expect(ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT slack_scope_required_json FROM outbox WHERE id=?").bind(`outbox:${e.id}`).first(),
    ).toEqual({ slack_scope_required_json: '[["channels:read"]]' });
    expect(
      await env.DB.prepare("SELECT notification_blocked_at FROM slack_channel_subscriptions WHERE id=?")
        .bind(m.id)
        .first(),
    ).toEqual({ notification_blocked_at: null });
  });
  it.each([true, false])("preserves an existing allocation before capability checks: browser=%s", async (browser) => {
    await mapping();
    await page("page", { kind: "diagram" });
    const id = await projection();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE slack_file_artifacts SET state='uploading',upload_phase='allocated',slack_file_id='FEXISTING',claimed_at=1 WHERE id=?",
      ).bind(id),
      env.DB.prepare("UPDATE slack_installations SET scopes='chat:write' WHERE id='installation'"),
    ]);
    const ack = vi.fn();
    await consumeDeliveryMessage(
      { ...runtime(), ...(!browser ? { BROWSER: undefined } : {}) } as Env,
      { body: { outboxId: `outbox:${id}` }, ack, retry: vi.fn() } as unknown as Message<{ outboxId: string }>,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT state,last_error,slack_file_id FROM slack_file_artifacts WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({
      state: browser ? "pending" : "failed",
      last_error: browser ? "missing_scope" : "thumbnail_unavailable",
      slack_file_id: "FEXISTING",
    });
    expect(
      await env.DB.prepare(
        "SELECT slack_scope_paused_at IS NOT NULL paused,slack_scope_required_json FROM outbox WHERE id=?",
      )
        .bind(`outbox:${id}`)
        .first(),
    ).toEqual({ paused: browser ? 1 : 0, slack_scope_required_json: browser ? '[["files:write"]]' : null });
    expect(calls.filter((call) => call.method.startsWith("files."))).toHaveLength(0);
  });
  it("pauses thumbnails with missing upload scope instead of permanently failing them", async () => {
    await mapping();
    await page("page", { kind: "diagram" });
    const id = await projection();
    await env.DB.prepare("UPDATE slack_installations SET scopes='chat:write' WHERE id='installation'").run();
    const ack = vi.fn();
    await consumeDeliveryMessage(runtime(), {
      body: { outboxId: `outbox:${id}` },
      ack,
      retry: vi.fn(),
    } as unknown as Message<{ outboxId: string }>);
    expect(ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT state,last_error FROM slack_file_artifacts WHERE id=?").bind(id).first(),
    ).toEqual({ state: "pending", last_error: "missing_scope" });
    expect(
      await env.DB.prepare("SELECT slack_scope_paused_at IS NOT NULL paused FROM outbox WHERE id=?")
        .bind(`outbox:${id}`)
        .first(),
    ).toEqual({ paused: 1 });
    expect(calls.filter((c) => c.method === "files.getUploadURLExternal")).toHaveLength(0);
  });
  it("stops upload delivery after eight failed attempts with a fresh allocation on each attempt", async () => {
    await mapping();
    await page("page", { kind: "diagram" });
    const id = await projection();
    await env.BUCKET.put("thumbnail-key", "<svg></svg>");
    responses["files.getUploadURLExternal"] = {
      ok: true,
      file_id: "FRETRY",
      upload_url: "https://uploads.slack.test/rejected",
    };
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).startsWith("https://uploads.slack.test/")
        ? Promise.resolve(new Response("rejected", { status: 403 }))
        : remote(input, init),
    );
    const render = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const bindings = { ...runtime(), BROWSER: { quickAction: render } } as unknown as Env;
    for (let attempt = 0; attempt < 7; attempt++)
      await expect(deliverThumbnail(bindings, id)).rejects.toThrow("thumbnail_upload_http_403");
    await deliverThumbnail(bindings, id);
    await deliverThumbnail(bindings, id);
    expect(render).toHaveBeenCalledTimes(8);
    expect(calls.filter((c) => c.method === "files.getUploadURLExternal")).toHaveLength(8);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_artifacts WHERE id=?").bind(id).first(),
    ).toEqual({ state: "failed", attempt_count: 8 });
  });
  it("replaces a rejected upload allocation with one matching the next render's byte length", async () => {
    await mapping();
    await page("page", { kind: "diagram" });
    await env.DB.prepare("UPDATE pages SET content_epoch=1 WHERE id='page'").run();
    await env.BUCKET.put("thumbnail-key", "<svg></svg>");
    const id = await projection();
    const render = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    responses["files.getUploadURLExternal"] = {
      ok: true,
      file_id: "FOLD",
      upload_url: "https://uploads.slack.test/old",
    };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/old") {
        responses["files.getUploadURLExternal"] = {
          ok: true,
          file_id: "FNEW",
          upload_url: "https://uploads.slack.test/new",
        };
        return new Response("expired", { status: 403 });
      }
      return original(input, init);
    });
    const bindings = { ...runtime(), BROWSER: { quickAction: render } } as unknown as Env;
    await expect(deliverThumbnail(bindings, id)).rejects.toThrow("thumbnail_upload_http_403");
    await deliverThumbnail(bindings, id);
    expect(
      calls.filter((call) => call.method === "files.getUploadURLExternal").map((call) => call.body.length),
    ).toEqual([2, 3]);
    expect(calls.filter((call) => call.method === "files.delete").map((call) => call.body.file)).toEqual(["FOLD"]);
    expect(
      await env.DB.prepare("SELECT state,slack_file_id,attempt_count FROM slack_file_artifacts WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({ state: "uploaded", slack_file_id: "FNEW", attempt_count: 2 });
  });
  async function projection(hash = "hash-one") {
    await env.DB.prepare(`INSERT INTO diagram_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,thumbnail_r2_key,thumbnail_hash,thumbnail_byte_size,updated_at)
      VALUES('page',1,1,1,'diagram-key','content-hash',1,'thumbnail-key',?,1,?)
      ON CONFLICT(page_id) DO UPDATE SET thumbnail_hash=excluded.thumbnail_hash,updated_at=excluded.updated_at`)
      .bind(hash, Date.now())
      .run();
    return `file:installation:1:page:1:${hash}`;
  }
  it.each(["takeover", "artifact_deleted", "page_deleted", "identity_changed"])(
    "retains an allocation after %s during the Slack request without uploading it",
    async (change) => {
      await mapping();
      await page("page", { kind: "diagram" });
      const id = await projection();
      await env.BUCKET.put("thumbnail-key", "<svg></svg>");
      responses["files.getUploadURLExternal"] = {
        ok: true,
        file_id: "FLOST",
        upload_url: "https://uploads.slack.test/lost",
      };
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).includes("files.getUploadURLExternal")) {
          if (change === "page_deleted") await env.DB.prepare("DELETE FROM pages WHERE id='page'").run();
          else if (change === "artifact_deleted")
            await env.DB.prepare("DELETE FROM slack_file_artifacts WHERE id=?").bind(id).run();
          else {
            await env.DB.prepare(
              "UPDATE slack_file_artifacts SET claim_token='replacement-consumer',claimed_at=? WHERE id=?",
            )
              .bind(Date.now(), id)
              .run();
            if (change === "identity_changed")
              await env.DB.prepare(
                "UPDATE slack_installations SET generation=2,team_id='TOTHER',bot_user_id='BOTHER' WHERE id='installation'",
              ).run();
          }
        }
        return remote(input, init);
      });
      const bindings = {
        ...runtime(),
        BROWSER: { quickAction: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) },
      } as unknown as Env;
      const outcomes = [
        await deliverThumbnail(bindings, id).then(
          () => null,
          (error: unknown) => error,
        ),
      ];
      expect(await env.DB.prepare("SELECT claim_token FROM slack_file_artifacts WHERE id=?").bind(id).first()).toEqual(
        ["takeover", "identity_changed"].includes(change) ? { claim_token: "replacement-consumer" } : null,
      );
      if (change === "takeover") {
        await env.DB.prepare("UPDATE slack_file_artifacts SET claimed_at=NULL,claim_token=NULL WHERE id=?")
          .bind(id)
          .run();
        outcomes.push(
          await deliverThumbnail(bindings, id).then(
            () => null,
            (error: unknown) => error,
          ),
        );
      }
      expect(outcomes).toHaveLength(change === "takeover" ? 2 : 1);
      for (const outcome of outcomes) expect(outcome).toBeInstanceOf(DeliveryInProgressError);
      expect(
        (
          await env.DB.prepare(
            "SELECT workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,attempt_count FROM slack_file_cleanup_jobs WHERE file_id='FLOST'",
          ).all()
        ).results,
      ).toEqual([
        {
          workspace_id: "workspace",
          installation_id: "installation",
          installation_generation: 1,
          team_id: "T123",
          bot_user_id: "B123",
          file_id: "FLOST",
          artifact_id: id,
          state: "pending",
          attempt_count: 0,
        },
      ]);
      expect(
        calls.filter((call) => ["upload", "files.completeUploadExternal", "files.delete"].includes(call.method)),
      ).toHaveLength(0);
    },
  );
  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "gates thumbnail enqueueing, redrive, and delivery for flag combination %i",
    async (flags) => {
      await mapping();
      await page("page", { kind: "diagram" });
      const id = await projection();
      await env.BUCKET.put("thumbnail-key", "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
      responses["files.getUploadURLExternal"] = {
        ok: true,
        file_id: "F123",
        upload_url: "https://uploads.slack.test/upload",
      };
      responses["files.completeUploadExternal"] = { ok: true, files: [{ id: "F123" }] };
      const send = vi.fn().mockResolvedValue(undefined);
      const testEnv = {
        ...runtime(),
        SLACK_RICH_DIGESTS_ENABLED: flags & 1 ? "true" : "false",
        SLACK_CHANNEL_VALIDATION_ENABLED: flags & 2 ? "true" : "false",
        WORKSPACE_ACTIVITY_ENABLED: flags & 4 ? "true" : "false",
        DELIVERY_QUEUE: { send },
        BROWSER: { quickAction: vi.fn().mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]))) },
      } as unknown as Env;
      await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=?,slack_redrive_count=2 WHERE id=?")
        .bind(Date.now() - 1, `outbox:${id}`)
        .run();
      const before = await env.DB.prepare(
        "SELECT enqueued_at,available_at,slack_redrive_due_at,slack_redrive_count FROM outbox WHERE id=?",
      )
        .bind(`outbox:${id}`)
        .first();
      calls = [];
      await sweepOutbox(testEnv);
      await redriveRound2Outbox(testEnv);
      const ack = vi.fn();
      await consumeDeliveryMessage(testEnv, { ack, body: { outboxId: `outbox:${id}` } } as unknown as Parameters<
        typeof consumeDeliveryMessage
      >[1]);
      await deliverThumbnail(testEnv, id);
      expect(ack).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(flags === 7 ? 1 : 0);
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_artifacts WHERE id=?").bind(id).first(),
      ).toEqual({ state: flags === 7 ? "uploaded" : "pending", attempt_count: flags === 7 ? 1 : 0 });
      expect(calls.length > 0).toBe(flags === 7);
      const uploadedMarkers = expect.objectContaining({ enqueued_at: expect.any(Number), slack_redrive_due_at: null });
      expect(
        await env.DB.prepare(
          "SELECT enqueued_at,available_at,slack_redrive_due_at,slack_redrive_count FROM outbox WHERE id=?",
        )
          .bind(`outbox:${id}`)
          .first(),
      ).toEqual(flags === 7 ? uploadedMarkers : before);
      if (flags !== 7) {
        const enabled: Env = {
          ...testEnv,
          SLACK_RICH_DIGESTS_ENABLED: "true",
          SLACK_CHANNEL_VALIDATION_ENABLED: "true",
          WORKSPACE_ACTIVITY_ENABLED: "true",
        };
        await redriveRound2Outbox(enabled);
        await consumeDeliveryMessage(enabled, {
          ack: vi.fn(),
          body: { outboxId: `outbox:${id}` },
        } as unknown as Parameters<typeof consumeDeliveryMessage>[1]);
      }
      expect(send).toHaveBeenCalledOnce();
      expect(await env.DB.prepare("SELECT state FROM slack_file_artifacts WHERE id=?").bind(id).first()).toEqual({
        state: "uploaded",
      });
    },
  );

  it.each([
    { change: "disconnect", expired: true },
    { change: "generation", expired: true },
    { change: "disconnect", expired: false },
    { change: "generation", expired: false },
  ])(
    "retires obsolete uploading artifacts after $change only when the claim expired: $expired",
    async ({ change, expired }) => {
      await mapping();
      await page("page", { kind: "diagram" });
      const id = await projection();
      await env.DB.prepare(
        "UPDATE slack_file_artifacts SET state='uploading',claim_token='original',claimed_at=? WHERE id=?",
      )
        .bind(Date.now() - (expired ? 120_000 : 0), id)
        .run();
      await env.DB.prepare(
        change === "disconnect"
          ? "UPDATE slack_installations SET disconnected_at=1 WHERE id='installation'"
          : "UPDATE slack_installations SET generation=2 WHERE id='installation'",
      ).run();
      calls = [];
      await deliverThumbnail(runtime(), id);
      expect(
        await env.DB.prepare("SELECT state,claim_token FROM slack_file_artifacts WHERE id=?").bind(id).first(),
      ).toEqual({ state: expired ? "retired" : "uploading", claim_token: expired ? null : "original" });
      expect(calls).toEqual([]);
      const send = vi.fn().mockResolvedValue(undefined);
      await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=1 WHERE id=?").bind(`outbox:${id}`).run();
      await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
      expect(send).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare("SELECT slack_redrive_due_at IS NULL cleared FROM outbox WHERE id=?")
          .bind(`outbox:${id}`)
          .first(),
      ).toEqual({ cleared: expired ? 1 : 0 });
    },
  );

  it("preserves an obsolete uncertain digest receipt for reconciliation", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    await env.DB.prepare(
      "UPDATE slack_digest_receipts SET state='sending',claim_token='original',claimed_at=1,attempted_at=1 WHERE id=?",
    )
      .bind(r.id)
      .run();
    await env.DB.prepare("UPDATE slack_installations SET generation=2 WHERE id='installation'").run();
    await deliverDigest(runtime(), r.id);
    expect(
      await env.DB.prepare("SELECT state,claim_token,attempted_at FROM slack_digest_receipts WHERE id=?")
        .bind(r.id)
        .first(),
    ).toEqual({ state: "sending", claim_token: "original", attempted_at: 1 });
  });
  it("supports multiple revisions per epoch and retires stale projections", async () => {
    await mapping();
    await page("page", { kind: "diagram" });
    const old = await projection();
    await projection("hash-two");
    expect((await env.DB.prepare("SELECT count(*) n FROM slack_file_artifacts").first<{ n: number }>())!.n).toBe(2);
    await deliverThumbnail(runtime(), old);
    expect(await env.DB.prepare("SELECT state FROM slack_file_artifacts WHERE id=?").bind(old).first()).toEqual({
      state: "retired",
    });
  });
  it("uploads a private PNG and reuses the resulting Slack file", async () => {
    await mapping();
    await page("page", { kind: "diagram" });
    const id = await projection();
    await env.BUCKET.put("thumbnail-key", "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    responses["files.getUploadURLExternal"] = {
      ok: true,
      file_id: "F123",
      upload_url: "https://uploads.slack.test/upload",
    };
    responses["files.completeUploadExternal"] = { ok: true, files: [{ id: "F123" }] };
    const testEnv = {
      ...runtime(),
      BROWSER: { quickAction: vi.fn().mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]))) },
    } as unknown as Env;
    await deliverThumbnail(testEnv, id);
    await deliverThumbnail(testEnv, id);
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_file_cleanup_jobs").first()).toEqual({ n: 0 });
    expect(calls.filter((c) => c.method === "files.getUploadURLExternal")).toHaveLength(1);
    expect(calls.find((c) => c.method === "files.completeUploadExternal")!.body).toEqual({
      files: [{ id: "F123", title: "NoteFlare diagram thumbnail" }],
    });
    const m = (await env.DB.prepare("SELECT id FROM slack_channel_subscriptions").first<{ id: string }>())!;
    await thread();
    const r = await receipt(m.id);
    const pages = await digestPages(
      runtime(),
      (await digestMapping(runtime(), m.id))!,
      r,
      (await round2Installation(runtime(), "installation"))!,
    );
    expect(pages[0]!.fileId).toBe("F123");
  });
  it("records failed images but still delivers text immediately without later edits", async () => {
    const m = await mapping();
    await page("page", { kind: "diagram" });
    await thread();
    const id = await projection();
    await deliverThumbnail({ ...runtime(), BROWSER: null } as unknown as Env, id);
    const r = await receipt(m.id);
    await deliverDigest(runtime(), r.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect(JSON.stringify(calls.find((c) => c.method === "chat.postMessage")!.body)).not.toContain('"slack_file"');
  });
  it("retries thumbnail preparation and replaces an uncertain private upload", async () => {
    await mapping();
    await page("page", { kind: "diagram" });
    const id = await projection();
    await env.BUCKET.put("thumbnail-key", "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const render = vi
      .fn()
      .mockRejectedValueOnce(new Error("render_timeout"))
      .mockImplementation(async () => new Response(new Uint8Array([137, 80, 78, 71])));
    const testEnv = { ...runtime(), BROWSER: { quickAction: render } } as unknown as Env;
    await expect(deliverThumbnail(testEnv, id)).rejects.toThrow("render_timeout");
    expect(
      await env.DB.prepare("SELECT state,last_error FROM slack_file_artifacts WHERE id=?").bind(id).first(),
    ).toEqual({ state: "pending", last_error: "render_timeout" });
    responses["files.getUploadURLExternal"] = {
      ok: true,
      file_id: "FOLD",
      upload_url: "https://uploads.slack.test/upload",
    };
    responses["files.completeUploadExternal"] = new Error("lost completion response");
    await expect(deliverThumbnail(testEnv, id)).rejects.toThrow("lost completion response");
    expect(
      await env.DB.prepare("SELECT upload_phase,slack_file_id FROM slack_file_artifacts WHERE id=?").bind(id).first(),
    ).toEqual({ upload_phase: "complete", slack_file_id: "FOLD" });
    responses["files.getUploadURLExternal"] = {
      ok: true,
      file_id: "FNEW",
      upload_url: "https://uploads.slack.test/replacement",
    };
    responses["files.completeUploadExternal"] = { ok: true };
    await deliverThumbnail(testEnv, id);
    expect(calls.find((c) => c.method === "files.delete")?.body).toEqual({ file: "FOLD" });
    expect(
      calls.filter((c) => c.method === "files.completeUploadExternal").every((c) => !("channel_id" in c.body)),
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT state,slack_file_id,attempt_count FROM slack_file_artifacts WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({ state: "uploaded", slack_file_id: "FNEW", attempt_count: 3 });
  });
  it("redrives only queued work and leaves release-paused recovery markers intact", async () => {
    const m = await mapping();
    await page();
    await thread();
    const r = await receipt(m.id);
    await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at)
      VALUES('outbox:digest','workspace','slack_digest',json_object('digestId',?),1,1,1,1)`)
      .bind(r.id)
      .run();
    const send = vi.fn().mockResolvedValue(undefined);
    await redriveRound2Outbox({
      ...runtime(),
      DELIVERY_QUEUE: { send },
      SLACK_CHANNEL_VALIDATION_ENABLED: "false",
    } as unknown as Env);
    expect(send).not.toHaveBeenCalled();
    await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT slack_redrive_count FROM outbox WHERE id='outbox:digest'").first()).toEqual({
      slack_redrive_count: 1,
    });
  });
});

describe("review delivery regressions", () => {
  it("bounds candidate work and advances a paused backlog fairly before enqueueing at most 50 receipts", async () => {
    const paused = await mapping();
    await page();
    const active = await upsertSlackChannelSubscription(runtime(), owner, {
      spaceId: "workspace-general",
      pageId: "page",
      channelId: "C123",
      channelName: "notes",
      eventTypes: [...CHANNEL_EVENT_TYPES],
      cadence: "digest",
    });
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='no_permission' WHERE id=?",
    )
      .bind(paused.id)
      .run();
    await env.DB.batch(
      Array.from({ length: 270 }, (_, n) => {
        const id = `bounded-${String(n).padStart(3, "0")}`;
        return [
          env.DB.prepare(
            "INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,created_at) VALUES(?,'installation',1,?,0,?,'C123',1)",
          ).bind(id, n < 210 ? paused.id : active.id, n + 1),
          env.DB.prepare(
            "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES(?,'workspace','slack_digest',json_object('digestId',?),1,1,1,1,3)",
          ).bind(`outbox:${id}`, id),
        ];
      }).flat(),
    );
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT count(*) n FROM outbox WHERE slack_redrive_due_at=1").first()).toEqual({
      n: 70,
    });
    expect(await env.DB.prepare("SELECT min(slack_redrive_count) n FROM outbox").first()).toEqual({ n: 3 });
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(50);
    expect(send.mock.calls[0]).toEqual([{ outboxId: "outbox:bounded-210" }]);
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(60);
    expect(await env.DB.prepare("SELECT count(*) n FROM outbox WHERE slack_redrive_due_at=1").first()).toEqual({
      n: 0,
    });
    await wakeRound2Mapping(bindings, paused.id);
    expect(await env.DB.prepare("SELECT count(*) n FROM outbox WHERE enqueued_at IS NULL").first()).toEqual({ n: 0 });
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=NULL,notification_error=NULL WHERE id=?",
    )
      .bind(paused.id)
      .run();
    await wakeRound2Mapping(bindings, paused.id);
    expect(await env.DB.prepare("SELECT count(*) n FROM outbox WHERE enqueued_at IS NULL").first()).toEqual({ n: 210 });
  });

  it.each(["not JSON", "{}", '{"digestId":4}', '{"digestId":[]}', '{"digestId":""}'])(
    "retains malformed payload evidence without enqueueing: %s",
    async (payload) => {
      await env.DB.prepare(
        "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_claim_recheck_at) VALUES('malformed','workspace','slack_digest',?,1,1,1,1,1)",
      )
        .bind(payload)
        .run();
      const send = vi.fn();
      await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
      expect(send).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare(
          "SELECT payload_json,last_error,slack_redrive_due_at,slack_claim_recheck_at FROM outbox WHERE id='malformed'",
        ).first(),
      ).toEqual({
        payload_json: payload,
        last_error: "invalid_round2_payload",
        slack_redrive_due_at: null,
        slack_claim_recheck_at: null,
      });
    },
  );

  it("wakes pending work despite unrelated malformed payloads", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at) VALUES('safe','workspace','slack_digest',json_object('digestId',?),1,1,1,9999999999999)",
      ).bind(r.id),
      env.DB.prepare(
        "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at) VALUES('bad','workspace','slack_digest','not JSON',1,1)",
      ),
    ]);
    await wakeRound2Mapping(runtime(), m.id);
    expect(await env.DB.prepare("SELECT enqueued_at,slack_redrive_due_at FROM outbox WHERE id='safe'").first()).toEqual(
      { enqueued_at: null, slack_redrive_due_at: null },
    );
    expect(await env.DB.prepare("SELECT payload_json FROM outbox WHERE id='bad'").first()).toEqual({
      payload_json: "not JSON",
    });
  });

  it("keeps legacy recovery running after the round-two candidate query fails", async () => {
    await env.DB.prepare(
      "INSERT INTO slack_interaction_receipts(id,installation_id,interaction_id,callback_id,received_at,response_delivery_state,response_delivery_attempted_at) VALUES('legacy','installation','legacy-interaction','callback',1,'sending',1)",
    ).run();
    const database = {
      prepare(sql: string) {
        if (sql.startsWith("WITH regular AS")) throw new Error("Round-two query failed");
        return env.DB.prepare(sql);
      },
    } as Env["DB"];
    await redriveStaleSlackOutbox({ ...runtime(), DB: database });
    expect(
      await env.DB.prepare(
        "SELECT response_delivery_state,response_delivery_error FROM slack_interaction_receipts WHERE id='legacy'",
      ).first(),
    ).toEqual({ response_delivery_state: "blocked", response_delivery_error: "send_unconfirmed" });
  });
  it.each([0, 3, 10, 11])("limits unchanged reminders to the first partition with %i changes", async (changed) => {
    const m = await mapping();
    const r = await receipt(m.id);
    for (let n = 0; n < (changed === 0 ? 95 : 25); n++) {
      await page(`open-${String(n).padStart(2, "0")}`);
      await thread(`open-${String(n).padStart(2, "0")}`, `thread-${n}`);
    }
    for (let n = 0; n < changed; n++) {
      await page(`changed-${n}`);
      await event(m.id, `changed-${n}`, r.window_start + n + 1);
    }
    for (let n = 0; n < Math.max(1, Math.ceil(changed / 10)); n++) await deliverDigest(runtime(), r.id);
    const parts = (
      await env.DB.prepare(
        "SELECT page_ids_json,event_ids_json FROM slack_digest_messages WHERE receipt_id=? ORDER BY sequence",
      )
        .bind(r.id)
        .all<{ page_ids_json: string; event_ids_json: string }>()
    ).results;
    expect(parts.map((part) => JSON.parse(part.page_ids_json).length)).toEqual(changed > 10 ? [10, 1] : [10]);
    expect(parts.flatMap((part) => JSON.parse(part.event_ids_json))).toHaveLength(changed);
    expect(
      parts.slice(1).every((part) => JSON.parse(part.page_ids_json).every((id: string) => id.startsWith("changed-"))),
    ).toBe(true);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(parts.length);
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "sent",
    });
  });

  it("freezes first-message reminders across retries and excludes them from late partitions", async () => {
    const m = await mapping();
    for (let n = 0; n < 12; n++) {
      await page(`open-${n}`);
      await thread(`open-${n}`, `thread-${n}`);
    }
    await dueRound2Digests(runtime());
    const r = (await env.DB.prepare("SELECT * FROM slack_digest_receipts WHERE subscription_id=?")
      .bind(m.id)
      .first<DigestReceipt>())!;
    responses["chat.postMessage"] = new Response("limited", { status: 429, headers: { "Retry-After": "1" } });
    await expect(deliverDigest(runtime(), r.id)).rejects.toMatchObject({ retryAfter: 1 });
    const frozen = await env.DB.prepare(
      "SELECT page_ids_json,event_ids_json FROM slack_digest_messages WHERE receipt_id=? AND sequence=0",
    )
      .bind(r.id)
      .first();
    await page("aaa-new");
    await thread("aaa-new", "new-thread");
    responses["chat.postMessage"] = { ok: true, ts: "999.001" };
    await deliverDigest(runtime(), r.id);
    expect(
      await env.DB.prepare(
        "SELECT page_ids_json,event_ids_json FROM slack_digest_messages WHERE receipt_id=? AND sequence=0",
      )
        .bind(r.id)
        .first(),
    ).toEqual(frozen);
    await event(m.id, "aaa-new", r.window_start + 100, "page_edit", "late-with-reminders");
    await dueRound2Digests(runtime());
    await deliverDigest(runtime(), r.id);
    expect(
      await env.DB.prepare(
        "SELECT page_ids_json,event_ids_json FROM slack_digest_messages WHERE receipt_id=? AND sequence=1",
      )
        .bind(r.id)
        .first(),
    ).toEqual({ page_ids_json: '["aaa-new"]', event_ids_json: '["late-with-reminders"]' });
  });

  it("does not reset pending digest backoff or retry counts on scheduler ticks", async () => {
    const m = await mapping();
    await page();
    await dueRound2Digests(runtime());
    const queued = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_digest'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=123,available_at=?,slack_redrive_due_at=?,slack_redrive_count=8 WHERE id=?",
    )
      .bind(Date.now() + 600_000, Date.now() + 600_000, queued.id)
      .run();
    const before = await env.DB.prepare("SELECT * FROM outbox WHERE id=?").bind(queued.id).first();
    await dueRound2Digests(runtime());
    await dueRound2Digests(runtime());
    expect(await env.DB.prepare("SELECT * FROM outbox WHERE id=?").bind(queued.id).first()).toEqual(before);
    expect(m.id).toBeTruthy();
  });

  it("acknowledges suppressed pending events without recurring redrive", async () => {
    const m = await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events WHERE subscription_id=?")
      .bind(m.id)
      .first<{ id: string }>())!;
    await env.DB.prepare("UPDATE slack_channel_events SET suppressed_at=1 WHERE id=?").bind(e.id).run();
    expect(await round2DeliveryOutcome(runtime(), "slack_channel", e.id)).toBe("completed");
    const ack = vi.fn();
    await consumeDeliveryMessage(runtime(), {
      body: { outboxId: `outbox:${e.id}` },
      ack,
      retry: vi.fn(),
    } as unknown as Message<{ outboxId: string }>);
    expect(ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT slack_redrive_due_at FROM outbox WHERE id=?").bind(`outbox:${e.id}`).first(),
    ).toEqual({ slack_redrive_due_at: null });
    const send = vi.fn();
    await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["mute", "snooze", "unmute", "repair"] as const)(
    "completes definitely unsent events suppressed by %s",
    async (mode) => {
      const m = await mapping("immediate");
      await page();
      const e = (await env.DB.prepare("SELECT id FROM slack_channel_events WHERE subscription_id=?")
        .bind(m.id)
        .first<{ id: string }>())!;
      if (mode === "unmute") await setSlackChannelPause(runtime(), owner, m.id, "mute");
      if (mode === "repair") {
        await env.DB.prepare(
          "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='no_permission' WHERE id=?",
        )
          .bind(m.id)
          .run();
        await repairSlackChannelNotifications(runtime(), owner, m.id);
      } else await setSlackChannelPause(runtime(), owner, m.id, mode, mode === "snooze" ? 1 : undefined);
      expect(await round2DeliveryOutcome(runtime(), "slack_channel", e.id)).toBe("completed");
      await env.DB.prepare("UPDATE outbox SET enqueued_at=1,slack_redrive_due_at=1 WHERE id=?")
        .bind(`outbox:${e.id}`)
        .run();
      const send = vi.fn();
      for (let tick = 0; tick < 3; tick++)
        await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
      expect(send).not.toHaveBeenCalledWith({ outboxId: `outbox:${e.id}` });
      expect(
        await env.DB.prepare("SELECT slack_redrive_due_at FROM outbox WHERE id=?").bind(`outbox:${e.id}`).first(),
      ).toEqual({ slack_redrive_due_at: null });
    },
  );

  it("reconciles a suppressed uncertain send without posting again", async () => {
    const m = await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events WHERE subscription_id=?")
      .bind(m.id)
      .first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE slack_channel_events SET round2_state='sending',attempted_at=?,suppressed_at=1 WHERE id=?",
    )
      .bind(Date.now(), e.id)
      .run();
    responses["conversations.history"] = {
      ok: true,
      messages: [{ ts: "999.001", user: "B123", metadata: { event_payload: { delivery_id: `channel:${e.id}` } } }],
    };
    await deliverRound2ChannelEvent(runtime(), e.id);
    expect(await round2DeliveryOutcome(runtime(), "slack_channel", e.id)).toBe("completed");
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT round2_state,suppressed_at,message_ts FROM slack_channel_events WHERE id=?")
        .bind(e.id)
        .first(),
    ).toEqual({ round2_state: "sent", suppressed_at: 1, message_ts: "999.001" });
  });

  it("wakes retained pending digests only after verified destination recovery", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    await env.DB.prepare(
      "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES('outbox:wake','workspace','slack_digest',json_object('digestId',?),1,1,1,?,7)",
    )
      .bind(r.id, Date.now() + 600_000)
      .run();
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='msg_too_long' WHERE id=?",
    )
      .bind(m.id)
      .run();
    await reconcileRound2Mapping(runtime(), m.id);
    expect(await env.DB.prepare("SELECT enqueued_at FROM outbox WHERE id='outbox:wake'").first()).toEqual({
      enqueued_at: 1,
    });
    await validateMapping(runtime(), (await round2Installation(runtime(), "installation"))!, m.id, m.channelId);
    expect(
      await env.DB.prepare(
        "SELECT enqueued_at,slack_redrive_due_at,slack_redrive_count FROM outbox WHERE id='outbox:wake'",
      ).first(),
    ).toEqual({ enqueued_at: null, slack_redrive_due_at: null, slack_redrive_count: 7 });
  });
  it("preserves live sending claims during owner recovery", async () => {
    const m = await mapping("immediate");
    await page();
    const r = await receipt(m.id);
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events WHERE subscription_id=?")
      .bind(m.id)
      .first<{ id: string }>())!;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE slack_digest_receipts SET state='sending',attempted_at=?,claim_token='live-digest',claimed_at=? WHERE id=?",
      ).bind(Date.now(), Date.now(), r.id),
      env.DB.prepare(
        "UPDATE slack_channel_events SET round2_state='sending',attempted_at=?,claim_token='live-event',claimed_at=? WHERE id=?",
      ).bind(Date.now(), Date.now(), e.id),
    ]);
    calls = [];
    await reconcileRound2Mapping(runtime(), m.id);
    expect(calls).toEqual([]);
    expect(
      await env.DB.prepare("SELECT state,claim_token FROM slack_digest_receipts WHERE id=?").bind(r.id).first(),
    ).toEqual({ state: "sending", claim_token: "live-digest" });
    expect(
      await env.DB.prepare("SELECT round2_state,claim_token FROM slack_channel_events WHERE id=?").bind(e.id).first(),
    ).toEqual({ round2_state: "sending", claim_token: "live-event" });
  });

  it("does not let paused and blocked receipts consume the runnable batch", async () => {
    const paused = await mapping();
    await page();
    const active = await upsertSlackChannelSubscription(runtime(), owner, {
      spaceId: "workspace-general",
      pageId: "page",
      channelId: "C123",
      channelName: "canonical-notes",
      cadence: "digest",
      eventTypes: [...CHANNEL_EVENT_TYPES],
    });
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='no_permission' WHERE id=?",
    )
      .bind(paused.id)
      .run();
    for (let n = 0; n < 111; n++) {
      const id = `batch-${n}`;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,state,created_at) VALUES(?,'installation',1,?,0,?,'C123',?,1)",
        ).bind(id, n < 55 ? paused.id : active.id, n + 1, n >= 55 && n < 110 ? "blocked" : "pending"),
        env.DB.prepare(
          "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at) VALUES(?,'workspace','slack_digest',json_object('digestId',?),1,1,1,1)",
        ).bind(`outbox:${id}`, id),
      ]);
    }
    const send = vi.fn();
    await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(send).toHaveBeenCalledExactlyOnceWith({ outboxId: "outbox:batch-110" });
  });
  it.each(["slack_bulk", "slack_file_upload"] as const)(
    "preserves blocked %s work during queue consumption",
    async (topic) => {
      const m = await mapping();
      await page("page", { kind: "diagram" });
      let id: string;
      if (topic === "slack_file_upload") {
        await env.DB.prepare(
          "INSERT INTO diagram_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,thumbnail_r2_key,thumbnail_hash,thumbnail_byte_size,updated_at) VALUES('page',1,1,1,'diagram-key','hash',1,'thumbnail-key','pause-hash',1,1)",
        ).run();
        id = (await env.DB.prepare("SELECT id FROM slack_file_artifacts WHERE page_id='page'").first<{ id: string }>())!
          .id;
      } else {
        await page("second");
        await env.DB.batch([
          activityMutationStart(env.DB, "SELECT id FROM pages", [], "paused-bulk", "archive"),
          env.DB.prepare("UPDATE pages SET archived_at=1,archived_by='owner'"),
          activityMutationEnd(env.DB, "paused-bulk"),
        ]);
        id = (await env.DB.prepare("SELECT id FROM slack_bulk_receipts").first<{ id: string }>())!.id;
      }
      await env.DB.prepare(
        "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='no_permission' WHERE id=?",
      )
        .bind(m.id)
        .run();
      const ack = vi.fn();
      await consumeDeliveryMessage(runtime(), {
        body: { outboxId: `outbox:${id}` },
        ack,
        retry: vi.fn(),
      } as unknown as Message<{ outboxId: string }>);
      expect(ack).toHaveBeenCalledOnce();
      expect(await round2DeliveryOutcome(runtime(), topic, id)).toBe("paused");
      expect(
        await env.DB.prepare(
          `SELECT state FROM ${topic === "slack_bulk" ? "slack_bulk_receipts" : "slack_file_artifacts"} WHERE id=?`,
        )
          .bind(id)
          .first(),
      ).toEqual({ state: "pending" });
      expect(
        calls.filter((c) => c.method === "files.getUploadURLExternal" || c.method === "chat.postMessage"),
      ).toHaveLength(0);
    },
  );

  it("retires exhausted unsent partitions but preserves uncertain and claimed work", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    await page();
    await env.DB.prepare(
      "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES('outbox:cap','workspace','slack_digest',json_object('digestId',?),1,1,1,1,8)",
    )
      .bind(r.id)
      .run();
    await env.DB.prepare("UPDATE slack_digest_receipts SET claim_token='live',claimed_at=? WHERE id=?")
      .bind(Date.now(), r.id)
      .run();
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(await round2DeliveryOutcome(bindings, "slack_digest", r.id)).toBe("competing");
    await env.DB.prepare("UPDATE slack_digest_receipts SET state='sending',attempted_at=NULL,claimed_at=1 WHERE id=?")
      .bind(r.id)
      .run();
    await redriveRound2Outbox(bindings);
    expect(await round2DeliveryOutcome(bindings, "slack_digest", r.id)).toBe("uncertain");
    await env.DB.prepare("UPDATE slack_digest_receipts SET state='pending',claim_token=NULL,claimed_at=NULL WHERE id=?")
      .bind(r.id)
      .run();
    await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=1 WHERE id='outbox:cap'").run();
    await redriveRound2Outbox(bindings);
    expect(send).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT state,last_error FROM slack_digest_receipts WHERE id=?").bind(r.id).first(),
    ).toEqual({ state: "retired", last_error: "redrive_exhausted" });
    expect(
      await env.DB.prepare("SELECT reason FROM slack_delivery_failures WHERE subscription_id=?").bind(m.id).first(),
    ).toEqual({ reason: "redrive_exhausted" });
  });

  it("caps successful redrive enqueues at eight despite repeated digest scheduling", async () => {
    await mapping();
    await page();
    await dueRound2Digests(runtime());
    const queued = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_digest'").first<{ id: string }>())!;
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    for (let tick = 0; tick < 11; tick++) {
      await env.DB.prepare("UPDATE outbox SET enqueued_at=1,slack_redrive_due_at=1 WHERE id=?").bind(queued.id).run();
      await dueRound2Digests(bindings);
      await redriveRound2Outbox(bindings);
    }
    expect(send).toHaveBeenCalledTimes(8);
    expect(
      await env.DB.prepare("SELECT slack_redrive_count,slack_redrive_due_at FROM outbox WHERE id=?")
        .bind(queued.id)
        .first(),
    ).toEqual({ slack_redrive_count: 8, slack_redrive_due_at: null });
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts").first()).toEqual({ state: "retired" });
  });
  it("bounds exhausted-receipt cleanup and leaves later receipts due for the next pass", async () => {
    const m = await mapping();
    await env.DB.batch(
      Array.from({ length: 60 }, (_, n) => {
        const id = `exhausted-${String(n).padStart(2, "0")}`;
        return [
          env.DB.prepare(
            "INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,created_at) VALUES(?,'installation',1,?,0,?,'C123',1)",
          ).bind(id, m.id, n + 1),
          env.DB.prepare(
            "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES(?,'workspace','slack_digest',json_object('digestId',?),1,1,1,1,8)",
          ).bind(`outbox:${id}`, id),
        ];
      }).flat(),
    );
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_digest_receipts WHERE state='retired'").first()).toEqual({
      n: 50,
    });
    expect(await env.DB.prepare("SELECT count(*) n FROM outbox WHERE slack_redrive_due_at=1").first()).toEqual({
      n: 10,
    });
    await redriveRound2Outbox(bindings);
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_digest_receipts WHERE state='retired'").first()).toEqual({
      n: 60,
    });
    expect(
      await env.DB.prepare("SELECT count(*) n FROM slack_delivery_failures WHERE reason='redrive_exhausted'").first(),
    ).toEqual({ n: 60 });
    expect(send).not.toHaveBeenCalled();
  });

  it("shares a digest receipt's retry budget across continuation outbox rows", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    await env.DB.batch(
      Array.from({ length: 60 }, (_, n) =>
        env.DB.prepare(
          "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES(?,'workspace','slack_digest',json_object('digestId',?),1,1,1,1,?)",
        ).bind(`outbox:duplicate-${n}`, r.id, n === 0 ? 7 : 0),
      ),
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledOnce();
    expect(
      (
        await env.DB.prepare("SELECT slack_redrive_count FROM outbox WHERE topic='slack_digest'").all<{
          slack_redrive_count: number;
        }>()
      ).results.every((row) => row.slack_redrive_count === 8),
    ).toBe(true);
    await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=1 WHERE topic='slack_digest'").run();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "retired",
    });
    await redriveRound2Outbox(bindings);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM outbox WHERE slack_redrive_due_at IS NOT NULL").first(),
    ).toEqual({ n: 0 });
  });

  it("preserves redrive backoff when a queue acknowledgement finds a live claim", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    const due = Date.now() + 6 * 60 * 60_000;
    await env.DB.batch([
      env.DB.prepare("UPDATE slack_digest_receipts SET claim_token='live',claimed_at=? WHERE id=?").bind(
        Date.now(),
        r.id,
      ),
      env.DB.prepare(
        "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES('outbox:backoff','workspace','slack_digest',json_object('digestId',?),1,1,1,?,4)",
      ).bind(r.id, due),
    ]);
    const ack = vi.fn();
    await consumeDeliveryMessage(runtime(), {
      body: { outboxId: "outbox:backoff" },
      ack,
      retry: vi.fn(),
    } as unknown as Message<{ outboxId: string }>);
    expect(ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT slack_redrive_due_at,slack_redrive_count FROM outbox WHERE id='outbox:backoff'",
      ).first(),
    ).toEqual({ slack_redrive_due_at: due, slack_redrive_count: 4 });
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(send).not.toHaveBeenCalled();
    await env.DB.batch([
      env.DB.prepare("UPDATE slack_digest_receipts SET claimed_at=1 WHERE id=?").bind(r.id),
      env.DB.prepare("UPDATE outbox SET slack_claim_recheck_at=1 WHERE id='outbox:backoff'"),
    ]);
    send.mockRejectedValueOnce(new Error("Queue unavailable"));
    await redriveRound2Outbox(bindings);
    expect(
      await env.DB.prepare(
        "SELECT slack_redrive_due_at,slack_redrive_count,slack_claim_recheck_at FROM outbox WHERE id='outbox:backoff'",
      ).first(),
    ).toEqual({ slack_redrive_due_at: due, slack_redrive_count: 4, slack_claim_recheck_at: expect.any(Number) });
    send.mockClear();
    await env.DB.prepare("UPDATE outbox SET slack_claim_recheck_at=1 WHERE id='outbox:backoff'").run();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledExactlyOnceWith({ outboxId: "outbox:backoff" });
    expect(
      await env.DB.prepare(
        "SELECT slack_redrive_count,slack_claim_recheck_at FROM outbox WHERE id='outbox:backoff'",
      ).first(),
    ).toEqual({ slack_redrive_count: 5, slack_claim_recheck_at: null });
  });

  it.each(["channel", "bulk"])("fails an oversized %s delivery without blocking independent posts", async (kind) => {
    const m = await mapping("immediate");
    await page("oversize-one");
    if (kind === "bulk") {
      await page("oversize-two");
      await env.DB.batch([
        activityMutationStart(env.DB, "SELECT id FROM pages", [], "oversized-bulk", "archive"),
        env.DB.prepare("UPDATE pages SET archived_at=?,archived_by='owner'").bind(Date.now()),
        activityMutationEnd(env.DB, "oversized-bulk"),
      ]);
    }
    const row = (await env.DB.prepare(
      kind === "bulk"
        ? "SELECT id FROM slack_bulk_receipts"
        : "SELECT id FROM slack_channel_events WHERE page_id='oversize-one'",
    ).first<{ id: string }>())!;
    responses["chat.postMessage"] = { ok: false, error: "msg_too_long" };
    if (kind === "bulk") await deliverBulkSummary(runtime(), row.id);
    else await deliverRound2ChannelEvent(runtime(), row.id);
    expect(await round2DeliveryOutcome(runtime(), kind === "bulk" ? "slack_bulk" : "slack_channel", row.id)).toBe(
      "completed",
    );
    expect(
      await env.DB.prepare("SELECT notification_blocked_at FROM slack_channel_subscriptions WHERE id=?")
        .bind(m.id)
        .first(),
    ).toEqual({ notification_blocked_at: null });
    responses["chat.postMessage"] = { ok: true, ts: "999.002" };
    await page("independent-post");
    const next = (await env.DB.prepare("SELECT id FROM slack_channel_events WHERE page_id='independent-post'").first<{
      id: string;
    }>())!;
    await deliverRound2ChannelEvent(runtime(), next.id);
    expect(await round2DeliveryOutcome(runtime(), "slack_channel", next.id)).toBe("completed");
    expect(
      await env.DB.prepare("SELECT reason FROM slack_delivery_failures WHERE subscription_id=?").bind(m.id).first(),
    ).toEqual({ reason: "msg_too_long" });
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2);
  });

  it("fails an oversized digest partition independently and resets redrive on subsequent confirmed progress", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    for (let n = 0; n < 11; n++) {
      await page(`size-${n}`);
      await event(m.id, `size-${n}`, r.window_start + n + 1);
    }
    responses["chat.postMessage"] = { ok: false, error: "msg_too_long" };
    await deliverDigest(runtime(), r.id);
    expect(
      await env.DB.prepare("SELECT notification_error FROM slack_channel_subscriptions WHERE id=?").bind(m.id).first(),
    ).toEqual({ notification_error: null });
    expect(
      await env.DB.prepare("SELECT state FROM slack_digest_messages WHERE receipt_id=? AND sequence=0")
        .bind(r.id)
        .first(),
    ).toEqual({ state: "retired" });
    expect(
      await env.DB.prepare("SELECT delivery_id FROM slack_delivery_failures WHERE subscription_id=?")
        .bind(m.id)
        .first(),
    ).toEqual({ delivery_id: r.id });
    await env.DB.prepare("UPDATE outbox SET slack_redrive_count=7 WHERE topic='slack_digest'").run();
    responses["chat.postMessage"] = { ok: true, ts: "999.001" };
    await deliverDigest(runtime(), r.id);
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "sent",
    });
    expect(
      (
        await env.DB.prepare("SELECT slack_redrive_count FROM outbox WHERE topic='slack_digest'").all<{
          slack_redrive_count: number;
        }>()
      ).results.every((row) => row.slack_redrive_count === 0),
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT reason FROM slack_delivery_failures WHERE subscription_id=?").bind(m.id).first(),
    ).toEqual({ reason: "msg_too_long" });
  });
  it("migrates pending partitions while preserving historical receipts and private artifacts", async () => {
    await reset();
    const migrations = env.TEST_MIGRATIONS!;
    await applyD1Migrations(
      env.DB,
      migrations.filter((migration) => migration.name < "0067"),
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
        "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at,generation) VALUES('installation','workspace','T123','Slack','B123',?,'chat:write,channels:read','owner',1,1,1)",
      ).bind(await encryptSlackToken(runtime(), "xoxb-test-token")),
      env.DB.prepare(
        "INSERT INTO slack_channel_subscriptions(id,installation_id,space_id,channel_id,channel_name,event_types_json,cadence,created_by,created_at,updated_at) VALUES('migrate-map','installation','workspace-general','C123','notes','[\"page_edit\"]','digest','owner',1,1)",
      ),
    ]);
    for (let n = 0; n < 11; n++) {
      await page(`migrate-${n}`);
      await event("migrate-map", `migrate-${n}`, 100 + n, "page_edit", `migrate-event-${n}`);
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,state,created_at) VALUES('pending-old','installation',1,'migrate-map',1,200,'C123','pending',1),('uncertain-old','installation',1,'migrate-map',200,300,'C123','sending',1),('sent-old','installation',1,'migrate-map',300,400,'C123','sent',1)",
      ),
      env.DB.prepare(
        "INSERT INTO slack_file_artifacts(id,installation_id,installation_generation,page_id,content_epoch,content_sha256,thumbnail_r2_key,slack_file_id,state,created_at,updated_at) VALUES('kept-file','installation',1,'migrate-0',1,'hash','thumbnail-key','FEXISTING','uploaded',1,1)",
      ),
    ]);
    await applyD1Migrations(
      env.DB,
      migrations.filter((migration) => migration.name >= "0067"),
    );
    const messages = (
      await env.DB.prepare("SELECT receipt_id,page_ids_json,event_ids_json FROM slack_digest_messages").all<{
        receipt_id: string;
        page_ids_json: string;
        event_ids_json: string;
      }>()
    ).results;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.receipt_id).toBe("pending-old");
    expect(JSON.parse(messages[0]!.page_ids_json)).toHaveLength(10);
    expect(JSON.parse(messages[0]!.event_ids_json)).toHaveLength(10);
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id='uncertain-old'").first()).toEqual({
      state: "sending",
    });
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id='sent-old'").first()).toEqual({
      state: "sent",
    });
    expect(
      await env.DB.prepare("SELECT state,slack_file_id FROM slack_file_artifacts WHERE id='kept-file'").first(),
    ).toEqual({ state: "uploaded", slack_file_id: "FEXISTING" });
  });
  it("reconciles legacy uncertainty with its original ID before scheduling the remaining pages", async () => {
    const m = await mapping();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    const r = await receipt(m.id);
    const ids: string[] = [];
    for (let n = 0; n < 11; n++) {
      await page(`legacy-${n}`);
      ids.push(`legacy-event-${n}`);
      await event(m.id, `legacy-${n}`, r.window_start + 1000 + n, "page_edit", ids.at(-1));
    }
    await env.DB.prepare("UPDATE slack_digest_receipts SET state='sending',attempted_at=?,event_ids_json=? WHERE id=?")
      .bind(Date.now(), JSON.stringify(ids), r.id)
      .run();
    responses["conversations.history"] = {
      ok: true,
      messages: [{ ts: "999.001", user: "B123", metadata: { event_payload: { delivery_id: r.id } } }],
    };
    await deliverDigest(runtime(), r.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM slack_channel_events WHERE delivered_at IS NOT NULL").first(),
    ).toEqual({ n: 10 });
    await deliverDigest(runtime(), r.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "sent",
    });
  });

  it.each([0, 10, 11, 25])("covers %i changed pages with messages of at most ten pages", async (count) => {
    const m = await mapping();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    const r = await receipt(m.id);
    for (let n = 0; n < count; n++) {
      const id = `partition-${String(n).padStart(2, "0")}`;
      await page(id);
      await event(m.id, id, r.window_start + 1000 + n, "page_edit", `partition-event-${n}`);
    }
    for (let n = 0; n < Math.max(1, Math.ceil(count / 10)); n++) await deliverDigest(runtime(), r.id);
    const parts = (
      await env.DB.prepare(
        "SELECT state,page_ids_json,event_ids_json FROM slack_digest_messages WHERE receipt_id=? ORDER BY sequence",
      )
        .bind(r.id)
        .all<{ state: string; page_ids_json: string; event_ids_json: string }>()
    ).results;
    expect(parts).toHaveLength(Math.ceil(count / 10));
    expect(parts.every((part) => part.state === "sent" && JSON.parse(part.page_ids_json).length <= 10)).toBe(true);
    expect(parts.flatMap((part) => JSON.parse(part.event_ids_json))).toHaveLength(count);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(Math.ceil(count / 10));
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM slack_channel_events WHERE cadence='digest' AND delivered_at IS NOT NULL",
      ).first(),
    ).toEqual({ n: count });
  });
  it("preserves completed partitions through a rate-limit retry and appends late events", async () => {
    const m = await mapping();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    const r = await receipt(m.id);
    for (let n = 0; n < 11; n++) {
      await page(`partial-${n}`);
      await event(m.id, `partial-${n}`, r.window_start + 1000 + n, "page_edit", `partial-event-${n}`);
    }
    await deliverDigest(runtime(), r.id);
    const completed = await env.DB.prepare(
      "SELECT page_ids_json,event_ids_json FROM slack_digest_messages WHERE receipt_id=? AND sequence=0",
    )
      .bind(r.id)
      .first();
    responses["chat.postMessage"] = new Response("limited", { status: 429, headers: { "Retry-After": "1" } });
    await expect(deliverDigest(runtime(), r.id)).rejects.toMatchObject({ retryAfter: 1 });
    responses["chat.postMessage"] = { ok: true, ts: "999.002" };
    await deliverDigest(runtime(), r.id);
    await page("late");
    await event(m.id, "late", r.window_start + 1500, "page_edit", "late-event");
    await dueRound2Digests(runtime()); // The scheduler ID differs from this hand-built receipt.
    await env.DB.prepare("UPDATE slack_digest_receipts SET state='pending' WHERE id=?").bind(r.id).run();
    await deliverDigest(runtime(), r.id);
    expect(
      await env.DB.prepare(
        "SELECT page_ids_json,event_ids_json FROM slack_digest_messages WHERE receipt_id=? AND sequence=0",
      )
        .bind(r.id)
        .first(),
    ).toEqual(completed);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM slack_digest_messages WHERE receipt_id=? AND state='sent'")
        .bind(r.id)
        .first(),
    ).toEqual({ n: 3 });
  });
  it("never posts after its claim is stolen during channel validation", async () => {
    await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("conversations.info"))
        await env.DB.prepare("UPDATE slack_channel_events SET claim_token='competitor' WHERE id=?").bind(e.id).run();
      return remote(input, init);
    });
    await expect(deliverRound2ChannelEvent(runtime(), e.id)).rejects.toThrow("Delivery is already in progress");
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    expect(await env.DB.prepare("SELECT claim_token FROM slack_channel_events WHERE id=?").bind(e.id).first()).toEqual({
      claim_token: "competitor",
    });
  });
  it("rechecks Activity permissions after a remote channel lookup", async () => {
    await mapping("immediate");
    await page();
    const queued = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
    await env.DB.prepare("UPDATE workspace_members SET role='owner' WHERE user_id='viewer'").run();
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("conversations.info"))
        await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='owner'").run();
      return remote(input, init);
    });
    await expect(deliverRound2ChannelEvent(runtime(), queued.id)).rejects.toBeInstanceOf(StaleSlackValidationError);
    await deliverRound2ChannelEvent(runtime(), queued.id);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
  });
  it("acknowledges a competing queue attempt while preserving continuation", async () => {
    await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
    await env.DB.prepare("UPDATE slack_channel_events SET claim_token='busy',claimed_at=? WHERE id=?")
      .bind(Date.now(), e.id)
      .run();
    const outbox = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    const ack = vi.fn(),
      retry = vi.fn();
    await consumeDeliveryMessage(runtime(), {
      body: { outboxId: outbox.id },
      ack,
      retry,
      attempts: 1,
    } as unknown as Message<{ outboxId: string }>);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT slack_claim_recheck_at FROM outbox WHERE id=?").bind(outbox.id).first(),
    ).toEqual({
      slack_claim_recheck_at: expect.any(Number),
    });
  });
  it.each(["not_in_channel", "channel_not_found"])(
    "retires a definite %s rejection without ambiguous recovery",
    async (code) => {
      await mapping("immediate");
      await page();
      const e = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
      responses["chat.postMessage"] = { ok: false, error: code };
      await deliverRound2ChannelEvent(runtime(), e.id);
      expect(
        await env.DB.prepare("SELECT round2_state FROM slack_channel_events WHERE id=?").bind(e.id).first(),
      ).toEqual({ round2_state: "retired" });
      expect(calls.filter((call) => call.method === "conversations.history")).toHaveLength(0);
    },
  );
  it("records authentication errors and pauses missing-scope work", async () => {
    await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
    responses["chat.postMessage"] = { ok: false, error: "token_revoked" };
    await expect(deliverRound2ChannelEvent(runtime(), e.id)).rejects.toMatchObject({ code: "token_revoked" });
    expect(await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first()).toEqual({
      auth_error: "token_revoked",
    });
    expect(
      await env.DB.prepare("SELECT round2_state,attempted_at FROM slack_channel_events WHERE id=?").bind(e.id).first(),
    ).toEqual({ round2_state: "pending", attempted_at: null });
  });
  it.each(["missing_scope", "invalid_auth"])(
    "preserves an immediate event after a %s validation failure",
    async (code) => {
      await mapping("immediate");
      await page();
      const queued = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
      responses["conversations.info"] = { ok: false, error: code };
      const result = await deliverRound2ChannelEvent(runtime(), queued.id).then(
        () => null,
        (error) => ({ code: error.code }),
      );
      expect(result).toEqual({ code });
      expect(
        await env.DB.prepare("SELECT round2_state,delivered_at FROM slack_channel_events WHERE id=?")
          .bind(queued.id)
          .first(),
      ).toEqual({ round2_state: "pending", delivered_at: null });
      expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    },
  );
  it("retains a durable marker when a queue post pauses for missing scope", async () => {
    await mapping("immediate");
    await page();
    const pending = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{
      id: string;
    }>())!;
    responses["chat.postMessage"] = { ok: false, error: "missing_scope" };
    const ack = vi.fn();
    await consumeDeliveryMessage(runtime(), {
      body: { outboxId: pending.id },
      ack,
      retry: vi.fn(),
      attempts: 1,
    } as unknown as Message<{ outboxId: string }>);
    expect(ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT slack_scope_paused_at IS NOT NULL paused,slack_redrive_due_at IS NOT NULL continued FROM outbox WHERE id=?",
      )
        .bind(pending.id)
        .first(),
    ).toEqual({ paused: 1, continued: 1 });
  });
  it("isolates invalid schedules and accepts settings-only edits of legacy DM mappings", async () => {
    const good = await mapping();
    const legacy = await upsertSlackChannelSubscription(
      { ...runtime(), SLACK_CHANNEL_VALIDATION_ENABLED: "false" },
      owner,
      {
        spaceId: "workspace-general",
        pageId: null,
        channelId: "D123",
        channelName: "DM",
        eventTypes: ["task_assigned"],
        cadence: "digest",
      },
    );
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET digest_time='25:00',digest_timezone='America/Chicago',round2_initialized=1 WHERE id=?",
    )
      .bind(legacy.id)
      .run();
    await dueRound2Digests(runtime());
    expect(
      await env.DB.prepare("SELECT count(*) n FROM slack_digest_receipts WHERE subscription_id=?")
        .bind(good.id)
        .first(),
    ).toEqual({ n: 1 });
    const saved = await upsertSlackChannelSubscription(runtime(), owner, {
      spaceId: "workspace-general",
      pageId: null,
      channelId: "D123",
      channelName: "DM",
      eventTypes: ["task_assigned"],
      cadence: "immediate",
      mappingId: legacy.id,
      digestTime: "09:00",
    });
    expect(saved.eventTypes).toEqual(["task_assigned"]);
  });
  it("fences a validation result from an installation reconnected during lookup", async () => {
    const m = await mapping();
    const installation = (await round2Installation(runtime(), "installation"))!;
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      await env.DB.prepare("UPDATE slack_installations SET generation=2 WHERE id='installation'").run();
      return remote(input, init);
    });
    await expect(validateMapping(runtime(), installation, m.id, "C123")).rejects.toBeInstanceOf(
      StaleSlackValidationError,
    );
  });
  it("records import Activity without Slack events and rolls mutation context back on failure", async () => {
    await mapping("immediate");
    await page("import-one", { staged: "import-job" });
    await page("import-two", { staged: "import-job" });
    const query = "SELECT id FROM pages WHERE import_job_id=?";
    await env.DB.batch([
      activityMutationStart(env.DB, query, ["import-job"], "publish-job", "import", false),
      env.DB.prepare("UPDATE pages SET import_job_id=NULL WHERE import_job_id='import-job'"),
      activityMutationEnd(env.DB, "publish-job"),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM workspace_activity WHERE operation_id='publish-job' AND source='import'",
      ).first(),
    ).toEqual({ n: 2 });
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_channel_events").first()).toEqual({ n: 0 });
    await expect(
      env.DB.batch([
        activityMutationStart(env.DB, "SELECT id FROM pages", [], "rollback", "archive"),
        env.DB.prepare("UPDATE pages SET created_by='missing-user'"),
      ]),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    expect(await env.DB.prepare("SELECT count(*) n FROM activity_mutation_context").first()).toEqual({ n: 0 });
  });
  it.each(["immediate", "digest"] as const)(
    "posts one bulk summary per channel across overlapping %s mappings without page titles",
    async (cadence) => {
      const m = await mapping(cadence);
      await page("bulk-one", { title: "Private first title" });
      await page("bulk-two", { title: "Private second title" });
      await upsertSlackChannelSubscription(runtime(), owner, {
        spaceId: "workspace-general",
        pageId: "bulk-one",
        channelId: "C123",
        channelName: "notes",
        eventTypes: ["page_archived"],
        cadence: "immediate",
      });
      calls = [];
      await env.DB.batch([
        activityMutationStart(env.DB, "SELECT id FROM pages", [], "bulk-operation", "archive"),
        env.DB.prepare("UPDATE pages SET archived_at=?,archived_by='owner'").bind(Date.now()),
        activityMutationEnd(env.DB, "bulk-operation"),
      ]);
      const summaries = (await env.DB.prepare("SELECT id FROM slack_bulk_receipts").all<{ id: string }>()).results;
      expect(summaries).toHaveLength(1);
      await deliverBulkSummary(runtime(), summaries[0]!.id);
      await deliverBulkSummary(runtime(), summaries[0]!.id);
      const posts = calls.filter((call) => call.method === "chat.postMessage");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.text).toBe("2 pages archived");
      expect(JSON.stringify(posts)).not.toContain("Private");
      expect(
        await env.DB.prepare(
          "SELECT count(*) n FROM slack_channel_events WHERE subscription_id=? AND event_type='page_archived' AND delivered_at IS NOT NULL",
        )
          .bind(m.id)
          .first(),
      ).toEqual({ n: 2 });
    },
  );
  it("keeps suppressed edits and comments without mentions out of channels and normalizes empty actors", async () => {
    await mapping("immediate");
    await page();
    await env.DB.prepare("DELETE FROM slack_channel_events").run();
    for (const [type, actor, emit] of [
      ["page_edit", "", false],
      ["mention", "owner", true],
    ] as const)
      await env.DB.batch(
        notificationFanoutStatements(env.DB, {
          workspaceId: "workspace",
          spaceId: "workspace-general",
          pageId: "page",
          threadId: null,
          actorId: actor,
          eventType: type,
          sourceId: type,
          recipientIds: [],
          emitSlackChannel: emit,
          createdAt: Date.now(),
        }),
      );
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_channel_events").first()).toEqual({ n: 0 });
    expect(
      await env.DB.prepare("SELECT actor_id FROM workspace_activity WHERE event_type='page_edit'").first(),
    ).toEqual({ actor_id: null });
  });
  it("advances failed enqueues so later work is not starved", async () => {
    const m = await mapping();
    await page();
    await env.DB.batch(
      Array.from({ length: 51 }, (_, n) => [
        env.DB.prepare(
          "INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,created_at) VALUES(?,'installation',1,?,0,?,'C123',1)",
        ).bind(`failed-receipt-${n}`, m.id, n + 1),
        env.DB.prepare(
          `INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at) VALUES(?,'workspace','slack_digest',json_object('digestId',?),1,1,1,1)`,
        ).bind(`failed-${String(n).padStart(2, "0")}`, `failed-receipt-${n}`),
      ]).flat(),
    );
    const send = vi.fn().mockRejectedValue(new Error("Queue unavailable"));
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(50);
    send.mockClear();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT max(slack_redrive_count) n FROM outbox").first()).toEqual({ n: 0 });
  });
});

describe("review follow-up permissions and recovery", () => {
  it.each([
    ['["channels:history","groups:history","im:history","mpim:history"]', "channels:history", false],
    ['["channels:history","groups:history","im:history","mpim:history"]', "groups:history", false],
    ['[["channels:read","groups:read"],["chat:write"]]', "groups:read,chat:write", false],
    ['[["channels:read","groups:read"],["chat:write"]]', "groups:read", false],
    ['["channels:read"]', "groups:read", false],
    ['["channels:read","groups:read","future:permission"]', "channels:read", false],
    ["[[]]", "chat:write,channels:read,channels:history", false],
    ["malformed", "chat:write,groups:read,groups:history", false],
    [null, "chat:write,channels:read,channels:history", false],
  ])("evaluates old and new scope clauses safely %#", async (requirements, grants, expected) => {
    await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,slack_scope_required_json)
      VALUES('requirements','workspace','slack_digest','{}',1,1,?)`)
      .bind(requirements)
      .run();
    const result = await env.DB.prepare(
      `SELECT ${slackScopesGrantedSql(SLACK_PAUSED_SCOPES_SQL, "?")} granted FROM outbox WHERE id='requirements'`,
    )
      .bind(JSON.stringify(grants.split(",")))
      .first<{ granted: number }>();
    expect(Boolean(result?.granted)).toBe(expected);
    expect(
      slackScopeRequirements("slack_digest", "conversations.history", [
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
      ]),
    ).toEqual([["channels:history"], ["groups:history"]]);
  });
  it.each(["public_channel", "private_channel", null] as const)(
    "uses the actual channel family for saved, legacy and fallback scopes: %s",
    async (type) => {
      const m = await mapping();
      await receipt(m.id);
      await env.DB.prepare("UPDATE slack_channel_subscriptions SET channel_type=? WHERE id=?").bind(type, m.id).run();
      for (const stored of [
        null,
        "malformed",
        '["channels:read","groups:read","channels:history","groups:history","chat:write"]',
        '[["channels:read","groups:read"],["channels:history","groups:history"],["chat:write"]]',
      ]) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,slack_scope_required_json) VALUES('scope-context','workspace','slack_digest',json_object('digestId','digest-test'),1,1,?)",
        )
          .bind(stored)
          .run();
        for (const family of ["channels", "groups"]) {
          const granted = await env.DB.prepare(
            `SELECT ${slackScopesGrantedSql(SLACK_PAUSED_SCOPES_SQL, "?")} granted FROM outbox WHERE id='scope-context'`,
          )
            .bind(JSON.stringify(["chat:write", `${family}:read`, `${family}:history`]))
            .first<{ granted: number }>();
          expect(granted?.granted).toBe(
            type === (family === "channels" ? "public_channel" : "private_channel") ? 1 : 0,
          );
        }
      }
    },
  );
  it.each([
    { boundary: "candidate read", action: "rescheduled" },
    { boundary: "candidate read", action: "disappeared" },
    { boundary: "status read", action: "rescheduled" },
    { boundary: "status read", action: "disappeared" },
  ])("handles a due sibling after the first candidate is $action at $boundary", async ({ boundary, action }) => {
    await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare("UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_due_at=1 WHERE id=?")
      .bind(row.id)
      .run();
    await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at)
      SELECT 'z-due-sibling',workspace_id,topic,payload_json,1,1,1,1 FROM outbox WHERE id=?`)
      .bind(row.id)
      .run();
    let changed = false;
    const changeCandidate = async () => {
      if (changed) return;
      changed = true;
      if (action === "disappeared") await env.DB.prepare("DELETE FROM outbox WHERE id=?").bind(row.id).run();
      else
        await env.DB.prepare("UPDATE outbox SET attempts=attempts+1,slack_redrive_due_at=? WHERE id=?")
          .bind(Date.now() + 3600000, row.id)
          .run();
    };
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(prepared, method) {
                  if (method === "bind") return (...args: unknown[]) => wrap(prepared.bind(...args));
                  if (method === "all" && sql.includes("WITH regular AS"))
                    return async () => {
                      const rows = await prepared.all();
                      if (boundary === "candidate read") await changeCandidate();
                      return rows;
                    };
                  if (method === "first" && sql.includes("outcome,state,claimed_at,attempted_at,paused,blocked_child"))
                    return async () => {
                      const status = await prepared.first();
                      if (boundary === "status read") await changeCandidate();
                      return status;
                    };
                  const value: unknown = Reflect.get(prepared, method, prepared);
                  return typeof value === "function" ? value.bind(prepared) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const send = vi.fn();
    await redriveRound2Outbox({ ...runtime(), DB: db, DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(send).toHaveBeenCalledTimes(boundary === "status read" ? 0 : 1);
    const recheck = (await env.DB.prepare("SELECT slack_claim_recheck_at FROM outbox WHERE id='z-due-sibling'").first<{
      slack_claim_recheck_at: number | null;
    }>())!;
    expect(recheck.slack_claim_recheck_at ?? Infinity).toBeGreaterThan(Date.now());
    if (boundary === "status read") {
      vi.spyOn(Date, "now").mockReturnValue(recheck.slack_claim_recheck_at! + 1);
      await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    }
    expect(send).toHaveBeenCalledExactlyOnceWith({ outboxId: "z-due-sibling" });
    const saved = (await env.DB.prepare("SELECT id,attempts,slack_redrive_count FROM outbox ORDER BY id").all())
      .results;
    expect(saved).toEqual(
      action === "disappeared"
        ? [{ id: "z-due-sibling", attempts: 1, slack_redrive_count: 1 }]
        : [
            { id: row.id, attempts: 2, slack_redrive_count: 1 },
            { id: "z-due-sibling", attempts: 1, slack_redrive_count: 1 },
          ],
    );
  });

  it.each(["error", "deadline", "completion"])(
    "accounts for an enqueue after a fast consumer changes its %s",
    async (mode) => {
      const m = await mapping("immediate");
      await page();
      const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
      await env.DB.prepare(
        "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_due_at=1,last_error='prior_failure' WHERE id=?",
      )
        .bind(row.id)
        .run();
      const consumerDue = Date.now() + 7200000;
      const send = vi.fn(async () => {
        await env.DB.prepare("UPDATE outbox SET last_error=NULL WHERE id=?").bind(row.id).run();
        if (mode === "deadline")
          await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=?,slack_claim_recheck_at=? WHERE id=?")
            .bind(consumerDue, consumerDue, row.id)
            .run();
        if (mode === "completion") {
          await env.DB.prepare(
            "UPDATE slack_channel_events SET round2_state='sent',delivered_at=1 WHERE subscription_id=?",
          )
            .bind(m.id)
            .run();
          await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL WHERE id=?")
            .bind(row.id)
            .run();
        }
      });
      await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
      const saved = (await env.DB.prepare(
        "SELECT attempts,enqueued_at,last_error,slack_redrive_count,slack_redrive_due_at,slack_claim_recheck_at FROM outbox WHERE id=?",
      )
        .bind(row.id)
        .first<{
          attempts: number;
          enqueued_at: number;
          last_error: string | null;
          slack_redrive_count: number;
          slack_redrive_due_at: number | null;
          slack_claim_recheck_at: number | null;
        }>())!;
      expect(saved).toMatchObject({
        attempts: 1,
        enqueued_at: expect.any(Number),
        last_error: null,
        slack_redrive_count: 1,
      });
      const numericDeadline = expect.any(Number);
      expect(saved).toMatchObject({
        slack_redrive_due_at: mode === "completion" ? null : mode === "deadline" ? consumerDue : numericDeadline,
        slack_claim_recheck_at: mode === "deadline" ? consumerDue : null,
      });
      expect(saved.slack_redrive_due_at ?? Infinity).toBeGreaterThan(Date.now());
    },
  );

  it("allows only one competing enqueue checkpoint for a shared receipt", async () => {
    await mapping("immediate");
    await page();
    await env.DB.prepare("UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_due_at=1").run();
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await Promise.all([redriveRound2Outbox(bindings), redriveRound2Outbox(bindings)]);
    expect(send).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT attempts,slack_redrive_count FROM outbox").first()).toEqual({
      attempts: 1,
      slack_redrive_count: 1,
    });
  });

  it.each([false, true])("keeps an enqueue failure free and preserves a concurrent scope pause (%s)", async (pause) => {
    await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_due_at=1,slack_redrive_count=7 WHERE id=?",
    )
      .bind(row.id)
      .run();
    const now = Date.now();
    const send = vi.fn(async () => {
      if (pause)
        await env.DB.prepare("UPDATE outbox SET slack_scope_paused_at=123,last_error='slack_scope_missing' WHERE id=?")
          .bind(row.id)
          .run();
      throw new Error("Queue unavailable");
    });
    await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    const saved = (await env.DB.prepare(
      "SELECT attempts,enqueued_at,available_at,last_error,slack_redrive_count,slack_claim_recheck_at,slack_scope_paused_at FROM outbox WHERE id=?",
    )
      .bind(row.id)
      .first<{
        attempts: number;
        enqueued_at: number | null;
        available_at: number;
        last_error: string;
        slack_redrive_count: number;
        slack_claim_recheck_at: number | null;
        slack_scope_paused_at: number | null;
      }>())!;
    expect(saved).toMatchObject({
      attempts: 1,
      slack_redrive_count: 7,
      slack_scope_paused_at: pause ? 123 : null,
      last_error: pause ? "slack_scope_missing" : "Queue unavailable",
    });
    const numericTimestamp = expect.any(Number);
    expect(saved).toMatchObject({
      enqueued_at: pause ? numericTimestamp : null,
      slack_claim_recheck_at: pause ? null : numericTimestamp,
    });
    expect(saved.available_at).toBeGreaterThanOrEqual(pause ? 1 : now + 10000);
    expect(saved.slack_claim_recheck_at ?? Infinity).toBeGreaterThanOrEqual(now + 10000);
  });

  it("leaves a durable future deadline when the producer is interrupted after checkpointing", async () => {
    await mapping("immediate");
    await page();
    await env.DB.prepare("UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_due_at=1").run();
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(prepared, method) {
                  if (method === "bind") return (...args: unknown[]) => wrap(prepared.bind(...args));
                  if (method === "run" && sql.includes("UPDATE outbox SET attempts=attempts+1,enqueued_at="))
                    return async () => {
                      await prepared.run();
                      throw new Error("Producer interrupted");
                    };
                  const value: unknown = Reflect.get(prepared, method, prepared);
                  return typeof value === "function" ? value.bind(prepared) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const send = vi.fn();
    await redriveRound2Outbox({ ...runtime(), DB: db, DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(send).not.toHaveBeenCalled();
    const saved = (await env.DB.prepare("SELECT attempts,slack_redrive_count,slack_redrive_due_at FROM outbox").first<{
      attempts: number;
      slack_redrive_count: number;
      slack_redrive_due_at: number;
    }>())!;
    expect(saved).toMatchObject({ attempts: 1, slack_redrive_count: 0 });
    expect(saved.slack_redrive_due_at).toBeGreaterThan(Date.now());
  });

  it.each(["destination", "credentials", "feature", "competing", "scope", "uncertain"])(
    "retains the budget-eight coordination exemption through a %s consumer outcome",
    async (mode) => {
      const m = await mapping("immediate");
      await page();
      const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
      await env.DB.prepare(
        "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_count=8,slack_redrive_due_at=1,slack_claim_recheck_at=NULL,last_error='slack_validation_stale' WHERE id=?",
      )
        .bind(row.id)
        .run();
      if (mode === "destination")
        await env.DB.prepare("UPDATE slack_channel_subscriptions SET muted_at=1 WHERE id=?").bind(m.id).run();
      if (mode === "credentials")
        await env.DB.prepare("UPDATE slack_installations SET auth_error='invalid_auth'").run();
      if (mode === "competing")
        await env.DB.prepare("UPDATE slack_channel_events SET claim_token='other',claimed_at=?").bind(Date.now()).run();
      if (mode === "scope") responses["chat.postMessage"] = { ok: false, error: "missing_scope" };
      if (mode === "uncertain") responses["chat.postMessage"] = new Error("Connection lost");
      const ack = vi.fn();
      const consuming: Env = {
        ...runtime(),
        ...(mode === "feature" ? { SLACK_CHANNEL_VALIDATION_ENABLED: "false" } : {}),
      };
      const result = consumeDeliveryMessage(consuming, {
        body: { outboxId: row.id },
        ack,
        retry: vi.fn(),
      } as unknown as Message<{ outboxId: string }>);
      const failure = await result.then(
        () => null,
        (error: Error) => error.message,
      );
      expect(failure).toBe(mode === "uncertain" ? "Connection lost" : null);
      expect(
        await env.DB.prepare("SELECT last_error,slack_redrive_count FROM outbox WHERE id=?").bind(row.id).first(),
      ).toEqual({ last_error: "slack_validation_stale", slack_redrive_count: 8 });
      await env.DB.prepare(
        "UPDATE slack_channel_subscriptions SET muted_at=NULL,notification_blocked_at=NULL WHERE id=?",
      )
        .bind(m.id)
        .run();
      await env.DB.prepare("UPDATE slack_installations SET auth_error=NULL").run();
      await env.DB.prepare("UPDATE slack_channel_events SET claim_token=NULL,claimed_at=NULL").run();
      await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=1,slack_scope_paused_at=NULL WHERE id=?")
        .bind(row.id)
        .run();
      const send = vi.fn();
      await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
      expect(send).toHaveBeenCalledOnce();
      expect(
        await env.DB.prepare("SELECT last_error,slack_redrive_count FROM outbox WHERE id=?").bind(row.id).first(),
      ).toEqual({ last_error: "slack_validation_stale", slack_redrive_count: 8 });
    },
  );

  it("keeps coordination through a wakeup and sweep until a runnable completion", async () => {
    const m = await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=1,slack_redrive_count=8,slack_claim_recheck_at=1,last_error='slack_validation_stale' WHERE id=?",
    )
      .bind(row.id)
      .run();
    await wakeRound2Mapping(runtime(), m.id);
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await sweepOutbox(bindings);
    expect(send).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT last_error,slack_redrive_count FROM outbox WHERE id=?").bind(row.id).first(),
    ).toEqual({ last_error: "slack_validation_stale", slack_redrive_count: 8 });
    const ack = vi.fn();
    await consumeDeliveryMessage(bindings, { body: { outboxId: row.id }, ack, retry: vi.fn() } as unknown as Message<{
      outboxId: string;
    }>);
    expect(ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT last_error,slack_redrive_due_at FROM outbox WHERE id=?").bind(row.id).first(),
    ).toEqual({ last_error: null, slack_redrive_due_at: null });
  });

  it.each([false, true])(
    "consumes sibling coordination atomically while preserving a newer sibling retry (%s)",
    async (newer) => {
      await mapping("immediate");
      await page();
      const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
      await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,last_error,slack_redrive_count)
      SELECT 'coordination-sibling',workspace_id,topic,payload_json,1,1,1,'slack_validation_stale',8 FROM outbox WHERE id=?`)
        .bind(row.id)
        .run();
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (newer && String(input).includes("chat.postMessage"))
          await env.DB.prepare(
            "UPDATE outbox SET attempts=attempts+1,last_error='slack_validation_stale',slack_claim_recheck_at=9999999999999 WHERE id='coordination-sibling'",
          ).run();
        return remote(input, init);
      });
      responses["chat.postMessage"] = Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "retry-after": "1" } },
      );
      await expect(
        consumeDeliveryMessage(runtime(), {
          body: { outboxId: row.id },
          ack: vi.fn(),
          retry: vi.fn(),
        } as unknown as Message<{ outboxId: string }>),
      ).rejects.toBeInstanceOf(SlackRateLimitError);
      expect(await env.DB.prepare("SELECT last_error FROM outbox WHERE id='coordination-sibling'").first()).toEqual({
        last_error: newer ? "slack_validation_stale" : null,
      });
    },
  );

  it.each(["retryable", "completed"])(
    "keeps a newer coordination retry when an older consumer finishes %s",
    async (outcome) => {
      await mapping("immediate");
      await page();
      const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
      await env.DB.prepare(
        "UPDATE outbox SET enqueued_at=1,available_at=1,last_error='slack_validation_stale' WHERE id=?",
      )
        .bind(row.id)
        .run();
      const due = Date.now() + 123456;
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).includes("chat.postMessage"))
          await env.DB.prepare(
            "UPDATE outbox SET attempts=attempts+1,available_at=?,slack_redrive_due_at=?,slack_claim_recheck_at=?,last_error='slack_validation_stale' WHERE id=?",
          )
            .bind(due, due, due, row.id)
            .run();
        return remote(input, init);
      });
      if (outcome === "retryable")
        responses["chat.postMessage"] = Response.json(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "retry-after": "1" } },
        );
      const failure = await consumeDeliveryMessage(runtime(), {
        body: { outboxId: row.id },
        ack: vi.fn(),
        retry: vi.fn(),
      } as unknown as Message<{ outboxId: string }>).then(
        () => null,
        (error: Error) => error.name,
      );
      expect(failure).toBe(outcome === "retryable" ? "SlackRateLimitError" : null);
      expect(
        await env.DB.prepare(
          "SELECT last_error,available_at,slack_redrive_due_at,slack_claim_recheck_at FROM outbox WHERE id=?",
        )
          .bind(row.id)
          .first(),
      ).toEqual({
        last_error: "slack_validation_stale",
        available_at: due,
        slack_redrive_due_at: due,
        slack_claim_recheck_at: due,
      });
    },
  );

  it("preserves a coordination retry through a failed maintenance enqueue at the delivery budget limit", async () => {
    const m = await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=NULL,slack_redrive_count=8,slack_claim_recheck_at=1,last_error='slack_validation_stale' WHERE id=?",
    )
      .bind(row.id)
      .run();
    const send = vi.fn().mockRejectedValueOnce(new Error("Queue unavailable")).mockResolvedValue(undefined);
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    await env.DB.prepare("UPDATE outbox SET slack_claim_recheck_at=1 WHERE id=?").bind(row.id).run();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare("SELECT slack_redrive_count,last_error FROM outbox WHERE id=?").bind(row.id).first(),
    ).toEqual({ slack_redrive_count: 8, last_error: "slack_validation_stale" });
    expect(
      await env.DB.prepare("SELECT round2_state FROM slack_channel_events WHERE subscription_id=?").bind(m.id).first(),
    ).toEqual({ round2_state: "pending" });
  });
  it("preserves a pending coordination retry while the destination is temporarily paused", async () => {
    const m = await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET slack_redrive_count=8,slack_redrive_due_at=NULL,slack_claim_recheck_at=1,last_error='slack_validation_stale' WHERE id=?",
    )
      .bind(row.id)
      .run();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET snoozed_until=? WHERE id=?")
      .bind(Date.now() + 3600000, m.id)
      .run();
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    const paused = await env.DB.prepare("SELECT slack_claim_recheck_at FROM outbox WHERE id=?")
      .bind(row.id)
      .first<{ slack_claim_recheck_at: number | null }>();
    expect(paused?.slack_claim_recheck_at).toEqual(expect.any(Number));
    expect(send).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET snoozed_until=NULL WHERE id=?").bind(m.id).run();
    await env.DB.prepare("UPDATE outbox SET slack_claim_recheck_at=1,slack_redrive_due_at=1 WHERE id=?")
      .bind(row.id)
      .run();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT last_error,slack_redrive_count FROM outbox WHERE id=?").bind(row.id).first(),
    ).toEqual({ last_error: "slack_validation_stale", slack_redrive_count: 8 });
  });

  it.each(["paused", "competing", "exhausting"])(
    "preserves a newer stale retry during %s recovery",
    async (outcome) => {
      const m = await mapping("immediate");
      await page();
      const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
      const budget = outcome === "exhausting" ? 8 : 7;
      await env.DB.prepare(
        "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_count=?,slack_redrive_due_at=1,last_error=NULL WHERE id=?",
      )
        .bind(budget, row.id)
        .run();
      if (outcome === "paused")
        await env.DB.prepare("UPDATE slack_channel_subscriptions SET snoozed_until=? WHERE id=?")
          .bind(Date.now() + 3600000, m.id)
          .run();
      else if (outcome === "competing")
        await env.DB.prepare(
          "UPDATE slack_channel_events SET claim_token='competing',claimed_at=? WHERE subscription_id=?",
        )
          .bind(Date.now(), m.id)
          .run();
      const due = Date.now() + 123456;
      const db = new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(statement, {
                  get(prepared, key) {
                    if (key === "bind") return (...binds: unknown[]) => wrap(prepared.bind(...binds));
                    if (key === "first" && sql.includes("outcome,state,claimed_at,attempted_at,paused,blocked_child"))
                      return async () => {
                        const status = await prepared.first();
                        await env.DB.prepare(
                          "UPDATE outbox SET attempts=attempts+1,enqueued_at=NULL,available_at=?,slack_redrive_due_at=NULL,slack_claim_recheck_at=?,last_error='slack_validation_stale' WHERE id=?",
                        )
                          .bind(due, due, row.id)
                          .run();
                        return status;
                      };
                    const value: unknown = Reflect.get(prepared, key, prepared);
                    return typeof value === "function" ? value.bind(prepared) : value;
                  },
                });
              return wrap(target.prepare(sql));
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const send = vi.fn();
      await redriveRound2Outbox({ ...runtime(), DB: db, DELIVERY_QUEUE: { send } } as unknown as Env);
      expect(send).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare("SELECT round2_state FROM slack_channel_events WHERE subscription_id=?")
          .bind(m.id)
          .first(),
      ).toEqual({ round2_state: "pending" });
      expect(
        await env.DB.prepare(
          "SELECT enqueued_at,available_at,slack_redrive_due_at,slack_claim_recheck_at,last_error,slack_redrive_count FROM outbox WHERE id=?",
        )
          .bind(row.id)
          .first(),
      ).toEqual({
        enqueued_at: null,
        available_at: due,
        slack_redrive_due_at: null,
        slack_claim_recheck_at: due,
        last_error: "slack_validation_stale",
        slack_redrive_count: budget,
      });
    },
  );

  it.each([
    { mode: "changed", boundary: "status read" },
    { mode: "added", boundary: "status read" },
    { mode: "removed", boundary: "status read" },
    { mode: "scope paused", boundary: "status read" },
    { mode: "changed", boundary: "retirement batch" },
    { mode: "added", boundary: "retirement batch" },
    { mode: "removed", boundary: "retirement batch" },
    { mode: "scope paused", boundary: "retirement batch" },
  ])("does not exhaust after another sibling is $mode at $boundary", async ({ mode, boundary }) => {
    const m = await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_count=8,slack_redrive_due_at=1 WHERE id=?",
    )
      .bind(row.id)
      .run();
    await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_count)
      SELECT 'sibling',workspace_id,topic,payload_json,1,1,1,8 FROM outbox WHERE id=?`)
      .bind(row.id)
      .run();
    let changed = false;
    const changeSibling = async () => {
      if (!changed) {
        changed = true;
        if (mode === "changed")
          await env.DB.prepare(
            "UPDATE outbox SET enqueued_at=NULL,last_error='slack_validation_stale',slack_claim_recheck_at=? WHERE id='sibling'",
          )
            .bind(Date.now() + 60_000)
            .run();
        else if (mode === "removed") await env.DB.prepare("DELETE FROM outbox WHERE id='sibling'").run();
        else if (mode === "scope paused")
          await env.DB.prepare("UPDATE outbox SET slack_scope_paused_at=1 WHERE id='sibling'").run();
        else
          await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
    SELECT 'new-sibling',workspace_id,topic,payload_json,1,1 FROM outbox WHERE id=?`)
            .bind(row.id)
            .run();
      }
    };
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (boundary === "retirement batch") await changeSibling();
            return target.batch(statements);
          };
        if (key === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(prepared, method) {
                  if (method === "bind") return (...args: unknown[]) => wrap(prepared.bind(...args));
                  if (method === "first" && sql.includes("outcome,state,claimed_at,attempted_at,paused,blocked_child"))
                    return async () => {
                      const status = await prepared.first();
                      if (boundary === "status read") await changeSibling();
                      return status;
                    };
                  const value: unknown = Reflect.get(prepared, method, prepared);
                  return typeof value === "function" ? value.bind(prepared) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await redriveRound2Outbox({ ...runtime(), DB: db });
    expect(changed).toBe(true);
    expect(
      await env.DB.prepare("SELECT round2_state FROM slack_channel_events WHERE subscription_id=?").bind(m.id).first(),
    ).toEqual({ round2_state: "pending" });
    expect(
      await env.DB.prepare("SELECT 1 FROM slack_delivery_failures WHERE reason='redrive_exhausted'").first(),
    ).toBeNull();
  });

  it("consumes the coordination exemption only after a runnable retryable attempt", async () => {
    const m = await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_count=8,slack_redrive_due_at=1,slack_claim_recheck_at=NULL,last_error='slack_validation_stale' WHERE id=?",
    )
      .bind(row.id)
      .run();
    const send = vi.fn();
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(1);
    await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=1 WHERE id=?").bind(row.id).run();
    await redriveRound2Outbox(bindings); // Accepted messages can be lost without using the exemption.
    expect(send).toHaveBeenCalledTimes(2);
    responses["chat.postMessage"] = Response.json(
      { ok: false, error: "ratelimited" },
      { status: 429, headers: { "retry-after": "1" } },
    );
    await expect(
      consumeDeliveryMessage(bindings, {
        body: { outboxId: row.id },
        ack: vi.fn(),
        retry: vi.fn(),
      } as unknown as Message<{ outboxId: string }>),
    ).rejects.toBeInstanceOf(SlackRateLimitError);
    expect(await env.DB.prepare("SELECT last_error FROM outbox WHERE id=?").bind(row.id).first()).toEqual({
      last_error: null,
    });
    await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=1 WHERE id=?").bind(row.id).run();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare("SELECT last_error,slack_redrive_count FROM outbox WHERE id=?").bind(row.id).first(),
    ).toEqual({ last_error: "redrive_exhausted", slack_redrive_count: 8 });
    expect(
      await env.DB.prepare("SELECT round2_state FROM slack_channel_events WHERE subscription_id=?").bind(m.id).first(),
    ).toEqual({ round2_state: "retired" });
  });

  it.each([false, true])("preserves a newer stale retry during maintenance enqueue failure %s", async (fails) => {
    await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_count=7,slack_redrive_due_at=1,last_error=NULL WHERE id=?",
    )
      .bind(row.id)
      .run();
    const due = Date.now() + 123456;
    const send = vi.fn(async () => {
      await env.DB.prepare(
        "UPDATE outbox SET attempts=attempts+1,enqueued_at=NULL,available_at=?,slack_redrive_due_at=NULL,slack_claim_recheck_at=?,last_error='slack_validation_stale' WHERE id=?",
      )
        .bind(due, due, row.id)
        .run();
      if (fails) throw new Error("Queue unavailable");
    });
    await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(
      await env.DB.prepare(
        "SELECT enqueued_at,available_at,slack_redrive_due_at,slack_claim_recheck_at,last_error,slack_redrive_count FROM outbox WHERE id=?",
      )
        .bind(row.id)
        .first(),
    ).toEqual({
      enqueued_at: null,
      available_at: due,
      slack_redrive_due_at: null,
      slack_claim_recheck_at: due,
      last_error: "slack_validation_stale",
      slack_redrive_count: 7,
    });
  });

  it("groups cleanup health by normalized reason", async () => {
    await env.DB.batch(
      [null, "cleanup_credentials_unavailable", "missing_scope"].map((reason, n) =>
        env.DB.prepare(`INSERT INTO slack_file_cleanup_jobs(id,workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,last_error,created_at,updated_at)
        VALUES(?,'workspace','installation',1,'T123','B123',?,'health-artifact','paused',?,1,1)`).bind(
          `health-${n}`,
          `F${n}`,
          reason,
        ),
      ),
    );
    const health = await slackFileCleanupHealth(runtime(), "workspace");
    expect(health.paused).toBe(3);
    expect(health.pausedByReason).toEqual(
      expect.arrayContaining([
        { reason: "cleanup_credentials_unavailable", count: 2 },
        { reason: "missing_scope", count: 1 },
      ]),
    );
    expect(health.pausedByReason).toHaveLength(2);
  });

  it("blocks personal content when access is revoked during token rotation", async () => {
    await env.DB.prepare(
      "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,installation_generation,security_generation,authorization_started_at) VALUES('installation','owner','U123',1,1,0,1)",
    ).run();
    await env.DB.prepare("UPDATE slack_installations SET token_expires_at=1,bot_refresh_token_ciphertext=?")
      .bind(await encryptSlackToken(runtime(), "refresh"))
      .run();
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("oauth.v2.access")) {
        await env.DB.prepare("DELETE FROM slack_user_links").run();
        return Response.json({ ok: true, access_token: "new-token", expires_in: 3600 });
      }
      return remote(input, init);
    });
    await expect(
      sendPersonalSlackNotification(runtime(), "owner", "workspace", "Private mention", "page"),
    ).rejects.toMatchObject({ code: "slack_identity_required" });
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
  });

  it("keeps rate-limit backoff on repeated unmute of an active mapping", async () => {
    const m = await mapping("immediate");
    await page();
    await env.DB.prepare("UPDATE outbox SET enqueued_at=1,available_at=777,slack_redrive_due_at=9999999999999").run();
    const before = (
      await env.DB.prepare("SELECT id,enqueued_at,available_at,slack_redrive_due_at FROM outbox ORDER BY id").all()
    ).results;
    await setSlackChannelPause(runtime(), owner, m.id, "unmute");
    await setSlackChannelPause(runtime(), owner, m.id, "unmute");
    expect(
      (await env.DB.prepare("SELECT id,enqueued_at,available_at,slack_redrive_due_at FROM outbox ORDER BY id").all())
        .results,
    ).toEqual(before);
  });
  it("parses Retry-After zero as a numeric delay", async () => {
    const installation = (await round2Installation(runtime(), "installation"))!;
    responses["files.delete"] = new Response("limited", { status: 429, headers: { "Retry-After": "0" } });
    const now = Date.now();
    const error = await slackApi(runtime(), installation, "files.delete", { file: "F1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackRateLimitError);
    expect((error as SlackRateLimitError).retryAt).toBeGreaterThanOrEqual(now + 1000);
    expect((error as SlackRateLimitError).retryAt).toBeLessThan(now + 10000);
  });

  it.each(["slack_thread_reply", "slack_unfurl"])(
    "retains mandatory operation scopes in saved alternatives: %s",
    async (topic) => {
      const requirements = slackScopeRequirements(topic, "conversations.info", ["channels:read", "groups:read"]);
      await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,slack_scope_required_json)
      VALUES('requirements','workspace',?,'{}',1,1,?)`)
        .bind(topic, JSON.stringify(requirements))
        .run();
      const result = await env.DB.prepare(
        `SELECT ${slackScopesGrantedSql(SLACK_PAUSED_SCOPES_SQL, "?")} granted FROM outbox WHERE id='requirements'`,
      )
        .bind('["chat:write","channels:read"]')
        .first<{ granted: number }>();
      expect(result?.granted).toBe(0);
    },
  );
  it.each(["success", "missing_scope", "channel_not_found"])(
    "retries stale validation without changing delivery evidence: %s",
    async (result) => {
      const m = await mapping("immediate");
      await page();
      const e = (await env.DB.prepare("SELECT id FROM slack_channel_events WHERE subscription_id=?")
        .bind(m.id)
        .first<{ id: string }>())!;
      await env.DB.prepare("UPDATE slack_channel_subscriptions SET validation_error='channel_not_found' WHERE id=?")
        .bind(m.id)
        .run();
      await env.DB.prepare(
        "UPDATE outbox SET slack_redrive_count=7,enqueued_at=1,slack_redrive_due_at=9999999999999 WHERE id=?",
      )
        .bind(`outbox:${e.id}`)
        .run();
      responses["conversations.info"] = result === "success" ? { ok: true, channel } : { ok: false, error: result };
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).includes("conversations.info"))
          await env.DB.prepare(
            "UPDATE slack_installations SET credential_revision=credential_revision+1 WHERE id='installation'",
          ).run();
        return remote(input, init);
      });
      const retry = vi.fn(),
        ack = vi.fn();
      const send = vi.fn().mockResolvedValue(undefined);
      await consumeDeliveryMessage(
        { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env,
        {
          body: { outboxId: `outbox:${e.id}` },
          retry,
          ack,
        } as unknown as Message<{ outboxId: string }>,
      );
      expect(retry).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledExactlyOnceWith({ outboxId: `outbox:${e.id}` }, { delaySeconds: 2 });
      expect(
        await env.DB.prepare("SELECT round2_state,delivered_at,claim_token FROM slack_channel_events WHERE id=?")
          .bind(e.id)
          .first(),
      ).toEqual({ round2_state: "pending", delivered_at: null, claim_token: null });
      expect(
        await env.DB.prepare(
          "SELECT slack_scope_paused_at,slack_redrive_count,slack_redrive_due_at FROM outbox WHERE id=?",
        )
          .bind(`outbox:${e.id}`)
          .first(),
      ).toEqual({ slack_scope_paused_at: null, slack_redrive_count: 7, slack_redrive_due_at: expect.any(Number) });
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    },
  );
  it.each(["notification", "ownership"])(
    "fences changed %s and clears scope cache after a proved repair",
    async (change) => {
      const m = await mapping();
      await env.DB.prepare("UPDATE workspace_members SET role='owner' WHERE user_id='viewer'").run();
      const installation = (await round2Installation(runtime(), "installation"))!;
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        await env.DB.prepare(
          change === "notification"
            ? "UPDATE slack_channel_subscriptions SET notification_blocked_at=7,notification_error='no_permission' WHERE id=?"
            : "UPDATE slack_channel_subscriptions SET created_by='viewer' WHERE id=?",
        )
          .bind(m.id)
          .run();
        return remote(input, init);
      });
      await expect(validateMapping(runtime(), installation, m.id, "C123")).rejects.toBeInstanceOf(
        StaleSlackValidationError,
      );
      vi.mocked(fetch).mockImplementation(remote);
      await env.DB.prepare(
        "UPDATE slack_channel_subscriptions SET validation_error='missing_scope',validation_scope_error_revision=? WHERE id=?",
      )
        .bind(installation.credential_revision, m.id)
        .run();
      await repairSlackChannelNotifications(runtime(), owner, m.id);
      expect(
        await env.DB.prepare(
          "SELECT validation_error,validation_scope_error_revision,notification_blocked_at FROM slack_channel_subscriptions WHERE id=?",
        )
          .bind(m.id)
          .first(),
      ).toEqual({ validation_error: null, validation_scope_error_revision: null, notification_blocked_at: null });
      await expect(validateMapping(runtime(), installation, m.id, "C123")).resolves.toBe(true);
    },
  );
  it("counts blocked and uncertain bulk receipts for the existing verification action", async () => {
    const m = await mapping();
    await env.DB.prepare(`INSERT INTO slack_bulk_receipts(id,installation_id,installation_generation,channel_id,operation_id,event_type,state,attempted_at,created_at)
      VALUES('blocked','installation',1,'C123','job','bulk_import','blocked',1,1),
      ('uncertain','installation',1,'C123','job-two','bulk_import','sending',1,1),
      ('live','installation',1,'C123','job-three','bulk_import','sending',?,1)`)
      .bind(Date.now())
      .run();
    expect(
      (await listSlackChannelSubscriptions(runtime(), owner)).find((row) => row.id === m.id)?.blockedDeliveries,
    ).toBe(2);
  });
  it.each(["unmute", "expiry"])(
    "wakes safe pending work after %s while preserving uncertain work and budgets",
    async (mode) => {
      const m = await mapping();
      const r = await receipt(m.id);
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES('safe','workspace','slack_digest',?,1,1,1,9999999999999,7)",
        ).bind(JSON.stringify({ digestId: r.id })),
        env.DB.prepare("UPDATE slack_channel_subscriptions SET muted_at=?,snoozed_until=? WHERE id=?").bind(
          mode === "unmute" ? 1 : null,
          mode === "expiry" ? 1 : null,
          m.id,
        ),
      ]);
      if (mode === "unmute") await setSlackChannelPause(runtime(), owner, m.id, "unmute");
      else await deliverSlackControlsExpiry(runtime(), { mappingId: m.id, installationGeneration: 1, snoozedUntil: 1 });
      expect(
        await env.DB.prepare(
          "SELECT enqueued_at,slack_redrive_due_at,slack_redrive_count FROM outbox WHERE id='safe'",
        ).first(),
      ).toEqual({ enqueued_at: null, slack_redrive_due_at: null, slack_redrive_count: 7 });
    },
  );
  it.each([null, "invalid_auth"])(
    "wakes after auth recovery but preserves healthy rotation backoff: %s",
    async (authError) => {
      const m = await mapping();
      const r = await receipt(m.id);
      await env.DB.prepare(
        "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count) VALUES('safe','workspace','slack_digest',?,1,1,1,9999999999999,7)",
      )
        .bind(JSON.stringify({ digestId: r.id }))
        .run();
      await env.DB.prepare(
        "UPDATE slack_installations SET token_expires_at=1,bot_refresh_token_ciphertext=?,auth_error=?,auth_error_at=1 WHERE id='installation'",
      )
        .bind(await encryptSlackToken(runtime(), "refresh"), authError)
        .run();
      responses["oauth.v2.access"] = {
        ok: true,
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 3600,
      };
      const installation = (await env.DB.prepare("SELECT * FROM slack_installations WHERE id='installation'").first<
        NonNullable<Awaited<ReturnType<typeof round2Installation>>>
      >())!;
      const send = vi.fn();
      await usableBotToken(
        { ...runtime(), DELIVERY_QUEUE: { send } as unknown as Env["DELIVERY_QUEUE"] },
        installation,
      );
      expect(send).toHaveBeenCalledTimes(authError ? 1 : 0);
      const testEnv = { ...runtime(), DELIVERY_QUEUE: { send } as unknown as Env["DELIVERY_QUEUE"] };
      if (authError)
        await consumeDeliveryMessage(testEnv, {
          body: { sweep: true },
          ack: vi.fn(),
          retry: vi.fn(),
        } as unknown as Message<{ sweep: true }>);
      expect(send.mock.calls[0]?.[0]).toEqual(authError ? { sweep: true } : undefined);
      expect(send).toHaveBeenCalledTimes(authError ? 2 : 0);
      const recovered = await env.DB.prepare(
        "SELECT slack_redrive_count,slack_redrive_due_at FROM outbox WHERE id='safe'",
      ).first<{ slack_redrive_count: number; slack_redrive_due_at: number }>();
      expect(recovered?.slack_redrive_count).toBe(7);
      expect(recovered?.slack_redrive_due_at === 9999999999999).toBe(!authError);
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: null });
    },
  );
});

describe("durable abandoned thumbnail cleanup", () => {
  async function allocation(id = "allocation", file = "FOLD", state = "uploading") {
    if (!(await env.DB.prepare("SELECT id FROM pages WHERE id='page'").first())) await page();
    await env.DB.prepare(`INSERT INTO slack_file_artifacts(id,installation_id,installation_generation,page_id,content_epoch,content_sha256,thumbnail_r2_key,slack_file_id,state,created_at,updated_at)
      VALUES(?,'installation',1,'page',1,?,'thumbnail-key',?,?,1,1)`)
      .bind(id, id, file, state)
      .run();
    return `slack-file-cleanup:installation:${file}`;
  }
  async function abandon(id = "allocation") {
    await env.DB.prepare("UPDATE slack_file_artifacts SET slack_file_id=NULL,upload_url=NULL WHERE id=?")
      .bind(id)
      .run();
  }
  it.each(["invalid_auth", "token_revoked", "account_inactive"])(
    "records cleanup authentication failure %s and resumes without resetting attempts",
    async (code) => {
      const required = (await slackWorkspaceStatus(runtime(), owner)).installation!.scopeHealth.required;
      await env.DB.prepare("UPDATE slack_installations SET scopes=?").bind(required.join(",")).run();
      expect((await slackWorkspaceStatus(runtime(), owner)).reauthorization.required).toBe(false);
      const id = await allocation();
      await abandon();
      responses["files.delete"] = { ok: false, error: code };
      await processSlackFileCleanup(runtime(), id);
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: code });
      expect((await slackWorkspaceStatus(runtime(), owner)).reauthorization.required).toBe(true);
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: "paused", attempt_count: 1 });
      await env.DB.prepare(
        "UPDATE slack_installations SET auth_error=NULL,auth_error_at=NULL,credential_revision=credential_revision+1",
      ).run();
      await resumeSlackFileCleanup(runtime(), "workspace");
      responses["files.delete"] = { ok: true };
      await processSlackFileCleanup(runtime(), id);
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: "completed", attempt_count: 2 });
    },
  );

  it.each(["no_refresh_token", "revoked_refresh"])(
    "records %s during cleanup token preparation without spending an attempt",
    async (reason) => {
      const id = await allocation();
      await abandon();
      await env.DB.prepare("UPDATE slack_installations SET token_expires_at=1,bot_refresh_token_ciphertext=?")
        .bind(reason === "no_refresh_token" ? null : await encryptSlackToken(runtime(), "refresh-token"))
        .run();
      responses["oauth.v2.access"] = { ok: false, error: "token_revoked" };
      await processSlackFileCleanup(runtime(), id);
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: reason === "no_refresh_token" ? "invalid_auth" : "token_revoked" });
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: "paused", attempt_count: 0 });
      expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(0);
    },
  );

  it("records authentication failure even when the last cleanup attempt is exhausted", async () => {
    const id = await allocation();
    await abandon();
    await env.DB.prepare("UPDATE slack_file_cleanup_jobs SET attempt_count=1 WHERE id=?").bind(id).run();
    responses["files.delete"] = { ok: false, error: "invalid_auth" };
    await processSlackFileCleanup(runtime(), id);
    expect(await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first()).toEqual({
      auth_error: "invalid_auth",
    });
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "failed", attempt_count: 2 });
  });

  it.each(["credential_revision", "generation"])(
    "ignores a stale cleanup auth error after %s changes",
    async (field) => {
      const id = await allocation();
      await abandon();
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).includes("files.delete"))
          await env.DB.prepare(`UPDATE slack_installations SET ${field}=${field}+1 WHERE id='installation'`).run();
        return remote(input, init);
      });
      responses["files.delete"] = { ok: false, error: "invalid_auth" };
      await processSlackFileCleanup(runtime(), id);
      expect(
        await env.DB.prepare("SELECT auth_error FROM slack_installations WHERE id='installation'").first(),
      ).toEqual({ auth_error: null });
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: "pending", attempt_count: 1 });
      vi.mocked(fetch).mockImplementation(remote);
      responses["files.delete"] = { ok: true };
      await env.DB.prepare("UPDATE slack_file_cleanup_jobs SET next_attempt_at=1 WHERE id=?").bind(id).run();
      await processSlackFileCleanup(runtime(), id);
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: "completed", attempt_count: 2 });
    },
  );

  it("captures replacement and terminal failure transactionally and survives page deletion", async () => {
    const first = await allocation();
    await abandon();
    await env.DB.prepare(
      "UPDATE slack_file_artifacts SET slack_file_id='FNEW',state='failed' WHERE id='allocation'",
    ).run();
    await env.DB.prepare("DELETE FROM pages WHERE id='page'").run();
    const jobs = (
      await env.DB.prepare("SELECT id,file_id,state,team_id,bot_user_id FROM slack_file_cleanup_jobs ORDER BY id").all()
    ).results;
    expect(jobs).toHaveLength(2);
    expect(jobs).toContainEqual({ id: first, file_id: "FOLD", state: "pending", team_id: "T123", bot_user_id: "B123" });
    await processDueSlackFileCleanup(runtime());
    expect(
      calls
        .filter((call) => call.method === "files.delete")
        .map((call) => String(call.body.file))
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["FNEW", "FOLD"]);
    expect(
      (await env.DB.prepare("SELECT state FROM slack_file_cleanup_jobs").all()).results.every(
        (job) => job.state === "completed",
      ),
    ).toBe(true);
  });
  it("never schedules successfully uploaded files for cleanup", async () => {
    await allocation("uploaded", "FSENT", "uploaded");
    await env.DB.prepare("DELETE FROM pages WHERE id='page'").run();
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_file_cleanup_jobs").first()).toEqual({ n: 0 });
  });
  it("permits exactly two dispatches and reports exhaustion without resetting on acknowledgment or reauthorization", async () => {
    const id = await allocation();
    await abandon();
    responses["files.delete"] = new TypeError("network unavailable");
    await processSlackFileCleanup(runtime(), id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "pending", attempt_count: 1 });
    await processSlackFileCleanup(runtime(), id);
    expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(1);
    await env.DB.prepare("UPDATE slack_file_cleanup_jobs SET next_attempt_at=1 WHERE id=?").bind(id).run();
    await processSlackFileCleanup(runtime(), id);
    const failures = await listSlackDeliveryFailureGroups(runtime(), owner);
    expect(failures).toEqual([
      { id: "slack-file-cleanup:installation", channelName: "Slack thumbnail cleanup", failedDeliveries: 1 },
    ]);
    await acknowledgeSlackDeliveryFailures(runtime(), owner, failures[0]!.id);
    await resumeSlackFileCleanup(runtime(), "workspace");
    await processSlackFileCleanup(runtime(), id);
    expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(2);
    expect(
      await env.DB.prepare("SELECT file_id,state,attempt_count,last_error FROM slack_file_cleanup_jobs WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({ file_id: "FOLD", state: "failed", attempt_count: 2, last_error: "network_error" });
    expect(await listSlackDeliveryFailureGroups(runtime(), owner)).toHaveLength(0);
  });
  it.each(["scope", "disconnected", "identity"])(
    "does not spend an attempt during a failed %s precheck",
    async (reason) => {
      const id = await allocation();
      await abandon();
      await env.DB.prepare(
        reason === "scope"
          ? "UPDATE slack_installations SET scopes='chat:write'"
          : reason === "identity"
            ? "UPDATE slack_installations SET bot_user_id='BOTHER'"
            : "UPDATE slack_installations SET disconnected_at=1",
      ).run();
      await processSlackFileCleanup(runtime(), id);
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: "paused", attempt_count: 0 });
      await resumeSlackFileCleanup(runtime(), "workspace");
      expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(0);
      await env.DB.prepare(
        "UPDATE slack_installations SET scopes='files:write',disconnected_at=NULL,bot_user_id='B123',generation=2,credential_revision=credential_revision+1",
      ).run();
      await resumeSlackFileCleanup(runtime(), "workspace");
      const cleanupEnv = { ...runtime(), SLACK_RICH_DIGESTS_ENABLED: "false" as const };
      delete cleanupEnv.BROWSER;
      await processSlackFileCleanup(cleanupEnv, id);
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: "completed", attempt_count: 1 });
    },
  );
  it.each(["invalid_auth", "missing_scope"])(
    "stops dispatch for the remaining team jobs and exposes paused cleanup: %s",
    async (error) => {
      for (let n = 0; n < 25; n++) {
        await allocation(`blocked-${n}`, `F${n}`);
        await abandon(`blocked-${n}`);
      }
      responses["files.delete"] = { ok: false, error };
      await processDueSlackFileCleanup(runtime());
      expect(calls.filter((c) => c.method === "files.delete")).toHaveLength(1);
      expect(await env.DB.prepare("SELECT sum(attempt_count) attempts FROM slack_file_cleanup_jobs").first()).toEqual({
        attempts: 1,
      });
      expect(await slackFileCleanupHealth(runtime(), "workspace")).toMatchObject({ pending: 0, paused: 25, failed: 0 });
      expect(
        await env.DB.prepare("SELECT auth_error,file_scope_error_revision FROM slack_installations").first(),
      ).toEqual(
        error === "invalid_auth"
          ? { auth_error: "invalid_auth", file_scope_error_revision: null }
          : { auth_error: null, file_scope_error_revision: 0 },
      );
    },
  );
  it("keeps a stale missing-scope response retryable after reauthorization wins", async () => {
    const id = await allocation();
    await abandon();
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("files.delete")) {
        await env.DB.prepare(
          "UPDATE slack_installations SET credential_revision=credential_revision+1,file_scope_error_revision=NULL",
        ).run();
        return Response.json({ ok: false, error: "missing_scope" });
      }
      return remote(input, init);
    });
    await processSlackFileCleanup(runtime(), id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "pending", attempt_count: 1 });
    expect(await env.DB.prepare("SELECT file_scope_error_revision FROM slack_installations").first()).toEqual({
      file_scope_error_revision: null,
    });
  });

  it("retries a reservation lost to token rotation without dispatch or spending a slot", async () => {
    const id = await allocation();
    await abandon();
    let rotated = false;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("SET attempt_count=attempt_count+1")) return statement;
            const wrap = (prepared: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(prepared, {
                get(object, key) {
                  if (key === "bind") return (...args: unknown[]) => wrap(object.bind(...args));
                  if (key === "run")
                    return async () => {
                      if (!rotated) {
                        rotated = true;
                        await env.DB.prepare(
                          "UPDATE slack_installations SET credential_revision=credential_revision+1",
                        ).run();
                      }
                      return object.run();
                    };
                  const value: unknown = Reflect.get(object, key, object);
                  return typeof value === "function" ? value.bind(object) : value;
                },
              });
            return wrap(statement);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await processSlackFileCleanup({ ...runtime(), DB: db }, id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count,last_error FROM slack_file_cleanup_jobs WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({ state: "pending", attempt_count: 0, last_error: "cleanup_credentials_changed" });
    expect(calls.filter((c) => c.method === "files.delete")).toHaveLength(0);
    await env.DB.prepare("UPDATE slack_file_cleanup_jobs SET next_attempt_at=1 WHERE id=?").bind(id).run();
    await processSlackFileCleanup(runtime(), id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "completed", attempt_count: 1 });
  });

  it("counts a remote missing-scope rejection and preserves that budget through resumption", async () => {
    const id = await allocation();
    await abandon();
    responses["files.delete"] = { ok: false, error: "missing_scope" };
    await processSlackFileCleanup(runtime(), id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "paused", attempt_count: 1 });
    await env.DB.prepare("UPDATE slack_installations SET credential_revision=credential_revision+1").run();
    await resumeSlackFileCleanup(runtime(), "workspace");
    await processSlackFileCleanup(runtime(), id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "paused", attempt_count: 1 });
    await env.DB.prepare("UPDATE slack_installations SET file_scope_error_revision=NULL").run();
    await resumeSlackFileCleanup(runtime(), "workspace");
    await processSlackFileCleanup(runtime(), id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "failed", attempt_count: 2 });
  });
  it.each(["file_deleted", "file_not_found", "cant_delete_file"])(
    "distinguishes confirmed deletion from permanent manual attention: %s",
    async (code) => {
      const id = await allocation();
      await abandon();
      responses["files.delete"] = { ok: false, error: code };
      await processSlackFileCleanup(runtime(), id);
      expect(
        await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
      ).toEqual({ state: code === "file_deleted" ? "completed" : "failed", attempt_count: 1 });
      expect(await listSlackDeliveryFailureGroups(runtime(), owner)).toHaveLength(code === "file_deleted" ? 0 : 1);
    },
  );
  it("respects long Retry-After and skips the limited installation for the rest of the pass", async () => {
    const id = await allocation("first", "F1");
    await abandon("first");
    await allocation("second", "F2");
    await abandon("second");
    responses["files.delete"] = new Response("limited", { status: 429, headers: { "Retry-After": "3600" } });
    const now = Date.now();
    await processDueSlackFileCleanup(runtime());
    expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(1);
    const job = await env.DB.prepare("SELECT next_attempt_at,attempt_count FROM slack_file_cleanup_jobs WHERE id=?")
      .bind(id)
      .first<{ next_attempt_at: number; attempt_count: number }>();
    expect(job?.next_attempt_at).toBeGreaterThanOrEqual(now + 3600_000);
    expect(job?.attempt_count).toBe(0);
    await env.DB.prepare("UPDATE slack_file_cleanup_jobs SET next_attempt_at=1 WHERE id=?").bind(id).run();
    await processSlackFileCleanup(runtime(), id);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(id).first(),
    ).toEqual({ state: "pending", attempt_count: 0 });
  });
  it("fences concurrent cleanup and exhausts crashed second reservations without a third dispatch", async () => {
    const id = await allocation();
    await abandon();
    await Promise.all([processSlackFileCleanup(runtime(), id), processSlackFileCleanup(runtime(), id)]);
    expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(1);
    const second = await allocation("crashed", "FCRASHED");
    await abandon("crashed");
    await env.DB.prepare(
      "UPDATE slack_file_cleanup_jobs SET attempt_count=2,claim_token='crashed',claimed_at=1 WHERE id=?",
    )
      .bind(second)
      .run();
    await processSlackFileCleanup(runtime(), second);
    expect(
      await env.DB.prepare("SELECT state,attempt_count FROM slack_file_cleanup_jobs WHERE id=?").bind(second).first(),
    ).toEqual({ state: "failed", attempt_count: 2 });
    expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(1);
  });
  it("caps cleanup passes at 25 jobs, leaving remaining jobs due", async () => {
    await page();
    for (let n = 0; n < 26; n++) {
      await allocation(`allocation-${n}`, `F${n.toString().padStart(2, "0")}`);
      await abandon(`allocation-${n}`);
    }
    await processDueSlackFileCleanup(runtime());
    expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(25);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM slack_file_cleanup_jobs WHERE state='pending'").first(),
    ).toEqual({ n: 1 });
    await processDueSlackFileCleanup(runtime());
    expect(calls.filter((call) => call.method === "files.delete")).toHaveLength(26);
  });
});

describe("final Round 2 dispatch authorization", () => {
  function afterWrite(check: (sql: string) => boolean, hook: () => Promise<void>, before = false) {
    const statements = new WeakMap<D1PreparedStatement, { sql: string; raw: D1PreparedStatement }>();
    const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const proxy = new Proxy(raw, {
        get(target, key) {
          if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
          if (key === "run")
            return async () => {
              if (before && check(sql)) await hook();
              const result = await target.run();
              if (!before && check(sql)) await hook();
              return result;
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      statements.set(proxy, { sql, raw });
      return proxy;
    };
    return new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (key === "batch")
          return async (batch: D1PreparedStatement[]) => {
            const result = await target.batch(batch.map((statement) => statements.get(statement)?.raw ?? statement));
            if (batch.some((statement) => check(statements.get(statement)?.sql ?? ""))) await hook();
            return result;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async function mixedBulk() {
    const active = await mapping("immediate");
    await page("active-page");
    await page("paused-page");
    await page("denied-page");
    const paused = await upsertSlackChannelSubscription(runtime(), owner, {
      spaceId: "workspace-general",
      pageId: "paused-page",
      channelId: "C123",
      channelName: "notes",
      eventTypes: ["page_moved"],
      cadence: "immediate",
    });
    await env.DB.batch([env.DB.prepare("DELETE FROM slack_channel_events"), env.DB.prepare("DELETE FROM outbox")]);
    await event(active.id, "active-page", 1, "page_moved", "active-event");
    await event(active.id, "active-page", 2, "page_moved", "overlapping-event");
    await event(paused.id, "paused-page", 3, "page_moved", "paused-event");
    await event(active.id, "denied-page", 4, "page_moved", "denied-event");
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET is_template=1 WHERE id='denied-page'"),
      env.DB.prepare("UPDATE slack_channel_subscriptions SET muted_at=1 WHERE id=?").bind(paused.id),
      env.DB.prepare("UPDATE slack_channel_events SET summary_id='mixed-bulk'"),
      env.DB
        .prepare(`INSERT INTO slack_bulk_receipts(id,installation_id,installation_generation,channel_id,operation_id,event_type,created_at)
        VALUES('mixed-bulk','installation',1,'C123','mixed-operation','page_moved',1)`),
      env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
        VALUES('outbox:mixed-bulk','workspace','slack_bulk','{"summaryId":"mixed-bulk"}',1,1)`),
    ]);
    calls = [];
    return { active, paused };
  }

  it.each(["muted", "snoozed", "destination blocked"])(
    "posts eligible bulk events and wakes only the %s continuation's own mapping",
    async (mode) => {
      const { active, paused } = await mixedBulk();
      if (mode === "snoozed")
        await env.DB.prepare("UPDATE slack_channel_subscriptions SET muted_at=NULL,snoozed_until=? WHERE id=?")
          .bind(Date.now() + 7200000, paused.id)
          .run();
      if (mode === "destination blocked")
        await env.DB.prepare(
          "UPDATE slack_channel_subscriptions SET muted_at=NULL,notification_blocked_at=1,notification_error='not_in_channel',validation_state='invalid',validation_error='not_in_channel' WHERE id=?",
        )
          .bind(paused.id)
          .run();
      await deliverBulkSummary(runtime(), "mixed-bulk");
      const deferred = (await env.DB.prepare(
        "SELECT id,state,operation_id,event_ids_json FROM slack_bulk_receipts WHERE id<>'mixed-bulk'",
      ).first<{ id: string; state: string; operation_id: string; event_ids_json: string }>())!;
      expect(deferred).toMatchObject({
        state: "pending",
        operation_id: "mixed-operation",
        event_ids_json: '["paused-event"]',
      });
      expect(deferred.id).toMatch(/^mixed-bulk:deferred:[a-f0-9]{64}$/);
      expect(calls.filter((call) => call.method === "chat.postMessage").map((call) => call.body.text)).toEqual([
        "1 pages moved",
      ]);
      expect(
        await env.DB.prepare(
          "SELECT id,round2_state,delivered_at IS NOT NULL delivered,suppressed_at IS NOT NULL suppressed,summary_id FROM slack_channel_events ORDER BY id",
        ).all(),
      ).toMatchObject({
        results: [
          { id: "active-event", round2_state: "sent", delivered: 1, suppressed: 0, summary_id: "mixed-bulk" },
          { id: "denied-event", round2_state: "retired", delivered: 0, suppressed: 1, summary_id: "mixed-bulk" },
          { id: "overlapping-event", round2_state: "sent", delivered: 1, suppressed: 0, summary_id: "mixed-bulk" },
          { id: "paused-event", round2_state: "pending", delivered: 0, suppressed: 0, summary_id: deferred.id },
        ],
      });
      await deliverBulkSummary(runtime(), "mixed-bulk");
      expect(await round2DeliveryOutcome(runtime(), "slack_bulk", deferred.id)).toBe("paused");
      await env.DB.prepare(
        "UPDATE outbox SET enqueued_at=1,slack_redrive_due_at=1,slack_redrive_count=7 WHERE slack_round2_receipt_id=?",
      )
        .bind(deferred.id)
        .run();
      const send = vi.fn();
      await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
      expect(send).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare("SELECT slack_redrive_count FROM outbox WHERE slack_round2_receipt_id=?")
          .bind(deferred.id)
          .first(),
      ).toEqual({ slack_redrive_count: 7 });
      const beforeWake = await env.DB.prepare(
        "SELECT attempts,enqueued_at,available_at FROM outbox WHERE slack_round2_receipt_id=?",
      )
        .bind(deferred.id)
        .first();
      await wakeRound2Mapping(runtime(), active.id);
      expect(
        await env.DB.prepare("SELECT attempts,enqueued_at,available_at FROM outbox WHERE slack_round2_receipt_id=?")
          .bind(deferred.id)
          .first(),
      ).toEqual(beforeWake);
      if (mode === "destination blocked")
        await validateMapping(runtime(), (await round2Installation(runtime(), "installation", 1))!, paused.id, "C123");
      else await setSlackChannelPause(runtime(), owner, paused.id, "unmute");
      expect(
        await env.DB.prepare("SELECT enqueued_at FROM outbox WHERE slack_round2_receipt_id=?")
          .bind(deferred.id)
          .first(),
      ).toEqual({ enqueued_at: null });
      await deliverBulkSummary(runtime(), deferred.id);
      await deliverBulkSummary(runtime(), deferred.id);
      expect(calls.filter((call) => call.method === "chat.postMessage").map((call) => call.body.metadata)).toEqual([
        { event_type: "noteflare_bulk", event_payload: { delivery_id: "mixed-bulk" } },
        { event_type: "noteflare_bulk", event_payload: { delivery_id: deferred.id } },
      ]);
      expect(
        await env.DB.prepare(
          "SELECT delivered_at IS NOT NULL delivered,suppressed_at FROM slack_channel_events WHERE id='paused-event'",
        ).first(),
      ).toEqual({ delivered: 1, suppressed_at: null });
    },
  );

  it("leaves all-paused bulk events in their original pending receipt", async () => {
    const { active } = await mixedBulk();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET muted_at=1 WHERE id=?").bind(active.id).run();
    await deliverBulkSummary(runtime(), "mixed-bulk");
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_bulk_receipts WHERE state='pending'").first()).toEqual({
      n: 1,
    });
    expect(
      await env.DB.prepare(
        "SELECT delivered_at,suppressed_at,summary_id FROM slack_channel_events WHERE id='paused-event'",
      ).first(),
    ).toEqual({ delivered_at: null, suppressed_at: null, summary_id: "mixed-bulk" });
    expect(await round2DeliveryOutcome(runtime(), "slack_bulk", "mixed-bulk")).toBe("paused");
  });

  it("reconciles a lost bulk response without consuming its paused continuation", async () => {
    const { paused } = await mixedBulk();
    responses["chat.postMessage"] = new Error("Lost bulk response");
    await expect(deliverBulkSummary(runtime(), "mixed-bulk")).rejects.toThrow("Lost bulk response");
    await env.DB.prepare("UPDATE slack_channel_events SET suppressed_at=123 WHERE id='active-event'").run();
    const deferred = (await env.DB.prepare("SELECT id FROM slack_bulk_receipts WHERE id<>'mixed-bulk'").first<{
      id: string;
    }>())!;
    responses["conversations.history"] = {
      ok: true,
      messages: [{ user: "B123", ts: "999.001", metadata: { event_payload: { delivery_id: "mixed-bulk" } } }],
    };
    await deliverBulkSummary(runtime(), "mixed-bulk");
    expect(await env.DB.prepare("SELECT state FROM slack_bulk_receipts WHERE id='mixed-bulk'").first()).toEqual({
      state: "sent",
    });
    expect(
      await env.DB.prepare(
        "SELECT round2_state,delivered_at IS NOT NULL delivered,suppressed_at FROM slack_channel_events WHERE id='active-event'",
      ).first(),
    ).toEqual({ round2_state: "sent", delivered: 1, suppressed_at: 123 });
    expect(
      await env.DB.prepare(
        "SELECT delivered_at,suppressed_at FROM slack_channel_events WHERE id='paused-event'",
      ).first(),
    ).toEqual({ delivered_at: null, suppressed_at: null });
    responses["chat.postMessage"] = { ok: true, ts: "999.002" };
    await setSlackChannelPause(runtime(), owner, paused.id, "unmute");
    await deliverBulkSummary(runtime(), deferred.id);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
  });

  it("allows only one concurrent bulk split and rolls the entire split back on checkpoint failure", async () => {
    await mixedBulk();
    await env.DB.prepare(`CREATE TRIGGER reject_bulk_split BEFORE UPDATE OF summary_id ON slack_channel_events
      WHEN NEW.summary_id<>OLD.summary_id BEGIN SELECT RAISE(ABORT,'Split unavailable'); END`).run();
    try {
      await expect(deliverBulkSummary(runtime(), "mixed-bulk")).rejects.toThrow("Split unavailable");
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_bulk_split").run();
    }
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_bulk_receipts").first()).toEqual({ n: 1 });
    expect(
      await env.DB.prepare("SELECT state,attempted_at FROM slack_bulk_receipts WHERE id='mixed-bulk'").first(),
    ).toEqual({ state: "pending", attempted_at: null });
    expect(await env.DB.prepare("SELECT summary_id FROM slack_channel_events WHERE id='paused-event'").first()).toEqual(
      { summary_id: "mixed-bulk" },
    );
    expect(await env.DB.prepare("SELECT count(*) n FROM outbox").first()).toEqual({ n: 1 });
    const attempts = await Promise.allSettled([
      deliverBulkSummary(runtime(), "mixed-bulk"),
      deliverBulkSummary(runtime(), "mixed-bulk"),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) n FROM slack_bulk_receipts").first()).toEqual({ n: 2 });
  });

  it.each(["mapping loss", "window expiry", "obsolete installation"])(
    "retires reserved digest children on late %s",
    async (mode) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const m = await mapping();
      await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
      await page();
      await env.DB.prepare("UPDATE slack_channel_events SET suppressed_at=1").run();
      const r = await receipt(m.id);
      await event(m.id, "page", r.window_start + 1000, "page_edit", "reserved-event");
      let changed = false;
      const db = afterWrite(
        (sql) => sql.includes("INSERT INTO slack_digest_messages(id"),
        async () => {
          if (changed) return;
          changed = true;
          if (mode === "mapping loss")
            await env.DB.prepare("UPDATE slack_channel_subscriptions SET created_by='viewer' WHERE id=?")
              .bind(m.id)
              .run();
          if (mode === "window expiry") vi.mocked(Date.now).mockReturnValue(now + 86400000);
          if (mode === "obsolete installation")
            await env.DB.prepare("UPDATE slack_installations SET generation=2").run();
        },
      );
      await deliverDigest({ ...runtime(), DB: db }, r.id).catch((error: unknown) => {
        if (mode !== "obsolete installation") throw error;
      });
      if (mode === "obsolete installation") await deliverDigest(runtime(), r.id);
      expect(changed).toBe(true);
      expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
        state: "retired",
      });
      expect(
        await env.DB.prepare("SELECT state,claim_token FROM slack_digest_messages WHERE receipt_id=?")
          .bind(r.id)
          .first(),
      ).toEqual({ state: "retired", claim_token: null });
      expect(
        await env.DB.prepare(
          "SELECT round2_state,delivered_at,suppressed_at FROM slack_channel_events WHERE id='reserved-event'",
        ).first(),
      ).toEqual({ round2_state: "retired", delivered_at: null, suppressed_at: expect.any(Number) });
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    },
  );

  it.each(["sending", "blocked"])(
    "preserves an uncertain %s digest child after installation replacement",
    async (state) => {
      const m = await mapping();
      await page();
      const r = await receipt(m.id);
      await env.DB.prepare(`INSERT INTO slack_digest_messages(id,receipt_id,sequence,state,page_ids_json,event_ids_json,attempted_at)
      VALUES('uncertain-child',?,0,?,'["page"]','[]',1)`)
        .bind(r.id, state)
        .run();
      await env.DB.prepare("UPDATE slack_installations SET generation=2").run();
      await deliverDigest(runtime(), r.id);
      expect(
        await env.DB.prepare("SELECT state FROM slack_digest_messages WHERE id='uncertain-child'").first(),
      ).toEqual({ state });
      expect(
        await env.DB.prepare("SELECT state,claim_token FROM slack_digest_receipts WHERE id=?").bind(r.id).first(),
      ).toEqual({ state: "pending", claim_token: null });
    },
  );

  it.each([1, 11])("continues scheduling after a late empty digest partition with %s original pages", async (count) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const m = await mapping();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    for (let n = 0; n < count; n++) await page(`partition-page-${n}`);
    await env.DB.prepare("UPDATE slack_channel_events SET suppressed_at=1").run();
    const r = await receipt(m.id);
    for (let n = 0; n < count; n++)
      await event(m.id, `partition-page-${n}`, r.window_start + n + 1000, "page_edit", `partition-event-${n}`);
    await env.DB.prepare("UPDATE slack_installations SET token_expires_at=?,bot_refresh_token_ciphertext=?")
      .bind(now + 61000, await encryptSlackToken(runtime(), "refresh-token"))
      .run();
    let prepared = false;
    const db = afterWrite(
      (sql) => sql.includes("INSERT INTO slack_digest_messages(id"),
      async () => {
        if (prepared) return;
        prepared = true;
        vi.mocked(Date.now).mockReturnValue(now + 2000);
      },
    );
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/oauth.v2.access")) {
        await env.DB.prepare(`UPDATE pages SET is_template=1 WHERE id IN
          (SELECT value FROM slack_digest_messages child,json_each(child.page_ids_json) WHERE child.receipt_id=? AND child.sequence=0)`)
          .bind(r.id)
          .run();
        return Response.json({ ok: true, access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 });
      }
      return remote(input, init);
    });
    calls = [];
    await deliverDigest({ ...runtime(), DB: db }, r.id);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT state FROM slack_digest_messages WHERE receipt_id=? AND sequence=0")
        .bind(r.id)
        .first(),
    ).toEqual({ state: "retired" });
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: count === 11 ? "pending" : "sent",
    });
    expect(
      await env.DB.prepare("SELECT state,event_ids_json FROM slack_digest_messages WHERE receipt_id=? AND sequence=1")
        .bind(r.id)
        .first(),
    ).toEqual(count === 11 ? { state: "pending", event_ids_json: '["partition-event-0"]' } : null);
    expect(
      await env.DB.prepare("SELECT topic FROM outbox WHERE id=?").bind(`outbox:${r.id}:message:1`).first(),
    ).toEqual(count === 11 ? { topic: "slack_digest" } : null);
    if (count === 11) await deliverDigest(runtime(), r.id);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(count === 11 ? 1 : 0);
  });

  it("rechecks a stale sibling snapshot after two seconds without enqueueing it", async () => {
    await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id,slack_round2_receipt_id receipt_id FROM outbox").first<{
      id: string;
      receipt_id: string;
    }>())!;
    await env.DB.prepare("UPDATE outbox SET available_at=1").run();
    const future = Date.now() + 3_600_000;
    const db = afterWrite(
      (sql) => sql.includes("UPDATE outbox SET attempts=attempts+1,enqueued_at="),
      async () => {
        await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
        SELECT 'new-sibling',workspace_id,topic,payload_json,?,1 FROM outbox WHERE id=?`)
          .bind(future, row.id)
          .run();
      },
      true,
    );
    const now = Date.now();
    const send = vi.fn();
    expect(
      await enqueueRound2Outbox(
        { ...runtime(), DB: db, DELIVERY_QUEUE: { send } } as unknown as Env,
        row.id,
        "slack_channel",
        row.receipt_id,
        { dueAt: future },
      ),
    ).toBe("stale");
    expect(send).not.toHaveBeenCalled();
    const saved = (await env.DB.prepare(
      "SELECT attempts,available_at,slack_claim_recheck_at,slack_redrive_count FROM outbox WHERE id=?",
    )
      .bind(row.id)
      .first<{ available_at: number; slack_claim_recheck_at: number }>())!;
    expect(saved).toMatchObject({ attempts: 0, slack_redrive_count: 0 });
    expect(saved.available_at).toBeGreaterThanOrEqual(now + 2_000);
    expect(saved.available_at).toBeLessThan(now + 10_000);
    expect(saved.slack_claim_recheck_at).toBe(saved.available_at);
    expect(await env.DB.prepare("SELECT available_at FROM outbox WHERE id='new-sibling'").first()).toEqual({
      available_at: future,
    });
  });

  it.each(["unchanged", "version", "enqueued", "paused", "deadline"])(
    "backs off a rejected sweep checkpoint while preserving %s scheduling",
    async (mode) => {
      await mapping("immediate");
      await page();
      const row = (await env.DB.prepare(
        "SELECT id,slack_round2_receipt_id receipt_id FROM outbox WHERE topic='slack_channel'",
      ).first<{ id: string; receipt_id: string }>())!;
      await env.DB.prepare(
        "UPDATE outbox SET available_at=1,attempts=0,last_error='slack_validation_stale',slack_redrive_count=7",
      ).run();
      const future = Date.now() + 7200000;
      let checkpoints = 0;
      const db = afterWrite(
        (sql) => sql.includes("UPDATE outbox SET attempts=attempts+1,enqueued_at="),
        async () => {
          checkpoints++;
          await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_scope_paused_at)
      VALUES('checkpoint-sibling','workspace','slack_channel',?,1,1,1,1)`)
            .bind(JSON.stringify({ eventId: row.receipt_id }))
            .run();

          if (mode === "version")
            await env.DB.prepare("UPDATE outbox SET attempts=attempts+1 WHERE id=?").bind(row.id).run();
          if (mode === "enqueued")
            await env.DB.prepare("UPDATE outbox SET enqueued_at=123 WHERE id=?").bind(row.id).run();
          if (mode === "paused")
            await env.DB.prepare("UPDATE outbox SET slack_scope_paused_at=123 WHERE id=?").bind(row.id).run();
          if (mode === "deadline")
            await env.DB.prepare("UPDATE outbox SET available_at=? WHERE id=?").bind(future, row.id).run();
        },
        true,
      );
      const now = Date.now();
      const send = vi.fn();
      expect(
        await enqueueRound2Outbox(
          { ...runtime(), DB: db, DELIVERY_QUEUE: { send } } as unknown as Env,
          row.id,
          "slack_channel",
          row.receipt_id,
          { dueAt: now + 60_000, expectedVersion: 0 },
        ),
      ).toBe("scope_paused");
      const saved = (await env.DB.prepare(
        "SELECT attempts,enqueued_at,available_at,slack_scope_paused_at,last_error,slack_redrive_count FROM outbox WHERE id=?",
      )
        .bind(row.id)
        .first<{
          attempts: number;
          enqueued_at: number | null;
          available_at: number;
          slack_scope_paused_at: number | null;
          last_error: string;
          slack_redrive_count: number;
        }>())!;
      expect(send).not.toHaveBeenCalled();
      expect(checkpoints).toBe(1);
      expect(saved).toMatchObject({
        attempts: mode === "version" ? 1 : 0,
        enqueued_at: mode === "enqueued" ? 123 : null,
        slack_scope_paused_at: mode === "paused" ? 123 : null,
        last_error: "slack_validation_stale",
        slack_redrive_count: 7,
      });
      const timestamp = expect.any(Number);
      expect(saved.available_at).toEqual(mode === "unchanged" ? timestamp : mode === "deadline" ? future : 1);
      expect(saved.available_at).toBeGreaterThanOrEqual(mode === "unchanged" ? now + 30 * 60_000 : 1);

      expect(checkpoints).toBe(1);
    },
  );

  it.each(
    ["channel", "digest", "bulk"].flatMap((path) =>
      ["refresh", "checkpoint"].flatMap((boundary) =>
        ["actor revoked", "claim stolen", "temporary pause", "transient failure"].map((change) => ({
          path,
          boundary,
          change,
        })),
      ),
    ),
  )("fences $path at $boundary after $change", async ({ path, boundary, change }) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const m = await mapping(path === "digest" ? "digest" : "immediate");
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    await page();
    await env.DB.prepare("UPDATE slack_channel_events SET suppressed_at=1").run();
    const window = digestWindow(now, "09:00", "America/Chicago");
    await event(m.id, "page", window.start + 1000, path === "bulk" ? "page_archived" : "page_edit", "dispatch-event");
    await env.DB.prepare("UPDATE slack_channel_events SET actor_id='viewer',cadence=? WHERE id='dispatch-event'")
      .bind(path === "digest" ? "digest" : "immediate")
      .run();
    const table =
      path === "channel" ? "slack_channel_events" : path === "digest" ? "slack_digest_receipts" : "slack_bulk_receipts";
    const id = path === "channel" ? "dispatch-event" : path === "digest" ? (await receipt(m.id)).id : "bulk-dispatch";
    if (path === "bulk") {
      await env.DB.prepare(`INSERT INTO slack_bulk_receipts(id,operation_id,installation_id,installation_generation,channel_id,event_type,event_ids_json,created_at)
        VALUES(?,'bulk-operation','installation',1,'C123','page_archived','["dispatch-event"]',1)`)
        .bind(id)
        .run();
      await env.DB.prepare("UPDATE slack_channel_events SET summary_id=? WHERE id='dispatch-event'").bind(id).run();
    }
    let failed = false;
    const changeAuthority = async () => {
      if (change === "transient failure" && !failed) {
        failed = true;
        throw new Error("Transient dispatch checkpoint failure");
      }
      if (change === "actor revoked")
        await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'").run();
      if (change === "claim stolen")
        await env.DB.prepare(`UPDATE ${table} SET claim_token='other',claimed_at=? WHERE id=?`)
          .bind(now + 2000, id)
          .run();
      if (change === "temporary pause")
        await env.DB.prepare("UPDATE slack_channel_subscriptions SET muted_at=1 WHERE id=?").bind(m.id).run();
    };
    let changed = false;
    const db = afterWrite(
      (sql) =>
        boundary === "refresh"
          ? sql.includes("UPDATE slack_channel_subscriptions SET channel_name=")
          : sql.includes(`UPDATE ${table} SET ${path === "channel" ? "round2_state" : "state"}='sending'`),
      async () => {
        if (changed) return;
        changed = true;
        if (boundary === "refresh") vi.mocked(Date.now).mockReturnValue(now + 2000);
        else await changeAuthority();
      },
    );
    if (boundary === "refresh") {
      await env.DB.prepare("UPDATE slack_installations SET token_expires_at=?,bot_refresh_token_ciphertext=?")
        .bind(now + 61000, await encryptSlackToken(runtime(), "refresh-token"))
        .run();
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).endsWith("/oauth.v2.access")) {
          await changeAuthority();
          return Response.json({ ok: true, access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 });
        }
        return remote(input, init);
      });
    }
    calls = [];
    const deliver = () =>
      path === "channel"
        ? deliverRound2ChannelEvent({ ...runtime(), DB: db }, id)
        : path === "digest"
          ? deliverDigest({ ...runtime(), DB: db }, id)
          : deliverBulkSummary({ ...runtime(), DB: db }, id);
    const failure: unknown = await deliver().catch((error: unknown) => error);
    const expectedError = change === "transient failure" ? Error : DeliveryInProgressError;
    expect(failure === undefined || failure instanceof expectedError).toBe(true);
    expect(
      change !== "transient failure" ||
        (failure instanceof Error && failure.message === "Transient dispatch checkpoint failure"),
    ).toBe(true);
    expect(changed).toBe(true);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    const result = await env.DB.prepare(
      `SELECT ${path === "channel" ? "round2_state" : "state"} state,attempted_at FROM ${table} WHERE id=?`,
    )
      .bind(id)
      .first<{ state: string; attempted_at: number | null }>();
    // A stolen claim retains its new owner's checkpoint; only the losing worker's own claim can be reset.
    expect(change === "claim stolen" || result!.state !== "sending").toBe(true);
    expect(change === "claim stolen" || result!.attempted_at === null).toBe(true);
    if (change === "transient failure") await deliver();
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(
      change === "transient failure" ? 1 : 0,
    );
  });

  it("dispatches and acknowledges only the remaining authorized digest candidates", async () => {
    const m = await mapping();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0 WHERE id=?").bind(m.id).run();
    await page("allowed", { title: "Allowed title" });
    await page("revoked", { title: "Secret title" });
    const window = digestWindow(Date.now(), "09:00", "America/Chicago");
    await event(m.id, "allowed", window.start + 1000, "page_edit", "allowed-event");
    await event(m.id, "revoked", window.start + 1000, "page_edit", "revoked-event");
    await env.DB.prepare("UPDATE slack_channel_events SET actor_id='viewer' WHERE id='revoked-event'").run();
    const r = await receipt(m.id);
    let changed = false;
    const db = afterWrite(
      (sql) => sql.includes("UPDATE slack_channel_subscriptions SET channel_name="),
      async () => {
        if (!changed) {
          changed = true;
          await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'").run();
        }
      },
    );
    calls = [];
    await deliverDigest({ ...runtime(), DB: db }, r.id);
    const post = calls.find((call) => call.method === "chat.postMessage")!;
    expect(JSON.stringify(post.body)).toContain("Allowed title");
    expect(JSON.stringify(post.body)).not.toContain("Secret title");
    const child = await env.DB.prepare(
      "SELECT event_ids_json,page_ids_json FROM slack_digest_messages WHERE receipt_id=?",
    )
      .bind(r.id)
      .first();
    expect(child).toEqual({ event_ids_json: '["allowed-event"]', page_ids_json: '["allowed"]' });
    expect(
      await env.DB.prepare(
        "SELECT delivered_at IS NOT NULL delivered FROM slack_channel_events WHERE id='allowed-event'",
      ).first(),
    ).toEqual({ delivered: 1 });
    expect(
      await env.DB.prepare(
        "SELECT delivered_at IS NOT NULL delivered FROM slack_channel_events WHERE id='revoked-event'",
      ).first(),
    ).toEqual({ delivered: 0 });
  });

  it("rolls back exhaustion records and sibling retirement when the transaction fails", async () => {
    const m = await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox WHERE topic='slack_channel'").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_count=8,slack_redrive_due_at=1 WHERE id=?",
    )
      .bind(row.id)
      .run();
    await env.DB.prepare(`CREATE TRIGGER reject_sibling_retirement BEFORE UPDATE OF last_error ON outbox
      WHEN NEW.last_error='redrive_exhausted' BEGIN SELECT RAISE(ABORT,'retirement unavailable'); END`).run();
    try {
      await expect(redriveRound2Outbox(runtime())).rejects.toThrow("retirement unavailable");
      expect(
        await env.DB.prepare("SELECT round2_state,claim_token FROM slack_channel_events WHERE subscription_id=?")
          .bind(m.id)
          .first(),
      ).toEqual({ round2_state: "pending", claim_token: null });
      expect(
        await env.DB.prepare(
          "SELECT count(*) count FROM slack_delivery_failures WHERE reason='redrive_exhausted'",
        ).first(),
      ).toEqual({ count: 0 });
      expect(
        await env.DB.prepare("SELECT last_error,slack_redrive_due_at FROM outbox WHERE id=?").bind(row.id).first(),
      ).toEqual({ last_error: null, slack_redrive_due_at: 1 });
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_sibling_retirement").run();
    }
    await redriveRound2Outbox(runtime());
    expect(
      await env.DB.prepare("SELECT round2_state,claim_token FROM slack_channel_events WHERE subscription_id=?")
        .bind(m.id)
        .first(),
    ).toEqual({ round2_state: "retired", claim_token: null });
    expect(
      await env.DB.prepare("SELECT last_error,slack_redrive_due_at FROM outbox WHERE id=?").bind(row.id).first(),
    ).toEqual({ last_error: "redrive_exhausted", slack_redrive_due_at: null });
  });
});

describe("remaining delivery recovery regressions", () => {
  it("leaves legacy digest retirement to its bounded cleanup pass", async () => {
    const m = await mapping();
    await page();
    await env.DB.prepare("DELETE FROM slack_channel_events").run();
    await event(m.id, "page", Date.now() - 1, "page_edit", "legacy-denied");
    await env.DB.prepare("UPDATE slack_channel_events SET actor_id='viewer'").run();
    await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'").run();
    await env.DB.prepare("UPDATE slack_channel_subscriptions SET round2_initialized=0").run();
    await dueRound2Digests(runtime());
    expect(await env.DB.prepare("SELECT round2_state,suppressed_at FROM slack_channel_events").first()).toEqual({
      round2_state: "pending",
      suppressed_at: null,
    });
  });

  it("retires denied unreserved digest events while preserving an uncertain partition", async () => {
    const m = await mapping();
    await page();
    await env.DB.prepare("DELETE FROM slack_channel_events").run();
    const r = await receipt(m.id);
    await event(m.id, "page", r.window_end - 2, "page_edit", "uncertain-event");
    await event(m.id, "page", r.window_end - 1, "page_edit", "unreserved-event");
    await env.DB.batch([
      env.DB.prepare("UPDATE slack_channel_events SET actor_id='viewer'"),
      env.DB.prepare("UPDATE slack_digest_receipts SET state='blocked'"),
      env.DB.prepare(`INSERT INTO slack_digest_messages(id,receipt_id,sequence,state,page_ids_json,event_ids_json,attempted_at)
        VALUES('uncertain-message',?,0,'blocked','["page"]','["uncertain-event"]',1)`).bind(r.id),
      env.DB.prepare(
        "INSERT INTO slack_digest_message_events(event_id,message_id) VALUES('uncertain-event','uncertain-message')",
      ),
      env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'"),
    ]);
    await dueRound2Digests(runtime());
    expect(
      (
        await env.DB.prepare(
          "SELECT id,round2_state,suppressed_at IS NOT NULL suppressed FROM slack_channel_events ORDER BY id",
        ).all()
      ).results,
    ).toEqual([
      { id: "uncertain-event", round2_state: "pending", suppressed: 0 },
      { id: "unreserved-event", round2_state: "retired", suppressed: 1 },
    ]);
    expect(
      await env.DB.prepare("SELECT state FROM slack_digest_messages WHERE id='uncertain-message'").first(),
    ).toEqual({ state: "blocked" });
  });

  it("charges an enqueue intent once when one sibling pauses before accounting", async () => {
    await mapping("immediate");
    await page();
    const row = (await env.DB.prepare("SELECT id FROM outbox").first<{ id: string }>())!;
    await env.DB.prepare(
      "UPDATE outbox SET enqueued_at=1,available_at=1,slack_redrive_due_at=1,slack_redrive_count=7",
    ).run();
    await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,enqueued_at,available_at,created_at,slack_redrive_due_at,slack_redrive_count)
      SELECT 'sibling',workspace_id,topic,payload_json,1,1,1,1,7 FROM outbox WHERE id=?`)
      .bind(row.id)
      .run();
    const send = vi.fn(async () => {
      await env.DB.prepare("UPDATE outbox SET slack_scope_paused_at=123 WHERE id=?").bind(row.id).run();
    });
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(
      (await env.DB.prepare("SELECT slack_redrive_count,slack_enqueue_redrive_pending FROM outbox ORDER BY id").all())
        .results,
    ).toEqual([
      { slack_redrive_count: 7, slack_enqueue_redrive_pending: 1 },
      { slack_redrive_count: 8, slack_enqueue_redrive_pending: 0 },
    ]);
    await env.DB.prepare(
      "UPDATE outbox SET slack_scope_paused_at=NULL,enqueued_at=NULL,slack_redrive_due_at=1 WHERE id=?",
    )
      .bind(row.id)
      .run();
    send.mockImplementation(async () => {});
    await redriveRound2Outbox(bindings);
    expect(
      (await env.DB.prepare("SELECT slack_redrive_count,slack_enqueue_redrive_pending FROM outbox").all()).results,
    ).toEqual([
      { slack_redrive_count: 8, slack_enqueue_redrive_pending: 0 },
      { slack_redrive_count: 8, slack_enqueue_redrive_pending: 0 },
    ]);
    await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=1").run();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT round2_state FROM slack_channel_events").first()).toEqual({
      round2_state: "retired",
    });
  });

  it("logs and measures persistent Round 2 enqueue failures with sanitized error text", async () => {
    await mapping("immediate");
    await page();
    await env.DB.prepare("UPDATE outbox SET available_at=1,attempts=9").run();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeDataPoint = vi.fn();
    const send = vi.fn(async () => {
      throw new Error("Queue Authorization: Basic dXNlcjpwYXNz unavailable");
    });
    await sweepOutbox({ ...runtime(), OBSERVABILITY: { writeDataPoint }, DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(log.mock.calls.map(([record]) => record)).toContainEqual(
      expect.objectContaining({
        event: "outbox.enqueue.persistent_failure",
        attempts: 10,
        errorValue: expect.stringContaining("Basic [redacted]"),
      }),
    );
    expect(writeDataPoint.mock.calls.map(([point]) => point)).toContainEqual(
      expect.objectContaining({
        indexes: ["outbox.delivery"],
        blobs: expect.arrayContaining(["outbox", "enqueue", "failure"]),
        doubles: expect.arrayContaining([10]),
      }),
    );
    const row = (await env.DB.prepare("SELECT last_error FROM outbox").first<{ last_error: string }>())!;
    expect(row.last_error).toContain("Basic [redacted]");
    expect(row.last_error).not.toContain("dXNlcjpwYXNz");
  });

  it("deduplicates scope-paused siblings before the recovery limit", async () => {
    const m = await mapping();
    const r = await receipt(m.id);
    await env.DB.prepare(`INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,created_at)
      VALUES('digest-next','installation',1,?,?,?,'C123',1)`)
      .bind(m.id, r.window_start, r.window_end + 1)
      .run();
    await env.DB.prepare(`WITH RECURSIVE siblings(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM siblings WHERE n<49)
      INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_redrive_count)
      SELECT printf('a%03d',n),'workspace','slack_digest','{"digestId":"digest-test"}',1,1,1,1,7 FROM siblings`).run();
    await env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at,slack_scope_paused_at)
      VALUES('paused','workspace','slack_digest','{"digestId":"digest-test"}',1,1,1,1,123),
      ('z-outbox','workspace','slack_digest','{"digestId":"digest-next"}',1,1,1,1,NULL)`).run();
    const now = Date.now();
    const send = vi.fn();
    await redriveRound2Outbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(send).toHaveBeenCalledExactlyOnceWith({ outboxId: "z-outbox" });
    expect(
      await env.DB.prepare(
        "SELECT min(slack_redrive_due_at) due,min(slack_redrive_count) budget,max(attempts) attempts FROM outbox WHERE id LIKE 'a%'",
      ).first(),
    ).toMatchObject({ due: expect.any(Number), budget: 7, attempts: 0 });
    const saved = await env.DB.prepare("SELECT slack_redrive_due_at due FROM outbox WHERE id='a000'").first<{
      due: number;
    }>();
    expect(saved!.due).toBeGreaterThanOrEqual(now + 30 * 60_000);
    expect(
      await env.DB.prepare("SELECT slack_redrive_due_at,slack_scope_paused_at FROM outbox WHERE id='paused'").first(),
    ).toEqual({ slack_redrive_due_at: 1, slack_scope_paused_at: 123 });
  });

  it.each([false, true])(
    "retries enqueue transport failures without losing or duplicating redrive intent (%s)",
    async (ordinary) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      await mapping("immediate");
      await page();
      await env.DB.prepare("UPDATE outbox SET available_at=1,enqueued_at=?,slack_redrive_due_at=?")
        .bind(ordinary ? 1 : null, ordinary ? 1 : null)
        .run();
      const send = vi.fn<() => Promise<void>>(async () => {
        throw new Error("Queue unavailable");
      });
      const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
      if (ordinary) await redriveRound2Outbox(bindings);
      else await sweepOutbox(bindings);
      for (let attempt = 1; attempt <= 11; attempt++) {
        const saved = (await env.DB.prepare(
          "SELECT attempts,enqueued_at,available_at,last_error,slack_redrive_count,slack_enqueue_redrive_pending,slack_claim_recheck_at FROM outbox",
        ).first<{ attempts: number; available_at: number }>())!;
        expect(saved).toMatchObject({
          attempts: attempt,
          enqueued_at: null,
          last_error: "Queue unavailable",
          slack_redrive_count: 0,
          slack_enqueue_redrive_pending: ordinary ? 1 : 0,
          slack_claim_recheck_at: expect.any(Number),
        });
        expect(saved.available_at).toBe(now + Math.min(3_600_000, 10_000 * 2 ** Math.min(attempt - 1, 9)));
        now = saved.available_at + 1;
        if (attempt < 11) await sweepOutbox(bindings);
      }
      send.mockImplementation(async () => {});
      await sweepOutbox(bindings);
      expect(
        await env.DB.prepare("SELECT slack_redrive_count,slack_enqueue_redrive_pending FROM outbox").first(),
      ).toEqual({ slack_redrive_count: ordinary ? 1 : 0, slack_enqueue_redrive_pending: 0 });
      await sweepOutbox(bindings);
      expect(send).toHaveBeenCalledTimes(12);
    },
  );

  it("keeps activity work under Round 2 while validation is disabled", async () => {
    await mapping("immediate");
    await page();
    await env.DB.prepare("UPDATE round2_runtime SET validation_enabled=0 WHERE id=1").run();
    await env.DB.prepare("UPDATE outbox SET available_at=1,enqueued_at=1,slack_redrive_due_at=1").run();
    const send = vi.fn();
    const bindings = {
      ...runtime(),
      SLACK_CHANNEL_VALIDATION_ENABLED: "false",
      DELIVERY_QUEUE: { send },
    } as unknown as Env;
    await redriveStaleSlackOutbox(bindings);
    await env.DB.prepare("UPDATE outbox SET enqueued_at=NULL").run();
    await sweepOutbox(bindings);
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT last_error,slack_redrive_due_at FROM outbox").first()).toEqual({
      last_error: null,
      slack_redrive_due_at: 1,
    });
    await syncRound2Configuration(runtime());
    await sweepOutbox({ ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["unvalidated", "invalid"])("validates a %s bulk contributor before selecting events", async (state) => {
    const m = await mapping("immediate");
    await page();
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM slack_channel_events").run();
    await event(m.id, "page", 1, "page_archived", "bulk-event");
    await env.DB.prepare("UPDATE slack_channel_events SET summary_id='bulk-unvalidated' WHERE id='bulk-event'").run();
    await env.DB.prepare(`INSERT INTO slack_bulk_receipts(id,operation_id,installation_id,installation_generation,channel_id,event_type,created_at)
      VALUES('bulk-unvalidated','operation','installation',1,'C123','page_archived',1)`).run();
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET validation_state=?,validated_at=NULL,notification_blocked_at=NULL",
    )
      .bind(state)
      .run();
    calls = [];
    await deliverBulkSummary(runtime(), "bulk-unvalidated");
    expect(calls.filter((call) => call.method === "conversations.info")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT state FROM slack_bulk_receipts").first()).toEqual({ state: "sent" });
  });

  it.each([2, 3, 4])("preserves temporary channel invalidation at load %s and resumes it", async (boundary) => {
    await mapping("immediate");
    await page();
    const e = (await env.DB.prepare("SELECT id FROM slack_channel_events").first<{ id: string }>())!;
    let reads = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(prepared, method) {
                  if (method === "bind") return (...args: unknown[]) => wrap(prepared.bind(...args));
                  if (method === "first" && sql.includes("SELECT e.*,m.installation_id"))
                    return async () => {
                      reads++;
                      if (reads === boundary)
                        await env.DB.prepare(
                          "UPDATE slack_channel_subscriptions SET validation_state='invalid',validation_error='temporary_failure',notification_blocked_at=1",
                        ).run();
                      return prepared.first();
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
    await deliverRound2ChannelEvent({ ...runtime(), DB: db }, e.id);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT round2_state,attempted_at,delivered_at FROM slack_channel_events WHERE id=?")
        .bind(e.id)
        .first(),
    ).toEqual({ round2_state: "pending", attempted_at: null, delivered_at: null });
    await env.DB.prepare(
      "UPDATE slack_channel_subscriptions SET notification_blocked_at=NULL,validation_state='unvalidated',validation_error=NULL,validated_at=NULL",
    ).run();
    await deliverRound2ChannelEvent(runtime(), e.id);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  });

  it.each(["membership", "protection", "integration"])(
    "retires unreserved digest events after actor %s loss",
    async (authority) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-04T15:00:00Z"));
      const m = await mapping();
      await page();
      await env.DB.prepare("UPDATE slack_channel_subscriptions SET digest_open_work=0").run();
      await env.DB.prepare("DELETE FROM outbox").run();
      await env.DB.prepare("DELETE FROM slack_channel_events").run();
      const window = digestWindow(Date.now(), "09:00", "America/Chicago");
      await event(m.id, "page", window.start + 1, "page_edit", "denied-digest");
      await env.DB.prepare("UPDATE slack_channel_events SET actor_id='viewer'").run();
      if (authority === "membership")
        await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='viewer'").run();
      else if (authority === "protection")
        await env.DB.prepare("UPDATE account_security SET codes_saved=0 WHERE user_id='viewer'").run();
      else {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO user(id,name,email,createdAt,updatedAt,account_type) VALUES('bot','Writer','bot@example.test',1,1,'bot')",
          ),
          env.DB.prepare(
            "INSERT INTO integrations(id,workspace_id,bot_user_id,name,read_content,insert_content,created_by,created_at,updated_at) VALUES('integration','workspace','bot','Writer',1,1,'owner',1,1)",
          ),
          env.DB.prepare(
            "INSERT INTO integration_grants(integration_id,root_page_id,created_by,created_at) VALUES('integration','page','owner',1)",
          ),
          env.DB.prepare("UPDATE slack_channel_events SET actor_id='bot'"),
          env.DB.prepare("UPDATE integrations SET revoked_at=1"),
        ]);
      }
      await dueRound2Digests(runtime());
      const root = (await env.DB.prepare("SELECT id FROM slack_digest_receipts").first<{ id: string }>())!;
      await deliverDigest(runtime(), root.id);
      expect(
        await env.DB.prepare(
          "SELECT round2_state,suppressed_at IS NOT NULL suppressed FROM slack_channel_events",
        ).first(),
      ).toEqual({ round2_state: "retired", suppressed: 1 });
      if (authority === "membership")
        await env.DB.prepare(
          "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','viewer','viewer',1)",
        ).run();
      else if (authority === "protection")
        await env.DB.prepare("UPDATE account_security SET codes_saved=1 WHERE user_id='viewer'").run();
      else await env.DB.prepare("UPDATE integrations SET revoked_at=NULL").run();
      await dueRound2Digests(runtime());
      await deliverDigest(runtime(), root.id);
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
      expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts").first()).toEqual({ state: "skipped" });
    },
  );
});
