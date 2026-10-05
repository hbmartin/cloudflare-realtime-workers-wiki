import { enrollAccount, responseCookies, securityRequest } from "../../tests/helpers/security";
import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext, Page, Space } from "../shared/types";
import type { Env, MemberContext } from "./env";
import worker from "./index";
import { consumeDeliveryMessage } from "./jobs";
import { syncRound2Configuration } from "./slack-channels";
import { createShare } from "./shares";
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
  upsertSlackChannelSubscription,
  handleSlackCommand,
  handleSlackEvent,
  recordVerifiedSlackIdentity,
  recordSlackPrimaryFactorProof,
  recordSlackInstallationError,
  sendPersonalSlackNotification,
  sendDueSlackChannelDigests,
  SlackRateLimitError,
  SlackApiError,
  slackScopeHealth,
  slackWorkspaceStatus,
  validateSlackIdentity,
  verifySlackRequest,
} from "./slack";
import { deliverSlackHome } from "./slack-workspace";

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

async function bootstrapResponse() {
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
  return response;
}

async function bootstrap() {
  const cookie = await enrollAccount(await bootstrapResponse());
  const member = await (await SELF.fetch(request(cookie, "/api/me"))).json<ClientMemberContext>();
  sessionIds.set(
    member.user.id,
    (await env.DB.prepare("SELECT id FROM session WHERE userId=? ORDER BY createdAt DESC LIMIT 1")
      .bind(member.user.id)
      .first<{ id: string }>())!.id,
  );
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
  const cookie = await enrollAccount(accepted, token);
  const member = await (await SELF.fetch(request(cookie, "/api/me"))).json<ClientMemberContext>();
  sessionIds.set(
    member.user.id,
    (await env.DB.prepare("SELECT id FROM session WHERE userId=? ORDER BY createdAt DESC LIMIT 1")
      .bind(member.user.id)
      .first<{ id: string }>())!.id,
  );
  return { cookie, member };
}

const sessionIds = new Map<string, string>();

