import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, MemberContext } from "./env";
import {
  addCommentReply,
  createCommentThread,
  listCommentThreads,
  setThreadResolved,
  type CommentPage,
} from "./comments";
import {
  acceptSlackReply,
  acceptSlackThreadAction,
  deliverSlackDenial,
  deliverSlackMutation,
  deliverSlackThread,
  setSlackMirror,
  wakeNextSlackDelivery,
} from "./slack-threads";
import {
  encryptSlackToken,
  decryptSlackToken,
  deliverSlackChannelEvent,
  deliverSlackControlsExpiry,
  disconnectSlack,
  handleSlackEvent,
  recordVerifiedSlackIdentity,
  repairSlackChannelNotifications,
  sendDueSlackChannelDigests,
  setSlackChannelPause,
  usableBotToken,
  SlackApiError,
  SlackRateLimitError,
  upsertSlackChannelSubscription,
  verifySlackRequest,
  type SlackEventPayload,
  type SlackInstallation,
} from "./slack";
import { DeliveryInProgressError, notificationFanoutStatements } from "./notifications";
import {
  acceptSlackWorkspaceInteraction,
  deliverSlackWorkspaceAction,
  deliverSlackShareResponse,
  deliverSlackSearchUpdate,
  openSlackSearch,
  purgeExpiredSlackSearchSessions,
  publishSlackHome,
} from "./slack-workspace";
import { consumeDeliveryMessage, redriveStaleSlackOutbox, type DeliveryQueueMessage } from "./jobs";
import worker from "./index";
import { hmacSha256 } from "../shared/security";

const scopes =
  "commands,chat:write,links:read,links:write,channels:read,groups:read,channels:history,groups:history,users:read";
const secrets = {
  SLACK_CLIENT_ID: "123",
  SLACK_CLIENT_SECRET: "secret",
  SLACK_SIGNING_SECRET: "signing",
  SLACK_TOKEN_ENCRYPTION_KEY: "test-token-key-long-enough-for-encryption",
};
const runtime = () => ({ ...env, ...secrets }) as unknown as Env;
async function signedSlackRequest(path: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${Array.from(
    await hmacSha256(secrets.SLACK_SIGNING_SECRET, `v0:${timestamp}:${body}`),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  return new Request(`http://example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body,
  });
}
const owner: MemberContext = {
  user: { id: "owner", name: "Owner", email: "owner@example.test" },
  role: "owner",
  workspace: { id: "workspace", name: "Notes", locationHint: null },
  session: { id: "session", expiresAt: new Date(Date.now() + 60000) },
};
const viewer: MemberContext = {
  ...owner,
  user: { id: "viewer", name: "Viewer", email: "viewer@example.test" },
  role: "viewer",
};
const commentPage: CommentPage = {
  id: "page",
  workspace_id: "workspace",
  space_id: "workspace-general",
  content_epoch: 1,
  created_by: "owner",
  effective_role: "owner",
};
const body = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }];
type Post = {
  channel: string;
  ts: string;
  text: string;
  thread_ts?: string;
  metadata?: { event_type: string; event_payload: { delivery_id: string } };
  user: string;
  blocks?: unknown[];
};
let posts: Post[] = [];
let threadHistoryReplies: Array<{ ts: string; thread_ts: string; user: string; text: string; subtype?: string }> = [];
let calls: { method: string; payload: Record<string, unknown>; httpMethod: string; url: string }[] = [];
let channelExtra: Record<string, unknown> = {};
let userExtra: Record<string, unknown> = {};
let members = ["UOWNER", "UVIEWER"];
let postFailure: "none" | "rate" | "lost" | "unrecorded" | "malformed" | "permission" = "none";
let ephemeralFailure: "none" | "rate" | "lost" = "none";
let userFailure: "none" | "transient" = "none";
let viewFailure: "none" | "not_found" | "transient" | "hash_conflict" = "none";
let historyFailure: "none" | "internal_error" | "service_unavailable" | "no_permission" = "none";
let homePublishFailure: "none" | "lost" = "none";
let homeHash: string | null = null;
let beforeResponse: ((method: string) => Promise<void>) | undefined;

async function mockSlack(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const method = url.pathname.split("/").at(-1)!;
  const payload =
    init?.method === "GET"
      ? Object.fromEntries(url.searchParams)
      : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
  calls.push({ method, payload, httpMethod: init?.method ?? "GET", url: url.toString() });
  if (beforeResponse) await beforeResponse(method);
  if (method === "users.info" && userFailure === "transient")
    return Response.json({ ok: false, error: "service_unavailable" }, { status: 503 });
  if (method === "users.info")
    return Response.json({ ok: true, user: { id: payload.user, team_id: "T123", ...userExtra } });
  if (method === "conversations.info")
    return Response.json({
      ok: true,
      channel: {
        id: payload.channel,
        name: "validated",
        is_channel: true,
        is_member: true,
        is_private: false,
        ...channelExtra,
      },
    });
  if (method === "conversations.members") return Response.json({ ok: true, members });
  if (method === "chat.postMessage") {
    if (postFailure === "permission") return Response.json({ ok: false, error: "no_permission" });
    if (postFailure === "rate") {
      postFailure = "none";
      return Response.json({ ok: false }, { status: 429, headers: { "retry-after": "2" } });
    }
    if (postFailure === "unrecorded") throw new Error("connection lost");
    const post = { ...payload, ts: `${1700000000 + posts.length}.000001`, user: "UBOT" } as Post;
    posts.push(post);
    if (postFailure === "lost") {
      postFailure = "none";
      throw new Error("response lost");
    }
    if (postFailure === "malformed") return Response.json({ ok: true });
    return Response.json({ ok: true, channel: post.channel, ts: post.ts });
  }
  if (method === "conversations.history" && historyFailure !== "none")
    return Response.json({ ok: false, error: historyFailure });
  if (method === "conversations.history" || method === "conversations.replies")
    return Response.json({
      ok: true,
      messages: method === "conversations.replies" ? [...posts, ...threadHistoryReplies] : posts,
      response_metadata: {},
    });
  if (method === "chat.update") return Response.json({ ok: true, channel: payload.channel, ts: payload.ts });
  if (method === "chat.postEphemeral") {
    if (ephemeralFailure === "rate") {
      ephemeralFailure = "none";
      return Response.json({ ok: false }, { status: 429, headers: { "retry-after": "1" } });
    }
    if (ephemeralFailure === "lost") {
      ephemeralFailure = "none";
      throw new Error("ephemeral response lost");
    }
    return Response.json({ ok: true, message_ts: "1700000009.000001" });
  }
  if (method === "views.open") return Response.json({ ok: true, view: { id: "VSEARCH", hash: "hash-open" } });
  if (method === "views.update" && viewFailure === "not_found") return Response.json({ ok: false, error: "not_found" });
  if (method === "views.update" && viewFailure === "transient") {
    viewFailure = "none";
    return Response.json({ ok: false, error: "service_unavailable" }, { status: 503 });
  }
  if (method === "views.update" && viewFailure === "hash_conflict") {
    viewFailure = "none";
    return Response.json({ ok: false, error: "hash_conflict" });
  }
  if (method === "views.update")
    return Response.json({ ok: true, view: { id: payload.view_id, hash: `hash-${calls.length}` } });
  if (method === "views.publish") {
    if (payload.hash && payload.hash !== homeHash) return Response.json({ ok: false, error: "hash_conflict" });
    homeHash = `hash-${calls.length}`;
    if (homePublishFailure === "lost") {
      homePublishFailure = "none";
      throw new Error("Home publish response lost");
    }
    return Response.json({ ok: true, view: { id: "VHOME", hash: homeHash } });
  }
  if (method === "chat.unfurl") return Response.json({ ok: true });
  if (method === "auth.revoke") return Response.json({ ok: true, revoked: true });
  throw new Error(`Unexpected Slack method: ${method}`);
}

async function mapping(id: string, channel = "CSPACE", pageId: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO slack_channel_subscriptions (id, installation_id, space_id, page_id, channel_id, channel_name, created_by, created_at, updated_at) VALUES (?, 'installation', 'workspace-general', ?, ?, 'typed-name', 'owner', 1, 1)`,
  )
    .bind(id, pageId, channel)
    .run();
}
async function thread(actor = owner) {
  return createCommentThread(runtime(), actor, { ...commentPage, effective_role: actor.role }, body("First comment"));
}
async function deliveries(threadId: string) {
  return (
    await env.DB.prepare(
      `SELECT d.* FROM slack_thread_deliveries d JOIN slack_thread_links l ON l.id = d.link_id WHERE l.thread_id = ? ORDER BY d.operation = 'root' DESC, d.created_at, d.id`,
    )
      .bind(threadId)
      .all<{ id: string; operation: string; state: string; link_id: string }>()
  ).results;
}
async function activeThread(actor = owner) {
  await setSlackMirror(runtime(), owner, "space", true);
  const created = await thread(actor);
  await deliverSlackThread(runtime(), (await deliveries(created.id))[0]!.id);
  const link = await env.DB.prepare(
    `SELECT id, root_message_ts FROM slack_thread_links WHERE thread_id = ? AND state = 'active'`,
  )
    .bind(created.id)
    .first<{ id: string; root_message_ts: string }>();
  expect(link).not.toBeNull();
  return { created, link: link! };
}
function reply(
  root: string,
  overrides: Partial<NonNullable<SlackEventPayload["event"]>> = {},
  eventId = "Ev1",
): SlackEventPayload {
  return {
    type: "event_callback",
    event_id: eventId,
    team_id: "T123",
    event: {
      type: "message",
      channel: "CSPACE",
      user: "UVIEWER",
      ts: "1700000100.000001",
      thread_ts: root,
      text: "A Slack reply",
      channel_type: "channel",
      ...overrides,
    },
  };
}
async function inboundId() {
  return (await env.DB.prepare(`SELECT id FROM slack_inbound_receipts ORDER BY received_at DESC LIMIT 1`).first<{
    id: string;
  }>())!.id;
}
async function action(
  link: { id: string; root_message_ts: string },
  resolved = true,
  timestamp = "1700000110.000001",
  user = "UOWNER",
) {
  await acceptSlackThreadAction(runtime(), {
    type: "block_actions",
    team: { id: "T123" },
    user: { id: user },
    channel: { id: "CSPACE" },
    message: { ts: link.root_message_ts },
    actions: [
      {
        action_id: resolved ? "noteflare_thread_resolve" : "noteflare_thread_reopen",
        value: link.id,
        action_ts: timestamp,
      },
    ],
  });
  return (await env.DB.prepare(
    `SELECT id FROM slack_interaction_receipts ORDER BY received_at DESC, rowid DESC LIMIT 1`,
  ).first<{ id: string }>())!.id;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  posts = [];
  threadHistoryReplies = [];
  calls = [];
  channelExtra = {};
  userExtra = {};
  members = ["UOWNER", "UVIEWER"];
  postFailure = "none";
  ephemeralFailure = "none";
  userFailure = "none";
  viewFailure = "none";
  historyFailure = "none";
  homePublishFailure = "none";
  homeHash = null;
  beforeResponse = undefined;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES ('owner','Owner','owner@example.test',1,1), ('viewer','Viewer','viewer@example.test',1,1)`,
    ),
    env.DB.prepare(`INSERT INTO workspaces (id,name,created_at) VALUES ('workspace','Notes',1)`),
    env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('workspace','owner','owner',1), ('workspace','viewer','viewer',1)`,
    ),
    env.DB.prepare(
      `INSERT INTO pages (id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES ('page','workspace','workspace-general','document','a0','Private project title','owner',1,1)`,
    ),
    env.DB.prepare(
      `INSERT INTO slack_installations (id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at) VALUES ('installation','workspace','T123','Slack','UBOT',?,?,'owner',1,1)`,
    ).bind(await encryptSlackToken(runtime(), "xoxb-test"), scopes),
    env.DB.prepare(
      `INSERT INTO account (id,accountId,providerId,userId,createdAt,updatedAt) VALUES ('owner-account','T123:UOWNER','slack','owner',1,1), ('viewer-account','T123:UVIEWER','slack','viewer',1,1)`,
    ),
    env.DB.prepare(
      `INSERT INTO slack_user_links (installation_id,user_id,slack_user_id,linked_at,better_auth_account_id,verification_method,verified_at,migration_state) VALUES ('installation','owner','UOWNER',1,'owner-account','slack_openid',1,'verified'), ('installation','viewer','UVIEWER',1,'viewer-account','slack_openid',1,'verified')`,
    ),
  ]);
  await mapping("space");
  vi.stubGlobal("fetch", vi.fn(mockSlack));
});

