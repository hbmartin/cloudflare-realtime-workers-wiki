import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CommentThread, Notification, NotificationPreference, Page } from "../shared/types";
import type { Env } from "./env";
import { deliverNotification, digestCandidates, sendDueNotificationDigests } from "./notifications";
import { encryptSlackToken } from "./slack";

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

const commentBody = (text: string, mention?: { id: string; label: string }) => [
  {
    id: crypto.randomUUID(),
    type: "paragraph",
    props: {},
    content: [
      { type: "text", text, styles: {} },
      ...(mention
        ? [{ type: "mention", props: { entityType: "user", entityId: mention.id, label: mention.label } }]
        : []),
    ],
    children: [],
  },
];

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Notification Notes",
      name: "Owner",
      email: "notification-owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const me = await (
    await SELF.fetch(request(cookie, "/api/me"))
  ).json<{ user: { id: string }; workspace: { id: string } }>();
  const pages = await (await SELF.fetch(request(cookie, "/api/pages/tree"))).json<{ pages: Page[] }>();
  return { cookie, userId: me.user.id, workspaceId: me.workspace.id, page: pages.pages[0]! };
}

async function invite(ownerCookie: string, suffix: string) {
  const invitation = await SELF.fetch(
    request(ownerCookie, "/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    }),
  );
  const token = (await invitation.json<{ invite: { token: string } }>()).invite.token;
  const response = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      token,
      name: `Viewer ${suffix}`,
      email: `notification-${suffix}@example.test`,
      password: "password123",
    }),
  });
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const me = await (await SELF.fetch(request(cookie, "/api/me"))).json<{ user: { id: string } }>();
  return { cookie, userId: me.user.id };
}

