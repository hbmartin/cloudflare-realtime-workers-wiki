import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext, Page, Space } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { notificationFanoutStatements } from "./notifications";
import {
  consumeSlackLink,
  createSlackOAuthUrl,
  decryptSlackToken,
  deliverSlackChannelEvent,
  deliverSlackUnfurl,
  disconnectSlack,
  encryptSlackToken,
  finishSlackOAuth,
  handleSlackCommand,
  handleSlackEvent,
  sendPersonalSlackNotification,
  sendDueSlackChannelDigests,
  SlackRateLimitError,
  verifySlackRequest,
} from "./slack";

const SLACK_SECRETS = {
  SLACK_CLIENT_ID: "123.456",
  SLACK_CLIENT_SECRET: "slack-client-secret",
  SLACK_SIGNING_SECRET: "slack-signing-secret",
  SLACK_TOKEN_ENCRYPTION_KEY: "slack-token-encryption-key-with-enough-entropy",
};

function slackEnv(): Env {
  return { ...env, ...SLACK_SECRETS } as unknown as Env;
}

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Slack Notes",
      name: "Owner",
      email: "slack-owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const member = await (await SELF.fetch(request(cookie, "/api/me"))).json<ClientMemberContext>();
  const pages = await (await SELF.fetch(request(cookie, "/api/pages/tree"))).json<{ pages: Page[] }>();
  return { cookie, member, page: pages.pages[0]! };
}

async function inviteViewer(ownerCookie: string) {
  const invitation = await SELF.fetch(
    request(ownerCookie, "/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    }),
  );
  const token = (await invitation.json<{ invite: { token: string } }>()).invite.token;
  const accepted = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      token,
      name: "Slack Viewer",
      email: "slack-viewer@example.test",
      password: "password123",
    }),
  });
  expect(accepted.status).toBe(200);
  const cookie = accepted.headers.get("set-cookie")!.split(";", 1)[0]!;
  const member = await (await SELF.fetch(request(cookie, "/api/me"))).json<ClientMemberContext>();
  return { cookie, member };
}

function memberContext(member: ClientMemberContext): MemberContext {
  return {
    ...member,
    session: { id: "test-session", expiresAt: new Date(Date.now() + 60_000) },
  };
}

async function installSlack(member: ClientMemberContext, token = "xoxb-test-bot-token") {
  await env.DB.prepare(
    `INSERT INTO slack_installations
      (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext,
       bot_refresh_token_ciphertext, token_expires_at, scopes, installed_by, created_at, updated_at)
     VALUES ('slack-installation', ?, 'T123', 'Test Slack', 'B123', ?, NULL, NULL,
       'commands,chat:write,links:read,links:write', ?, ?, ?)`,
  )
    .bind(member.workspace.id, await encryptSlackToken(slackEnv(), token), member.user.id, Date.now(), Date.now())
    .run();
}