function memberContext(member: ClientMemberContext): MemberContext {
  return {
    ...member,
    session: { id: sessionIds.get(member.user.id)!, expiresAt: new Date(Date.now() + 60_000) },
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

async function legacyChannelFixture(cadence: "immediate" | "digest") {
  const installed = await bootstrap();
  await installSlack(installed.member);
  const bindings: Env = { ...slackEnv(), SLACK_CHANNEL_VALIDATION_ENABLED: "false" };
  const mapping = await upsertSlackChannelSubscription(bindings, memberContext(installed.member), {
    spaceId: installed.page.spaceId,
    pageId: null,
    channelId: "C0123456789",
    channelName: "notes",
    cadence,
    eventTypes: ["page_edit", "mention"],
  });
  await env.DB.prepare(`INSERT INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at)
    VALUES('actor-event',?,?,'mention',?,?,?,1)`)
    .bind(mapping.id, installed.member.workspace.id, installed.member.user.id, installed.page.id, cadence)
    .run();
  return { ...installed, bindings, mapping };
}

describe("legacy channel event settlement", () => {
  it.each(["immediate", "digest"] as const)("suppresses unauthorized %s actors", async (cadence) => {
    const fixture = await legacyChannelFixture(cadence);
    await env.DB.prepare("UPDATE account_security SET codes_saved=0 WHERE user_id=?")
      .bind(fixture.member.user.id)
      .run();
    const remote = vi.fn();
    vi.stubGlobal("fetch", remote);
    if (cadence === "immediate") await deliverSlackChannelEvent(fixture.bindings, "actor-event");
    else await sendDueSlackChannelDigests(fixture.bindings, Date.UTC(2026, 9, 4, 10));
    expect(remote).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT suppressed_at,delivered_at FROM slack_channel_events WHERE id='actor-event'",
      ).first(),
    ).toEqual({ suppressed_at: expect.any(Number), delivered_at: null });
  });

  it("leaves a live competing claim untouched for an authorized event", async () => {
    const fixture = await legacyChannelFixture("immediate");
    await env.DB.prepare("UPDATE slack_channel_events SET claim_token='other',claimed_at=? WHERE id='actor-event'")
      .bind(Date.now())
      .run();
    const before = await env.DB.prepare("SELECT * FROM slack_channel_events WHERE id='actor-event'").first();
    const remote = vi.fn();
    vi.stubGlobal("fetch", remote);
    await deliverSlackChannelEvent(fixture.bindings, "actor-event");
    expect(remote).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT * FROM slack_channel_events WHERE id='actor-event'").first()).toEqual(before);
  });

  it.each(["immediate", "digest", "partial digest"] as const)(
    "rechecks %s authorization during token refresh",
    async (mode) => {
      const fixture = await legacyChannelFixture(mode === "immediate" ? "immediate" : "digest");
      if (mode === "partial digest") {
        const viewer = await inviteViewer(fixture.cookie);
        await env.DB.prepare(`INSERT INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,cadence,created_at)
          VALUES('surviving-event',?,?,'mention',?,?,'digest',1)`)
          .bind(fixture.mapping.id, fixture.member.workspace.id, viewer.member.user.id, fixture.page.id)
          .run();
      }
      await env.DB.prepare("UPDATE slack_installations SET token_expires_at=1,bot_refresh_token_ciphertext=?")
        .bind(await encryptSlackToken(fixture.bindings, "xoxr-old"))
        .run();
      const posts: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("oauth.v2.access")) {
            await env.DB.prepare("UPDATE account_security SET codes_saved=0 WHERE user_id=?")
              .bind(fixture.member.user.id)
              .run();
            return Response.json({ ok: true, access_token: "xoxb-new", refresh_token: "xoxr-new", expires_in: 3600 });
          }
          if (String(input).includes("chat.postMessage"))
            posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ ok: true, ts: "1700000000.000001" });
        }),
      );
      if (mode === "immediate") await deliverSlackChannelEvent(fixture.bindings, "actor-event");
      else await sendDueSlackChannelDigests(fixture.bindings, Date.UTC(2026, 9, 4, 10));
      expect(posts).toHaveLength(mode === "partial digest" ? 1 : 0);
      expect(
        await env.DB.prepare(
          "SELECT suppressed_at,delivered_at FROM slack_channel_events WHERE id='actor-event'",
        ).first(),
      ).toEqual({ suppressed_at: expect.any(Number), delivered_at: null });
      expect(posts.map((post) => post.text)).toEqual(mode === "partial digest" ? ["1 NoteFlare update"] : []);
      expect(JSON.stringify(posts)).not.toContain(fixture.member.user.name);
      const delivered = { delivered_at: expect.any(Number), suppressed_at: null };
      expect(
        await env.DB.prepare(
          "SELECT delivered_at,suppressed_at FROM slack_channel_events WHERE id='surviving-event'",
        ).first(),
      ).toEqual(mode === "partial digest" ? delivered : null);
    },
  );

  it.each(["immediate", "digest"] as const)(
    "does not dispatch %s work after losing its claim during refresh",
    async (cadence) => {
      const fixture = await legacyChannelFixture(cadence);
      await env.DB.prepare("UPDATE slack_installations SET token_expires_at=1,bot_refresh_token_ciphertext=?")
        .bind(await encryptSlackToken(fixture.bindings, "xoxr-old"))
        .run();
      const posts = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).includes("oauth.v2.access")) {
            await env.DB.prepare(
              "UPDATE slack_channel_events SET claim_token='competitor',claimed_at=? WHERE id='actor-event'",
            )
              .bind(Date.now())
              .run();
            return Response.json({ ok: true, access_token: "xoxb-new", refresh_token: "xoxr-new", expires_in: 3600 });
          }
          posts();
          return Response.json({ ok: true, ts: "1700000000.000001" });
        }),
      );
      if (cadence === "immediate") await deliverSlackChannelEvent(fixture.bindings, "actor-event");
      else await sendDueSlackChannelDigests(fixture.bindings, Date.UTC(2026, 9, 4, 10));
      expect(posts).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare(
          "SELECT claim_token,delivered_at,suppressed_at FROM slack_channel_events WHERE id='actor-event'",
        ).first(),
      ).toEqual({ claim_token: "competitor", delivered_at: null, suppressed_at: null });
    },
  );

  it.each(["immediate", "digest"] as const)(
    "releases %s claims after a dispatch authorization query fails",
    async (cadence) => {
      const fixture = await legacyChannelFixture(cadence);
      const db = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (sql.trimStart().startsWith("SELECT event.id FROM slack_channel_events event"))
                throw new Error("authorization database unavailable");
              return target.prepare(sql);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const remote = vi.fn();
      vi.stubGlobal("fetch", remote);
      const delivery =
        cadence === "immediate"
          ? deliverSlackChannelEvent({ ...fixture.bindings, DB: db }, "actor-event")
          : sendDueSlackChannelDigests({ ...fixture.bindings, DB: db }, Date.UTC(2026, 9, 4, 10));
      const error = await delivery.then(
        () => "",
        (cause: Error) => cause.message,
      );
      expect(error).toBe(cadence === "immediate" ? "authorization database unavailable" : "");
      expect(remote).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare(
          "SELECT claim_token,claimed_at,delivered_at,suppressed_at FROM slack_channel_events WHERE id='actor-event'",
        ).first(),
      ).toEqual({ claim_token: null, claimed_at: null, delivered_at: null, suppressed_at: null });
    },
  );

  it("suppresses an actor in account recovery", async () => {
    const fixture = await legacyChannelFixture("immediate");
    await env.DB.prepare("UPDATE account_security SET recovery_required=1 WHERE user_id=?")
      .bind(fixture.member.user.id)
      .run();
    await deliverSlackChannelEvent(fixture.bindings, "actor-event");
    expect(
      await env.DB.prepare("SELECT suppressed_at FROM slack_channel_events WHERE id='actor-event'").first(),
    ).toEqual({ suppressed_at: expect.any(Number) });
  });

  it.each(["other claim", "delivered"])("preserves an event with %s", async (mode) => {
    const fixture = await legacyChannelFixture("immediate");
    await env.DB.prepare("UPDATE account_security SET codes_saved=0 WHERE user_id=?")
      .bind(fixture.member.user.id)
      .run();
    await env.DB.prepare(
      mode === "other claim"
        ? "UPDATE slack_channel_events SET claim_token='other',claimed_at=? WHERE id='actor-event'"
        : "UPDATE slack_channel_events SET delivered_at=? WHERE id='actor-event'",
    )
      .bind(Date.now())
      .run();
    const before = await env.DB.prepare("SELECT * FROM slack_channel_events WHERE id='actor-event'").first();
    await deliverSlackChannelEvent(fixture.bindings, "actor-event");
    expect(await env.DB.prepare("SELECT * FROM slack_channel_events WHERE id='actor-event'").first()).toEqual(before);
  });

  it.each(["immediate", "digest"] as const)("suppresses access revoked after the %s claim", async (cadence) => {
    const fixture = await legacyChannelFixture(cadence);
    let claimed = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === "bind") return (...binds: unknown[]) => wrap(target.bind(...binds));
          if (key === "all")
            return async () => {
              const result = await target.all();
              claimed = true;
              await env.DB.prepare("UPDATE account_security SET codes_saved=0 WHERE user_id=?")
                .bind(fixture.member.user.id)
                .run();
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            sql.includes("UPDATE slack_channel_events SET claimed_at")
              ? wrap(target.prepare(sql))
              : target.prepare(sql);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bindings = { ...fixture.bindings, DB: db };
    const remote = vi.fn();
    vi.stubGlobal("fetch", remote);
    if (cadence === "immediate") await deliverSlackChannelEvent(bindings, "actor-event");
    else await sendDueSlackChannelDigests(bindings, Date.UTC(2026, 9, 4, 10));
    expect(claimed).toBe(true);
    expect(remote).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT suppressed_at,claim_token FROM slack_channel_events WHERE id='actor-event'").first(),
    ).toEqual({ suppressed_at: expect.any(Number), claim_token: null });
  });

  it.each(["muted", "snoozed", "installation error"])("keeps %s events deferred", async (mode) => {
    const fixture = await legacyChannelFixture("immediate");
    await env.DB.prepare(
      mode === "installation error"
        ? "UPDATE slack_installations SET auth_error='invalid_auth'"
        : mode === "muted"
          ? "UPDATE slack_channel_subscriptions SET muted_at=1"
          : "UPDATE slack_channel_subscriptions SET snoozed_until=9999999999999",
    ).run();
    await deliverSlackChannelEvent(fixture.bindings, "actor-event");
    expect(
      await env.DB.prepare(
        "SELECT suppressed_at,delivered_at FROM slack_channel_events WHERE id='actor-event'",
      ).first(),
    ).toEqual({ suppressed_at: null, delivered_at: null });
  });

  it("keeps authorized integration actors eligible", async () => {
    const fixture = await legacyChannelFixture("immediate");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('legacy-bot','Bot','legacy-bot@example.test',1,1)",
      ),
      env.DB.prepare(`INSERT INTO integrations(id,workspace_id,bot_user_id,name,read_comments,insert_comments,created_by,created_at,updated_at)
        VALUES('legacy-integration',?,'legacy-bot','Writer',1,1,?,1,1)`).bind(
        fixture.member.workspace.id,
        fixture.member.user.id,
      ),
      env.DB.prepare(
        "INSERT INTO integration_grants(integration_id,root_page_id,created_by,created_at) VALUES('legacy-integration',?,?,1)",
      ).bind(fixture.page.id, fixture.member.user.id),
      env.DB.prepare("UPDATE slack_channel_events SET actor_id='legacy-bot' WHERE id='actor-event'"),
    ]);
    const remote = vi.fn(async () => Response.json({ ok: true, ts: "123.456" }));
    vi.stubGlobal("fetch", remote);
    await deliverSlackChannelEvent(fixture.bindings, "actor-event");
    expect(remote).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT suppressed_at,delivered_at FROM slack_channel_events WHERE id='actor-event'",
      ).first(),
    ).toEqual({ suppressed_at: null, delivered_at: expect.any(Number) });
  });
});