async function notificationFeed(cookie: string) {
  const response = await SELF.fetch(request(cookie, "/api/notifications"));
  expect(response.status).toBe(200);
  return response.json<{ notifications: Notification[]; unreadCount: number; hasMore: boolean }>();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await abortAllDurableObjects();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM install_state`),
    env.DB.prepare(`DELETE FROM page_search`),
    env.DB.prepare(`DELETE FROM workspaces`),
    env.DB.prepare(`DELETE FROM verification`),
    env.DB.prepare(`DELETE FROM user`),
  ]);
  await reset();
});

describe("notification feed and subscriptions", () => {
  it("fans out comment events with mention precedence and supports inbox actions", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "comments");
    const created = await SELF.fetch(
      request(viewer.cookie, `/api/pages/${installed.page.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialComment: { body: commentBody("Please review ", { id: installed.userId, label: "Owner" }) },
        }),
      }),
    );
    const thread = (await created.json<{ thread: CommentThread }>()).thread;
    expect((await notificationFeed(installed.cookie)).notifications.map((item) => item.eventType)).toEqual(["mention"]);

    await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: { body: commentBody("Reviewed") } }),
      }),
    );
    await SELF.fetch(request(installed.cookie, `/api/comment-threads/${thread.id}/resolve`, { method: "POST" }));
    const viewerFeed = await notificationFeed(viewer.cookie);
    expect(viewerFeed.notifications.map((item) => item.eventType)).toEqual(["thread_resolved", "reply"]);
    expect(viewerFeed.unreadCount).toBe(2);

    await SELF.fetch(
      request(viewer.cookie, "/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [viewerFeed.notifications[0]!.id] }),
      }),
    );
    expect((await notificationFeed(viewer.cookie)).unreadCount).toBe(1);
    // An empty selection archives nothing rather than everything.
    await SELF.fetch(
      request(viewer.cookie, "/api/notifications/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [] }),
      }),
    );
    expect((await notificationFeed(viewer.cookie)).notifications).toHaveLength(2);
    await SELF.fetch(
      request(viewer.cookie, "/api/notifications/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect((await notificationFeed(viewer.cookie)).notifications).toEqual([]);
  });

  it("applies space watches, page mute overrides, and document mention priority", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "watcher");
    const watched = await SELF.fetch(
      request(viewer.cookie, `/api/spaces/${installed.page.spaceId}/watch`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "watching" }),
      }),
    );
    expect(watched.status).toBe(200);
    const stub = env.DOCUMENT.getByName(`${installed.page.id}~${installed.page.contentEpoch}`);
    await stub.fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    await runInDurableObject(stub, async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      document.transact(
        () => {
          const paragraph = new Y.XmlElement("paragraph");
          const text = new Y.XmlText();
          text.insert(0, "First edit");
          paragraph.insert(0, [text]);
          document.getXmlFragment("document-store").insert(0, [paragraph]);
        },
        { state: { userId: installed.userId } },
      );
    });
    expect(
      await env.DB.prepare(`SELECT resource_type, resource_id, user_id, muted_at FROM subscriptions WHERE user_id = ?`)
        .bind(viewer.userId)
        .all(),
    ).toMatchObject({ results: [{ resource_type: "space", resource_id: installed.page.spaceId, muted_at: null }] });
    const projected = await stub.fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    expect(projected.status).toBe(200);
    expect(
      await env.DB.prepare(`SELECT event_type, user_id FROM notifications WHERE page_id = ?`)
        .bind(installed.page.id)
        .all(),
    ).toMatchObject({ results: [{ event_type: "page_edit", user_id: viewer.userId }] });
    expect((await notificationFeed(viewer.cookie)).notifications.map((item) => item.eventType)).toEqual(["page_edit"]);

    await SELF.fetch(
      request(viewer.cookie, `/api/pages/${installed.page.id}/watch`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "muted" }),
      }),
    );
    await runInDurableObject(stub, async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      document.transact(
        () => {
          const paragraph = new Y.XmlElement("paragraph");
          const mention = new Y.XmlElement("mention");
          mention.setAttribute("entityType", "user");
          mention.setAttribute("entityId", viewer.userId);
          mention.setAttribute("label", "Viewer watcher");
          paragraph.insert(0, [mention]);
          document.getXmlFragment("document-store").insert(0, [paragraph]);
        },
        { state: { userId: installed.userId } },
      );
    });
    await stub.fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    const events = (await notificationFeed(viewer.cookie)).notifications.map((item) => item.eventType);
    expect(events).toEqual(["mention", "page_edit"]);
  });

  it("validates preferences and reports unavailable external channels", async () => {
    const installed = await bootstrap();
    const response = await SELF.fetch(request(installed.cookie, "/api/notification-preferences"));
    const initial = await response.json<{
      preferences: NotificationPreference[];
      configured: boolean;
      channels: { email: { available: boolean }; slack: { available: boolean } };
    }>();
    expect(initial.preferences).toHaveLength(5);
    expect(initial.configured).toBe(false);
    expect(initial.channels).toEqual({
      email: { available: false },
      slack: {
        available: false,
        missing: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "SLACK_TOKEN_ENCRYPTION_KEY"],
      },
    });

    const updated = await SELF.fetch(
      request(installed.cookie, "/api/notification-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preference: { eventType: "page_edit", inApp: false, email: "off", slack: "off", timezone: "Asia/Kathmandu" },
        }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(
      (await updated.json<{ preferences: NotificationPreference[] }>()).preferences.find(
        (preference) => preference.eventType === "page_edit",
      ),
    ).toMatchObject({ inApp: false, email: "off", timezone: "Asia/Kathmandu" });

    const reject = async (preference: Record<string, unknown>) => {
      const rejected = await SELF.fetch(
        request(installed.cookie, "/api/notification-preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preference }),
        }),
      );
      expect(rejected.status).toBe(422);
      return (await rejected.json<{ error?: { code?: string } }>()).error?.code ?? "";
    };
    const valid = { eventType: "page_edit", inApp: false, email: "off", slack: "off", timezone: "UTC" };
    expect(await reject({ ...valid, eventType: "page_renamed" })).toBe("invalid_notification_event");
    expect(await reject({ ...valid, email: "hourly" })).toBe("invalid_notification_channel");
    expect(await reject({ ...valid, slack: "hourly" })).toBe("invalid_notification_channel");
    expect(await reject({ ...valid, timezone: "Mars/Olympus" })).toBe("invalid_timezone");
    // The route caps the field at 100 characters, so setNotificationPreference's own
    // length guard is only reachable by a direct call; over the wire this is invalid_input.
    expect(await reject({ ...valid, timezone: "U".repeat(101) })).toBe("invalid_input");
  });

  it("sends immediate email once and rechecks access at delivery time", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "delivery");
    await SELF.fetch(
      request(viewer.cookie, `/api/pages/${installed.page.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialComment: { body: commentBody("Please review ", { id: installed.userId, label: "Owner" }) },
        }),
      }),
    );
    const ownerNotification = await env.DB.prepare(
      `SELECT id FROM notifications WHERE user_id = ? AND event_type = 'mention'`,
    )
      .bind(installed.userId)
      .first<{ id: string }>();
    const send = vi.fn(async () => ({ messageId: "email-1" }));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "SEND_EMAIL") return { send };
        if (property === "EMAIL_FROM") return "notes@example.test";
        return Reflect.get(target, property, receiver);
      },
    });
    await deliverNotification(bindings, ownerNotification!.id);
    await deliverNotification(bindings, ownerNotification!.id);
    expect(send).toHaveBeenCalledTimes(1);

    const thread = await env.DB.prepare(`SELECT id FROM comment_threads WHERE page_id = ?`)
      .bind(installed.page.id)
      .first<{ id: string }>();
    await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread!.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: { body: commentBody("Reply") } }),
      }),
    );
    const viewerNotification = await env.DB.prepare(
      `SELECT id FROM notifications WHERE user_id = ? AND event_type = 'reply'`,
    )
      .bind(viewer.userId)
      .first<{ id: string }>();
    await env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .bind(installed.workspaceId, viewer.userId)
      .run();
    await deliverNotification(bindings, viewerNotification!.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(`SELECT status, last_error FROM deliveries WHERE idempotency_key = ?`)
        .bind(`outbox:${viewerNotification!.id}:in_app`)
        .first(),
    ).toMatchObject({ status: "failed", last_error: "access_revoked" });
  });

  it("does not let a stale delivery claimant finish a newer email lease", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "delivery-lease");
    await SELF.fetch(
      request(viewer.cookie, `/api/pages/${installed.page.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialComment: { body: commentBody("Please review ", { id: installed.userId, label: "Owner" }) },
        }),
      }),
    );
    const notification = await env.DB.prepare(
      `SELECT id FROM notifications WHERE user_id = ? AND event_type = 'mention'`,
    )
      .bind(installed.userId)
      .first<{ id: string }>();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseFirst = resolve));
    const bindings = (send: (message: unknown) => Promise<unknown>) =>
      new Proxy(env as Env, {
        get(target, property, receiver) {
          if (property === "SEND_EMAIL") return { send };
          if (property === "EMAIL_FROM") return "notes@example.test";
          return Reflect.get(target, property, receiver);
        },
      });
    const first = deliverNotification(
      bindings(async () => {
        firstStarted();
        await blocked;
        return { messageId: "first" };
      }),
      notification!.id,
    );
    await started;
    const key = `outbox:${notification!.id}:email`;
    const firstLease = await env.DB.prepare(`SELECT claim_token FROM deliveries WHERE idempotency_key = ?`)
      .bind(key)
      .first<{ claim_token: string }>();
    await env.DB.prepare(`UPDATE deliveries SET updated_at = 0 WHERE idempotency_key = ?`).bind(key).run();

    await deliverNotification(
      bindings(async () => ({ messageId: "second" })),
      notification!.id,
    );
    const secondLease = await env.DB.prepare(
      `SELECT status, attempts, claim_token FROM deliveries WHERE idempotency_key = ?`,
    )
      .bind(key)
      .first<{ status: string; attempts: number; claim_token: string }>();
    expect(secondLease).toMatchObject({ status: "sent", attempts: 2 });
    expect(secondLease?.claim_token).not.toBe(firstLease?.claim_token);

    releaseFirst();
    await first;
    expect(
      await env.DB.prepare(`SELECT status, claim_token FROM deliveries WHERE idempotency_key = ?`).bind(key).first(),
    ).toEqual({ status: "sent", claim_token: secondLease!.claim_token });
  });

  it("delivers digest-mode mentions without letting other timezones consume the candidate limit", async () => {
    const installed = await bootstrap();
    const timestamp = Date.UTC(2026, 8, 5, 9, 5);
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 51)
         INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         SELECT printf('digest-user-%02d', n), printf('Digest User %02d', n),
                printf('digest-user-%02d@example.test', n), 1, ?, ? FROM sequence`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 51)
         INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT ?, printf('digest-user-%02d', n), 'viewer', ? FROM sequence`,
      ).bind(installed.workspaceId, timestamp),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 51)
         INSERT INTO notification_preferences (user_id, event_type, in_app, email, slack, timezone)
         SELECT printf('digest-user-%02d', n), 'mention', 1, 'digest', 'off',
                CASE WHEN n = 51 THEN 'UTC' ELSE 'America/Los_Angeles' END FROM sequence`,
      ),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 51)
         INSERT INTO notifications
           (id, workspace_id, user_id, event_type, actor_id, space_id, page_id, data_json, dedupe_key, created_at)
         SELECT printf('mention:digest:%02d', n), ?, printf('digest-user-%02d', n), 'mention', ?, ?, ?, '{}',
                printf('digest:%02d', n), ? + n FROM sequence`,
      ).bind(
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 10 * 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         SELECT 'outbox:' || id, workspace_id, 'notification', json_object('notificationId', id), ?, ?
           FROM notifications WHERE id LIKE 'mention:digest:%'`,
      ).bind(timestamp, timestamp),
    ]);
    const send = vi.fn(async () => ({ messageId: "digest-email" }));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "SEND_EMAIL") return { send };
        if (property === "EMAIL_FROM") return "notes@example.test";
        return Reflect.get(target, property, receiver);
      },
    });

    await sendDueNotificationDigests(bindings, timestamp);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "digest-user-51@example.test",
        text: expect.stringContaining("mentioned you"),
      }),
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) count FROM notifications WHERE emailed_at IS NOT NULL AND id LIKE 'mention:digest:%'`,
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("excludes digest timezones whose notifications are all newer than the cutoff", async () => {
    const installed = await bootstrap();
    const timestamp = Date.UTC(2026, 8, 5, 18, 5);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
          ('future-digest-user', 'Future Digest', 'future-digest@example.test', 1, ?, ?),
          ('due-digest-user', 'Due Digest', 'due-digest@example.test', 1, ?, ?)`,
      ).bind(timestamp, timestamp, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES
          (?, 'future-digest-user', 'viewer', ?),
          (?, 'due-digest-user', 'viewer', ?)`,
      ).bind(installed.workspaceId, timestamp, installed.workspaceId, timestamp),
      env.DB.prepare(
        `INSERT INTO notification_preferences (user_id, event_type, in_app, email, slack, timezone) VALUES
          ('future-digest-user', 'mention', 1, 'digest', 'off', 'UTC'),
          ('due-digest-user', 'mention', 1, 'digest', 'off', 'America/Los_Angeles')`,
      ),
      env.DB.prepare(
        `INSERT INTO notifications
          (id, workspace_id, user_id, event_type, actor_id, space_id, page_id, data_json, dedupe_key, created_at)
         VALUES
          ('future-digest-notification', ?, 'future-digest-user', 'mention', ?, ?, ?, '{}', 'future-digest', ?),
          ('due-digest-notification', ?, 'due-digest-user', 'mention', ?, ?, ?, '{}', 'due-digest', ?)`,
      ).bind(
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 60 * 60_000,
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 12 * 60 * 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         VALUES ('outbox:due-digest-notification', ?, 'notification',
                 '{"notificationId":"due-digest-notification"}', ?, ?)`,
      ).bind(installed.workspaceId, timestamp, timestamp),
    ]);

    const send = vi.fn(async () => ({ messageId: "due-digest" }));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "SEND_EMAIL") return { send };
        if (property === "EMAIL_FROM") return "notes@example.test";
        return Reflect.get(target, property, receiver);
      },
    });

    await sendDueNotificationDigests(bindings, timestamp);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "due-digest@example.test" }));
    expect(
      await env.DB.prepare(
        `SELECT timezone FROM digest_delivery_cursors WHERE channel = 'email' ORDER BY timezone`,
      ).all(),
    ).toMatchObject({ results: [{ timezone: "America/Los_Angeles" }] });
    expect(
      await env.DB.prepare(
        `SELECT emailed_at IS NOT NULL delivered FROM notifications WHERE id = 'future-digest-notification'`,
      ).first(),
    ).toEqual({ delivered: 0 });
  });

  it("advances the ordering timestamp for an empty digest window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const read = vi.fn(async () => ({
      results: [] as Array<{ user_id: string; workspace_id: string; timezone: string }>,
    }));

    await digestCandidates(env, "email", "UTC", 10, read);
    const first = await env.DB.prepare(
      `SELECT user_id, workspace_id, updated_at FROM digest_delivery_cursors
        WHERE channel = 'email' AND timezone = 'UTC'`,
    ).first();
    await digestCandidates(env, "email", "UTC", 10, read);
    const second = await env.DB.prepare(
      `SELECT user_id, workspace_id, updated_at FROM digest_delivery_cursors
        WHERE channel = 'email' AND timezone = 'UTC'`,
    ).first();

    expect(first).toEqual({ user_id: "", workspace_id: "", updated_at: 1_000 });
    expect(second).toEqual({ user_id: "", workspace_id: "", updated_at: 1_001 });
    expect(read).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("does not discover Slack digest windows without a live recipient link", async () => {
    const installed = await bootstrap();
    const timestamp = Date.UTC(2026, 8, 5, 10, 5);
    const configured = slackEnv();
    const token = await encryptSlackToken(configured, "xoxb-discovery");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
          ('unlinked-digest-user', 'Unlinked Digest', 'unlinked-digest@example.test', 1, ?, ?),
          ('linked-digest-user', 'Linked Digest', 'linked-digest@example.test', 1, ?, ?)`,
      ).bind(timestamp, timestamp, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES
          (?, 'unlinked-digest-user', 'viewer', ?),
          (?, 'linked-digest-user', 'viewer', ?)`,
      ).bind(installed.workspaceId, timestamp, installed.workspaceId, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_installations
          (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
           installed_by, created_at, updated_at)
         VALUES ('digest-discovery-installation', ?, 'TDISCOVERY', 'Discovery', 'BDISCOVERY',
                 ?, 'chat:write', ?, ?, ?)`,
      ).bind(installed.workspaceId, token, installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
         VALUES ('digest-discovery-installation', 'linked-digest-user', 'ULINKED', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO notification_preferences (user_id, event_type, in_app, email, slack, timezone) VALUES
          ('unlinked-digest-user', 'mention', 1, 'off', 'digest', 'Africa/Abidjan'),
          ('linked-digest-user', 'mention', 1, 'off', 'digest', 'UTC')`,
      ),
      env.DB.prepare(
        `INSERT INTO notifications
          (id, workspace_id, user_id, event_type, actor_id, space_id, page_id, data_json, dedupe_key, created_at)
         VALUES
          ('unlinked-digest-notification', ?, 'unlinked-digest-user', 'mention', ?, ?, ?, '{}',
           'unlinked-digest', ?),
          ('linked-digest-notification', ?, 'linked-digest-user', 'mention', ?, ?, ?, '{}',
           'linked-digest', ?)`,
      ).bind(
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 3 * 60 * 60_000,
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 3 * 60 * 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         VALUES ('outbox:linked-digest-notification', ?, 'notification',
                 '{"notificationId":"linked-digest-notification"}', ?, ?)`,
      ).bind(installed.workspaceId, timestamp, timestamp),
    ]);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await sendDueNotificationDigests(configured, timestamp);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `SELECT timezone FROM digest_delivery_cursors WHERE channel = 'slack' ORDER BY timezone`,
      ).all(),
    ).toMatchObject({ results: [{ timezone: "UTC" }] });
    expect(
      await env.DB.prepare(
        `SELECT slack_at IS NOT NULL delivered FROM notifications WHERE id = 'unlinked-digest-notification'`,
      ).first(),
    ).toEqual({ delivered: 0 });
  });

  it("keeps a full email and Slack digest tick within the statement budget", async () => {
    const installed = await bootstrap();
    const timestamp = Date.UTC(2026, 8, 5, 11, 5);
    const configured = slackEnv();
    const token = await encryptSlackToken(configured, "xoxb-budget");
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 10)
         INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         SELECT printf('budget-user-%02d', n), printf('Budget User %02d', n),
                printf('budget-user-%02d@example.test', n), 1, ?, ? FROM sequence`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 10)
         INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT ?, printf('budget-user-%02d', n), 'viewer', ? FROM sequence`,
      ).bind(installed.workspaceId, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_installations
          (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
           installed_by, created_at, updated_at)
         VALUES ('digest-budget-installation', ?, 'TBUDGET', 'Budget', 'BBUDGET', ?,
                 'chat:write', ?, ?, ?)`,
      ).bind(installed.workspaceId, token, installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 10)
         INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
         SELECT 'digest-budget-installation', printf('budget-user-%02d', n), printf('UBUDGET%02d', n), ?
           FROM sequence`,
      ).bind(timestamp),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 10)
         INSERT INTO notification_preferences (user_id, event_type, in_app, email, slack, timezone)
         SELECT printf('budget-user-%02d', n), 'mention', 1, 'digest', 'digest', 'UTC' FROM sequence`,
      ),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 10)
         INSERT INTO notifications
           (id, workspace_id, user_id, event_type, actor_id, space_id, page_id, data_json, dedupe_key, created_at)
         SELECT printf('budget-notification-%02d', n), ?, printf('budget-user-%02d', n), 'mention', ?, ?, ?,
                '{}', printf('budget-%02d', n), ? FROM sequence`,
      ).bind(
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 3 * 60 * 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         SELECT 'outbox:' || id, workspace_id, 'notification', json_object('notificationId', id), ?, ?
           FROM notifications WHERE id LIKE 'budget-notification-%'`,
      ).bind(timestamp, timestamp),
    ]);
    let statementCount = 0;
    const countedDatabase = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            statementCount += 1;
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const send = vi.fn(async () => ({ messageId: "budget-email" }));
    const bindings = new Proxy(configured, {
      get(target, property, receiver) {
        if (property === "DB") return countedDatabase;
        if (property === "SEND_EMAIL") return { send };
        if (property === "EMAIL_FROM") return "notes@example.test";
        return Reflect.get(target, property, receiver);
      },
    });
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await sendDueNotificationDigests(bindings, timestamp);

    expect(send).toHaveBeenCalledTimes(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(statementCount).toBeLessThanOrEqual(240);
  });

  it("defers only the rate-limited Slack installation and retries it on a later tick", async () => {
    const installed = await bootstrap();
    const timestamp = Date.UTC(2026, 8, 5, 9, 5);
    const configured = slackEnv();
    const [firstToken, secondToken] = await Promise.all([
      encryptSlackToken(configured, "xoxb-rate-limited"),
      encryptSlackToken(configured, "xoxb-available"),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces (id, name, created_at) VALUES ('rate-workspace-two', 'Second workspace', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
          ('rate-user-a', 'Rate A', 'rate-a@example.test', 1, ?, ?),
          ('rate-user-b', 'Rate B', 'rate-b@example.test', 1, ?, ?),
          ('rate-user-c', 'Rate C', 'rate-c@example.test', 1, ?, ?)`,
      ).bind(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES
          (?, 'rate-user-a', 'viewer', ?),
          (?, 'rate-user-b', 'viewer', ?),
          ('rate-workspace-two', ?, 'owner', ?),
          ('rate-workspace-two', 'rate-user-c', 'viewer', ?)`,
      ).bind(
        installed.workspaceId,
        timestamp,
        installed.workspaceId,
        timestamp,
        installed.userId,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, kind, position, title, created_by, created_at, updated_at, space_id)
         VALUES ('rate-page-two', 'rate-workspace-two', 'document', 'a0', 'Second page', ?, ?, ?,
                 'rate-workspace-two-general')`,
      ).bind(installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO slack_installations
          (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
           installed_by, created_at, updated_at)
         VALUES
          ('rate-installation-one', ?, 'TRATE1', 'Rate limited', 'BRATE1', ?, 'chat:write', ?, ?, ?),
          ('rate-installation-two', 'rate-workspace-two', 'TRATE2', 'Available', 'BRATE2', ?, 'chat:write', ?, ?, ?)`,
      ).bind(
        installed.workspaceId,
        firstToken,
        installed.userId,
        timestamp,
        timestamp,
        secondToken,
        installed.userId,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at) VALUES
          ('rate-installation-one', 'rate-user-a', 'URATEA', ?),
          ('rate-installation-one', 'rate-user-b', 'URATEB', ?),
          ('rate-installation-two', 'rate-user-c', 'URATEC', ?)`,
      ).bind(timestamp, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO notification_preferences (user_id, event_type, in_app, email, slack, timezone) VALUES
          ('rate-user-a', 'mention', 1, 'off', 'digest', 'UTC'),
          ('rate-user-b', 'mention', 1, 'off', 'digest', 'UTC'),
          ('rate-user-c', 'mention', 1, 'off', 'digest', 'UTC')`,
      ),
      env.DB.prepare(
        `INSERT INTO notifications
          (id, workspace_id, user_id, event_type, actor_id, space_id, page_id, data_json, dedupe_key, created_at)
         VALUES
          ('rate-notification-a', ?, 'rate-user-a', 'mention', ?, ?, ?, '{}', 'rate-a', ?),
          ('rate-notification-b', ?, 'rate-user-b', 'mention', ?, ?, ?, '{}', 'rate-b', ?),
          ('rate-notification-c', 'rate-workspace-two', 'rate-user-c', 'mention', ?,
           'rate-workspace-two-general', 'rate-page-two', '{}', 'rate-c', ?)`,
      ).bind(
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 10 * 60_000,
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 10 * 60_000,
        installed.userId,
        timestamp - 10 * 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         SELECT 'outbox:' || id, workspace_id, 'notification', json_object('notificationId', id), ?, ?
           FROM notifications WHERE id LIKE 'rate-notification-%'`,
      ).bind(timestamp, timestamp),
    ]);
    const channels: string[] = [];
    let remainingRateLimits = 1;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      channels.push(JSON.parse(String(init?.body)).channel as string);
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer xoxb-rate-limited" && remainingRateLimits-- > 0
        ? Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "30" } })
        : Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await sendDueNotificationDigests(configured, timestamp);

    expect(channels).toEqual(["URATEA", "URATEC"]);
    expect(
      await env.DB.prepare(
        `SELECT id, slack_at IS NOT NULL delivered FROM notifications
          WHERE id LIKE 'rate-notification-%' ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: "rate-notification-a", delivered: 0 },
        { id: "rate-notification-b", delivered: 0 },
        { id: "rate-notification-c", delivered: 1 },
      ],
    });

    await sendDueNotificationDigests(configured, timestamp + 15 * 60_000);

    expect(channels).toEqual(["URATEA", "URATEC", "URATEA", "URATEB"]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) delivered FROM notifications
          WHERE id LIKE 'rate-notification-%' AND slack_at IS NOT NULL`,
      ).first(),
    ).toEqual({ delivered: 3 });
    log.mockRestore();
  });

  it("advances the persisted digest cursor past a failing leading cohort", async () => {
    const installed = await bootstrap();
    const timestamp = Date.UTC(2026, 8, 5, 9, 5);
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 31)
         INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         SELECT printf('cursor-user-%02d', n), printf('Cursor User %02d', n),
                printf('cursor-user-%02d@example.test', n), 1, ?, ? FROM sequence`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 31)
         INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT ?, printf('cursor-user-%02d', n), 'viewer', ? FROM sequence`,
      ).bind(installed.workspaceId, timestamp),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 31)
         INSERT INTO notification_preferences (user_id, event_type, in_app, email, slack, timezone)
         SELECT printf('cursor-user-%02d', n), 'mention', 1, 'digest', 'off', 'UTC' FROM sequence`,
      ),
      env.DB.prepare(
        `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 31)
         INSERT INTO notifications
           (id, workspace_id, user_id, event_type, actor_id, space_id, page_id, data_json, dedupe_key, created_at)
         SELECT printf('mention:cursor:%02d', n), ?, printf('cursor-user-%02d', n), 'mention', ?, ?, ?, '{}',
                printf('cursor:%02d', n), ? + n FROM sequence`,
      ).bind(
        installed.workspaceId,
        installed.userId,
        installed.page.spaceId,
        installed.page.id,
        timestamp - 10 * 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         SELECT 'outbox:' || id, workspace_id, 'notification', json_object('notificationId', id), ?, ?
           FROM notifications WHERE id LIKE 'mention:cursor:%'`,
      ).bind(timestamp, timestamp),
    ]);
    const send = vi.fn(async (message: { to: string }) => {
      if (!message.to.startsWith("cursor-user-31@")) throw new Error("mailbox unavailable");
      return { messageId: "tail-delivered" };
    });
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "SEND_EMAIL") return { send };
        if (property === "EMAIL_FROM") return "notes@example.test";
        return Reflect.get(target, property, receiver);
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await sendDueNotificationDigests(bindings, timestamp);
    expect(send.mock.calls.some(([message]) => message.to === "cursor-user-31@example.test")).toBe(false);
    for (let tick = 1; tick < 4; tick += 1) {
      await sendDueNotificationDigests(bindings, timestamp + tick * 15 * 60_000);
      if (send.mock.calls.some(([message]) => message.to === "cursor-user-31@example.test")) break;
    }

    expect(send.mock.calls.some(([message]) => message.to === "cursor-user-31@example.test")).toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT emailed_at IS NOT NULL delivered FROM notifications WHERE id = 'mention:cursor:31'`,
      ).first(),
    ).toEqual({ delivered: 1 });
    log.mockRestore();
  });
});