describe("interactive Slack workspace", () => {
  async function workspaceAction(input: {
    actionId: string;
    value: string;
    user?: string;
    link?: { id: string; root_message_ts: string };
    actionTs?: string;
    selected?: boolean;
  }) {
    const response = await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: input.user ?? "UOWNER" },
      channel: { id: "CSPACE" },
      message: { ts: input.link?.root_message_ts ?? "1700000000.000001" },
      actions: [
        {
          action_id: input.actionId,
          action_ts: input.actionTs ?? "1700000800.000001",
          ...(input.selected ? { selected_option: { value: input.value } } : { value: input.value }),
        },
      ],
    });
    expect(response.handled).toBe(true);
    const receipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
      .bind(input.actionId)
      .first<{ id: string }>();
    return receipt!.id;
  }

  it("expires a queued button after ten minutes without applying its mutation", async () => {
    const { link } = await activeThread();
    const receiptId = await workspaceAction({ actionId: "noteflare_mapping_mute", value: link.id, link });
    await env.DB.prepare(`UPDATE slack_interaction_receipts SET received_at=? WHERE id=?`)
      .bind(Date.now() - 11 * 60_000, receiptId)
      .run();
    await deliverSlackWorkspaceAction(runtime(), receiptId);
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id=?`).bind(receiptId).first(),
    ).toEqual({ outcome: "expired" });
    expect(await env.DB.prepare(`SELECT muted_at FROM slack_channel_subscriptions WHERE id='space'`).first()).toEqual({
      muted_at: null,
    });
    const denial = await env.DB.prepare(`SELECT payload_json FROM outbox
      WHERE id=?`)
      .bind(`outbox:slack-denial:${receiptId}`)
      .first<{ payload_json: string }>();
    await deliverSlackDenial(runtime(), JSON.parse(denial!.payload_json) as Record<string, unknown>);
    const ephemeral = calls.find((call) => call.method === "chat.postEphemeral")!.payload;
    expect(ephemeral.text).toContain("expired");
    expect(ephemeral).not.toHaveProperty("thread_ts");
  });

  it("notifies the actor when a queued button expires during scheduled redrive", async () => {
    const { link } = await activeThread();
    const receiptId = await workspaceAction({ actionId: "noteflare_mapping_mute", value: link.id, link });
    const stored = await env.DB.prepare(`SELECT payload_json FROM slack_interaction_receipts WHERE id=?`)
      .bind(receiptId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(stored!.payload_json)).toMatchObject({
      installationId: "installation",
      generation: 0,
      channelId: "CSPACE",
      slackUserId: "UOWNER",
      messageTs: link.root_message_ts,
    });
    await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=? WHERE id=?`)
      .bind(Date.now() - 1, `outbox:slack-workspace:${receiptId}`)
      .run();
    await redriveStaleSlackOutbox(runtime());
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id=?`).bind(receiptId).first(),
    ).toEqual({ outcome: "expired" });
    const denial = await env.DB.prepare(`SELECT payload_json FROM outbox WHERE id=?`)
      .bind(`outbox:slack-denial:${receiptId}`)
      .first<{ payload_json: string }>();
    await deliverSlackDenial(runtime(), JSON.parse(denial!.payload_json) as Record<string, unknown>);
    expect(calls.find((call) => call.method === "chat.postEphemeral")?.payload.text).toContain("expired");
  });

  it("deduplicates Watch and owner controls, then rechecks a revoked owner before execution", async () => {
    const { link } = await activeThread();
    const watch = await workspaceAction({ actionId: "noteflare_page_watch", value: link.id, link });
    await workspaceAction({ actionId: "noteflare_page_watch", value: link.id, link });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) count FROM slack_interaction_receipts WHERE callback_id = 'noteflare_page_watch'`,
      ).first(),
    ).toEqual({ count: 1 });
    await deliverSlackWorkspaceAction(runtime(), watch);
    await deliverSlackWorkspaceAction(runtime(), watch);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) count FROM subscriptions WHERE user_id = 'owner' AND resource_type = 'page' AND resource_id = 'page' AND muted_at IS NULL`,
      ).first(),
    ).toEqual({ count: 1 });
    const unwatch = await workspaceAction({
      actionId: "noteflare_page_unwatch",
      value: link.id,
      link,
      actionTs: "1700000801.000001",
    });
    await deliverSlackWorkspaceAction(runtime(), unwatch);
    expect(
      await env.DB.prepare(
        `SELECT muted_at IS NOT NULL muted FROM subscriptions WHERE user_id = 'owner' AND resource_type = 'page' AND resource_id = 'page'`,
      ).first(),
    ).toEqual({ muted: 1 });
    const snooze = await workspaceAction({
      actionId: "noteflare_mapping_snooze",
      value: `${link.id}:8`,
      link,
      selected: true,
      actionTs: "1700000802.000001",
    });
    await deliverSlackWorkspaceAction(runtime(), snooze);
    expect(
      (await env.DB.prepare(`SELECT snoozed_until FROM slack_channel_subscriptions WHERE id = 'space'`).first<{
        snoozed_until: number;
      }>())!.snoozed_until,
    ).toBeGreaterThan(Date.now() + 7 * 3_600_000);
    const mute = await workspaceAction({
      actionId: "noteflare_mapping_mute",
      value: link.id,
      link,
      actionTs: "1700000803.000001",
    });
    await env.DB.prepare(`UPDATE workspace_members SET role = 'owner' WHERE user_id = 'viewer'`).run();
    await env.DB.prepare(`UPDATE workspace_members SET role = 'editor' WHERE user_id = 'owner'`).run();
    await deliverSlackWorkspaceAction(runtime(), mute);
    expect(await env.DB.prepare(`SELECT muted_at FROM slack_channel_subscriptions WHERE id = 'space'`).first()).toEqual(
      { muted_at: null },
    );
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id = ?`).bind(mute).first(),
    ).toEqual({ outcome: "denied" });
  });

  it("delivers the Connect guidance for a revoked workspace action", async () => {
    const { link } = await activeThread();
    const receipt = await workspaceAction({ actionId: "noteflare_page_watch", value: link.id, link });
    await env.DB.prepare(`UPDATE slack_user_links SET migration_state = 'legacy' WHERE user_id = 'owner'`).run();
    await deliverSlackWorkspaceAction(runtime(), receipt);
    const row = await env.DB.prepare(`SELECT payload_json FROM outbox WHERE topic = 'slack_interaction_response'
      ORDER BY rowid DESC LIMIT 1`).first<{ payload_json: string }>();
    expect(JSON.parse(row!.payload_json)).toMatchObject({ reason: "connect" });
    await deliverSlackDenial(runtime(), JSON.parse(row!.payload_json) as Record<string, unknown>);
    expect(calls.filter((call) => call.method === "chat.postEphemeral").at(-1)?.payload.text).toContain(
      "Connect your Slack account",
    );
    expect(calls.filter((call) => call.method === "chat.postEphemeral").at(-1)?.payload.thread_ts).toBeUndefined();
  });

  it("opens search synchronously, pages ten results, and rejects a stale view hash", async () => {
    const pages = Array.from({ length: 12 }, (_, index) => `search-${String(index).padStart(2, "0")}`);
    await env.DB.batch(
      pages.flatMap((id) => [
        env.DB.prepare(`INSERT INTO pages (id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
        VALUES (?, 'workspace', 'workspace-general', 'document', ?, ?, 'owner', 1, 1)`).bind(id, id, `Orchid ${id}`),
        env.DB.prepare(`INSERT INTO page_search_v2
        (page_id,workspace_id,space_id,title,tags,body,comments,attachments)
        VALUES (?, 'workspace', 'workspace-general', ?, '', '', '', '')`).bind(id, `Orchid ${id}`),
      ]),
    );
    const opened = await openSlackSearch(
      runtime(),
      (await env.DB.prepare(`SELECT * FROM slack_installations WHERE id = 'installation'`).first())!,
      "UOWNER",
      "trigger",
      "Orchid",
    );
    expect(opened.text).toBe("");
    const session = await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
    }>();
    await deliverSlackSearchUpdate(runtime(), session!.id, 0);
    const first = calls.find((call) => call.method === "views.update")!;
    expect(
      (first.payload.view as { blocks: Array<{ type: string }> }).blocks.filter(
        (block) => block.type === "section" && JSON.stringify(block).includes("Orchid search-"),
      ),
    ).toHaveLength(10);
    const state = await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id = ?`)
      .bind(session!.id)
      .first<{ view_hash: string }>();
    const next = await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash: state!.view_hash,
        private_metadata: session!.id,
        state: { values: { query: { value: { value: "Orchid" } } } },
      },
      actions: [{ action_id: "noteflare_search_next", action_ts: "1700000900.000001", value: session!.id }],
    });
    expect(next.handled).toBe(true);
    const receipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_search_next'`,
    ).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), receipt!.id);
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json, '$.offset') offset FROM slack_view_sessions WHERE id = ?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ offset: 10 });
    await deliverSlackWorkspaceAction(runtime(), receipt!.id);
    expect(calls.filter((call) => call.method === "views.update")).toHaveLength(2);
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash: state!.view_hash,
        private_metadata: session!.id,
        state: { values: { query: { value: { value: "Orchid" } } } },
      },
      actions: [{ action_id: "noteflare_search_next", action_ts: "1700000900.000002", value: session!.id }],
    });
    const stale = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_search_next' ORDER BY rowid DESC LIMIT 1`,
    ).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), stale!.id);
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id = ?`).bind(stale!.id).first(),
    ).toEqual({ outcome: "superseded" });
    expect(calls.filter((call) => call.method === "views.update")).toHaveLength(2);
  });

  it("honors a Search click from the loading view and repairs a lost stored hash", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id = 'installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "search-race", "Original");
    const session = await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
      view_hash: string;
    }>();
    const click = async (query: string, hash: string, revision: number, actionTs: string) => {
      await acceptSlackWorkspaceInteraction(runtime(), {
        type: "block_actions",
        team: { id: "T123" },
        user: { id: "UOWNER" },
        view: {
          id: "VSEARCH",
          hash,
          private_metadata: `${session!.id}:${revision}`,
          state: { values: { query: { value: { value: query } } } },
        },
        actions: [{ action_id: "noteflare_search_run", action_ts: actionTs, value: session!.id }],
      });
      return (await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
        WHERE callback_id = 'noteflare_search_run' ORDER BY rowid DESC LIMIT 1`).first<{ id: string }>())!.id;
    };
    const loadingClick = await click("While loading", session!.view_hash, 0, "1700000991.000001");
    await deliverSlackSearchUpdate(runtime(), session!.id, 0);
    const firstHash = (await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id = ?`)
      .bind(session!.id)
      .first<{ view_hash: string }>())!.view_hash;
    await deliverSlackWorkspaceAction(runtime(), loadingClick);
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json, '$.query') query FROM slack_view_sessions WHERE id = ?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ query: "While loading" });
    const actualHash = (await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id = ?`)
      .bind(session!.id)
      .first<{ view_hash: string }>())!.view_hash;
    await env.DB.prepare(`UPDATE slack_view_sessions SET view_hash = ?, revision = 1,
      pending_state_json = state_json, pending_revision = 2, pending_token = 'lost-intent' WHERE id = ?`)
      .bind(firstHash, session!.id)
      .run();
    const staleClick = await click("Stale", session!.view_hash, 0, "1700000992.000001");
    expect(await deliverSlackWorkspaceAction(runtime(), staleClick)).toBe("deferred");
    const recoveryClick = await click("Recovered", actualHash, 2, "1700000992.000002");
    await deliverSlackWorkspaceAction(runtime(), recoveryClick);
    expect(await deliverSlackWorkspaceAction(runtime(), staleClick)).toBe("completed");
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id = ?`).bind(staleClick).first(),
    ).toEqual({ outcome: "superseded" });
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json, '$.query') query, pending_state_json pending
      FROM slack_view_sessions WHERE id = ?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ query: "Recovered", pending: null });
    expect(calls.filter((call) => call.method === "views.update").at(-1)?.payload.hash).toBe(actualHash);
  });

  it("defers a loading-view click until its first result update finishes", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "loading-race", "Original");
    const session = (await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
      view_hash: string;
    }>())!;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeResponse = async (method) => {
      if (method === "views.update" && calls.filter((call) => call.method === "views.update").length === 1) {
        enter();
        await held;
      }
    };
    const initial = deliverSlackSearchUpdate(runtime(), session.id, 0);
    await entered;
    await env.DB.prepare(`UPDATE slack_view_sessions SET opening_view_hash=NULL WHERE id=?`).bind(session.id).run();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash: session.view_hash,
        private_metadata: `${session.id}:0`,
        state: { values: { query: { value: { value: "Clicked while loading" } } } },
      },
      actions: [{ action_id: "noteflare_search_run", action_ts: "1700000993.000001", value: session.id }],
    });
    const receipt = (await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
      WHERE callback_id='noteflare_search_run'`).first<{ id: string }>())!;
    expect(await deliverSlackWorkspaceAction(runtime(), receipt.id)).toBe("deferred");
    expect(
      await env.DB.prepare(`SELECT processed_at FROM slack_interaction_receipts WHERE id=?`).bind(receipt.id).first(),
    ).toEqual({ processed_at: null });
    release();
    await initial;
    beforeResponse = undefined;
    expect(await deliverSlackWorkspaceAction(runtime(), receipt.id)).toBe("completed");
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json,'$.query') query FROM slack_view_sessions WHERE id=?`)
        .bind(session.id)
        .first(),
    ).toEqual({ query: "Clicked while loading" });
  });

  it("retries the same Search intent after a transient Slack update failure", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "transient-search", "Original");
    const session = (await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
    }>())!;
    viewFailure = "transient";
    await expect(deliverSlackSearchUpdate(runtime(), session.id, 0)).rejects.toThrow("Slack views.update failed.");
    expect(await deliverSlackSearchUpdate(runtime(), session.id, 0)).toBe("deferred");
    await env.DB.prepare(`UPDATE slack_view_sessions SET pending_lease_until=? WHERE id=?`)
      .bind(Date.now() - 1, session.id)
      .run();
    expect(await deliverSlackSearchUpdate(runtime(), session.id, 0)).toBe("applied");
    expect(
      await env.DB.prepare(`SELECT revision,pending_token FROM slack_view_sessions WHERE id=?`)
        .bind(session.id)
        .first(),
    ).toEqual({ revision: 1, pending_token: null });
  });

  it("retries a receipt-backed Search intent after a transient Slack update failure", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "receipt-retry", "Original");
    const session = (await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
    }>())!;
    await deliverSlackSearchUpdate(runtime(), session.id, 0);
    const hash = (await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id=?`)
      .bind(session.id)
      .first<{ view_hash: string }>())!.view_hash;
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash,
        private_metadata: `${session.id}:1`,
        state: { values: { query: { value: { value: "Retry this search" } } } },
      },
      actions: [{ action_id: "noteflare_search_run", action_ts: "1700000995.000001", value: session.id }],
    });
    const receipt = (await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
      WHERE callback_id='noteflare_search_run'`).first<{ id: string }>())!;
    viewFailure = "transient";
    await expect(deliverSlackWorkspaceAction(runtime(), receipt.id)).rejects.toThrow("Slack views.update failed.");
    expect(await deliverSlackWorkspaceAction(runtime(), receipt.id)).toBe("deferred");
    await env.DB.prepare(`UPDATE slack_view_sessions SET pending_lease_until=? WHERE id=?`)
      .bind(Date.now() - 1, session.id)
      .run();
    expect(await deliverSlackWorkspaceAction(runtime(), receipt.id)).toBe("completed");
    expect(
      await env.DB.prepare(
        `SELECT json_extract(state_json,'$.query') query,pending_token FROM slack_view_sessions WHERE id=?`,
      )
        .bind(session.id)
        .first(),
    ).toEqual({ query: "Retry this search", pending_token: null });
  });

  it("keeps an expired Search owner's ambiguous intent fenced until the modal is reopened", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "abandoned-search", "Original");
    const session = (await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
    }>())!;
    await deliverSlackSearchUpdate(runtime(), session.id, 0);
    const hash = (await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id=?`)
      .bind(session.id)
      .first<{ view_hash: string }>())!.view_hash;
    const click = async (query: string, actionTs: string) => {
      await acceptSlackWorkspaceInteraction(runtime(), {
        type: "block_actions",
        team: { id: "T123" },
        user: { id: "UOWNER" },
        view: {
          id: "VSEARCH",
          hash,
          private_metadata: `${session.id}:1`,
          state: { values: { query: { value: { value: query } } } },
        },
        actions: [{ action_id: "noteflare_search_run", action_ts: actionTs, value: session.id }],
      });
      return (await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
        WHERE callback_id='noteflare_search_run' ORDER BY rowid DESC LIMIT 1`).first<{ id: string }>())!.id;
    };
    const first = await click("Abandoned", "1700000996.000001");
    viewFailure = "transient";
    await expect(deliverSlackWorkspaceAction(runtime(), first)).rejects.toThrow("Slack views.update failed.");
    await env.DB.batch([
      env.DB.prepare(`UPDATE slack_interaction_receipts SET processed_at=?,outcome='expired' WHERE id=?`).bind(
        Date.now(),
        first,
      ),
      env.DB.prepare(`UPDATE slack_view_sessions SET pending_started_at=?,pending_lease_until=? WHERE id=?`).bind(
        Date.now() - 11 * 60_000,
        Date.now() - 1,
        session.id,
      ),
    ]);
    const second = await click("Current", "1700000996.000002");
    expect(await deliverSlackWorkspaceAction(runtime(), second)).toBe("completed");
    expect(
      await env.DB.prepare(
        `SELECT json_extract(state_json,'$.query') query,pending_token FROM slack_view_sessions WHERE id=?`,
      )
        .bind(session.id)
        .first(),
    ).toEqual({ query: "Original", pending_token: first });
  });

  it("keeps an abandoned initial Search load fenced after ten minutes", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "old-load", "Original");
    const session = (await env.DB.prepare(`SELECT id,view_hash FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
      view_hash: string;
    }>())!;
    viewFailure = "transient";
    await expect(deliverSlackSearchUpdate(runtime(), session.id, 0)).rejects.toThrow("Slack views.update failed.");
    await env.DB.prepare(`UPDATE slack_view_sessions SET pending_started_at=?,pending_lease_until=? WHERE id=?`)
      .bind(Date.now() - 11 * 60_000, Date.now() - 1, session.id)
      .run();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash: session.view_hash,
        private_metadata: `${session.id}:0`,
        state: { values: { query: { value: { value: "New request" } } } },
      },
      actions: [{ action_id: "noteflare_search_run", action_ts: "1700000996.000003", value: session.id }],
    });
    const receipt = (await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
      WHERE callback_id='noteflare_search_run'`).first<{ id: string }>())!;
    expect(await deliverSlackWorkspaceAction(runtime(), receipt.id)).toBe("completed");
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json,'$.query') query FROM slack_view_sessions WHERE id=?`)
        .bind(session.id)
        .first(),
    ).toEqual({ query: "Original" });
  });

  it("stops polling an uncertain Search update while retaining its recovery intent", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "uncertain-search", "Original");
    const session = (await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
    }>())!;
    viewFailure = "transient";
    await expect(deliverSlackSearchUpdate(runtime(), session.id, 0)).rejects.toThrow("Slack views.update failed.");
    await env.DB.prepare(`UPDATE slack_view_sessions SET pending_lease_until=? WHERE id=?`)
      .bind(Date.now() - 1, session.id)
      .run();
    viewFailure = "hash_conflict";
    expect(await deliverSlackSearchUpdate(runtime(), session.id, 0)).toBe("uncertain");
    const updates = calls.filter((call) => call.method === "views.update").length;
    expect(await deliverSlackSearchUpdate(runtime(), session.id, 0)).toBe("uncertain");
    expect(calls.filter((call) => call.method === "views.update")).toHaveLength(updates);
    expect(
      (await env.DB.prepare(`SELECT pending_token FROM slack_view_sessions WHERE id=?`)
        .bind(session.id)
        .first<{ pending_token: string }>())!.pending_token,
    ).toMatch(/^initial:/);
  });

  it("bounds Search updates to five API attempts and retains the unresolved intent", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "five-attempts", "Original");
    const session = (await env.DB.prepare(`SELECT id,created_at FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
      created_at: number;
    }>())!;
    for (let attempt = 0; attempt < 5; attempt++) {
      viewFailure = "transient";
      await expect(deliverSlackSearchUpdate(runtime(), session.id, 0)).rejects.toThrow("Slack views.update failed.");
      await env.DB.prepare(`UPDATE slack_view_sessions SET pending_lease_until=1 WHERE id=?`).bind(session.id).run();
    }
    expect(await deliverSlackSearchUpdate(runtime(), session.id, 0)).toBe("uncertain");
    expect(calls.filter((call) => call.method === "views.update")).toHaveLength(5);
    expect(
      await env.DB.prepare(`SELECT pending_attempts,created_at,pending_token IS NOT NULL fenced
      FROM slack_view_sessions WHERE id=?`)
        .bind(session.id)
        .first(),
    ).toEqual({ pending_attempts: 5, created_at: session.created_at, fenced: 1 });
  });

  it("keeps concurrent Search clicks from replacing one another's pending intent", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "concurrent-search", "Original");
    const session = (await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind='search'`).first<{
      id: string;
    }>())!;
    await deliverSlackSearchUpdate(runtime(), session.id, 0);
    const hash = (await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id=?`)
      .bind(session.id)
      .first<{ view_hash: string }>())!.view_hash;
    const click = async (query: string, actionTs: string) => {
      await acceptSlackWorkspaceInteraction(runtime(), {
        type: "block_actions",
        team: { id: "T123" },
        user: { id: "UOWNER" },
        view: {
          id: "VSEARCH",
          hash,
          private_metadata: session.id,
          state: { values: { query: { value: { value: query } } } },
        },
        actions: [{ action_id: "noteflare_search_run", action_ts: actionTs, value: session.id }],
      });
      return (await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
        WHERE callback_id='noteflare_search_run' ORDER BY rowid DESC LIMIT 1`).first<{ id: string }>())!.id;
    };
    const first = await click("First", "1700000994.000001");
    const second = await click("Second", "1700000994.000002");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeResponse = async (method) => {
      if (method === "views.update") {
        enter();
        await held;
      }
    };
    const firstWork = deliverSlackWorkspaceAction(runtime(), first);
    await entered;
    expect(await deliverSlackWorkspaceAction(runtime(), second)).toBe("deferred");
    expect(
      await env.DB.prepare(`SELECT pending_token FROM slack_view_sessions WHERE id=?`).bind(session.id).first(),
    ).toEqual({ pending_token: first });
    release();
    await firstWork;
    beforeResponse = undefined;
    await deliverSlackWorkspaceAction(runtime(), second);
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id=?`).bind(second).first(),
    ).toEqual({ outcome: "superseded" });
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json,'$.query') query FROM slack_view_sessions WHERE id=?`)
        .bind(session.id)
        .first(),
    ).toEqual({ query: "First" });
  });

  it("retires a closed Search modal without retrying its update", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id = 'installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "closed-modal", "Orchid");
    const session = await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
    }>();
    viewFailure = "not_found";
    await deliverSlackSearchUpdate(runtime(), session!.id, 0);
    expect(
      await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE id = ?`).bind(session!.id).first(),
    ).toBeNull();
  });

  it("maps every Slack search input to SearchFilters and rechecks page visibility", async () => {
    await env.DB.batch([
      env.DB
        .prepare(`INSERT INTO pages (id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,archived_at)
        VALUES ('filtered', 'workspace', 'workspace-general', 'table', 'z', 'Orchid filtered', 'owner', 1, 1, 2)`),
      env.DB.prepare(`INSERT INTO page_search_v2
        (page_id,workspace_id,space_id,title,tags,body,comments,attachments)
        VALUES ('filtered', 'workspace', 'workspace-general', 'Orchid filtered', 'launch', '', '', '')`),
      env.DB.prepare(`INSERT INTO tags (id,workspace_id,name,created_by,created_at,updated_at)
        VALUES ('launch', 'workspace', 'Launch', 'owner', 1, 1)`),
      env.DB.prepare(
        `INSERT INTO page_tags (page_id,tag_id,created_by,created_at) VALUES ('filtered', 'launch', 'owner', 1)`,
      ),
    ]);
    const installed = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id = 'installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installed, "UOWNER", "trigger", "Orchid");
    const session = await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
    }>();
    await deliverSlackSearchUpdate(runtime(), session!.id, 0);
    const current = await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id = ?`)
      .bind(session!.id)
      .first<{ view_hash: string }>();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash: current!.view_hash,
        private_metadata: session!.id,
        state: {
          values: {
            query: { value: { value: "Orchid" } },
            space: { value: { selected_option: { value: "workspace-general" } } },
            tags: { value: { selected_options: [{ value: "launch" }] } },
            kind: { value: { selected_option: { value: "table" } } },
            archive: { value: { selected_option: { value: "archived" } } },
          },
        },
      },
      actions: [{ action_id: "noteflare_search_run", action_ts: "1700000910.000001", value: session!.id }],
    });
    const receipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_search_run'`,
    ).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), receipt!.id);
    const update = calls.filter((call) => call.method === "views.update").at(-1)!;
    expect(JSON.stringify(update.payload.view)).toContain("Orchid filtered");
    const blocks = (update.payload.view as { blocks: Array<{ block_id?: string; element?: Record<string, unknown> }> })
      .blocks;
    expect(blocks.find((block) => block.block_id === "space")?.element?.initial_option).toMatchObject({
      value: "workspace-general",
    });
    expect(blocks.find((block) => block.block_id === "tags")?.element?.initial_options).toMatchObject([
      { value: "launch" },
    ]);
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json, '$.kind') kind,
      json_extract(state_json, '$.archive') archive FROM slack_view_sessions WHERE id = ?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ kind: "table", archive: "archived" });
    await env.DB.prepare(`DELETE FROM page_tags WHERE page_id = 'filtered'`).run();
    const newer = await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id = ?`)
      .bind(session!.id)
      .first<{ view_hash: string }>();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash: newer!.view_hash,
        private_metadata: session!.id,
        state: {
          values: {
            query: { value: { value: "Orchid" } },
            space: { value: { selected_option: { value: "workspace-general" } } },
            tags: { value: { selected_options: [{ value: "launch" }] } },
            kind: { value: { selected_option: { value: "table" } } },
            archive: { value: { selected_option: { value: "archived" } } },
          },
        },
      },
      actions: [{ action_id: "noteflare_search_run", action_ts: "1700000910.000002", value: session!.id }],
    });
    const next = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_search_run' ORDER BY rowid DESC LIMIT 1`,
    ).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), next!.id);
    expect(JSON.stringify(calls.filter((call) => call.method === "views.update").at(-1)!.payload.view)).toContain(
      "No accessible pages matched",
    );
    const emptyBlocks = (
      calls.filter((call) => call.method === "views.update").at(-1)!.payload.view as {
        blocks: Array<{ block_id?: string }>;
      }
    ).blocks;
    expect(emptyBlocks.some((block) => block.block_id === "search_navigation")).toBe(false);
  });

  it("opens a valid input modal and deduplicates Done submissions before expiring the session", async () => {
    const installed = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id = 'installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installed, "UOWNER", "trigger", "Orchid");
    expect(
      (calls.find((call) => call.method === "views.open")!.payload.view as { submit: { text: string } }).submit.text,
    ).toBe("Done");
    const session = await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
      view_hash: string;
    }>();
    const submission = {
      type: "view_submission",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: { callback_id: "noteflare_search", private_metadata: session!.id, id: "VSEARCH", hash: session!.view_hash },
    };
    expect((await acceptSlackWorkspaceInteraction(runtime(), submission)).response).toEqual({});
    expect((await acceptSlackWorkspaceInteraction(runtime(), submission)).response).toEqual({});
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) count FROM slack_interaction_receipts WHERE callback_id = 'noteflare_search_done'`,
      ).first(),
    ).toEqual({ count: 1 });
    await env.DB.prepare(`UPDATE slack_view_sessions SET created_at = 1 WHERE id = ?`).bind(session!.id).run();
    await purgeExpiredSlackSearchSessions(runtime());
    expect(await env.DB.prepare(`SELECT 1 FROM slack_view_sessions WHERE id = ?`).bind(session!.id).first()).toBeNull();
  });

  it("clears the query when Slack submits a null input value", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id = 'installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "clear-trigger", "Orchid");
    const session = await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
    }>();
    await deliverSlackSearchUpdate(runtime(), session!.id, 0);
    const current = await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id = ?`)
      .bind(session!.id)
      .first<{ view_hash: string }>();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: {
        id: "VSEARCH",
        hash: current!.view_hash,
        private_metadata: session!.id,
        state: { values: { query: { value: { value: null } } } },
      },
      actions: [{ action_id: "noteflare_search_run", action_ts: "1700000990.000001", value: session!.id }],
    });
    const receipt = await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
      WHERE callback_id = 'noteflare_search_run'`).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), receipt!.id);
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json, '$.query') query FROM slack_view_sessions WHERE id = ?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ query: "" });
  });

  it("opens a signed legacy-linked search with a verification prompt", async () => {
    await env.DB.prepare(`UPDATE slack_user_links SET migration_state = 'legacy',
      verification_method = 'legacy_command', verified_at = NULL WHERE user_id = 'viewer'`).run();
    const context = createExecutionContext();
    const response = await worker.fetch(
      await signedSlackRequest(
        "/api/slack/commands",
        new URLSearchParams({
          team_id: "T123",
          user_id: "UVIEWER",
          trigger_id: "legacy-trigger",
          text: "Orchid",
        }).toString(),
      ),
      runtime(),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await waitOnExecutionContext(context);
    const session = await env.DB.prepare(`SELECT id FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
    }>();
    await deliverSlackSearchUpdate(runtime(), session!.id, 0);
    expect(JSON.stringify(calls.find((call) => call.method === "views.update")?.payload.view)).toContain(
      "Verify your Slack identity in NoteFlare Settings",
    );
  });

  it("serves signed Space and Tags option loads", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tags (id,workspace_id,name,created_by,created_at,updated_at)
        VALUES ('launch','workspace','Launch','owner',1,1)`),
      env.DB.prepare(`INSERT INTO page_tags (page_id,tag_id,created_by,created_at)
        VALUES ('page','launch','owner',1)`),
    ]);
    const suggest = async (blockId: "space" | "tags") => {
      const payload = {
        type: "block_suggestion",
        team: { id: "T123" },
        user: { id: "UOWNER" },
        view: { callback_id: "noteflare_search" },
        action_id: "value",
        block_id: blockId,
        value: "a",
      };
      const context = createExecutionContext();
      const response = await worker.fetch(
        await signedSlackRequest(
          "/api/slack/interactions",
          new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
        ),
        runtime(),
        context,
      );
      expect(response.status).toBe(200);
      const result = await response.json<{ options: Array<{ value: string }> }>();
      await waitOnExecutionContext(context);
      return result.options.map((option) => option.value);
    };
    expect(await suggest("space")).toContain("workspace-general");
    expect(await suggest("tags")).toContain("launch");
  });

  it("acknowledges a signed Done submission with an empty body", async () => {
    const installation = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id = 'installation'`,
    ).first<SlackInstallation>())!;
    await openSlackSearch(runtime(), installation, "UOWNER", "done-trigger", "Orchid");
    const session = await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind = 'search'`).first<{
      id: string;
      view_hash: string;
    }>();
    const payload = {
      type: "view_submission",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      view: { callback_id: "noteflare_search", private_metadata: session!.id, id: "VSEARCH", hash: session!.view_hash },
    };
    const context = createExecutionContext();
    const response = await worker.fetch(
      await signedSlackRequest(
        "/api/slack/interactions",
        new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
      ),
      runtime(),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await waitOnExecutionContext(context);
    const staleContext = createExecutionContext();
    const stale = await worker.fetch(
      await signedSlackRequest(
        "/api/slack/interactions",
        new URLSearchParams({
          payload: JSON.stringify({ ...payload, view: { ...payload.view, hash: "stale-hash" } }),
        }).toString(),
      ),
      runtime(),
      staleContext,
    );
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("");
    await waitOnExecutionContext(staleContext);
  });

  it("navigates Home by Mentions cursors, records actor context, and marks the snapshot read", async () => {
    const timestamp = Date.now() - 1000;
    await env.DB.batch(
      Array.from({ length: 12 }, (_, index) => {
        const id = `mention-${String(index).padStart(2, "0")}`;
        return [
          env.DB.prepare(`INSERT INTO pages (id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
          VALUES (?, 'workspace', 'workspace-general', 'document', ?, ?, 'owner', 1, 1)`).bind(
            id,
            id,
            `Mention ${index}`,
          ),
          env.DB.prepare(`INSERT INTO member_mentions
          (workspace_id,source_page_id,target_user_id,excerpt,first_seen_at,first_seen_actor_id,projection_seq)
          VALUES ('workspace', ?, 'viewer', 'A useful excerpt', ?, 'owner', 1)`).bind(id, timestamp - index),
        ];
      }).flat(),
    );
    await publishSlackHome(runtime(), "installation", "UVIEWER");
    const first = calls.find((call) => call.method === "views.publish")!;
    expect(JSON.stringify(first.payload.view)).toContain("Owner mentioned you");
    expect(
      (first.payload.view as { blocks: Array<{ type: string }> }).blocks.filter((block) => block.type === "section"),
    ).toHaveLength(10);
    const session = await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind = 'home'`).first<{
      id: string;
      view_hash: string;
    }>();
    const next = await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UVIEWER" },
      view: { id: "VHOME", hash: session!.view_hash, private_metadata: session!.id },
      actions: [{ action_id: "noteflare_home_next", action_ts: "1700000901.000001", value: session!.id }],
    });
    expect(next.handled).toBe(true);
    const nextReceipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_home_next'`,
    ).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), nextReceipt!.id);
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json, '$.page') page FROM slack_view_sessions WHERE id = ?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ page: 1 });
    const current = await env.DB.prepare(`SELECT view_hash FROM slack_view_sessions WHERE id = ?`)
      .bind(session!.id)
      .first<{ view_hash: string }>();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UVIEWER" },
      view: { id: "VHOME", hash: current!.view_hash, private_metadata: session!.id },
      actions: [{ action_id: "noteflare_home_read", action_ts: "1700000902.000001", value: session!.id }],
    });
    const readReceipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_home_read'`,
    ).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), readReceipt!.id);
    expect(await env.DB.prepare(`SELECT read_at FROM mention_reads WHERE user_id = 'viewer'`).first()).toEqual({
      read_at: (await env.DB.prepare(
        `SELECT json_extract(state_json, '$.asOf') asOf FROM slack_view_sessions WHERE id = ?`,
      )
        .bind(session!.id)
        .first<{ asOf: number }>())!.asOf,
    });
  });

  it("keeps concurrent Home Next clicks on one page", async () => {
    const timestamp = Date.now() - 1_000;
    await env.DB.batch(
      Array.from({ length: 21 }, (_, index) => {
        const id = `concurrent-mention-${index}`;
        return [
          env.DB.prepare(`INSERT INTO pages (id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
            VALUES (?, 'workspace', 'workspace-general', 'document', ?, ?, 'owner', 1, 1)`).bind(
            id,
            id,
            `Mention ${index}`,
          ),
          env.DB.prepare(`INSERT INTO member_mentions
            (workspace_id,source_page_id,target_user_id,excerpt,first_seen_at,projection_seq)
            VALUES ('workspace', ?, 'viewer', 'Excerpt', ?, 1)`).bind(id, timestamp - index),
        ];
      }).flat(),
    );
    await publishSlackHome(runtime(), "installation", "UVIEWER");
    const session = await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind = 'home'`).first<{
      id: string;
      view_hash: string;
    }>();
    for (const actionTs of ["1700000908.000001", "1700000908.000002"])
      await acceptSlackWorkspaceInteraction(runtime(), {
        type: "block_actions",
        team: { id: "T123" },
        user: { id: "UVIEWER" },
        view: { id: "VHOME", hash: session!.view_hash, private_metadata: session!.id },
        actions: [{ action_id: "noteflare_home_next", action_ts: actionTs, value: session!.id }],
      });
    const receipts = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_home_next'`,
    ).all<{ id: string }>();
    await Promise.allSettled(receipts.results.map((receipt) => deliverSlackWorkspaceAction(runtime(), receipt.id)));
    await Promise.all(receipts.results.map((receipt) => deliverSlackWorkspaceAction(runtime(), receipt.id)));
    const outcomes = await env.DB.prepare(
      `SELECT outcome FROM slack_interaction_receipts WHERE callback_id = 'noteflare_home_next' ORDER BY outcome`,
    ).all<{ outcome: string }>();
    expect(outcomes.results.map((row) => row.outcome)).toEqual(["accepted", "superseded"]);
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json, '$.page') page FROM slack_view_sessions WHERE id = ?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ page: 1 });
  });

  it("reconciles a Home publish whose Slack response was lost", async () => {
    const timestamp = Date.now() - 1_000;
    await env.DB.batch(
      Array.from({ length: 11 }, (_, index) => {
        const id = `lost-home-mention-${index}`;
        return [
          env.DB.prepare(`INSERT INTO pages (id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
            VALUES (?, 'workspace', 'workspace-general', 'document', ?, ?, 'owner', 1, 1)`).bind(id, id, id),
          env.DB.prepare(`INSERT INTO member_mentions
            (workspace_id,source_page_id,target_user_id,excerpt,first_seen_at,projection_seq)
            VALUES ('workspace', ?, 'viewer', 'Excerpt', ?, 1)`).bind(id, timestamp - index),
        ];
      }).flat(),
    );
    await publishSlackHome(runtime(), "installation", "UVIEWER");
    const session = await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind = 'home'`).first<{
      id: string;
      view_hash: string;
    }>();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UVIEWER" },
      view: { id: "VHOME", hash: session!.view_hash, private_metadata: session!.id },
      actions: [{ action_id: "noteflare_home_next", action_ts: "1700000909.000001", value: session!.id }],
    });
    const receipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_home_next'`,
    ).first<{ id: string }>();
    homePublishFailure = "lost";
    await expect(deliverSlackWorkspaceAction(runtime(), receipt!.id)).rejects.toThrow("Home publish response lost");
    await deliverSlackWorkspaceAction(runtime(), receipt!.id);
    const current = await env.DB.prepare(
      `SELECT json_extract(state_json, '$.page') page, view_hash, pending_token FROM slack_view_sessions WHERE id = ?`,
    )
      .bind(session!.id)
      .first<{ page: number; view_hash: string; pending_token: string | null }>();
    expect(current).toMatchObject({ page: 1, view_hash: homeHash, pending_token: null });
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id = ?`).bind(receipt!.id).first(),
    ).toEqual({ outcome: "accepted" });
    expect(calls.filter((call) => call.method === "views.publish").at(-1)?.payload.hash).toBeUndefined();
  });

  it("refreshes Home through queued open events, including older numeric reset payloads", async () => {
    const consume = async (id: string) =>
      consumeDeliveryMessage(runtime(), {
        body: { outboxId: id },
        ack: vi.fn(),
        retry: vi.fn(),
      } as unknown as Message<DeliveryQueueMessage>);
    await handleSlackEvent(runtime(), {
      type: "event_callback",
      event_id: "home-first",
      team_id: "T123",
      event: { type: "app_home_opened", user: "UVIEWER" },
    });
    expect(
      await env.DB.prepare(
        `SELECT json_type(payload_json, '$.reset') kind FROM outbox WHERE id = 'outbox:slack-home:home-first'`,
      ).first(),
    ).toEqual({ kind: "true" });
    await consume("outbox:slack-home:home-first");
    const first = await env.DB.prepare(
      `SELECT json_extract(state_json, '$.asOf') asOf FROM slack_view_sessions WHERE kind = 'home'`,
    ).first<{ asOf: number }>();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await env.DB.prepare(`INSERT INTO member_mentions
      (workspace_id,source_page_id,target_user_id,excerpt,first_seen_at,projection_seq)
      VALUES ('workspace','page','viewer','New mention',?,1)`)
      .bind(Date.now())
      .run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handleSlackEvent(runtime(), {
      type: "event_callback",
      event_id: "home-second",
      team_id: "T123",
      event: { type: "app_home_opened", user: "UVIEWER" },
    });
    await consume("outbox:slack-home:home-second");
    const second = await env.DB.prepare(
      `SELECT json_extract(state_json, '$.asOf') asOf FROM slack_view_sessions WHERE kind = 'home'`,
    ).first<{ asOf: number }>();
    expect(second!.asOf).toBeGreaterThan(first!.asOf);
    expect(JSON.stringify(calls.filter((call) => call.method === "views.publish").at(-1)?.payload.view)).toContain(
      "Private project title",
    );
    await env.DB.prepare(`INSERT INTO outbox (id,workspace_id,topic,payload_json,available_at,created_at)
      VALUES ('outbox:old-home-reset','workspace','slack_home_publish',
        json_object('installationId','installation','userId','UVIEWER','reset',1),?,?)`)
      .bind(Date.now(), Date.now())
      .run();
    await consume("outbox:old-home-reset");
    expect(calls.filter((call) => call.method === "views.publish")).toHaveLength(3);
  });

  it("retries a transient identity lookup instead of publishing an unavailable Home", async () => {
    userFailure = "transient";
    await expect(publishSlackHome(runtime(), "installation", "UOWNER")).rejects.toBeInstanceOf(SlackApiError);
    expect(calls.filter((call) => call.method === "views.publish")).toHaveLength(0);
    userFailure = "none";
    await publishSlackHome(runtime(), "installation", "UOWNER");
    expect(JSON.stringify(calls.filter((call) => call.method === "views.publish").at(-1)?.payload.view)).not.toContain(
      "inbox is unavailable",
    );
  });

  it("rechecks Home identity after receipt ingestion and publishes an unavailable state", async () => {
    await env.DB.prepare(`INSERT INTO member_mentions
      (workspace_id,source_page_id,target_user_id,excerpt,first_seen_at,first_seen_actor_id,projection_seq)
      VALUES ('workspace', 'page', 'viewer', 'Private excerpt', ?, 'owner', 1)`)
      .bind(Date.now() - 1000)
      .run();
    await publishSlackHome(runtime(), "installation", "UVIEWER");
    const session = await env.DB.prepare(`SELECT id, view_hash FROM slack_view_sessions WHERE kind = 'home'`).first<{
      id: string;
      view_hash: string;
    }>();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UVIEWER" },
      view: { id: "VHOME", hash: session!.view_hash, private_metadata: session!.id },
      actions: [{ action_id: "noteflare_home_read", action_ts: "1700000904.000001", value: session!.id }],
    });
    const receipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_home_read'`,
    ).first<{ id: string }>();
    await env.DB.prepare(`UPDATE slack_view_sessions SET state_json=json_set(state_json,'$.page',1)
      WHERE id=?`)
      .bind(session!.id)
      .run();
    await env.DB.prepare(`DELETE FROM workspace_members WHERE user_id = 'viewer'`).run();
    await deliverSlackWorkspaceAction(runtime(), receipt!.id);
    expect(await env.DB.prepare(`SELECT 1 FROM mention_reads WHERE user_id = 'viewer'`).first()).toBeNull();
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id = ?`).bind(receipt!.id).first(),
    ).toEqual({ outcome: "denied" });
    expect(
      await env.DB.prepare(`SELECT json_extract(payload_json,'$.reset') reset FROM outbox
      WHERE id=?`)
        .bind(`outbox:slack-home:unavailable:${receipt!.id}`)
        .first(),
    ).toEqual({ reset: 0 });
    homeHash = "newer-remote-hash";
    await publishSlackHome(runtime(), "installation", "UVIEWER");
    expect(
      await env.DB.prepare(`SELECT json_extract(state_json,'$.page') page FROM slack_view_sessions WHERE id=?`)
        .bind(session!.id)
        .first(),
    ).toEqual({ page: 1 });
    expect(JSON.stringify(calls.filter((call) => call.method === "views.publish").at(-1)!.payload.view)).toContain(
      "inbox is unavailable",
    );
    expect(calls.filter((call) => call.method === "views.publish").at(-1)!.payload.hash).toBeUndefined();
  });

  it("acknowledges a signed slash command while a modal open call stalls", async () => {
    beforeResponse = async (method) => {
      if (method === "views.open") await new Promise((resolve) => setTimeout(resolve, 3500));
    };
    const formBody = new URLSearchParams({
      team_id: "T123",
      user_id: "UOWNER",
      trigger_id: "trigger",
      text: "Orchid",
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `v0=${Array.from(
      await hmacSha256(secrets.SLACK_SIGNING_SECRET, `v0:${timestamp}:${formBody}`),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}`;
    const context = createExecutionContext();
    const started = performance.now();
    const response = await worker.fetch(
      new Request("http://example.test/api/slack/commands", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": signature,
        },
        body: formBody,
      }),
      runtime(),
      context,
    );
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(3000);
    expect((await response.json<{ text: string }>()).text).toContain("Search could not open");
    await waitOnExecutionContext(context);
  });

  it("does not open a modal after token refresh exceeds the live trigger deadline", async () => {
    await env.DB.prepare(`UPDATE slack_installations SET token_expires_at = 1,
      bot_refresh_token_ciphertext = ? WHERE id = 'installation'`)
      .bind(await encryptSlackToken(runtime(), "xoxr-old"))
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/oauth.v2.access")) {
          await new Promise((resolve) => setTimeout(resolve, 3_500));
          return Response.json({ ok: true, access_token: "xoxb-new", refresh_token: "xoxr-new", expires_in: 3_600 });
        }
        return mockSlack(input, init);
      }),
    );
    const context = createExecutionContext();
    const started = performance.now();
    const response = await worker.fetch(
      await signedSlackRequest(
        "/api/slack/commands",
        new URLSearchParams({
          team_id: "T123",
          user_id: "UOWNER",
          trigger_id: "slow-refresh",
          text: "Orchid",
        }).toString(),
      ),
      runtime(),
      context,
    );
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect((await response.json<{ text: string }>()).text).toContain("Search could not open");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(calls.filter((call) => call.method === "views.open")).toHaveLength(0);
    await waitOnExecutionContext(context);
    const rotated = await env.DB.prepare(`SELECT bot_token_ciphertext, bot_refresh_token_ciphertext
      FROM slack_installations WHERE id='installation'`).first<{
      bot_token_ciphertext: string;
      bot_refresh_token_ciphertext: string;
    }>();
    expect(await decryptSlackToken(runtime(), rotated!.bot_token_ciphertext)).toBe("xoxb-new");
    expect(await decryptSlackToken(runtime(), rotated!.bot_refresh_token_ciphertext)).toBe("xoxr-new");
  });

  it("serializes competing bot-token refreshes and records a definitively invalid refresh token", async () => {
    await env.DB.prepare(`UPDATE slack_installations SET token_expires_at=1,
      bot_refresh_token_ciphertext=? WHERE id='installation'`)
      .bind(await encryptSlackToken(runtime(), "xoxr-old"))
      .run();
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/oauth.v2.access")) {
          refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return Response.json({ ok: true, access_token: "xoxb-new", refresh_token: "xoxr-new", expires_in: 3600 });
        }
        return mockSlack(input, init);
      }),
    );
    const one = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    const two = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    expect(await Promise.all([usableBotToken(runtime(), one), usableBotToken(runtime(), two)])).toEqual([
      "xoxb-new",
      "xoxb-new",
    ]);
    expect(refreshes).toBe(1);
    await env.DB.prepare(`UPDATE slack_installations SET token_expires_at=1,
      bot_refresh_token_ciphertext=? WHERE id='installation'`)
      .bind(await encryptSlackToken(runtime(), "xoxr-invalid"))
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/oauth.v2.access")
          ? Response.json({ ok: false, error: "invalid_refresh_token" })
          : mockSlack(input, init),
      ),
    );
    const invalid = (await env.DB.prepare(
      `SELECT * FROM slack_installations WHERE id='installation'`,
    ).first<SlackInstallation>())!;
    await expect(usableBotToken(runtime(), invalid)).rejects.toMatchObject({ code: "invalid_refresh_token" });
    expect(
      await env.DB.prepare(`SELECT auth_error,refresh_lease_token FROM slack_installations
      WHERE id='installation'`).first(),
    ).toEqual({ auth_error: "invalid_refresh_token", refresh_lease_token: null });
  });

  it("creates one public share from a root and an unfurl without trusting stale button state", async () => {
    const { link } = await activeThread();
    const create = await workspaceAction({ actionId: "noteflare_share_create", value: link.id, link });
    await deliverSlackWorkspaceAction(runtime(), create);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) count FROM share_links WHERE root_page_id = 'page' AND revoked_at IS NULL`,
      ).first(),
    ).toEqual({ count: 1 });
    const again = await workspaceAction({
      actionId: "noteflare_share_create",
      value: link.id,
      link,
      actionTs: "1700000804.000001",
    });
    await deliverSlackWorkspaceAction(runtime(), again);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) count FROM share_links WHERE root_page_id = 'page' AND revoked_at IS NULL`,
      ).first(),
    ).toEqual({ count: 1 });
    await handleSlackEvent(runtime(), {
      type: "event_callback",
      event_id: "Ev-share",
      team_id: "T123",
      event: {
        type: "link_shared",
        user: "UOWNER",
        channel: "CSPACE",
        message_ts: "1700000700.000001",
        links: [{ url: "http://example.test/?page=page" }],
      },
    });
    const reference = await env.DB.prepare(`SELECT id FROM slack_share_references WHERE page_id = 'page'`).first<{
      id: string;
    }>();
    expect(reference).not.toBeNull();
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      container: {
        channel_id: "CSPACE",
        message_ts: "1700000700.000001",
        app_unfurl_url: "http://example.test/?page=page",
      },
      app_unfurl: { app_unfurl_url: "http://example.test/?page=page" },
      actions: [{ action_id: "noteflare_unfurl_share_view", action_ts: "1700000903.000001", value: reference!.id }],
    });
    const receipt = await env.DB.prepare(
      `SELECT id FROM slack_interaction_receipts WHERE callback_id = 'noteflare_unfurl_share_view'`,
    ).first<{ id: string }>();
    await deliverSlackWorkspaceAction(runtime(), receipt!.id);
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id = ?`).bind(receipt!.id).first(),
    ).toEqual({ outcome: "accepted" });
  });

  it("sends share links outside the thread and distinguishes rate limits from uncertain sends", async () => {
    const { link } = await activeThread();
    const create = await workspaceAction({ actionId: "noteflare_share_create", value: link.id, link });
    await deliverSlackWorkspaceAction(runtime(), create);
    const row = await env.DB.prepare(`SELECT payload_json FROM outbox WHERE topic = 'slack_share_response'
      ORDER BY rowid LIMIT 1`).first<{ payload_json: string }>();
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;
    await env.DB.prepare(`UPDATE slack_installations SET token_expires_at = 1,
      bot_refresh_token_ciphertext = NULL WHERE id = 'installation'`).run();
    await expect(deliverSlackShareResponse(runtime(), payload)).rejects.toMatchObject({ code: "invalid_auth" });
    expect(
      await env.DB.prepare(`SELECT response_delivery_state state FROM slack_interaction_receipts WHERE id = ?`)
        .bind(create)
        .first(),
    ).toEqual({ state: "pending" });
    await env.DB.prepare(`UPDATE slack_installations SET token_expires_at = NULL WHERE id = 'installation'`).run();
    ephemeralFailure = "rate";
    await expect(deliverSlackShareResponse(runtime(), payload)).rejects.toBeInstanceOf(SlackRateLimitError);
    expect(
      await env.DB.prepare(`SELECT response_delivery_state state FROM slack_interaction_receipts WHERE id = ?`)
        .bind(create)
        .first(),
    ).toEqual({ state: "pending" });
    await deliverSlackShareResponse(runtime(), payload);
    expect(
      await env.DB.prepare(`SELECT response_delivery_state state FROM slack_interaction_receipts WHERE id = ?`)
        .bind(create)
        .first(),
    ).toEqual({ state: "sent" });
    expect(calls.filter((call) => call.method === "chat.postEphemeral").at(-1)?.payload.thread_ts).toBeUndefined();
    await deliverSlackShareResponse(runtime(), payload);
    expect(calls.filter((call) => call.method === "chat.postEphemeral")).toHaveLength(2);

    const again = await workspaceAction({
      actionId: "noteflare_share_view",
      value: link.id,
      link,
      actionTs: "1700000809.000001",
    });
    await deliverSlackWorkspaceAction(runtime(), again);
    const next = await env.DB.prepare(`SELECT payload_json FROM outbox WHERE topic = 'slack_share_response'
      ORDER BY rowid DESC LIMIT 1`).first<{ payload_json: string }>();
    ephemeralFailure = "lost";
    await deliverSlackShareResponse(runtime(), JSON.parse(next!.payload_json) as Record<string, unknown>);
    expect(
      await env.DB.prepare(`SELECT response_delivery_state state FROM slack_interaction_receipts WHERE id = ?`)
        .bind(again)
        .first(),
    ).toEqual({ state: "blocked" });
    await deliverSlackShareResponse(runtime(), JSON.parse(next!.payload_json) as Record<string, unknown>);
    expect(calls.filter((call) => call.method === "chat.postEphemeral")).toHaveLength(3);
    await env.DB.prepare(`UPDATE slack_interaction_receipts SET response_delivery_state = 'sending',
      response_delivery_attempted_at = ? WHERE id = ?`)
      .bind(Date.now() - 31 * 60_000, again)
      .run();
    await redriveStaleSlackOutbox(runtime());
    expect(
      await env.DB.prepare(`SELECT response_delivery_state state, response_delivery_error error
        FROM slack_interaction_receipts WHERE id = ?`)
        .bind(again)
        .first(),
    ).toEqual({ state: "blocked", error: "send_unconfirmed" });
    await deliverSlackShareResponse(runtime(), JSON.parse(next!.payload_json) as Record<string, unknown>);
    expect(calls.filter((call) => call.method === "chat.postEphemeral")).toHaveLength(3);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonical Slack mirrors", () => {
  it("lets an owner restore a mapping without a root and suppresses waiting digests on pause", async () => {
    const cutoff = Date.UTC(2026, 8, 24, 9);
    await env.DB.prepare(`INSERT INTO slack_channel_events
      (id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at)
      VALUES ('waiting','space','workspace','page_edit','owner','page','digest',?)`)
      .bind(cutoff - 1000)
      .run();
    await env.DB.prepare(`INSERT INTO slack_channel_events
      (id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at)
      VALUES ('waiting-immediate','space','workspace','page_edit','owner','page','immediate',?)`)
      .bind(cutoff - 1000)
      .run();
    await expect(setSlackChannelPause(runtime(), viewer, "space", "mute")).rejects.toMatchObject({ status: 403 });
    await setSlackChannelPause(runtime(), owner, "space", "mute");
    expect(
      await env.DB.prepare(
        `SELECT muted_at IS NOT NULL muted FROM slack_channel_subscriptions WHERE id = 'space'`,
      ).first(),
    ).toEqual({ muted: 1 });
    expect(
      await env.DB.prepare(
        `SELECT suppressed_at IS NOT NULL suppressed FROM slack_channel_events WHERE id = 'waiting'`,
      ).first(),
    ).toEqual({ suppressed: 1 });
    await env.DB.prepare(`UPDATE slack_user_links SET migration_state = 'legacy' WHERE user_id = 'owner'`).run();
    await setSlackChannelPause(runtime(), owner, "space", "unmute");
    expect(
      await env.DB.prepare(
        `SELECT muted_at, snoozed_until FROM slack_channel_subscriptions WHERE id = 'space'`,
      ).first(),
    ).toEqual({ muted_at: null, snoozed_until: null });
    await deliverSlackChannelEvent(runtime(), "waiting-immediate");
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0);
    await setSlackChannelPause(runtime(), owner, "space", "snooze", 8);
    expect(
      (await env.DB.prepare(`SELECT snoozed_until FROM slack_channel_subscriptions WHERE id = 'space'`).first<{
        snoozed_until: number;
      }>())!.snoozed_until,
    ).toBeGreaterThan(Date.now() + 7 * 3_600_000);
  });

  it("refreshes active root controls after Settings changes and snooze expiry", async () => {
    const { link } = await activeThread();
    const deliverRefresh = async () => {
      const delivery = await env.DB.prepare(`SELECT id FROM slack_thread_deliveries
        WHERE link_id = ? AND operation = 'refresh' AND state = 'pending' ORDER BY created_at, id LIMIT 1`)
        .bind(link.id)
        .first<{ id: string }>();
      expect(delivery).not.toBeNull();
      await deliverSlackThread(runtime(), delivery!.id);
      return calls.filter((call) => call.method === "chat.update").at(-1)!;
    };
    await setSlackChannelPause(runtime(), owner, "space", "mute");
    expect(JSON.stringify((await deliverRefresh()).payload.blocks)).toContain("noteflare_mapping_unmute");
    await setSlackChannelPause(runtime(), owner, "space", "unmute");
    expect(JSON.stringify((await deliverRefresh()).payload.blocks)).toContain("noteflare_mapping_mute");
    await setSlackChannelPause(runtime(), owner, "space", "snooze", 1);
    expect(JSON.stringify((await deliverRefresh()).payload.blocks)).toContain("noteflare_mapping_unmute");
    const expiry = await env.DB.prepare(`SELECT payload_json FROM outbox WHERE topic='slack_controls_expire'`).first<{
      payload_json: string;
    }>();
    const expired = Date.now() - 1;
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET snoozed_until = ? WHERE id = 'space'`)
      .bind(expired)
      .run();
    await deliverSlackControlsExpiry(runtime(), {
      ...(JSON.parse(expiry!.payload_json) as Record<string, unknown>),
      snoozedUntil: expired,
    });
    expect(JSON.stringify((await deliverRefresh()).payload.blocks)).toContain("noteflare_mapping_mute");
  });

  it("refreshes every active root from a Slack control and chooses a current owner at expiry", async () => {
    const first = await activeThread();
    const second = await thread();
    await deliverSlackThread(runtime(), (await deliveries(second.id))[0]!.id);
    await acceptSlackWorkspaceInteraction(runtime(), {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "UOWNER" },
      channel: { id: "CSPACE" },
      message: { ts: first.link.root_message_ts },
      actions: [
        {
          action_id: "noteflare_mapping_snooze",
          action_ts: "1700000809.000001",
          selected_option: { value: `${first.link.id}:1` },
        },
      ],
    });
    const receipt = (await env.DB.prepare(`SELECT id FROM slack_interaction_receipts
      WHERE callback_id='noteflare_mapping_snooze'`).first<{ id: string }>())!;
    await deliverSlackWorkspaceAction(runtime(), receipt.id);
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) count FROM slack_thread_deliveries
      WHERE operation='refresh' AND state='pending'`).first<{ count: number }>())!.count,
    ).toBe(2);
    const initialRefreshes = await env.DB.prepare(`SELECT id FROM slack_thread_deliveries
      WHERE operation='refresh' AND state='pending'`).all<{ id: string }>();
    for (const delivery of initialRefreshes.results) await deliverSlackThread(runtime(), delivery.id);
    await env.DB.prepare(`UPDATE workspace_members SET role='owner' WHERE user_id='viewer'`).run();
    await env.DB.prepare(`UPDATE workspace_members SET role='editor' WHERE user_id='owner'`).run();
    const expired = Date.now() - 1;
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET snoozed_until=? WHERE id='space'`).bind(expired).run();
    await deliverSlackControlsExpiry(runtime(), {
      mappingId: "space",
      installationGeneration: 0,
      snoozedUntil: expired,
    });
    expect(
      (
        await env.DB.prepare(`SELECT DISTINCT actor_id FROM slack_thread_deliveries
      WHERE operation='refresh' AND state='pending'`).all<{ actor_id: string }>()
      ).results,
    ).toEqual([{ actor_id: "viewer" }]);
    expect(
      await env.DB.prepare(`SELECT controls_error FROM slack_channel_subscriptions WHERE id='space'`).first(),
    ).toEqual({ controls_error: null });
  });

  it("does not let fifty muted mappings starve an eligible digest", async () => {
    const cutoff = Date.UTC(2026, 8, 24, 9);
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET cadence = 'digest' WHERE id = 'space'`).run();
    const entries = Array.from({ length: 50 }, (_, index) => `muted-${index}`);
    for (const id of entries) {
      await mapping(id, `C${id}`);
      await env.DB.prepare(`UPDATE slack_channel_subscriptions SET cadence = 'digest', muted_at = 1 WHERE id = ?`)
        .bind(id)
        .run();
    }
    await env.DB.batch([
      ...entries.map((id) =>
        env.DB.prepare(`INSERT INTO slack_channel_events
        (id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at)
        VALUES (?,?,'workspace','page_edit','owner','page','digest',?)`).bind(`event-${id}`, id, cutoff - 2000),
      ),
      env.DB.prepare(`INSERT INTO slack_channel_events
        (id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at)
        VALUES ('eligible','space','workspace','page_edit','owner','page','digest',?)`).bind(cutoff - 1000),
    ]);
    await sendDueSlackChannelDigests(runtime(), cutoff + 3_600_000);
    expect(
      calls.filter((call) => call.method === "chat.postMessage" && call.payload.channel === "CSPACE"),
    ).toHaveLength(1);
  });

  it("defaults off, requires current owner and verified identity, and stores channel validation", async () => {
    await thread();
    expect(await env.DB.prepare(`SELECT 1 FROM slack_thread_links`).first()).toBeNull();
    await expect(setSlackMirror(runtime(), viewer, "space", true)).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare(`UPDATE slack_user_links SET migration_state = 'legacy' WHERE user_id = 'owner'`).run();
    await expect(setSlackMirror(runtime(), owner, "space", true)).rejects.toMatchObject({
      code: "slack_identity_required",
    });
    await env.DB.prepare(`UPDATE slack_user_links SET migration_state = 'verified' WHERE user_id = 'owner'`).run();
    await setSlackMirror(runtime(), owner, "space", true);
    expect(
      await env.DB.prepare(
        `SELECT mirror_enabled,channel_name,validation_state FROM slack_channel_subscriptions WHERE id = 'space'`,
      ).first(),
    ).toEqual({ mirror_enabled: 1, channel_name: "validated", validation_state: "valid" });
  });
  it.each([
    { is_im: true },
    { is_mpim: true },
    { is_ext_shared: true },
    { is_org_shared: true },
    { is_shared: true },
    { pending_shared: ["T2"] },
    { is_member: false },
    { is_archived: true },
  ])("rejects unsupported or unavailable channel %j", async (flags) => {
    channelExtra = flags;
    await expect(setSlackMirror(runtime(), owner, "space", true)).rejects.toMatchObject({ status: 403 });
    expect(
      await env.DB.prepare(`SELECT mirror_enabled FROM slack_channel_subscriptions WHERE id = 'space'`).first(),
    ).toEqual({ mirror_enabled: 0 });
  });
  it("accepts private channels, rejects missing scopes, and permits disabling without Slack access", async () => {
    channelExtra = { is_private: true };
    await setSlackMirror(runtime(), owner, "space", true);
    expect(
      await env.DB.prepare(`SELECT channel_type FROM slack_channel_subscriptions WHERE id = 'space'`).first(),
    ).toEqual({ channel_type: "private_channel" });
    await env.DB.prepare(`UPDATE slack_installations SET scopes = 'chat:write'`).run();
    await expect(setSlackMirror(runtime(), owner, "space", true)).rejects.toMatchObject({ status: 403 });
    await setSlackMirror(runtime(), owner, "space", false);
  });
  it("enforces uniqueness and page precedence while keeping existing roots in their original channel", async () => {
    const old = await activeThread();
    await mapping("space2", "COTHER");
    await expect(setSlackMirror(runtime(), owner, "space2", true)).rejects.toMatchObject({
      code: "slack_mirror_conflict",
    });
    await mapping("page", "CPAGE", "page");
    await setSlackMirror(runtime(), owner, "page", true);
    const next = await thread();
    await deliverSlackThread(runtime(), (await deliveries(next.id))[0]!.id);
    await addCommentReply(runtime(), owner, commentPage, old.created.id, body("Still in space"));
    await deliverSlackThread(runtime(), (await deliveries(old.created.id)).find((d) => d.operation === "reply")!.id);
    expect(posts.map((post) => [post.channel, post.thread_ts])).toEqual([
      ["CSPACE", undefined],
      ["CPAGE", undefined],
      ["CSPACE", old.link.root_message_ts],
    ]);
    expect(
      await env.DB.prepare(`SELECT 1 FROM slack_channel_events WHERE subscription_id = 'space'`).first(),
    ).toBeNull();
  });
  it("does not fall back to a space mirror when the selected page mirror is invalid", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    await mapping("page", "CPAGE", "page");
    await setSlackMirror(runtime(), owner, "page", true);
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET validation_state = 'invalid' WHERE id = 'page'`).run();
    const created = await thread();
    expect(await deliveries(created.id)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
  it("disables a previously enabled mirror on definitive invalidation but preserves it on a transient lookup failure", async () => {
    const { link } = await activeThread();
    beforeResponse = async (method) => {
      if (method === "conversations.info") throw new Error("temporary outage");
    };
    await expect(setSlackMirror(runtime(), owner, "space", true)).rejects.toThrow("temporary outage");
    expect(
      await env.DB.prepare(
        `SELECT mirror_enabled, validation_state FROM slack_channel_subscriptions WHERE id = 'space'`,
      ).first(),
    ).toEqual({ mirror_enabled: 1, validation_state: "valid" });
    beforeResponse = undefined;
    members = ["UVIEWER"];
    await expect(setSlackMirror(runtime(), owner, "space", true)).rejects.toMatchObject({ status: 403 });
    expect(
      await env.DB.prepare(
        `SELECT mirror_enabled, validation_state FROM slack_channel_subscriptions WHERE id = 'space'`,
      ).first(),
    ).toEqual({ mirror_enabled: 1, validation_state: "valid" });
    members = ["UOWNER", "UVIEWER"];
    channelExtra = { is_member: false };
    await expect(setSlackMirror(runtime(), owner, "space", true)).rejects.toMatchObject({ status: 403 });
    expect(
      await env.DB.prepare(
        `SELECT mirror_enabled, validation_state FROM slack_channel_subscriptions WHERE id = 'space'`,
      ).first(),
    ).toEqual({ mirror_enabled: 0, validation_state: "invalid" });
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id = ?`).bind(link.id).first()).toEqual({
      state: "retired",
    });
  });
  it("retires an enabled mirror when Slack definitively loses channel access during membership lookup", async () => {
    const { link } = await activeThread();
    beforeResponse = async (method) => {
      if (method === "conversations.members") throw new SlackApiError(method, "channel_not_found", 200);
    };
    await expect(setSlackMirror(runtime(), owner, "space", true)).rejects.toMatchObject({ code: "channel_not_found" });
    expect(
      await env.DB.prepare(
        `SELECT mirror_enabled, validation_state FROM slack_channel_subscriptions WHERE id = 'space'`,
      ).first(),
    ).toEqual({ mirror_enabled: 0, validation_state: "invalid" });
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id = ?`).bind(link.id).first()).toEqual({
      state: "retired",
    });
  });
  it("persists one canonical root, waits for it, and sends each reply once through the outbox", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Next"));
    const [root, next] = await deliveries(created.id);
    await expect(deliverSlackThread(runtime(), next!.id)).rejects.toBeInstanceOf(DeliveryInProgressError);
    await Promise.allSettled([deliverSlackThread(runtime(), root!.id), deliverSlackThread(runtime(), root!.id)]);
    await deliverSlackThread(runtime(), root!.id);
    const ack = vi.fn();
    await consumeDeliveryMessage(runtime(), {
      body: { outboxId: `outbox:${next!.id}` },
      ack,
      retry: vi.fn(),
    } as unknown as Message<DeliveryQueueMessage>);
    await deliverSlackThread(runtime(), next!.id);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.thread_ts).toBe(posts[0]!.ts);
    expect(ack).toHaveBeenCalledOnce();
  });
  it("retries a definite rate limit and reconciles a lost root response without reposting", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    postFailure = "rate";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toMatchObject({ retryAfter: 2 });
    postFailure = "lost";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("response lost");
    await deliverSlackThread(runtime(), root.id);
    expect(posts).toHaveLength(1);
    expect((await deliveries(created.id))[0]!.state).toBe("sent");
    expect(
      await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id = ?`).bind(root.link_id).first(),
    ).toEqual({ state: "active" });
  });
  it("uses query parameters for Slack reads and JSON bodies for writes", async () => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    await deliverSlackMutation(runtime(), await inboundId(), false);
    for (const call of calls.filter((entry) =>
      ["conversations.info", "conversations.members", "users.info"].includes(entry.method),
    )) {
      expect(call.httpMethod).toBe("GET");
      expect(new URL(call.url).searchParams.size).toBeGreaterThan(0);
    }
    expect(calls.find((entry) => entry.method === "chat.postMessage")?.httpMethod).toBe("POST");
  });
  it("redrives only stale unfinished Slack work without changing an uncertain send", async () => {
    const { created } = await activeThread();
    const finished = (await deliveries(created.id)).find((delivery) => delivery.operation === "root")!;
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Pending"));
    const next = (await deliveries(created.id)).find((delivery) => delivery.operation === "reply")!;
    const outboxId = `outbox:${next.id}`;
    await env.DB.prepare(`WITH RECURSIVE sequence(n) AS
      (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 500)
      INSERT INTO outbox (id,workspace_id,topic,payload_json,available_at,enqueued_at,created_at)
      SELECT 'finished-' || n,'workspace','slack_thread_reply',json_object('deliveryId',?),1,1,1
      FROM sequence`)
      .bind(finished.id)
      .run();
    await env.DB.prepare(`UPDATE outbox SET enqueued_at = ?, slack_redrive_due_at=?, attempts = 1 WHERE id = ?`)
      .bind(Date.now() - 31 * 60_000, Date.now() - 1, outboxId)
      .run();
    expect(await redriveStaleSlackOutbox(runtime())).toBe(1);
    expect(
      await env.DB.prepare(`SELECT enqueued_at, available_at > ? future FROM outbox WHERE id = ?`)
        .bind(Date.now(), outboxId)
        .first(),
    ).toEqual({ enqueued_at: null, future: 1 });
    expect(await redriveStaleSlackOutbox(runtime())).toBe(0);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === next.id)?.state).toBe("pending");
    await env.DB.prepare(`UPDATE slack_thread_deliveries SET state = 'blocked' WHERE id = ?`).bind(next.id).run();
    await env.DB.prepare(`UPDATE outbox SET enqueued_at = ?, available_at = ?, slack_redrive_due_at=? WHERE id = ?`)
      .bind(Date.now() - 31 * 60_000, Date.now(), Date.now() - 1, outboxId)
      .run();
    expect(await redriveStaleSlackOutbox(runtime())).toBe(0);
  });
  it("redrives a root before a same-batch refresh without charging the refresh wait", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    const rootTime = (await env.DB.prepare(`SELECT created_at FROM slack_thread_deliveries WHERE id=?`)
      .bind(root.id)
      .first<{ created_at: number }>())!.created_at;
    const refreshId = `${root.link_id}:refresh:before-root`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO slack_thread_deliveries
        (id,link_id,operation,source_id,actor_id,created_at,updated_at)
        VALUES (?,?,'refresh','same-batch','owner',?,?)`).bind(refreshId, root.link_id, rootTime, rootTime),
      env.DB.prepare(`INSERT INTO outbox (id,workspace_id,topic,payload_json,available_at,enqueued_at,
        created_at,slack_redrive_due_at)
        VALUES (?,'workspace','slack_thread_reply',?,1,1,1,1)`).bind(
        `outbox:${refreshId}`,
        JSON.stringify({ deliveryId: refreshId }),
      ),
      env.DB.prepare(`UPDATE outbox SET enqueued_at=1,slack_redrive_due_at=1 WHERE id=?`).bind(`outbox:${root.id}`),
    ]);
    expect(await redriveStaleSlackOutbox(runtime())).toBe(1);
    expect(
      await env.DB.prepare(`SELECT slack_redrive_count,slack_redrive_due_at>? due
      FROM outbox WHERE id=?`)
        .bind(Date.now(), `outbox:${refreshId}`)
        .first(),
    ).toEqual({ slack_redrive_count: 0, due: 1 });
    expect(
      await env.DB.prepare(`SELECT slack_redrive_count FROM outbox WHERE id=?`).bind(`outbox:${root.id}`).first(),
    ).toEqual({ slack_redrive_count: 1 });
  });
  it("ends redrive after eight attempts and lets later replies follow a definite failure", async () => {
    const { created } = await activeThread();
    await addCommentReply(runtime(), owner, commentPage, created.id, body("First"));
    const first = (await deliveries(created.id)).find((delivery) => delivery.operation === "reply")!;
    await env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?,slack_redrive_count=8
      WHERE id=?`)
      .bind(Date.now() - 31 * 60_000, Date.now() - 1, `outbox:${first.id}`)
      .run();
    expect(await redriveStaleSlackOutbox(runtime())).toBe(0);
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
        .bind(first.id)
        .first(),
    ).toEqual({ state: "retired", failure_reason: "redrive_exhausted" });
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Second"));
    const second = (await deliveries(created.id)).find(
      (delivery) => delivery.operation === "reply" && delivery.id !== first.id,
    )!;
    await deliverSlackThread(runtime(), second.id);
    expect(posts.at(-1)?.text).toContain("Second");
  });
  it("blocks successors behind any blocked predecessor and releases them in order", async () => {
    const { created, link } = await activeThread();
    for (let index = 0; index < 4; index++)
      await addCommentReply(runtime(), owner, commentPage, created.id, body(`Reply ${index}`));
    const replies = (await deliveries(created.id)).filter((delivery) => delivery.operation === "reply");
    const [earlierPending, blocked, next, last] = replies;
    await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='blocked',failure_reason='reconciliation_inconclusive'
      WHERE id=?`)
      .bind(blocked!.id)
      .run();
    await deliverSlackThread(runtime(), next!.id);
    expect(
      await env.DB.prepare(`SELECT id,state,failure_reason FROM slack_thread_deliveries
      WHERE id IN (?,?) ORDER BY id`)
        .bind(next!.id, last!.id)
        .all(),
    ).toMatchObject({
      results: expect.arrayContaining([
        { id: next!.id, state: "blocked", failure_reason: "predecessor_blocked" },
        { id: last!.id, state: "blocked", failure_reason: "predecessor_blocked" },
      ]),
    });
    expect((await deliveries(created.id)).find((delivery) => delivery.id === earlierPending!.id)?.state).toBe(
      "pending",
    );
    await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='sent',failure_reason=NULL WHERE id=?`)
      .bind(blocked!.id)
      .run();
    await wakeNextSlackDelivery(runtime(), link.id);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === next!.id)?.state).toBe("pending");
    expect((await deliveries(created.id)).find((delivery) => delivery.id === last!.id)?.state).toBe("blocked");
    await deliverSlackThread(runtime(), earlierPending!.id);
    await deliverSlackThread(runtime(), next!.id);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === last!.id)?.state).toBe("pending");
    await deliverSlackThread(runtime(), last!.id);
    expect(
      (await deliveries(created.id))
        .filter((delivery) => delivery.operation === "reply")
        .every((delivery) => delivery.state === "sent"),
    ).toBe(true);
  });
  it("releases a derived block after its reply predecessor is definitively retired", async () => {
    const { created, link } = await activeThread();
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Rejected predecessor"));
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Waiting successor"));
    const [first, second] = (await deliveries(created.id)).filter((delivery) => delivery.operation === "reply");
    await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='blocked',failure_reason='reconciliation_inconclusive'
      WHERE id=?`)
      .bind(first!.id)
      .run();
    await deliverSlackThread(runtime(), second!.id);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === second!.id)?.state).toBe("blocked");
    await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',failure_reason='invalid_blocks'
      WHERE id=?`)
      .bind(first!.id)
      .run();
    await wakeNextSlackDelivery(runtime(), link.id);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === second!.id)?.state).toBe("pending");
    await deliverSlackThread(runtime(), second!.id);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === second!.id)?.state).toBe("sent");
  });
  it("blocks later pending replies when an uncertain predecessor exhausts redrive", async () => {
    const { created } = await activeThread();
    for (let index = 0; index < 2; index++)
      await addCommentReply(runtime(), owner, commentPage, created.id, body(`Waiting ${index}`));
    const [first, second] = (await deliveries(created.id)).filter((delivery) => delivery.operation === "reply");
    await env.DB.batch([
      env.DB.prepare(`UPDATE slack_thread_deliveries SET state='sending',attempted_at=? WHERE id=?`).bind(
        Date.now(),
        first!.id,
      ),
      env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?,slack_redrive_count=8 WHERE id=?`).bind(
        Date.now() - 31 * 60_000,
        Date.now() - 1,
        `outbox:${first!.id}`,
      ),
    ]);
    await redriveStaleSlackOutbox(runtime());
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
        .bind(first!.id)
        .first(),
    ).toEqual({ state: "blocked", failure_reason: "redrive_exhausted_uncertain" });
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
        .bind(second!.id)
        .first(),
    ).toEqual({ state: "blocked", failure_reason: "predecessor_blocked" });
  });
  it("redrive detects a blocked predecessor even behind an earlier pending reply", async () => {
    const { created } = await activeThread();
    for (let index = 0; index < 3; index++)
      await addCommentReply(runtime(), owner, commentPage, created.id, body(`Queued ${index}`));
    const [earlier, blocked, last] = (await deliveries(created.id)).filter(
      (delivery) => delivery.operation === "reply",
    );
    await env.DB.prepare(`UPDATE slack_thread_deliveries SET state='blocked',failure_reason='reconciliation_inconclusive'
      WHERE id=?`)
      .bind(blocked!.id)
      .run();
    await env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=? WHERE id=?`)
      .bind(Date.now() - 31 * 60_000, Date.now() - 1, `outbox:${last!.id}`)
      .run();
    await redriveStaleSlackOutbox(runtime());
    expect((await deliveries(created.id)).find((delivery) => delivery.id === earlier!.id)?.state).toBe("pending");
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
        .bind(last!.id)
        .first(),
    ).toEqual({ state: "blocked", failure_reason: "predecessor_blocked" });
  });
  it("blocks replies already pending when an uncertain root cannot be reconciled", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Waiting for root"));
    const [root, waiting] = await deliveries(created.id);
    postFailure = "unrecorded";
    await expect(deliverSlackThread(runtime(), root!.id)).rejects.toThrow("connection lost");
    postFailure = "none";
    await deliverSlackThread(runtime(), root!.id);
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
        .bind(waiting!.id)
        .first(),
    ).toEqual({ state: "blocked", failure_reason: "predecessor_blocked" });
  });
  it("retires a rejected root and its waiting replies when redrive is exhausted", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Waiting"));
    const [root, waiting] = await deliveries(created.id);
    await env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?,slack_redrive_count=8
      WHERE id=?`)
      .bind(Date.now() - 31 * 60_000, Date.now() - 1, `outbox:${root!.id}`)
      .run();
    await redriveStaleSlackOutbox(runtime());
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id=?`).bind(root!.link_id).first()).toEqual(
      {
        state: "retired",
      },
    );
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
        .bind(waiting!.id)
        .first(),
    ).toEqual({ state: "retired", failure_reason: "root_rejected" });
  });
  it("keeps an exhausted sending root and its link fenced for reconciliation", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    await env.DB.batch([
      env.DB.prepare(`UPDATE slack_thread_deliveries SET state='sending',attempted_at=? WHERE id=?`).bind(
        Date.now(),
        root.id,
      ),
      env.DB.prepare(`UPDATE outbox SET enqueued_at=1,slack_redrive_due_at=1,slack_redrive_count=8
        WHERE id=?`).bind(`outbox:${root.id}`),
    ]);
    await redriveStaleSlackOutbox(runtime());
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`).bind(root.id).first(),
    ).toEqual({ state: "blocked", failure_reason: "redrive_exhausted_uncertain" });
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id=?`).bind(root.link_id).first()).toEqual({
      state: "pending",
    });
  });
  it("acknowledges ordering waits and wakes more than six serialized replies", async () => {
    const { created } = await activeThread();
    for (let index = 0; index < 8; index++)
      await addCommentReply(runtime(), owner, commentPage, created.id, body(`Reply ${index}`));
    const pending = (await deliveries(created.id)).filter((delivery) => delivery.operation === "reply");
    const consume = async (id: string) => {
      const ack = vi.fn();
      const retry = vi.fn();
      const message = { body: { outboxId: `outbox:${id}` }, ack, retry } as unknown as Message<DeliveryQueueMessage>;
      await consumeDeliveryMessage(runtime(), message);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    };
    for (const delivery of pending.toReversed()) await consume(delivery.id);
    for (const delivery of pending) await consume(delivery.id);
    expect(posts).toHaveLength(9);
    expect((await deliveries(created.id)).every((delivery) => delivery.state === "sent")).toBe(true);
  });
  it("retries failed reconciliation lookups and terminates permanent Slack errors", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    postFailure = "unrecorded";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("connection lost");
    postFailure = "none";
    beforeResponse = async (method) => {
      if (method === "conversations.history") throw new Error("lookup unavailable");
    };
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("lookup unavailable");
    expect((await deliveries(created.id))[0]?.state).toBe("sending");
    beforeResponse = undefined;
    await deliverSlackThread(runtime(), root.id);
    expect((await deliveries(created.id))[0]?.state).toBe("blocked");

    await mapping("other", "COTHER", "page");
    await setSlackMirror(runtime(), owner, "space", false);
    await setSlackMirror(runtime(), owner, "other", true);
    const another = await thread();
    const nextRoot = (await deliveries(another.id))[0]!;
    beforeResponse = async (method) => {
      if (method === "chat.postMessage") throw new SlackApiError(method, "restricted_action", 200);
    };
    await deliverSlackThread(runtime(), nextRoot.id);
    expect(
      await env.DB.prepare(
        `SELECT mirror_enabled, validation_state FROM slack_channel_subscriptions WHERE id = 'other'`,
      ).first(),
    ).toEqual({ mirror_enabled: 0, validation_state: "invalid" });
    expect((await deliveries(another.id))[0]?.state).toBe("retired");
  });
  it.each(["internal_error", "service_unavailable"] as const)(
    "retries a %s reconciliation error returned with HTTP 200",
    async (code) => {
      await setSlackMirror(runtime(), owner, "space", true);
      const created = await thread();
      const root = (await deliveries(created.id))[0]!;
      postFailure = "unrecorded";
      await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("connection lost");
      postFailure = "none";
      historyFailure = code;
      await expect(deliverSlackThread(runtime(), root.id)).rejects.toMatchObject({ code });
      expect(
        await env.DB.prepare(`SELECT state FROM slack_thread_deliveries WHERE id=?`).bind(root.id).first(),
      ).toEqual({ state: "sending" });
      historyFailure = "no_permission";
      await deliverSlackThread(runtime(), root.id);
      expect(
        await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
          .bind(root.id)
          .first(),
      ).toEqual({ state: "blocked", failure_reason: "reconciliation_no_permission" });
    },
  );
  it("blocks a permanent reconciliation failure without reposting an uncertain root", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    postFailure = "unrecorded";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("connection lost");
    postFailure = "none";
    beforeResponse = async (method) => {
      if (method === "conversations.history") throw new SlackApiError(method, "no_permission", 200);
    };
    await deliverSlackThread(runtime(), root.id);
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`).bind(root.id).first(),
    ).toEqual({ state: "blocked", failure_reason: "reconciliation_no_permission" });
    expect(posts).toHaveLength(0);
  });
  it("keeps an uncertain send blocked when the mirror definitively loses channel access", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    postFailure = "unrecorded";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("connection lost");
    channelExtra = { is_member: false };
    await deliverSlackThread(runtime(), root.id);
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`).bind(root.id).first(),
    ).toEqual({ state: "blocked", failure_reason: "reconciliation_channel_unavailable" });
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id=?`).bind(root.link_id).first()).toEqual({
      state: "retired",
    });
    expect(posts).toHaveLength(0);
  });
  it("reconciles a posted root before reacting to its author's revoked access", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread(viewer);
    const root = (await deliveries(created.id))[0]!;
    postFailure = "lost";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("response lost");
    expect(posts).toHaveLength(1);
    await env.DB.prepare(`DELETE FROM workspace_members WHERE user_id='viewer'`).run();
    await deliverSlackThread(runtime(), root.id);
    expect(posts).toHaveLength(1);
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_deliveries WHERE id=?`).bind(root.id).first()).toEqual({
      state: "sent",
    });
  });
  it("skips a definitively rejected reply and preserves later replies", async () => {
    const { created } = await activeThread();
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Rejected"));
    const first = (await deliveries(created.id)).find((delivery) => delivery.operation === "reply")!;
    beforeResponse = async (method) => {
      if (method === "chat.postMessage") throw new SlackApiError(method, "invalid_blocks", 200);
    };
    await deliverSlackThread(runtime(), first.id);
    expect(
      await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
        .bind(first.id)
        .first(),
    ).toEqual({ state: "retired", failure_reason: "invalid_blocks" });
    beforeResponse = undefined;
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Accepted"));
    const next = (await deliveries(created.id)).find(
      (delivery) => delivery.operation === "reply" && delivery.id !== first.id,
    )!;
    await deliverSlackThread(runtime(), next.id);
    expect(posts.at(-1)?.text).toContain("Accepted");
  });
  it("blocks an inconclusive send and its successors rather than risk a duplicate", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    postFailure = "unrecorded";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("connection lost");
    postFailure = "none";
    await deliverSlackThread(runtime(), root.id);
    await deliverSlackThread(runtime(), root.id);
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Pending"));
    await deliverSlackThread(runtime(), (await deliveries(created.id)).find((d) => d.operation === "reply")!.id);
    expect(posts).toHaveLength(0);
    expect((await deliveries(created.id)).every((d) => d.state === "blocked")).toBe(true);
  });
  it("reconciles reply sends and stale send claims, requiring a bot-authored matching marker", async () => {
    const { created } = await activeThread();
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Reply"));
    const next = (await deliveries(created.id)).find((d) => d.operation === "reply")!;
    postFailure = "lost";
    await expect(deliverSlackThread(runtime(), next.id)).rejects.toThrow("response lost");
    await env.DB.prepare(`UPDATE slack_thread_links SET claim_token = 'dead-worker', claimed_at = 1`).run();
    await deliverSlackThread(runtime(), next.id);
    expect(posts).toHaveLength(2);
    expect((await deliveries(created.id)).find((d) => d.id === next.id)!.state).toBe("sent");
  });
  it("keeps mapping receipts and retires old links across disable/re-enable and removal", async () => {
    const { created, link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    await deliverSlackMutation(runtime(), await inboundId(), false);
    await setSlackMirror(runtime(), owner, "space", false);
    await setSlackMirror(runtime(), owner, "space", true);
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id = ?`).bind(link.id).first()).toEqual({
      state: "retired",
    });
    await addCommentReply(runtime(), owner, commentPage, created.id, body("A new root"));
    await env.DB.prepare(`DELETE FROM slack_channel_subscriptions WHERE id = 'space'`).run();
    expect(await env.DB.prepare(`SELECT 1 FROM slack_thread_links WHERE state <> 'retired'`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM slack_inbound_receipts`).first()).toEqual({ count: 1 });
  });
  it("pauses new roots and legacy notifications but permits existing inbound and outbound replies", async () => {
    const { created, link } = await activeThread();
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET muted_at = 1, snoozed_until = ?`)
      .bind(Date.now() + 60000)
      .run();
    const unlinked = await thread();
    expect(await deliveries(unlinked.id)).toHaveLength(0);
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    await deliverSlackMutation(runtime(), await inboundId(), false);
    await addCommentReply(runtime(), owner, commentPage, created.id, body("Existing mirror"));
    await deliverSlackThread(runtime(), (await deliveries(created.id)).find((d) => d.operation === "reply")!.id);
    expect(posts).toHaveLength(2);
    expect(await env.DB.prepare(`SELECT 1 FROM slack_channel_events`).first()).toBeNull();
  });
});

describe("Slack inbound replies and actions", () => {
  it("deduplicates events and message identities atomically, keeps notifications, and never echoes", async () => {
    const { created, link } = await activeThread();
    await Promise.all([
      acceptSlackReply(runtime(), reply(link.root_message_ts)),
      acceptSlackReply(runtime(), reply(link.root_message_ts)),
    ]);
    await acceptSlackReply(runtime(), reply(link.root_message_ts, {}, "Ev2"));
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM slack_inbound_receipts`).first()).toEqual({ count: 1 });
    const id = await inboundId();
    await Promise.all([deliverSlackMutation(runtime(), id, false), deliverSlackMutation(runtime(), id, false)]);
    await deliverSlackMutation(runtime(), id, false);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) count FROM comments WHERE thread_id = ?`).bind(created.id).first(),
    ).toEqual({ count: 2 });
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM notifications WHERE event_type = 'reply'`).first()).toEqual(
      { count: 1 },
    );
    expect(await deliveries(created.id)).toHaveLength(1);
    expect(await env.DB.prepare(`SELECT 1 FROM slack_channel_events`).first()).toBeNull();
    expect(
      await env.DB.prepare(`SELECT origin, comment_id, outcome, payload_json FROM slack_inbound_receipts`).first(),
    ).toEqual({ origin: "slack", comment_id: id, outcome: "accepted", payload_json: null });
  });
  it("orders imported replies by Slack microseconds even when their receipts finish in reverse", async () => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts, { ts: "1700000100.000002" }, "EvLater"));
    await acceptSlackReply(runtime(), reply(link.root_message_ts, { ts: "1700000100.000001" }, "EvEarlier"));
    const rows = await env.DB.prepare(`SELECT id, message_ts FROM slack_inbound_receipts`).all<{
      id: string;
      message_ts: string;
    }>();
    const later = rows.results.find((row) => row.message_ts.endsWith("000002"))!;
    const earlier = rows.results.find((row) => row.message_ts.endsWith("000001"))!;
    await deliverSlackMutation(runtime(), later.id, false);
    await deliverSlackMutation(runtime(), earlier.id, false);
    const comments = (await listCommentThreads(runtime(), owner, commentPage))[0]!.comments;
    expect(comments.map((comment) => comment.id)).toEqual([comments[0]!.id, earlier.id, later.id]);
    expect(comments[1]!.createdAt).toBe(1700000100000);
    expect(
      await env.DB.prepare(`SELECT created_at,updated_at FROM comments WHERE id=?`).bind(earlier.id).first(),
    ).toEqual({ created_at: 1700000100000, updated_at: 1700000100000 });
    expect(await env.DB.prepare(`SELECT slack_order_us FROM comments WHERE id = ?`).bind(later.id).first()).toEqual({
      slack_order_us: 1700000100000002,
    });
  });
  it("keeps a queued reply authorized after the same Slack identity signs in again", async () => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId)
      VALUES ('new-session',?,'new-token',?,?,'viewer')`)
      .bind(new Date(now + 60_000).toISOString(), now, now)
      .run();
    await recordVerifiedSlackIdentity(runtime(), "viewer", "new-session", "viewer-account", {
      installationGeneration: 0,
      installationId: "installation",
      workspaceId: "workspace",
      teamId: "T123",
      slackUserId: "UVIEWER",
      accountSubject: "T123:UVIEWER",
    });
    expect(await env.DB.prepare(`SELECT verified_at FROM slack_user_links WHERE user_id = 'viewer'`).first()).toEqual({
      verified_at: 1,
    });
    expect(
      await env.DB.prepare(`SELECT 1 FROM slack_primary_factor_proofs WHERE session_id = 'new-session'`).first(),
    ).not.toBeNull();
    await deliverSlackMutation(runtime(), await inboundId(), false);
    expect(await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts`).first()).toEqual({ outcome: "accepted" });
  });
  it("records oversized Slack replies as content failures and sends a specific private explanation", async () => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts, { text: "x".repeat(17_000) }));
    const receiptId = await inboundId();
    await deliverSlackMutation(runtime(), receiptId, false);
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts WHERE id = ?`).bind(receiptId).first(),
    ).toEqual({ outcome: "invalid_content" });
    const outbox = await env.DB.prepare(`SELECT payload_json FROM outbox WHERE id = ?`)
      .bind(`outbox:slack-denial:${receiptId}`)
      .first<{ payload_json: string }>();
    await deliverSlackDenial(runtime(), JSON.parse(outbox!.payload_json) as Record<string, unknown>);
    expect(String(calls.find((call) => call.method === "chat.postEphemeral")?.payload.text)).toContain(
      "too large or complex",
    );
    expect(calls.find((call) => call.method === "chat.postEphemeral")?.payload.thread_ts).toBe(link.root_message_ts);
    const mentions = Array.from({ length: 51 }, (_, index) => `<@U${String(index).padStart(3, "0")}>`).join(" ");
    await acceptSlackReply(
      runtime(),
      reply(link.root_message_ts, { ts: "1700000100.000002", text: mentions }, "EvComplex"),
    );
    const complex = await env.DB.prepare(`SELECT id FROM slack_inbound_receipts WHERE event_id = 'EvComplex'`).first<{
      id: string;
    }>();
    await deliverSlackMutation(runtime(), complex!.id, false);
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts WHERE id = ?`).bind(complex!.id).first(),
    ).toEqual({ outcome: "invalid_content" });
  });
  it.each([
    { subtype: "bot_message" },
    { bot_id: "BOTHER" },
    { app_id: "AOTHER" },
    { user: "UBOT" },
    { subtype: "message_changed" },
    { subtype: "message_deleted" },
    { channel: "DDIRECT" },
    { channel_type: "mpim" },
    { channel: "CUNMAPPED" },
    { thread_ts: "1700000100.000001" },
  ])("ignores unsupported event %j", async (overrides) => {
    const { link } = await activeThread();
    await handleSlackEvent(runtime(), reply(link.root_message_ts, overrides));
    expect(await env.DB.prepare(`SELECT 1 FROM slack_inbound_receipts`).first()).toBeNull();
  });
  it.each([false, true])(
    "looks up a broadcast reply and deduplicates an ordinary event with the same timestamp (ordinary first: %s)",
    async (ordinaryFirst) => {
      const { link } = await activeThread();
      threadHistoryReplies = [
        { ts: "1700000100.000001", thread_ts: link.root_message_ts, user: "UVIEWER", text: "Actual threaded reply" },
      ];
      const broadcast = reply(
        link.root_message_ts,
        { subtype: "thread_broadcast", text: "Pointer text" },
        "EvBroadcast",
      );
      const ordinary = reply(link.root_message_ts, { text: "Actual threaded reply" }, "EvNormal");
      for (const event of ordinaryFirst ? [ordinary, broadcast] : [broadcast, ordinary]) {
        const payload = JSON.stringify(event);
        const timestamp = Math.floor(Date.now() / 1000);
        const digest = await hmacSha256(secrets.SLACK_SIGNING_SECRET, `v0:${timestamp}:${payload}`);
        const signature = `v0=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        const context = createExecutionContext();
        const response = await worker.fetch(
          new Request("http://example.test/api/slack/events", {
            method: "POST",
            headers: {
              "x-slack-request-timestamp": String(timestamp),
              "x-slack-signature": signature,
              "content-type": "application/json",
            },
            body: payload,
          }),
          runtime(),
          context,
        );
        expect(response.status).toBe(200);
        await waitOnExecutionContext(context);
      }
      const inbound = await env.DB.prepare(`SELECT id FROM slack_inbound_receipts`).first<{ id: string }>();
      await consumeDeliveryMessage(runtime(), {
        body: { outboxId: `outbox:slack-inbound:${inbound!.id}` },
        ack: vi.fn(),
        retry: vi.fn(),
      } as unknown as Message<DeliveryQueueMessage>);
      expect(await env.DB.prepare(`SELECT COUNT(*) count FROM slack_inbound_receipts`).first()).toEqual({ count: 1 });
      expect(
        await env.DB.prepare(`SELECT plain_text FROM comments WHERE slack_source_receipt_id IS NOT NULL`).first(),
      ).toEqual({ plain_text: "Actual threaded reply" });
    },
  );
  it("records a terminal content outcome when a broadcast reply is absent from thread history", async () => {
    const { link } = await activeThread();
    threadHistoryReplies = [
      {
        ts: "1700000100.000001",
        thread_ts: link.root_message_ts,
        user: "UVIEWER",
        subtype: "thread_broadcast",
        text: "Pointer text",
      },
    ];
    await acceptSlackReply(
      runtime(),
      reply(link.root_message_ts, { subtype: "thread_broadcast", text: "Pointer text" }, "EvMissingBroadcast"),
    );
    await deliverSlackMutation(runtime(), await inboundId(), false);
    expect(await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts`).first()).toEqual({
      outcome: "content_unavailable",
    });
    expect(await env.DB.prepare(`SELECT 1 FROM comments WHERE slack_source_receipt_id IS NOT NULL`).first()).toBeNull();
    const denial = await env.DB.prepare(
      `SELECT payload_json FROM outbox WHERE topic='slack_interaction_response'`,
    ).first<{ payload_json: string }>();
    await deliverSlackDenial(runtime(), JSON.parse(denial!.payload_json) as Record<string, unknown>);
    expect(calls.find((call) => call.method === "chat.postEphemeral")?.payload).toMatchObject({
      thread_ts: link.root_message_ts,
      text: expect.stringContaining("could not be retrieved"),
    });
  });
  it.each([
    "DELETE FROM workspace_members WHERE user_id = 'viewer'",
    "DELETE FROM account WHERE id = 'viewer-account'",
    "UPDATE slack_user_links SET migration_state = 'legacy' WHERE user_id = 'viewer'",
    "UPDATE slack_user_links SET verified_at = 2 WHERE user_id = 'viewer'",
    "UPDATE slack_installations SET generation = generation + 1",
    "UPDATE slack_installations SET scopes = 'chat:write'",
    "UPDATE spaces SET visibility = 'private'",
    "UPDATE pages SET archived_at = 1",
    "DELETE FROM slack_channel_subscriptions",
    "UPDATE slack_channel_subscriptions SET mirror_enabled = 0",
  ])("rechecks delayed reply authority after %s", async (mutation) => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    await env.DB.prepare(mutation).run();
    await deliverSlackMutation(runtime(), await inboundId(), false);
    expect(await env.DB.prepare(`SELECT 1 FROM comments WHERE slack_source_receipt_id IS NOT NULL`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts`).first()).toEqual({ outcome: "denied" });
  });
  it.each([
    { deleted: true },
    { is_bot: true },
    { is_app_user: true },
    { is_stranger: true },
    { is_restricted: true },
    { is_ultra_restricted: true },
    { team_id: "TOTHER" },
  ])("rechecks current Slack author status %j", async (flags) => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    userExtra = flags;
    await deliverSlackMutation(runtime(), await inboundId(), false);
    expect(await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts`).first()).toEqual({ outcome: "denied" });
  });
  it("checks membership and guards against revocation during the last Slack lookup", async () => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    beforeResponse = async (method) => {
      if (method === "conversations.members")
        await env.DB.prepare(`DELETE FROM workspace_members WHERE user_id = 'viewer'`).run();
    };
    await deliverSlackMutation(runtime(), await inboundId(), false);
    expect(await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts`).first()).toEqual({ outcome: "denied" });
  });
  it("sends generic ephemeral denials once for users no longer in a channel", async () => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    members = ["UOWNER"];
    await deliverSlackMutation(runtime(), await inboundId(), false);
    const response = await env.DB.prepare(
      `SELECT payload_json FROM outbox WHERE topic = 'slack_interaction_response'`,
    ).first<{ payload_json: string }>();
    const payload = JSON.parse(response!.payload_json) as Record<string, unknown>;
    await deliverSlackDenial(runtime(), payload);
    await deliverSlackDenial(runtime(), payload);
    const denial = calls.filter((c) => c.method === "chat.postEphemeral");
    expect(denial).toHaveLength(1);
    expect(denial[0]!.payload.text).not.toContain("Private project title");
    expect(denial[0]!.payload.user).toBe("UVIEWER");
    expect(denial[0]!.payload.thread_ts).toBe(link.root_message_ts);
  });
  it("resolves and reopens through durable actions, deduplicates retries, and refreshes the same root", async () => {
    const { created, link } = await activeThread();
    const first = await action(link);
    expect(await action(link)).toBe(first);
    await Promise.all([deliverSlackMutation(runtime(), first, true), deliverSlackMutation(runtime(), first, true)]);
    expect(
      await env.DB.prepare(`SELECT resolved_by FROM comment_threads WHERE id = ?`).bind(created.id).first(),
    ).toEqual({ resolved_by: "owner" });
    const reopened = await action(link, false, "1700000111.000001");
    await deliverSlackMutation(runtime(), reopened, true);
    for (const delivery of (await deliveries(created.id)).filter((d) => d.operation === "refresh"))
      await deliverSlackThread(runtime(), delivery.id);
    expect(posts).toHaveLength(1);
    expect(
      calls
        .filter((c) => c.method === "chat.update")
        .every((c) => c.payload.ts === link.root_message_ts && String(c.payload.text).startsWith("Open")),
    ).toBe(true);
  });
  it("denies resolution for a viewer who did not create the thread and rejects a forged root", async () => {
    const { link } = await activeThread();
    await deliverSlackMutation(runtime(), await action(link, true, "1700000110.000001", "UVIEWER"), true);
    expect(await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts`).first()).toEqual({
      outcome: "denied",
    });
    const forged = await action({ ...link, root_message_ts: "999.000001" }, true, "1700000112.000001");
    await deliverSlackMutation(runtime(), forged, true);
    expect(await env.DB.prepare(`SELECT resolved_at FROM comment_threads`).first()).toEqual({ resolved_at: null });
  });
  it("lets viewers resolve their own threads using the existing rule", async () => {
    const { link } = await activeThread(viewer);
    const id = await action(link, true, "1700000110.000001", "UVIEWER");
    await deliverSlackMutation(runtime(), id, true);
    expect(await env.DB.prepare(`SELECT resolved_by FROM comment_threads`).first()).toEqual({ resolved_by: "viewer" });
  });
  it("disconnect fences all queued authority even after reconnect", async () => {
    const { created, link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts));
    await addCommentReply(runtime(), owner, commentPage, created.id, body("queued"));
    const queued = (await deliveries(created.id)).find((d) => d.operation === "reply")!;
    await disconnectSlack(runtime(), owner);
    await env.DB.prepare(`UPDATE slack_installations SET disconnected_at = NULL, bot_token_ciphertext = ?`)
      .bind(await encryptSlackToken(runtime(), "xoxb-reconnected"))
      .run();
    await deliverSlackMutation(runtime(), await inboundId(), false);
    await deliverSlackThread(runtime(), queued.id);
    expect(posts).toHaveLength(1);
    expect(await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts`).first()).toEqual({ outcome: "denied" });
    expect(await env.DB.prepare(`SELECT mirror_enabled FROM slack_channel_subscriptions`).first()).toEqual({
      mirror_enabled: 0,
    });
  });
  it("blocks queued outbound content after author access is removed", async () => {
    const { created } = await activeThread();
    await addCommentReply(runtime(), viewer, { ...commentPage, effective_role: "viewer" }, created.id, body("queued"));
    await env.DB.prepare(`DELETE FROM workspace_members WHERE user_id = 'viewer'`).run();
    await deliverSlackThread(runtime(), (await deliveries(created.id)).find((d) => d.operation === "reply")!.id);
    expect(posts).toHaveLength(1);
  });
  it("mirrors an active integration's comment and rechecks its capability and active state", async () => {
    const { created } = await activeThread();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,account_type)
        VALUES ('bot','Automation','bot@integrations.invalid',1,1,1,'bot')`),
      env.DB
        .prepare(`INSERT INTO integrations (id,workspace_id,bot_user_id,name,read_comments,insert_comments,created_by,created_at,updated_at)
        VALUES ('integration','workspace','bot','Automation',1,1,'owner',1,1)`),
      env.DB.prepare(`INSERT INTO integration_grants (integration_id,root_page_id,created_by,created_at)
        VALUES ('integration','page','owner',1)`),
    ]);
    const bot = { role: "editor" as const, user: { id: "bot" } };
    await addCommentReply(runtime(), bot, { ...commentPage, effective_role: "editor" }, created.id, body("From API"));
    const first = (await deliveries(created.id)).find((delivery) => delivery.operation === "reply")!;
    await deliverSlackThread(runtime(), first.id);
    expect(posts.at(-1)?.text).toContain("From API");
    const beforeSecond = new Set((await deliveries(created.id)).map((delivery) => delivery.id));
    await addCommentReply(runtime(), bot, { ...commentPage, effective_role: "editor" }, created.id, body("Revoked"));
    const second = (await deliveries(created.id)).find((delivery) => !beforeSecond.has(delivery.id))!;
    await env.DB.prepare(`UPDATE integrations SET insert_comments = 0 WHERE id = 'integration'`).run();
    await deliverSlackThread(runtime(), second.id);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === second.id)?.state).toBe("retired");
    await env.DB.prepare(`UPDATE integrations SET insert_comments = 1 WHERE id = 'integration'`).run();
    const beforeThird = new Set((await deliveries(created.id)).map((delivery) => delivery.id));
    await addCommentReply(runtime(), bot, { ...commentPage, effective_role: "editor" }, created.id, body("Inactive"));
    const third = (await deliveries(created.id)).find((delivery) => !beforeThird.has(delivery.id))!;
    await env.DB.prepare(`UPDATE integrations SET revoked_at = ? WHERE id = 'integration'`).bind(Date.now()).run();
    await deliverSlackThread(runtime(), third.id);
    expect((await deliveries(created.id)).find((delivery) => delivery.id === third.id)?.state).toBe("retired");
    expect(posts).toHaveLength(2);
  });
  it("delivers one-way bot activity only while its integration retains page access", async () => {
    await mapping("one-way", "CONEWAY");
    await env.DB.batch([
      env.DB.prepare(`UPDATE slack_channel_subscriptions SET event_types_json = '["reply"]' WHERE id = 'one-way'`),
      env.DB.prepare(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,account_type)
        VALUES ('bot','Automation','bot@integrations.invalid',1,1,1,'bot')`),
      env.DB
        .prepare(`INSERT INTO integrations (id,workspace_id,bot_user_id,name,read_comments,insert_comments,created_by,created_at,updated_at)
        VALUES ('integration','workspace','bot','Automation',1,1,'owner',1,1)`),
      env.DB.prepare(`INSERT INTO integration_grants (integration_id,root_page_id,created_by,created_at)
        VALUES ('integration','page','owner',1)`),
    ]);
    const fanout = (sourceId: string) =>
      env.DB.batch(
        notificationFanoutStatements(env.DB, {
          workspaceId: "workspace",
          spaceId: "workspace-general",
          pageId: "page",
          threadId: null,
          actorId: "bot",
          eventType: "reply",
          sourceId,
          recipientIds: [],
          emitSlackChannel: true,
          data: {},
          createdAt: Date.now(),
        }),
      );
    await fanout("bot-first");
    const first = await env.DB.prepare(`SELECT id FROM slack_channel_events WHERE actor_id = 'bot'`).first<{
      id: string;
    }>();
    expect(first).not.toBeNull();
    await deliverSlackChannelEvent(runtime(), first!.id);
    expect(posts.at(-1)?.channel).toBe("CONEWAY");
    await env.DB.prepare(`DELETE FROM integration_grants WHERE integration_id = 'integration'`).run();
    await fanout("bot-revoked");
    const second = await env.DB.prepare(`SELECT id FROM slack_channel_events WHERE actor_id = 'bot' AND id <> ?`)
      .bind(first!.id)
      .first<{ id: string }>();
    expect(second).not.toBeNull();
    await deliverSlackChannelEvent(runtime(), second!.id);
    expect(posts).toHaveLength(1);
  });
  it("keeps shared-channel one-way delivery separate from mirror validation and repairs blocked notifications", async () => {
    await mapping("shared", "CSHARED");
    await env.DB.prepare(`UPDATE slack_channel_subscriptions SET validation_state='invalid',
      event_types_json='["reply"]' WHERE id='shared'`).run();
    const fanout = (sourceId: string) =>
      env.DB.batch(
        notificationFanoutStatements(env.DB, {
          workspaceId: "workspace",
          spaceId: "workspace-general",
          pageId: "page",
          threadId: null,
          actorId: "owner",
          eventType: "reply",
          sourceId,
          recipientIds: [],
          emitSlackChannel: true,
          data: {},
          createdAt: Date.now(),
        }),
      );
    await fanout("shared-first");
    const first = await env.DB.prepare(`SELECT event.id FROM slack_channel_events event
      WHERE event.subscription_id='shared'`).first<{ id: string }>();
    expect(first).not.toBeNull();
    postFailure = "permission";
    await deliverSlackChannelEvent(runtime(), first!.id);
    expect(
      await env.DB.prepare(`SELECT notification_error FROM slack_channel_subscriptions WHERE id='shared'`).first(),
    ).toEqual({ notification_error: "no_permission" });
    expect(
      await env.DB.prepare(`SELECT suppressed_at IS NOT NULL suppressed FROM slack_channel_events WHERE id=?`)
        .bind(first!.id)
        .first(),
    ).toEqual({ suppressed: 1 });
    channelExtra = { is_shared: true, is_ext_shared: true };
    postFailure = "none";
    await repairSlackChannelNotifications(runtime(), owner, "shared");
    await fanout("shared-next");
    const next = await env.DB.prepare(`SELECT id FROM slack_channel_events
      WHERE subscription_id='shared' AND id<>?`)
      .bind(first!.id)
      .first<{ id: string }>();
    expect(next).not.toBeNull();
    await repairSlackChannelNotifications(runtime(), owner, "shared");
    expect(
      await env.DB.prepare(`SELECT suppressed_at FROM slack_channel_events WHERE id=?`).bind(next!.id).first(),
    ).toEqual({ suppressed_at: null });
    await deliverSlackChannelEvent(runtime(), next!.id);
    expect(posts.at(-1)?.channel).toBe("CSHARED");
  });
  it("records installation token failure without disabling a valid mirror", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    beforeResponse = async (method) => {
      if (method === "chat.postMessage") throw new SlackApiError(method, "invalid_auth", 200);
    };
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toMatchObject({ code: "invalid_auth" });
    expect(
      await env.DB.prepare(
        `SELECT mirror_enabled,validation_state FROM slack_channel_subscriptions WHERE id='space'`,
      ).first(),
    ).toEqual({ mirror_enabled: 1, validation_state: "valid" });
    expect(await env.DB.prepare(`SELECT auth_error FROM slack_installations WHERE id='installation'`).first()).toEqual({
      auth_error: "invalid_auth",
    });
    expect((await deliveries(created.id))[0]?.state).toBe("pending");
    beforeResponse = undefined;
    await env.DB.prepare(`UPDATE slack_installations SET auth_error=NULL WHERE id='installation'`).run();
    await deliverSlackThread(runtime(), root.id);
    expect((await deliveries(created.id))[0]?.state).toBe("sent");
  });
  it("refreshes a resolved root with a placeholder after its original author leaves", async () => {
    const { created, link } = await activeThread(viewer);
    await env.DB.prepare(`DELETE FROM workspace_members WHERE user_id = 'viewer'`).run();
    await setThreadResolved(runtime(), owner, commentPage, created.id, true);
    const refresh = (await deliveries(created.id)).find((delivery) => delivery.operation === "refresh")!;
    await deliverSlackThread(runtime(), refresh.id);
    expect(calls.find((call) => call.method === "chat.update")?.payload).toMatchObject({ ts: link.root_message_ts });
    expect(String(calls.find((call) => call.method === "chat.update")?.payload.text)).toContain("Comment unavailable.");
  });
  it("retires a root when Slack reports its message is gone during refresh", async () => {
    const { created, link } = await activeThread();
    await setThreadResolved(runtime(), owner, commentPage, created.id, true);
    const refresh = (await deliveries(created.id)).find((delivery) => delivery.operation === "refresh")!;
    beforeResponse = async (method) => {
      if (method === "chat.update") throw new SlackApiError(method, "message_not_found", 200);
    };
    await deliverSlackThread(runtime(), refresh.id);
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id = ?`).bind(link.id).first()).toEqual({
      state: "retired",
    });
    expect((await deliveries(created.id)).find((delivery) => delivery.id === refresh.id)?.state).toBe("retired");
  });
  it("preserves one-way mappings when the owner edits their legacy notification settings", async () => {
    await upsertSlackChannelSubscription(runtime(), owner, {
      spaceId: "workspace-general",
      pageId: null,
      channelId: "CSPACE",
      channelName: "old",
      eventTypes: ["reply"],
      cadence: "digest",
    });
    expect(await env.DB.prepare(`SELECT mirror_enabled FROM slack_channel_subscriptions`).first()).toEqual({
      mirror_enabled: 0,
    });
  });
  it("recovers an event after the signature was recorded but durable ingestion failed", async () => {
    const { link } = await activeThread();
    const payload = JSON.stringify(reply(link.root_message_ts));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = await hmacSha256(secrets.SLACK_SIGNING_SECRET, `v0:${timestamp}:${payload}`);
    const signature = `v0=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const headers = {
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
      "content-type": "application/json",
    };
    await verifySlackRequest(
      runtime(),
      new Request("http://example.test/api/slack/events", { method: "POST", headers, body: payload }),
      payload,
    );
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.test/api/slack/events", {
        method: "POST",
        headers: { ...headers, "x-slack-retry-num": "1" },
        body: payload,
      }),
      runtime(),
      context,
    );
    expect(response.status).toBe(200);
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM slack_inbound_receipts`).first()).toEqual({ count: 1 });
    await waitOnExecutionContext(context);
  });
  it("updates a root from a NoteFlare resolution without posting a replacement", async () => {
    const { created, link } = await activeThread();
    await setThreadResolved(runtime(), owner, commentPage, created.id, true);
    await deliverSlackThread(runtime(), (await deliveries(created.id)).find((d) => d.operation === "refresh")!.id);
    expect(posts).toHaveLength(1);
    expect(calls.find((c) => c.method === "chat.update")?.payload).toMatchObject({ ts: link.root_message_ts });
  });
});