describe("Slack share-refresh HTTP enqueueing", () => {
  it.each(["rate limit", "competing claim"])(
    "returns a saved repair and sweeps safe work after a reconciliation %s",
    async (failure) => {
      const installed = await bootstrap();
      await installSlack(installed.member);
      await env.DB.prepare("UPDATE slack_installations SET generation=1 WHERE id='slack-installation'").run();
      const send = vi.fn();
      const testEnv: Env = {
        ...slackEnv(),
        SLACK_CHANNEL_VALIDATION_ENABLED: "true",
        WORKSPACE_ACTIVITY_ENABLED: "true",
        SLACK_DIGEST_DEFAULT_TIMEZONE: "America/Chicago",
        DELIVERY_QUEUE: { send } as unknown as Env["DELIVERY_QUEUE"],
      };
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const method = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        ).pathname
          .split("/")
          .at(-1);
        if (method === "openid-configuration")
          return Response.json({
            issuer: "https://slack.com",
            jwks_uri: "https://slack.com/openid/connect/keys",
            authorization_endpoint: "https://slack.com/openid/connect/authorize",
            token_endpoint: "https://slack.com/api/openid.connect.token",
            userinfo_endpoint: "https://slack.com/api/openid.connect.userInfo",
          });
        if (method === "conversations.info")
          return Response.json({ ok: true, channel: { id: "C123", name: "notes", is_channel: true, is_member: true } });
        if (method === "conversations.history") {
          if (failure === "competing claim") throw new Error("A live claim must prevent history lookup.");
          return new Response("limited", { status: 429, headers: { "Retry-After": "45" } });
        }
        throw new Error(`Unexpected Slack method ${method}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      await syncRound2Configuration(testEnv);
      const m = await upsertSlackChannelSubscription(testEnv, memberContext(installed.member), {
        spaceId: installed.page.spaceId!,
        pageId: null,
        channelId: "C123",
        channelName: "notes",
        eventTypes: ["page_edit"],
        cadence: "digest",
      });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE slack_channel_subscriptions SET notification_blocked_at=1,notification_error='no_permission' WHERE id=?",
        ).bind(m.id),
        env.DB.prepare(`INSERT INTO slack_digest_receipts(id,installation_id,installation_generation,subscription_id,window_start,window_end,channel_id,state,attempted_at,created_at)
        VALUES('older','slack-installation',1,?,0,1,'C123','sending',1,1),('safe','slack-installation',1,?,1,2,'C123','pending',NULL,1)`).bind(
          m.id,
          m.id,
        ),
        env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at,enqueued_at,slack_redrive_due_at)
        VALUES('older-outbox',?,'slack_digest','{"digestId":"older"}',1,1,1,9999999999999),('safe-outbox',?,'slack_digest','{"digestId":"safe"}',1,1,1,9999999999999)`).bind(
          installed.member.workspace.id,
          installed.member.workspace.id,
        ),
      ]);
      if (failure === "competing claim")
        await env.DB.prepare("UPDATE slack_digest_receipts SET claim_token='competing',claimed_at=? WHERE id='older'")
          .bind(Date.now())
          .run();
      const context = createExecutionContext();
      const response = await worker.fetch(
        request(installed.cookie, `/api/slack/channels/${m.id}/repair-notifications`, { method: "POST" }),
        testEnv,
        context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ subscription: { id: m.id, notificationBlockedAt: null } });
      await waitOnExecutionContext(context);
      expect(
        await env.DB.prepare("SELECT notification_blocked_at FROM slack_channel_subscriptions WHERE id=?")
          .bind(m.id)
          .first(),
      ).toEqual({ notification_blocked_at: null });
      expect(
        await env.DB.prepare("SELECT state,attempted_at FROM slack_digest_receipts WHERE id='older'").first(),
      ).toEqual({ state: "sending", attempted_at: 1 });
      expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outboxId: "safe-outbox" }));
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("conversations.history"))).toBe(
        failure === "rate limit",
      );
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("chat.postMessage"))).toBe(false);
    },
  );
  it.each([
    "share creation",
    "share update",
    "share revocation",
    "mapping creation",
    "mapping update",
    "mapping destination change",
    "mapping deletion",
  ])("sweeps pending refreshes after %s", async (mutation) => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    await env.DB.prepare(
      "UPDATE slack_installations SET scopes=scopes||',channels:read,groups:read' WHERE id='slack-installation'",
    ).run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        Response.json({
          ok: true,
          channel: {
            id: new URL(String(input)).searchParams.get("channel") ?? "C123",
            name: "canonical",
            is_channel: true,
            is_member: true,
            is_archived: false,
          },
        }),
      ),
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = {
      ...slackEnv(),
      WORKSPACE_ACTIVITY_ENABLED: "true",
      SLACK_CHANNEL_VALIDATION_ENABLED: "true",
      SLACK_SHARE_REFRESH_ENABLED: "true",
      SLACK_DIGEST_DEFAULT_TIMEZONE: "America/Los_Angeles",
      DELIVERY_QUEUE: { send },
    } as unknown as Env;
    await syncRound2Configuration(bindings);
    const input = {
      spaceId: installed.page.spaceId!,
      pageId: null,
      channelId: "C123",
      channelName: "canonical",
      cadence: "immediate" as const,
      eventTypes: ["page_created" as const],
    };
    const mapping =
      mutation === "mapping creation"
        ? null
        : await upsertSlackChannelSubscription(bindings, memberContext(installed.member), input);
    if (["share update", "share revocation"].includes(mutation))
      await createShare(bindings, memberContext(installed.member), installed.page.id, "http://example.test", {});
    await env.DB.prepare(`INSERT INTO slack_share_references(id,installation_id,installation_generation,page_id,channel_id,message_ts,url,observed_user_id,reference_kind,created_at,updated_at)
      VALUES('tracked','slack-installation',1,?,'C123','123.456',?,?,'page',1,1)`)
      .bind(installed.page.id, `http://example.test/?page=${installed.page.id}`, installed.member.user.id)
      .run();
    // Share options do not create a lifecycle revision themselves, but the route
    // must also sweep pending work from a preceding availability change.
    if (mutation === "share update")
      await env.DB.prepare(
        "UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE id='tracked'",
      ).run();
    const path = mutation.startsWith("share")
      ? `/api/pages/${installed.page.id}/share`
      : `/api/slack/channels${mutation === "mapping creation" ? "" : `/${mapping!.id}`}`;
    const method = mutation.endsWith("creation")
      ? "POST"
      : mutation.endsWith("revocation") || mutation.endsWith("deletion")
        ? "DELETE"
        : "PATCH";
    const body =
      mutation === "mapping creation"
        ? input
        : mutation === "mapping update"
          ? { pageId: installed.page.id }
          : mutation === "mapping destination change"
            ? { channelId: "C456" }
            : { showToc: false };
    const context = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
      }),
      bindings,
      context,
    );
    expect(response.status).toBe(method === "POST" ? 201 : mutation === "share revocation" ? 204 : 200);
    await waitOnExecutionContext(context);
    const outbox = (
      await env.DB.prepare("SELECT id,enqueued_at FROM outbox WHERE topic='slack_share_refresh'").all<{
        id: string;
        enqueued_at: number | null;
      }>()
    ).results;
    expect(outbox.length).toBeGreaterThan(0);
    for (const row of outbox) {
      expect(row.enqueued_at).not.toBeNull();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ outboxId: row.id }));
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mutation classification and sweep scheduling", () => {
  function trackedBindings(enabled = true) {
    const claims: string[] = [];
    const DB = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare")
          return (sql: string) => {
            if (/UPDATE outbox_sweep_state\s+SET lease_token = \?/i.test(sql)) claims.push(sql);
            return target.prepare(sql);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = {
      ...slackEnv(),
      DB,
      DELIVERY_QUEUE: { send },
      WORKSPACE_ACTIVITY_ENABLED: enabled ? "true" : "false",
      SLACK_CHANNEL_VALIDATION_ENABLED: enabled ? "true" : "false",
      SLACK_SHARE_REFRESH_ENABLED: enabled ? "true" : "false",
      SLACK_DIGEST_DEFAULT_TIMEZONE: "America/Los_Angeles",
    } as unknown as Env;
    return { bindings, claims, send };
  }

  it.each([
    { action: "archive", bulk: false },
    { action: "move", bulk: false },
    { action: "archive", bulk: true },
    { action: "move", bulk: true },
  ])(
    "classifies $action with bulk=$bulk using active descendants and schedules one sweep",
    async ({ action, bulk }) => {
      const installed = await bootstrap();
      await installSlack(installed.member);
      const { bindings, claims } = trackedBindings();
      await syncRound2Configuration(bindings);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ ok: true, channel: { id: "C123", name: "canonical", is_channel: true, is_member: true } }),
        ),
      );
      await upsertSlackChannelSubscription(bindings, memberContext(installed.member), {
        spaceId: installed.page.spaceId!,
        pageId: null,
        channelId: "C123",
        channelName: "canonical",
        cadence: "immediate",
        eventTypes: ["page_archived", "page_moved"],
      });
      await env.DB.batch([
        env.DB.prepare("UPDATE pages SET kind='table',is_task_list=1 WHERE id=?").bind(installed.page.id),
        env.DB.prepare(
          "INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,updated_by,created_at,updated_at,archived_at) VALUES('old-trash',?,?,?,'table','a0','Old child',?,?,1,1,1)",
        ).bind(
          installed.member.workspace.id,
          installed.page.spaceId,
          installed.page.id,
          installed.member.user.id,
          installed.member.user.id,
        ),
        env.DB.prepare(
          "INSERT INTO spaces(id,workspace_id,name,slug,position,created_by,created_at,updated_at) VALUES('destination',?,'Destination','destination','a1',?,1,1)",
        ).bind(installed.member.workspace.id, installed.member.user.id),
      ]);
      if (bulk)
        await env.DB.prepare(
          "INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,updated_by,created_at,updated_at) VALUES('active-child',?,?,?,'table','a1','Active child',?,?,1,1)",
        )
          .bind(
            installed.member.workspace.id,
            installed.page.spaceId,
            installed.page.id,
            installed.member.user.id,
            installed.member.user.id,
          )
          .run();
      const context = createExecutionContext();
      const response = await worker.fetch(
        request(installed.cookie, `/api/pages/${installed.page.id}${action === "move" ? "/move-space" : ""}`, {
          method: action === "move" ? "POST" : "DELETE",
          headers: { "content-type": "application/json" },
          ...(action === "move" ? { body: JSON.stringify({ spaceId: "destination", parentId: null }) } : {}),
        }),
        bindings,
        context,
      );
      expect(response.status).toBe(200);
      await waitOnExecutionContext(context);
      const type = action === "move" ? "page_moved" : "page_archived";
      expect(
        await env.DB.prepare("SELECT operation_bulk FROM workspace_activity WHERE page_id=? AND event_type=?")
          .bind(installed.page.id, type)
          .first(),
      ).toEqual({ operation_bulk: bulk ? 1 : 0 });
      expect(await env.DB.prepare("SELECT count(*) n FROM slack_bulk_receipts").first()).toEqual({ n: bulk ? 1 : 0 });
      expect(claims).toHaveLength(1);
      expect(await env.DB.prepare("SELECT space_id,archived_at FROM pages WHERE id='old-trash'").first()).toEqual({
        space_id: action === "move" ? "destination" : installed.page.spaceId,
        archived_at: 1,
      });
      let restoreStatus: number | undefined;
      let restoreClaims: number | undefined;
      if (action === "archive") {
        claims.length = 0;
        const restoreContext = createExecutionContext();
        restoreStatus = (
          await worker.fetch(
            request(installed.cookie, `/api/pages/${installed.page.id}/restore`, { method: "POST" }),
            bindings,
            restoreContext,
          )
        ).status;
        await waitOnExecutionContext(restoreContext);
        restoreClaims = claims.length;
      }
      expect([restoreStatus, restoreClaims]).toEqual(action === "archive" ? [200, 1] : [undefined, undefined]);
    },
  );

  it("sweeps share refreshes immediately when invite completion inserts membership", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const invitation = await SELF.fetch(
      request(installed.cookie, "/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      }),
    );
    const token = (await invitation.json<{ invite: { token: string } }>()).invite.token;
    const accepted = await SELF.fetch("http://example.test/api/invites/accept", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({ token, name: "New viewer", email: "new-viewer@example.test", password: "password123" }),
    });
    expect(accepted.status).toBe(200);
    const cookie = await enrollAccount(accepted);
    const viewer = (await env.DB.prepare("SELECT id FROM user WHERE email='new-viewer@example.test'").first<{
      id: string;
    }>())!;
    const { bindings, claims, send } = trackedBindings();
    await syncRound2Configuration(bindings);
    await env.DB.prepare(
      "INSERT INTO slack_share_references(id,installation_id,installation_generation,page_id,channel_id,message_ts,url,observed_user_id,reference_kind,created_at,updated_at) VALUES('invite-reference','slack-installation',1,?,'C123','123.456',?,?,'page',1,1)",
    )
      .bind(installed.page.id, `http://example.test/?page=${installed.page.id}`, viewer.id)
      .run();
    const context = createExecutionContext();
    const response = await worker.fetch(
      request(cookie, "/api/invites/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      bindings,
      context,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(context);
    expect(claims).toHaveLength(1);
    const rows = (
      await env.DB.prepare("SELECT id,enqueued_at FROM outbox WHERE topic='slack_share_refresh'").all<{
        id: string;
        enqueued_at: number | null;
      }>()
    ).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.enqueued_at).not.toBeNull();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ outboxId: row.id }));
    }
  });

  it("skips pure mutation sweeps with Activity and shares disabled and still sweeps notification producers", async () => {
    const installed = await bootstrap();
    const { bindings, claims, send } = trackedBindings(false);
    const editContext = createExecutionContext();
    expect(
      (
        await worker.fetch(
          request(installed.cookie, `/api/pages/${installed.page.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Changed", revision: installed.page.revision }),
          }),
          bindings,
          editContext,
        )
      ).status,
    ).toBe(200);
    await waitOnExecutionContext(editContext);
    expect(claims).toHaveLength(0);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const shareContext = createExecutionContext();
      const response = await worker.fetch(
        request(installed.cookie, `/api/pages/${installed.page.id}/share`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "DELETE" ? {} : { body: JSON.stringify({ showToc: false }) }),
        }),
        bindings,
        shareContext,
      );
      expect(response.status).toBe(method === "POST" ? 201 : method === "DELETE" ? 204 : 200);
      await waitOnExecutionContext(shareContext);
      expect(claims).toHaveLength(0);
    }
    const viewer = await inviteViewer(installed.cookie);
    for (const method of ["PATCH", "DELETE"]) {
      const membershipContext = createExecutionContext();
      const response = await worker.fetch(
        request(installed.cookie, `/api/members/${viewer.member.user.id}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "DELETE" ? {} : { body: JSON.stringify({ role: "editor" }) }),
        }),
        bindings,
        membershipContext,
      );
      expect(response.status).toBe(200);
      await waitOnExecutionContext(membershipContext);
      expect(claims).toHaveLength(0);
    }
    await env.DB.prepare(
      "INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at) VALUES('ordinary-notification',?,'notification','{}',1,1)",
    )
      .bind(installed.member.workspace.id)
      .run();
    await env.DB.prepare("UPDATE pages SET kind='table',is_task_list=1 WHERE id=?").bind(installed.page.id).run();
    await env.DB.prepare("INSERT INTO table_state(page_id) VALUES(?)").bind(installed.page.id).run();
    const { taskListStatements } = await import("./tasks");
    await env.DB.batch(taskListStatements(env.DB, installed.page.id));
    const createContext = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, `/api/task-lists/${installed.page.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "notification-producer",
          expectedRevision: 1,
          title: "Task",
          status: "todo",
        }),
      }),
      bindings,
      createContext,
    );
    expect(response.status).toBe(201);
    await waitOnExecutionContext(createContext);
    expect(claims).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ outboxId: "ordinary-notification" }));
    const task = await response.json<{ rowId: string }>();
    claims.length = 0;
    const archiveContext = createExecutionContext();
    const archived = await worker.fetch(
      request(installed.cookie, `/api/task-lists/${installed.page.id}/tasks/${task.rowId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: "notification-archive", expectedRevision: 2, archived: true }),
      }),
      bindings,
      archiveContext,
    );
    expect(archived.status).toBe(200);
    await waitOnExecutionContext(archiveContext);
    expect(claims).toHaveLength(1);
  });
});

