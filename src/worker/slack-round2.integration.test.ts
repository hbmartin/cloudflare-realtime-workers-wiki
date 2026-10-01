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
  id = crypto.randomUUID(),
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
    await revalidateMappings(runtime());
    expect(
      await env.DB.prepare("SELECT validation_error FROM slack_channel_subscriptions WHERE id=?").bind(m.id).first(),
    ).toEqual({ validation_error: "not_in_channel" });
    responses["conversations.info"] = { ok: true, channel };
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
    expect((await listActivity(runtime(), owner, { eventType: "task_status_changed" })).items).toHaveLength(1);
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
    const batch = vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("checkpoint unavailable"));
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