describe("Slack delayed-work boundaries", () => {
  it.each([
    "DELETE FROM workspace_members WHERE user_id = 'viewer'",
    "UPDATE slack_installations SET scopes = 'chat:write'",
    "UPDATE slack_channel_subscriptions SET mirror_enabled = 0",
    "UPDATE spaces SET visibility = 'private'",
  ])("asserts authority inside the comment transaction after mention conversion: %s", async (mutation) => {
    const { link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts, { text: "Hello <@UOWNER>" }));
    beforeResponse = async (method) => {
      if (method === "users.info" && calls.at(-1)?.payload.user === "UOWNER") await env.DB.prepare(mutation).run();
    };
    await deliverSlackMutation(runtime(), await inboundId(), false);
    expect(await env.DB.prepare(`SELECT outcome FROM slack_inbound_receipts`).first()).toEqual({ outcome: "denied" });
    expect(await env.DB.prepare(`SELECT 1 FROM comments WHERE slack_source_receipt_id IS NOT NULL`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 FROM slack_mutation_commits`).first()).toBeNull();
  });
  it("translates verified mentions both ways and preserves unknown mentions as plain text", async () => {
    const { created, link } = await activeThread();
    await acceptSlackReply(runtime(), reply(link.root_message_ts, { text: "Hello <@UOWNER> and <@UUNKNOWN>" }));
    await deliverSlackMutation(runtime(), await inboundId(), false);
    const imported = await env.DB.prepare(
      `SELECT body_json FROM comments WHERE slack_source_receipt_id IS NOT NULL`,
    ).first<{ body_json: string }>();
    expect(imported!.body_json).toContain('"entityId":"owner"');
    expect(imported!.body_json).toContain("@Slack member");
    await addCommentReply(runtime(), owner, commentPage, created.id, [
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { entityType: "user", entityId: "viewer", label: "Viewer" } },
          { type: "text", text: " safe <!everyone>" },
        ],
      },
    ]);
    await deliverSlackThread(runtime(), (await deliveries(created.id)).find((d) => d.operation === "reply")!.id);
    expect(posts.at(-1)!.text).toContain("<@UVIEWER>");
    expect(posts.at(-1)!.text).toContain("&lt;!everyone&gt;");
    expect(posts.at(-1)!.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.objectContaining({ verbatim: true }) })]),
    );
    expect(posts).toHaveLength(2);
  });
  it("does not ping an outbound mention whose account verification was removed", async () => {
    const { created } = await activeThread();
    await addCommentReply(runtime(), owner, commentPage, created.id, [
      { type: "mention", props: { entityType: "user", entityId: "viewer", label: "Viewer" } },
    ]);
    await env.DB.prepare(`DELETE FROM account WHERE id = 'viewer-account'`).run();
    await deliverSlackThread(runtime(), (await deliveries(created.id)).find((d) => d.operation === "reply")!.id);
    expect(posts.at(-1)!.text).toContain("@Viewer");
    expect(posts.at(-1)!.text).not.toContain("<@UVIEWER>");
  });
  it("retires a moved page's old root and selects its new space mapping", async () => {
    const { created, link } = await activeThread();
    await env.DB.prepare(
      `INSERT INTO spaces (id,workspace_id,name,slug,position,created_at,updated_at) VALUES ('new-space','workspace','New','new','a1',1,1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO slack_channel_subscriptions (id,installation_id,space_id,channel_id,created_by,created_at,updated_at) VALUES ('new-mapping','installation','new-space','CNEW','owner',1,1)`,
    ).run();
    await setSlackMirror(runtime(), owner, "new-mapping", true);
    await env.DB.prepare(`UPDATE pages SET space_id = 'new-space' WHERE id = 'page'`).run();
    await env.DB.prepare(`UPDATE comment_threads SET space_id = 'new-space' WHERE id = ?`).bind(created.id).run();
    await addCommentReply(runtime(), owner, { ...commentPage, space_id: "new-space" }, created.id, body("Moved"));
    const newRoot = (await deliveries(created.id)).find((d) => d.operation === "root" && d.state === "pending")!;
    await deliverSlackThread(runtime(), newRoot.id);
    expect(posts.at(-1)!.channel).toBe("CNEW");
    expect(await env.DB.prepare(`SELECT state FROM slack_thread_links WHERE id = ?`).bind(link.id).first()).toEqual({
      state: "retired",
    });
  });
  it("ignores impostor reconciliation markers and blocks malformed post results", async () => {
    await setSlackMirror(runtime(), owner, "space", true);
    const created = await thread();
    const root = (await deliveries(created.id))[0]!;
    postFailure = "malformed";
    await expect(deliverSlackThread(runtime(), root.id)).rejects.toThrow("Slack message result is incomplete");
    posts[0]!.user = "UOWNER";
    await deliverSlackThread(runtime(), root.id);
    expect((await deliveries(created.id))[0]!.state).toBe("blocked");
    expect(posts).toHaveLength(1);
  });
  it("rechecks a queued resolution after the actor loses editor permission", async () => {
    const { link } = await activeThread();
    await env.DB.prepare(`UPDATE workspace_members SET role = 'editor' WHERE user_id = 'viewer'`).run();
    const id = await action(link, true, "1700000115.000001", "UVIEWER");
    await env.DB.prepare(`UPDATE workspace_members SET role = 'viewer' WHERE user_id = 'viewer'`).run();
    await deliverSlackMutation(runtime(), id, true);
    expect(
      await env.DB.prepare(`SELECT outcome FROM slack_interaction_receipts WHERE id = ?`).bind(id).first(),
    ).toEqual({ outcome: "denied" });
    expect(await env.DB.prepare(`SELECT resolved_at FROM comment_threads`).first()).toEqual({ resolved_at: null });
  });

  it("acknowledges a signed Resolve action without waiting for downstream Slack calls", async () => {
    const { link } = await activeThread();
    calls = [];
    const payload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "T123" },
        user: { id: "UOWNER" },
        channel: { id: "CSPACE" },
        message: { ts: link.root_message_ts },
        actions: [{ action_id: "noteflare_thread_resolve", action_ts: "1700000999.000001", value: link.id }],
      }),
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `v0=${Array.from(await hmacSha256(secrets.SLACK_SIGNING_SECRET, `v0:${timestamp}:${payload}`), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const context = createExecutionContext();
    const started = performance.now();
    const response = await worker.fetch(
      new Request("http://example.test/api/slack/interactions", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": signature,
        },
        body: payload,
      }),
      runtime(),
      context,
    );
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(calls).toHaveLength(0);
    expect(await env.DB.prepare(`SELECT 1 FROM outbox WHERE topic = 'slack_thread_action'`).first()).not.toBeNull();
    await waitOnExecutionContext(context);
  });
});