describe("Slack security and integration", () => {
  describe("personal identity linking", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            issuer: "https://slack.com",
            authorization_endpoint: "https://slack.com/openid/connect/authorize",
            token_endpoint: "https://slack.com/api/openid.connect.token",
            userinfo_endpoint: "https://slack.com/api/openid.connect.userInfo",
            jwks_uri: "https://slack.com/openid/connect/keys",
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        ),
      );
    });

    async function link(cookie: string, provider = "slack") {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        request(cookie, "/api/auth/link-social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, callbackURL: "/?view=settings&slack=verified", disableRedirect: true }),
        }),
        slackEnv(),
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    }

    it("rejects linking without enrollment and does not grant workspace assurance", async () => {
      const cookie = responseCookies(await bootstrapResponse());
      const response = await link(cookie);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "SECURITY_REQUIRED" });
      expect(await env.DB.prepare("SELECT 1 FROM session_security").first()).toBeNull();
      expect(await (await securityRequest(cookie, "/api/security/status")).json()).toMatchObject({
        state: "enrollment_required",
        fresh: false,
      });
      expect((await securityRequest(cookie, "/api/me")).status).toBe(401);
      expect((await securityRequest(cookie, "/api/slack/oauth/start")).status).toBe(401);
    });

    it("rejects older assurance without changing its verification time", async () => {
      const { cookie } = await bootstrap();
      const verifiedAt = Date.now() - 6 * 60_000;
      await env.DB.prepare("UPDATE session_security SET verified_at = ?").bind(verifiedAt).run();
      expect(await (await securityRequest(cookie, "/api/security/status")).json()).toMatchObject({
        state: "ready",
        fresh: false,
      });
      expect((await link(cookie)).status).toBe(403);
      const otherProvider = await link(cookie, "google");
      expect(otherProvider.status).toBe(403);
      expect(await otherProvider.json()).toMatchObject({ code: "SECURITY_REQUIRED" });
      const accountChange = await securityRequest(cookie, "/api/auth/update-user", { name: "Changed" });
      expect(accountChange.status).toBe(403);
      expect(await accountChange.json()).toMatchObject({ code: "SECURITY_REQUIRED" });
      expect(await env.DB.prepare("SELECT verified_at FROM session_security").first()).toEqual({
        verified_at: verifiedAt,
      });
    });

    it("rejects a trusted-browser session without fresh factor verification", async () => {
      const { cookie } = await bootstrap();
      const trusted = await securityRequest(cookie, "/api/security/trust", {});
      expect(trusted.status).toBe(200);
      const browserCookie = responseCookies(trusted);
      const signIn = await securityRequest(browserCookie, "/api/auth/sign-in/email", {
        email: "slack-owner@example.test",
        password: "password123",
      });
      const pending = responseCookies(signIn, browserCookie);
      const completed = await securityRequest(pending, "/api/security/complete-trust", {});
      expect(completed.status).toBe(200);
      const session = responseCookies(completed, pending);
      expect(await (await securityRequest(session, "/api/security/status")).json()).toMatchObject({
        state: "ready",
        fresh: false,
      });
      expect((await link(session)).status).toBe(403);
    });

    it.each(["anonymous", "expired session"])("rejects %s requests", async (mode) => {
      let cookie = "";
      if (mode === "expired session") {
        cookie = responseCookies(await bootstrapResponse());
        await env.DB.prepare("UPDATE session SET expiresAt = ?")
          .bind(new Date(Date.now() - 1).toISOString())
          .run();
      }
      expect((await link(cookie)).status).toBe(401);
    });

    it("rejects a pending two-factor challenge without a live session", async () => {
      await bootstrap();
      const signIn = await securityRequest("", "/api/auth/sign-in/email", {
        email: "slack-owner@example.test",
        password: "password123",
      });
      expect(await signIn.clone().json()).toMatchObject({ twoFactorRedirect: true });
      expect((await link(responseCookies(signIn))).status).toBe(401);
    });

    it("requires recovery-key acknowledgment before linking", async () => {
      const { cookie } = await bootstrap();
      const { codes, receipt } = await (
        await securityRequest(cookie, "/api/security/recovery-codes", {})
      ).json<{ codes: string[]; receipt: string }>();
      expect((await securityRequest(cookie, "/api/security/acknowledge-codes", { receipt })).status).toBe(200);
      const recovered = await securityRequest(cookie, "/api/security/recover", {
        password: "password123",
        code: codes[0],
      });
      expect(recovered.status).toBe(200);
      const response = await link(responseCookies(recovered, cookie));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "SECURITY_REQUIRED",
        message: "Save your recovery resume key before continuing.",
      });
    });
  });

  it("requires reauthorization when the connected bot token fails with complete scopes", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    await env.DB.prepare(`UPDATE slack_installations SET scopes = ?,auth_error='invalid_auth',auth_error_at=?
      WHERE id='slack-installation'`)
      .bind(
        "commands,chat:write,links:read,links:write,channels:read,groups:read,channels:history,groups:history,users:read,reactions:read,files:write",
        Date.now(),
      )
      .run();
    const status = await slackWorkspaceStatus(slackEnv(), memberContext(installed.member));
    expect(status.installation?.scopeHealth.reauthorizationRequired).toBe(false);
    expect(status.reauthorization.required).toBe(true);
    expect(status.installation?.authError).toBe("invalid_auth");
  });
  it("reports capability-specific scope health without disabling legacy features", () => {
    const legacy = slackScopeHealth("links:write,commands,chat:write,links:read,commands");
    expect(legacy.granted).toEqual(["chat:write", "commands", "links:read", "links:write"]);
    expect(legacy.reauthorizationRequired).toBe(true);
    expect(legacy.capabilities.search.available).toBe(true);
    expect(legacy.capabilities.unfurls.available).toBe(true);
    expect(legacy.capabilities.notifications.available).toBe(true);
    expect(legacy.capabilities.identity).toMatchObject({ available: false, missingScopes: ["users:read"] });
    expect(legacy.capabilities.capture.available).toBe(false);
  });

  it("verifies team-scoped human identities and records a session-bound primary proof", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const profile = {
      "https://slack.com/team_id": "T123",
      "https://slack.com/user_id": "UOWNER",
      email: "untrusted-profile@example.test",
    };
    await expect(validateSlackIdentity(slackEnv(), profile)).rejects.toMatchObject({
      code: "slack_scope_missing",
    });
    await env.DB.prepare(
      `UPDATE slack_installations SET scopes = scopes || ',users:read' WHERE id = 'slack-installation'`,
    ).run();
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, user: { id: "UOWNER", team_id: "T123", deleted: false } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const identity = await validateSlackIdentity(slackEnv(), profile);
    expect(identity.accountSubject).toBe("T123:UOWNER");
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES ('slack-account', ?, 'slack', ?, ?, ?)`,
    )
      .bind(identity.accountSubject, installed.member.user.id, timestamp, timestamp)
      .run();
    const session = await env.DB.prepare(`SELECT id FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`)
      .bind(installed.member.user.id)
      .first<{ id: string }>();
    await recordVerifiedSlackIdentity(slackEnv(), installed.member.user.id, session!.id, "slack-account", identity);
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    await recordSlackPrimaryFactorProof(
      slackEnv(),
      installed.member.user.id,
      session!.id,
      "slack-account",
      identity,
      "sign_in",
    );
    expect(await slackWorkspaceStatus(slackEnv(), memberContext(installed.member))).toMatchObject({
      identity: { state: "verified", slackUserId: "UOWNER" },
      linked: true,
    });
    expect(
      await env.DB.prepare(
        `SELECT user_id, team_id, slack_user_id, expires_at > verified_at active
           FROM slack_primary_factor_proofs WHERE session_id = ?`,
      )
        .bind(session!.id)
        .first(),
    ).toEqual({ user_id: installed.member.user.id, team_id: "T123", slack_user_id: "UOWNER", active: 1 });
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM session_security WHERE session_id = ?`).bind(session!.id),
      env.DB.prepare(`DELETE FROM twoFactor WHERE userId = ?`).bind(installed.member.user.id),
      env.DB.prepare(`DELETE FROM passkey WHERE userId = ?`).bind(installed.member.user.id),
      env.DB.prepare(`UPDATE user SET twoFactorEnabled = 0 WHERE id = ?`).bind(installed.member.user.id),
      env.DB.prepare(`UPDATE account_security SET codes_saved = 0 WHERE user_id = ?`).bind(installed.member.user.id),
    ]);
    expect(await (await SELF.fetch(request(installed.cookie, "/api/security/status"))).json()).toMatchObject({
      state: "enrollment_required",
      slackPrimary: { available: true },
    });
    expect(
      (
        await SELF.fetch(
          request(installed.cookie, "/api/security/setup-totp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(200);
    expect((await SELF.fetch(request(installed.cookie, "/api/me"))).status).toBe(401);
    await env.DB.prepare(`DELETE FROM session WHERE id = ?`).bind(session!.id).run();
    expect(await env.DB.prepare(`SELECT 1 FROM slack_primary_factor_proofs`).first()).toBeNull();

    await expect(
      validateSlackIdentity(slackEnv(), { ...profile, "https://slack.com/team_id": "T999" }, { teamId: "T123" }),
    ).rejects.toMatchObject({ code: "slack_team_mismatch" });
    for (const [user, code] of [
      [{ id: "UOWNER", team_id: "T123", deleted: true }, "slack_member_removed"],
      [{ id: "UOWNER", team_id: "T123", is_bot: true }, "slack_bot_forbidden"],
      [{ id: "UOWNER", team_id: "T123", is_restricted: true }, "slack_guest_forbidden"],
      [{ id: "UOWNER", team_id: "T123", is_stranger: true }, "slack_external_forbidden"],
    ] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: true, user }));
      await expect(validateSlackIdentity(slackEnv(), profile)).rejects.toMatchObject({ code });
    }
  });

  it("matches settings identity linking to a Slack team the member belongs to", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('second-workspace', 'Second', ?)`).bind(
        timestamp,
      ),
      env.DB.prepare(`INSERT INTO slack_installations
        (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
         installed_by, created_at, updated_at)
        VALUES ('second-installation', 'second-workspace', 'T999', 'Second Slack', 'B999', ?,
          'commands,users:read', ?, ?, ?)`).bind(
        await encryptSlackToken(slackEnv(), "xoxb-second"),
        installed.member.user.id,
        timestamp,
        timestamp,
      ),
    ]);
    const profile = { "https://slack.com/team_id": "T999", "https://slack.com/user_id": "UOTHER" };
    const fetchMock = vi.fn(async () => Response.json({ ok: true, user: { id: "UOTHER", team_id: "T999" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      validateSlackIdentity(slackEnv(), profile, { memberUserId: installed.member.user.id }),
    ).rejects.toMatchObject({ code: "slack_team_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
    await env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
      VALUES ('second-workspace', ?, 'editor', ?)`)
      .bind(installed.member.user.id, timestamp)
      .run();
    await expect(
      validateSlackIdentity(slackEnv(), profile, { memberUserId: installed.member.user.id }),
    ).resolves.toMatchObject({ installationId: "second-installation", teamId: "T999" });
  });

  it("starts Slack sign-up only from a live server-owned invite reservation", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    await env.DB.prepare(
      `UPDATE slack_installations SET scopes = scopes || ',users:read' WHERE id = 'slack-installation'`,
    ).run();
    const invitation = await SELF.fetch(
      request(installed.cookie, "/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    const token = (await invitation.json<{ invite: { token: string } }>()).invite.token;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes(".well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://slack.com",
          authorization_endpoint: "https://slack.com/openid/connect/authorize",
          token_endpoint: "https://slack.com/api/openid.connect.token",
          userinfo_endpoint: "https://slack.com/api/openid.connect.userInfo",
          jwks_uri: "https://slack.com/openid/connect/keys",
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const start = () =>
      worker.fetch(
        request(installed.cookie, "/api/slack/identity/invite/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
        slackEnv(),
        createExecutionContext(),
      );
    const started = await start();
    expect(started.status).toBe(200);
    const authorization = await started.json<{ url: string }>();
    expect(authorization).toMatchObject({ url: expect.stringContaining("slack.com") });
    const cookie = responseCookies(started, installed.cookie);
    expect(cookie).toMatch(/(?:^|; )better-auth\.state=/);
    const state = new URL(authorization.url).searchParams.get("state");
    await worker.fetch(
      request(cookie, `/api/auth/callback/slack?state=${encodeURIComponent(state!)}&code=invalid-code`),
      slackEnv(),
      createExecutionContext(),
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("openid.connect.token"))).toBe(true);
    expect(await start()).toMatchObject({ status: 200 });

    const direct = await worker.fetch(
      request(installed.cookie, "/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "slack", requestSignUp: true, disableRedirect: true }),
      }),
      slackEnv(),
      createExecutionContext(),
    );
    expect(direct.status).toBe(403);

    await env.DB.prepare(`UPDATE invites SET claim_expires_at = 0`).run();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await start()).status).toBe(200);
  });

  it("acknowledges signed shortcuts and explains how to connect an unverified identity", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const payload = {
      type: "message_action",
      callback_id: "noteflare_save_to_notes",
      trigger_id: "trigger-123",
      action_ts: "1700000000.000100",
      team: { id: "T123" },
      user: { id: "UOWNER" },
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async () => Response.json({ ok: true, view: { id: "V123", hash: "hash" } }));
    vi.stubGlobal("fetch", fetchMock);
    const context = createExecutionContext();
    const startedAt = performance.now();
    const response = await worker.fetch(
      new Request("http://example.test/api/slack/interactions", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": await slackSignature(timestamp, body),
        },
        body,
      }),
      slackEnv(),
      context,
    );
    expect(response.status).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    await waitOnExecutionContext(context);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/views.open",
      expect.objectContaining({ body: expect.stringContaining("Connect your Slack account") }),
    );
    expect(await env.DB.prepare("SELECT count(*) count FROM slack_product_sessions").first()).toEqual({ count: 0 });
  });

  it("queues one Home publication and shows a safe linking state", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const home = {
      type: "event_callback",
      event_id: "Ev-home",
      team_id: "T123",
      event: { type: "app_home_opened", user: "UOWNER" },
    };
    await handleSlackEvent(slackEnv(), home);
    await handleSlackEvent(slackEnv(), home);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) count FROM outbox WHERE topic = 'slack_home_publish'`).first(),
    ).toEqual({ count: 1 });
    await handleSlackEvent(slackEnv(), {
      type: "event_callback",
      event_id: "Ev-message",
      team_id: "T123",
      event: { type: "message", user: "UOWNER", channel: "C123", event_ts: "1700000000.1" },
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM slack_inbound_receipts`).first()).toEqual({ count: 0 });
    const fetchMock = vi.fn(async () => Response.json({ ok: true, view: { id: "VHOME", hash: "hash" } }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverSlackHome(slackEnv(), "slack-installation", "UOWNER");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/views.publish",
      expect.objectContaining({ body: expect.stringContaining("Your NoteFlare inbox is unavailable") }),
    );
  });

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
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
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
      if (url.endsWith("auth.revoke")) return Response.json({ ok: true, revoked: true });
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
    const mismatchState = new URL(
      await createSlackOAuthUrl(configured, memberContext(installed.member)),
    ).searchParams.get("state")!;
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        access_token: "xoxb-wrong-team",
        refresh_token: "xoxe-wrong-team",
        scope: "commands",
        bot_user_id: "B999",
        team: { id: "T999", name: "Wrong Slack" },
      }),
    );
    await expect(
      finishSlackOAuth(configured, memberContext(installed.member), "oauth-code", mismatchState),
    ).rejects.toMatchObject({ code: "slack_team_mismatch" });
    const revocations = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("auth.revoke"));
    expect(revocations.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual([
      "Bearer xoxb-wrong-team",
      "Bearer xoxe-wrong-team",
    ]);
    expect(await env.DB.prepare(`SELECT id, team_id FROM slack_installations`).first()).toEqual({
      id: installation!.id,
      team_id: "T123",
    });
    const failedCleanupState = new URL(
      await createSlackOAuthUrl(configured, memberContext(installed.member)),
    ).searchParams.get("state")!;
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: true, access_token: "xoxb-cleanup-fails", bot_user_id: "B999", team: { id: "T999" } }),
    );
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false }, { status: 500 }));
    await expect(
      finishSlackOAuth(configured, memberContext(installed.member), "oauth-code", failedCleanupState),
    ).rejects.toMatchObject({ code: "slack_team_mismatch" });
    const reauthorizeState = new URL(
      await createSlackOAuthUrl(configured, memberContext(installed.member)),
    ).searchParams.get("state")!;
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        access_token: "xoxb-reauthorized",
        refresh_token: "xoxe-refresh-reauthorized",
        expires_in: 3600,
        scope: "commands,chat:write,links:read,links:write,users:read",
        bot_user_id: "B123",
        team: { id: "T123", name: "Test Slack" },
      }),
    );
    const oldRevision = (await env.DB.prepare(`SELECT credential_revision revision FROM slack_installations
      WHERE team_id='T123'`).first<{ revision: number }>())!.revision;
    await env.DB.prepare(`INSERT INTO outbox
      (id,workspace_id,topic,payload_json,available_at,enqueued_at,created_at,slack_redrive_due_at)
      SELECT 'reauth-pending',workspace_id,'slack_inbound_reply','{"receiptId":"pending"}',1,1,1,1
      FROM slack_installations WHERE team_id='T123'`).run();
    await finishSlackOAuth(configured, memberContext(installed.member), "oauth-code", reauthorizeState);
    expect(
      await env.DB.prepare(`SELECT enqueued_at,slack_redrive_due_at FROM outbox WHERE id='reauth-pending'`).first(),
    ).toEqual({ enqueued_at: null, slack_redrive_due_at: null });
    await recordSlackInstallationError(
      configured,
      installation!.id,
      new SlackApiError("chat.postMessage", "invalid_auth", 200, oldRevision),
    );
    expect(
      await env.DB.prepare(`SELECT auth_error FROM slack_installations WHERE id=?`).bind(installation!.id).first(),
    ).toEqual({ auth_error: null });
    expect(await env.DB.prepare(`SELECT id FROM slack_installations WHERE team_id = 'T123'`).first()).toEqual({
      id: installation!.id,
    });
    await env.DB.batch([
      env.DB.prepare(`UPDATE slack_installations SET token_expires_at = 0 WHERE team_id = 'T123'`),
      env.DB.prepare(
        `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at,installation_generation,security_generation) VALUES (?, ?, 'UOWNER', ?,(SELECT generation FROM slack_installations WHERE id=?),0)`,
      ).bind(installation!.id, installed.member.user.id, Date.now(), installation!.id),
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

  it("keeps a verified Slack identity intact when a legacy link names another user", async () => {
    const installed = await bootstrap();
    const viewer = await inviteViewer(installed.cookie);
    await installSlack(installed.member);
    const timestamp = Date.now();
    await env.DB.prepare(`INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
      VALUES ('verified-slack-account', 'T123:UOWNER', 'slack', ?, ?, ?)`)
      .bind(installed.member.user.id, timestamp, timestamp)
      .run();
    const session = await env.DB.prepare(`SELECT id FROM session WHERE userId = ? LIMIT 1`)
      .bind(installed.member.user.id)
      .first<{ id: string }>();
    await recordVerifiedSlackIdentity(slackEnv(), installed.member.user.id, session!.id, "verified-slack-account", {
      installationId: "slack-installation",
      installationGeneration: 0,
      workspaceId: installed.member.workspace.id,
      teamId: "T123",
      slackUserId: "UOWNER",
      accountSubject: "T123:UOWNER",
    });
    const linkToken = async (slackUserId: string) => {
      const reply = await handleSlackCommand(
        slackEnv(),
        new URLSearchParams({ team_id: "T123", user_id: slackUserId, text: "link" }),
      );
      return new URL(reply.text.match(/https?:\S+/)![0]).searchParams.get("slackLink")!;
    };
    const otherToken = await linkToken("UOTHER");
    await expect(consumeSlackLink(slackEnv(), memberContext(installed.member), otherToken)).rejects.toMatchObject({
      code: "slack_identity_verified",
    });
    expect(
      await env.DB.prepare(`SELECT used_at FROM slack_link_tokens WHERE slack_user_id = 'UOTHER'`).first(),
    ).toEqual({ used_at: null });
    const sameToken = await linkToken("UOWNER");
    await consumeSlackLink(slackEnv(), memberContext(installed.member), sameToken);
    expect(
      await env.DB.prepare(`SELECT slack_user_id, migration_state, better_auth_account_id
      FROM slack_user_links WHERE installation_id = 'slack-installation' AND user_id = ?`)
        .bind(installed.member.user.id)
        .first(),
    ).toEqual({
      slack_user_id: "UOWNER",
      migration_state: "verified",
      better_auth_account_id: "verified-slack-account",
    });
    await consumeSlackLink(slackEnv(), memberContext(viewer.member), await linkToken("UVIEWER"));
    await consumeSlackLink(slackEnv(), memberContext(viewer.member), await linkToken("UTHIRD"));
    expect(
      await env.DB.prepare(`SELECT slack_user_id, migration_state, verified_at, better_auth_account_id
      FROM slack_user_links WHERE installation_id = 'slack-installation' AND user_id = ?`)
        .bind(viewer.member.user.id)
        .first(),
    ).toEqual({
      slack_user_id: "UTHIRD",
      migration_state: "legacy",
      verified_at: null,
      better_auth_account_id: null,
    });
  });

  it("links accounts once and requires a live trigger for slash search", async () => {
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
      `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at,security_generation,authorization_started_at)
       VALUES ('slack-installation', ?, 'UVIEWER', ?,0,1)`,
    )
      .bind(viewer.member.user.id, Date.now())
      .run();

    const ownerResult = await handleSlackCommand(
      slackEnv(),
      new URLSearchParams("team_id=T123&user_id=UOWNER&text=Orchid"),
    );
    expect(ownerResult.text).toContain("Search is unavailable");
    const viewerResult = await handleSlackCommand(
      slackEnv(),
      new URLSearchParams("team_id=T123&user_id=UVIEWER&text=Orchid"),
    );
    expect(viewerResult.text).toContain("Search is unavailable");
  });

  it("suppresses private unfurls unless the linked user has access and the channel is explicitly mapped", async () => {
    const installed = await bootstrap();
    const viewer = await inviteViewer(installed.cookie);
    await installSlack(installed.member);
    await env.DB.prepare(
      `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at,security_generation,authorization_started_at)
       VALUES ('slack-installation', ?, 'UVIEWER', ?,0,1)`,
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
    await deliverSlackUnfurl(slackEnv(), "Ev-private-unfurl", "outbox:slack-unfurl:Ev-private-unfurl");
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
    await deliverSlackUnfurl(slackEnv(), "Ev-revoked-unfurl", "outbox:slack-unfurl:Ev-revoked-unfurl");
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

    await deliverSlackUnfurl(slackEnv(), "missing-ts", "outbox:missing-ts");

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

  it.each(["pending", "delivered", "retired"])(
    "guards revoked-identity unfurl retirement for a concurrently %s row",
    async (state) => {
      const installed = await bootstrap();
      await installSlack(installed.member);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO slack_unfurls(id,installation_id,workspace_id,user_id,channel_id,message_ts,unfurls_json,created_at)
        VALUES('revoked-identity','slack-installation',?,?,'C0123456789','1700000000.000100','{}',?)`).bind(
          installed.member.workspace.id,
          installed.member.user.id,
          now,
        ),
        env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at) VALUES
        ('outbox:revoked',?,'slack_unfurl',json_object('unfurlId','revoked-identity'),?,?),
        ('outbox:duplicate-revoked',?,'slack_unfurl',json_object('unfurlId','revoked-identity'),?,?)`).bind(
          installed.member.workspace.id,
          now,
          now,
          installed.member.workspace.id,
          now,
          now,
        ),
      ]);
      const db = new Proxy(env.DB, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (state === "delivered")
                await env.DB.prepare("UPDATE slack_unfurls SET delivered_at=123 WHERE id='revoked-identity'").run();
              if (state === "retired")
                await env.DB.prepare(
                  "UPDATE slack_unfurls SET retired_at=123,retirement_reason='prior_reason' WHERE id='revoked-identity'",
                ).run();
              return target.batch(statements);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const remote = vi.fn();
      vi.stubGlobal("fetch", remote);
      await deliverSlackUnfurl({ ...slackEnv(), DB: db }, "revoked-identity", "outbox:revoked");
      expect(remote).not.toHaveBeenCalled();
      const retirementTimestamp = expect.any(Number);
      expect(
        await env.DB.prepare(
          "SELECT delivered_at,retired_at,retirement_reason FROM slack_unfurls WHERE id='revoked-identity'",
        ).first(),
      ).toEqual(
        state === "pending"
          ? { delivered_at: null, retired_at: retirementTimestamp, retirement_reason: "slack_identity_revoked" }
          : state === "delivered"
            ? { delivered_at: 123, retired_at: null, retirement_reason: null }
            : { delivered_at: null, retired_at: 123, retirement_reason: "prior_reason" },
      );
      expect(
        (
          await env.DB.prepare(
            "SELECT id,last_error FROM outbox WHERE id IN ('outbox:revoked','outbox:duplicate-revoked') ORDER BY id",
          ).all()
        ).results,
      ).toEqual([
        { id: "outbox:duplicate-revoked", last_error: null },
        { id: "outbox:revoked", last_error: "slack_unfurl_slack_identity_revoked" },
      ]);
    },
  );

  it("records retirement against only the exact consumed unfurl outbox row", async () => {
    const installed = await bootstrap();
    await installSlack(installed.member);
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO slack_unfurls
          (id, installation_id, workspace_id, user_id, channel_id, unfurls_json, created_at)
         VALUES ('queued-missing-ts', 'slack-installation', ?, ?, 'C0123456789', '{}', ?)`,
      ).bind(installed.member.workspace.id, installed.member.user.id, timestamp),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at) VALUES
          ('outbox:queued-missing-ts', ?, 'slack_unfurl', json_object('unfurlId', 'queued-missing-ts'), ?, ?),
          ('outbox:duplicate-missing-ts', ?, 'slack_unfurl', json_object('unfurlId', 'queued-missing-ts'), ?, ?)`,
      ).bind(installed.member.workspace.id, timestamp, timestamp, installed.member.workspace.id, timestamp, timestamp),
    ]);
    const message = {
      id: "unfurl-message",
      timestamp: new Date(timestamp),
      body: { outboxId: "outbox:queued-missing-ts" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    } satisfies Message<{ outboxId: string }>;

    await consumeDeliveryMessage(slackEnv(), message);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `SELECT id, last_error FROM outbox
          WHERE id IN ('outbox:queued-missing-ts', 'outbox:duplicate-missing-ts') ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: "outbox:duplicate-missing-ts", last_error: null },
        { id: "outbox:queued-missing-ts", last_error: "slack_unfurl_missing_message_ts" },
      ],
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
    await expect(deliverSlackChannelEvent(slackEnv(), event!.id)).rejects.toMatchObject({
      retryAfter: 17,
      method: "chat.postMessage",
    } satisfies Partial<SlackRateLimitError>);
    expect(
      await env.DB.prepare(`SELECT delivered_at FROM slack_channel_events WHERE id = ?`).bind(event!.id).first(),
    ).toEqual({ delivered_at: null });

    await env.DB.prepare(`UPDATE slack_installations SET credential_revision=7 WHERE id='slack-installation'`).run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false, error: "invalid_auth" })),
    );
    await expect(deliverSlackChannelEvent(slackEnv(), event!.id)).rejects.toMatchObject({ code: "invalid_auth" });
    expect(
      await env.DB.prepare(`SELECT auth_error FROM slack_installations WHERE id='slack-installation'`).first(),
    ).toEqual({ auth_error: "invalid_auth" });
    await env.DB.prepare(
      `UPDATE slack_installations SET auth_error=NULL,auth_error_at=NULL WHERE id='slack-installation'`,
    ).run();

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
    const payloads: Array<Record<string, unknown>> = [];
    let remainingRateLimits = 1;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      payloads.push(payload);
      channels.push(payload.channel as string);
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer xoxb-test-bot-token" && remainingRateLimits-- > 0
        ? Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "30" } })
        : Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await sendDueSlackChannelDigests(slackEnv(), timestamp);

    expect(channels).toEqual(["CRATEA", "CRATEC"]);
    expect(payloads[0]).toMatchObject({
      text: "1 NoteFlare update",
      blocks: [{ text: { text: expect.stringContaining("Your NoteFlare digest") } }],
    });
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