async function slackSignature(timestamp: number, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SECRETS.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)),
  );
  return `v0=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack security and integration", () => {
  it("encrypts tokens and rejects stale, forged, and replayed requests", async () => {
    const configured = slackEnv();
    const ciphertext = await encryptSlackToken(configured, "xoxb-sensitive");
    expect(ciphertext).not.toContain("xoxb-sensitive");
    expect(await decryptSlackToken(configured, ciphertext)).toBe("xoxb-sensitive");

    const body = "team_id=T123&user_id=U123&text=launch";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await slackSignature(timestamp, body);
    const signed = new Request("http://example.test/api/slack/commands", {
      method: "POST",
      headers: { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signature },
      body,
    });
    await expect(verifySlackRequest(configured, signed, body)).resolves.toEqual({ duplicate: false });
    await expect(verifySlackRequest(configured, signed, body)).rejects.toMatchObject({
      status: 409,
      code: "slack_replay",
    });

    const retry = new Request(signed, { headers: { ...Object.fromEntries(signed.headers), "x-slack-retry-num": "1" } });
    await expect(verifySlackRequest(configured, retry, body)).resolves.toEqual({ duplicate: true });

    const staleTimestamp = timestamp - 301;
    const stale = new Request("http://example.test/api/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(staleTimestamp),
        "x-slack-signature": await slackSignature(staleTimestamp, body),
      },
      body,
    });
    await expect(verifySlackRequest(configured, stale, body)).rejects.toMatchObject({ status: 401 });

    const forged = new Request("http://example.test/api/slack/commands", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
      body,
    });
    await expect(verifySlackRequest(configured, forged, body)).rejects.toMatchObject({ status: 401 });
  });

  it("uses single-use OAuth state, stores encrypted credentials, and rotates expiring tokens", async () => {
    const installed = await bootstrap();
    const configured = slackEnv();
    const authorization = new URL(await createSlackOAuthUrl(configured, memberContext(installed.member)));
    const state = authorization.searchParams.get("state")!;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-original",
          refresh_token: "xoxe-refresh-original",
          expires_in: 3600,
          scope: "commands,chat:write,links:read,links:write",
          bot_user_id: "B123",
          team: { id: "T123", name: "Test Slack" },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await finishSlackOAuth(configured, memberContext(installed.member), "oauth-code", state);
    await expect(
      finishSlackOAuth(configured, memberContext(installed.member), "oauth-code", state),
    ).rejects.toMatchObject({
      status: 409,
    });

    const stored = await env.DB.prepare(
      `SELECT bot_token_ciphertext, bot_refresh_token_ciphertext FROM slack_installations WHERE team_id = 'T123'`,
    ).first<{ bot_token_ciphertext: string; bot_refresh_token_ciphertext: string }>();
    expect(stored!.bot_token_ciphertext).not.toContain("xoxb-original");
    expect(await decryptSlackToken(configured, stored!.bot_refresh_token_ciphertext)).toBe("xoxe-refresh-original");

    const installation = await env.DB.prepare(`SELECT id FROM slack_installations WHERE team_id = 'T123'`).first<{
      id: string;
    }>();
    await env.DB.batch([
      env.DB.prepare(`UPDATE slack_installations SET token_expires_at = 0 WHERE team_id = 'T123'`),
      env.DB.prepare(
        `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at) VALUES (?, ?, 'UOWNER', ?)`,
      ).bind(installation!.id, installed.member.user.id, Date.now()),
    ]);
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("oauth.v2.access")
        ? Response.json({
            ok: true,
            access_token: "xoxb-rotated",
            refresh_token: "xoxe-refresh-rotated",
            expires_in: 7200,
          })
        : Response.json({ ok: true });
    });
    await expect(
      sendPersonalSlackNotification(
        configured,
        installed.member.user.id,
        installed.member.workspace.id,
        "A note changed",
        installed.page.id,
      ),
    ).resolves.toBe(true);
    const rotated = await env.DB.prepare(
      `SELECT bot_token_ciphertext, bot_refresh_token_ciphertext, token_expires_at
         FROM slack_installations WHERE team_id = 'T123'`,
    ).first<{ bot_token_ciphertext: string; bot_refresh_token_ciphertext: string; token_expires_at: number }>();
    expect(await decryptSlackToken(configured, rotated!.bot_token_ciphertext)).toBe("xoxb-rotated");
    expect(await decryptSlackToken(configured, rotated!.bot_refresh_token_ciphertext)).toBe("xoxe-refresh-rotated");
    expect(rotated!.token_expires_at).toBeGreaterThan(Date.now());

    await disconnectSlack(configured, memberContext(installed.member));
    expect(
      await env.DB.prepare(
        `SELECT bot_token_ciphertext, bot_refresh_token_ciphertext, token_expires_at,
                disconnected_at IS NOT NULL disconnected
           FROM slack_installations WHERE team_id = 'T123'`,
      ).first(),
    ).toEqual({
      bot_token_ciphertext: "",
      bot_refresh_token_ciphertext: null,
      token_expires_at: null,
      disconnected: 1,
    });
  });

  it("links accounts once and keeps slash search scoped to the linked Notes user", async () => {
    const installed = await bootstrap();
    const viewer = await inviteViewer(installed.cookie);
    await installSlack(installed.member);
    const privateSpaceResponse = await SELF.fetch(
      request(installed.cookie, "/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Secret", visibility: "private" }),
      }),
    );
    const privateSpace = (await privateSpaceResponse.json<{ space: Space }>()).space;
    const pageResponse = await SELF.fetch(
      request(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Orchid launch", kind: "document", parentId: null, spaceId: privateSpace.id }),
      }),
    );
    expect(pageResponse.status).toBe(201);

    const linkReply = await handleSlackCommand(
      slackEnv(),
      new URLSearchParams("team_id=T123&user_id=UOWNER&text=link"),
    );
    const linkUrl = new URL(linkReply.text.match(/https?:\S+/)![0]);
    const rawToken = linkUrl.searchParams.get("slackLink")!;
    await consumeSlackLink(slackEnv(), memberContext(installed.member), rawToken);
    await expect(consumeSlackLink(slackEnv(), memberContext(installed.member), rawToken)).rejects.toMatchObject({
      status: 422,
    });
    await env.DB.prepare(
      `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
       VALUES ('slack-installation', ?, 'UVIEWER', ?)`,
    )
      .bind(viewer.member.user.id, Date.now())
      .run();

    const ownerResult = await handleSlackCommand(
      slackEnv(),
      new URLSearchParams("team_id=T123&user_id=UOWNER&text=Orchid"),
    );
    expect(ownerResult.text).toContain("Orchid launch");
    const viewerResult = await handleSlackCommand(
      slackEnv(),
      new URLSearchParams("team_id=T123&user_id=UVIEWER&text=Orchid"),
    );
    expect(viewerResult.text).toContain("No Notes pages matched");
  });

  it("suppresses private unfurls unless the linked user has access and the channel is explicitly mapped", async () => {
    const installed = await bootstrap();
    const viewer = await inviteViewer(installed.cookie);
    await installSlack(installed.member);
    await env.DB.prepare(
      `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
       VALUES ('slack-installation', ?, 'UVIEWER', ?)`,
    )
      .bind(viewer.member.user.id, Date.now())
      .run();
    const privateSpace = (
      await (
        await SELF.fetch(
          request(installed.cookie, "/api/spaces", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Private plans", visibility: "private" }),
          }),
        )
      ).json<{ space: Space }>()
    ).space;
    const page = (
      await (
        await SELF.fetch(
          request(installed.cookie, "/api/pages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "Private launch",
              kind: "document",
              parentId: null,
              spaceId: privateSpace.id,
            }),
          }),
        )
      ).json<{ page: Page }>()
    ).page;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = {
      type: "event_callback",
      event_id: "Ev-private-unfurl",
      team_id: "T123",
      event: {
        type: "link_shared",
        user: "UVIEWER",
        channel: "C0123456789",
        message_ts: "1700000000.000100",
        links: [
          { url: `http://example.test/?page=${page.id}` },
          { url: `http://example.test.evil.invalid/?page=${page.id}` },
          { url: "http://example.test/%" },
        ],
      },
    };
    await handleSlackEvent(slackEnv(), payload);
    expect(fetchMock).not.toHaveBeenCalled();

    await SELF.fetch(
      request(installed.cookie, `/api/spaces/${privateSpace.id}/members/${viewer.member.user.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      }),
    );
    await handleSlackEvent(slackEnv(), payload);
    expect(fetchMock).not.toHaveBeenCalled();

    const mapping = await SELF.fetch(
      request(installed.cookie, "/api/slack/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceId: privateSpace.id,
          pageId: page.id,
          channelId: "C0123456789",
          channelName: "launch",
          cadence: "immediate",
          eventTypes: ["mention", "page_edit"],
        }),
      }),
    );
    expect(mapping.status).toBe(201);
    const mappingId = (await mapping.json<{ subscription: { id: string } }>()).subscription.id;
    expect((await SELF.fetch(request(viewer.cookie, "/api/slack/channels"))).status).toBe(403);
    await handleSlackEvent(slackEnv(), payload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(`SELECT topic FROM outbox WHERE id = 'outbox:slack-unfurl:Ev-private-unfurl'`).first(),
    ).toEqual({ topic: "slack_unfurl" });
    await deliverSlackUnfurl(slackEnv(), "Ev-private-unfurl");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://slack.com/api/chat.unfurl");
    // chat.unfurl only attaches previews when told which message they belong to.
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      channel: "C0123456789",
      ts: "1700000000.000100",
    });

    fetchMock.mockClear();
    await handleSlackEvent(slackEnv(), {
      ...payload,
      event_id: "Ev-no-ts",
      event: { ...payload.event, message_ts: undefined },
    });
    expect(await env.DB.prepare(`SELECT id FROM slack_unfurls WHERE id = 'Ev-no-ts'`).first()).toBeNull();

    fetchMock.mockClear();
    await handleSlackEvent(slackEnv(), { ...payload, event_id: "Ev-revoked-unfurl" });
    expect(
      (await SELF.fetch(request(installed.cookie, `/api/slack/channels/${mappingId}`, { method: "DELETE" }))).status,
    ).toBe(200);
    await deliverSlackUnfurl(slackEnv(), "Ev-revoked-unfurl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retires an undeliverable unfurl without reporting it as delivered", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO slack_unfurls
          (id, installation_id, workspace_id, user_id, channel_id, unfurls_json, created_at)
         VALUES ('missing-ts', 'slack-installation', ?, ?, 'C0123456789', '{}', ?)`,
      ).bind(installed.member.workspace.id, installed.member.user.id, timestamp),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         VALUES ('outbox:missing-ts', ?, 'slack_unfurl', json_object('unfurlId', 'missing-ts'), ?, ?)`,
      ).bind(installed.member.workspace.id, timestamp, timestamp),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await deliverSlackUnfurl(slackEnv(), "missing-ts");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        `SELECT delivered_at, retired_at IS NOT NULL retired, retirement_reason
           FROM slack_unfurls WHERE id = 'missing-ts'`,
      ).first(),
    ).toEqual({ delivered_at: null, retired: 1, retirement_reason: "missing_message_ts" });
    expect(await env.DB.prepare(`SELECT last_error FROM outbox WHERE id = 'outbox:missing-ts'`).first()).toEqual({
      last_error: "slack_unfurl_missing_message_ts",
    });
  });

  it("fans channel events into the outbox and preserves Slack retry-after delays", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const mapping = await SELF.fetch(
      request(installed.cookie, "/api/slack/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceId: installed.page.spaceId,
          pageId: null,
          channelId: "C0123456789",
          channelName: "notes",
          cadence: "immediate",
          eventTypes: ["page_edit", "mention"],
        }),
      }),
    );
    expect(mapping.status).toBe(201);
    await env.DB.prepare(`UPDATE pages SET title = 'Launch <@UATTACK>|plan' WHERE id = ?`)
      .bind(installed.page.id)
      .run();
    await env.DB.batch(
      notificationFanoutStatements(env.DB, {
        workspaceId: installed.member.workspace.id,
        spaceId: installed.page.spaceId,
        pageId: installed.page.id,
        threadId: null,
        actorId: installed.member.user.id,
        eventType: "page_edit",
        sourceId: "projection-1",
        recipientIds: [],
        emitSlackChannel: true,
        createdAt: Date.now(),
      }),
    );
    const event = await env.DB.prepare(`SELECT id FROM slack_channel_events WHERE page_id = ?`)
      .bind(installed.page.id)
      .first<{ id: string }>();
    expect(event).not.toBeNull();
    await env.DB.batch(
      notificationFanoutStatements(env.DB, {
        workspaceId: installed.member.workspace.id,
        spaceId: installed.page.spaceId,
        pageId: installed.page.id,
        threadId: null,
        actorId: installed.member.user.id,
        eventType: "mention",
        sourceId: "suppressed-projection",
        recipientIds: [],
        emitSlackChannel: false,
        // A separately subscribed event type makes emitSlackChannel the only
        // reason this fanout does not create another channel event.
        createdAt: Date.now(),
      }),
    );
    expect(
      await env.DB.prepare(`SELECT COUNT(*) count FROM slack_channel_events WHERE page_id = ?`)
        .bind(installed.page.id)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(`SELECT topic FROM outbox WHERE payload_json = json_object('eventId', ?)`)
        .bind(event!.id)
        .first(),
    ).toEqual({
      topic: "slack_channel",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "17" } }),
      ),
    );
    await expect(deliverSlackChannelEvent(slackEnv(), event!.id)).rejects.toEqual(new SlackRateLimitError(17));
    expect(
      await env.DB.prepare(`SELECT delivered_at FROM slack_channel_events WHERE id = ?`).bind(event!.id).first(),
    ).toEqual({ delivered_at: null });

    const deliveredFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", deliveredFetch);
    await deliverSlackChannelEvent(slackEnv(), event!.id);
    expect(String(deliveredFetch.mock.calls[0]![1]?.body)).toContain("Launch &lt;@UATTACK&gt;¦plan");
    expect(
      await env.DB.prepare(`SELECT delivered_at IS NOT NULL delivered FROM slack_channel_events WHERE id = ?`)
        .bind(event!.id)
        .first(),
    ).toEqual({ delivered: 1 });
  });

  it("defers only the rate-limited Slack installation and retries it on a later tick", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const timestamp = Date.UTC(2026, 8, 5, 9, 5);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces (id, name, created_at) VALUES ('channel-workspace-two', 'Second workspace', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES ('channel-workspace-two', ?, 'owner', ?)`,
      ).bind(installed.member.user.id, timestamp),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, kind, position, title, created_by, created_at, updated_at, space_id)
         VALUES ('channel-page-two', 'channel-workspace-two', 'document', 'a0', 'Second page', ?, ?, ?,
                 'channel-workspace-two-general')`,
      ).bind(installed.member.user.id, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_installations
          (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
           installed_by, created_at, updated_at)
         VALUES ('channel-installation-two', 'channel-workspace-two', 'TCHANNEL2', 'Available', 'BCHANNEL2', ?,
                 'chat:write', ?, ?, ?)`,
      ).bind(
        await encryptSlackToken(slackEnv(), "xoxb-channel-available"),
        installed.member.user.id,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO slack_channel_subscriptions
          (id, installation_id, space_id, page_id, channel_id, channel_name, event_types_json, cadence,
           created_by, created_at, updated_at)
         VALUES
          ('channel-subscription-a', 'slack-installation', ?, ?, 'CRATEA', 'rate-a', '["page_edit"]',
           'digest', ?, ?, ?),
          ('channel-subscription-b', 'slack-installation', ?, ?, 'CRATEB', 'rate-b', '["page_edit"]',
           'digest', ?, ?, ?),
          ('channel-subscription-c', 'channel-installation-two', 'channel-workspace-two-general',
           'channel-page-two', 'CRATEC', 'rate-c', '["page_edit"]', 'digest', ?, ?, ?)`,
      ).bind(
        installed.page.spaceId,
        installed.page.id,
        installed.member.user.id,
        timestamp,
        timestamp,
        installed.page.spaceId,
        installed.page.id,
        installed.member.user.id,
        timestamp + 1,
        timestamp + 1,
        installed.member.user.id,
        timestamp + 2,
        timestamp + 2,
      ),
      env.DB.prepare(
        `INSERT INTO slack_channel_events
          (id, subscription_id, workspace_id, event_type, actor_id, page_id, cadence, created_at)
         VALUES
          ('channel-event-a', 'channel-subscription-a', ?, 'page_edit', ?, ?, 'digest', ?),
          ('channel-event-b', 'channel-subscription-b', ?, 'page_edit', ?, ?, 'digest', ?),
          ('channel-event-c', 'channel-subscription-c', 'channel-workspace-two', 'page_edit', ?,
           'channel-page-two', 'digest', ?)`,
      ).bind(
        installed.member.workspace.id,
        installed.member.user.id,
        installed.page.id,
        timestamp - 10 * 60_000,
        installed.member.workspace.id,
        installed.member.user.id,
        installed.page.id,
        timestamp - 10 * 60_000 + 1,
        installed.member.user.id,
        timestamp - 10 * 60_000 + 2,
      ),
    ]);
    const channels: string[] = [];
    let remainingRateLimits = 1;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      channels.push(JSON.parse(String(init?.body)).channel as string);
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer xoxb-test-bot-token" && remainingRateLimits-- > 0
        ? Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "30" } })
        : Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await sendDueSlackChannelDigests(slackEnv(), timestamp);

    expect(channels).toEqual(["CRATEA", "CRATEC"]);
    expect(
      await env.DB.prepare(
        `SELECT id, delivered_at IS NOT NULL delivered FROM slack_channel_events
          WHERE id LIKE 'channel-event-%' ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: "channel-event-a", delivered: 0 },
        { id: "channel-event-b", delivered: 0 },
        { id: "channel-event-c", delivered: 1 },
      ],
    });

    await sendDueSlackChannelDigests(slackEnv(), timestamp + 15 * 60_000);

    expect(channels).toEqual(["CRATEA", "CRATEC", "CRATEA", "CRATEB"]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) delivered FROM slack_channel_events
          WHERE id LIKE 'channel-event-%' AND delivered_at IS NOT NULL`,
      ).first(),
    ).toEqual({ delivered: 3 });
    log.mockRestore();
  });
});
