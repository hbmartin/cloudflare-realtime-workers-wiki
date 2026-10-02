import { activityMutationStart, activityMutationEnd } from "./activity-mutations";
import { deliverBulkSummary } from "./slack-bulk";
import { consumeDeliveryMessage, sweepOutbox } from "./jobs";
import { recordDeliveryError } from "./slack-delivery";
import { validateMapping } from "./slack-channels";
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
  handleSlackEvent,
  deliverSlackUnfurl,
} from "./slack";
import { deliverShareRefresh } from "./slack-shares";
import { createShare, revokeShare } from "./shares";
import { listActivity } from "./activity";
import { notificationFanoutStatements } from "./notifications";
import { mutateTask, taskListStatements } from "./tasks";
import { deliverThumbnail } from "./slack-files";
import { redriveRound2Outbox } from "./slack-recovery";

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
  await syncRound2Configuration(runtime());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("channel validation and scheduling", () => {
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
      await expect(validateMapping(runtime(), installation, m.id, m.channelId)).resolves.toBe(false);
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
    expect(
      await env.DB.prepare("SELECT suppressed_at FROM slack_channel_events WHERE id='excluded-event'").first(),
    ).toEqual({ suppressed_at: null });
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
    await dueRound2Digests(runtime());
    expect(await env.DB.prepare("SELECT state FROM slack_digest_receipts WHERE id=?").bind(r.id).first()).toEqual({
      state: "pending",
    });
    expect(await env.DB.prepare("SELECT topic FROM outbox WHERE id=?").bind(`outbox:${r.id}`).first()).toEqual({
      topic: "slack_digest",
    });
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
  it("re-observation invalidates rendering evidence and refreshes an edited message", async () => {
    await mapping();
    await page();
    await env.DB.prepare(
      "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,installation_generation) VALUES('installation','owner','U123',1,1)",
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
      "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,installation_generation) VALUES('installation','owner','U123',1,1)",
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
  async function projection(hash = "hash-one") {
    await env.DB.prepare(`INSERT INTO diagram_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,thumbnail_r2_key,thumbnail_hash,thumbnail_byte_size,updated_at)
      VALUES('page',1,1,1,'diagram-key','content-hash',1,'thumbnail-key',?,1,?)
      ON CONFLICT(page_id) DO UPDATE SET thumbnail_hash=excluded.thumbnail_hash,updated_at=excluded.updated_at`)
      .bind(hash, Date.now())
      .run();
    return `file:installation:1:page:1:${hash}`;
  }
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
      expect(send).toHaveBeenCalledTimes(expired ? 0 : 1);
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
  it("migrates pending partitions while preserving historical receipts and private artifacts", async () => {
    await reset();
    const migrations = env.TEST_MIGRATIONS!;
    await applyD1Migrations(env.DB, migrations.slice(0, -1));
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
    await applyD1Migrations(env.DB, migrations.slice(-1));
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
    expect(await env.DB.prepare("SELECT slack_redrive_due_at FROM outbox WHERE id=?").bind(outbox.id).first()).toEqual({
      slack_redrive_due_at: expect.any(Number),
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
      await deliverRound2ChannelEvent(runtime(), queued.id);
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
    expect(await validateMapping(runtime(), installation, m.id, "C123")).toBe(false);
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
    const r = await receipt(m.id);
    await env.DB.batch(
      Array.from({ length: 51 }, (_, n) =>
        env.DB.prepare(
          `INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at) VALUES(?,'workspace','slack_digest',json_object('digestId',?),1,1,1,1)`,
        ).bind(`failed-${String(n).padStart(2, "0")}`, r.id),
      ),
    );
    const send = vi.fn().mockRejectedValue(new Error("Queue unavailable"));
    const bindings = { ...runtime(), DELIVERY_QUEUE: { send } } as unknown as Env;
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(50);
    send.mockClear();
    await redriveRound2Outbox(bindings);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
