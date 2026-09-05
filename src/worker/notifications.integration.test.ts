import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CommentThread, Notification, NotificationPreference, Page } from "../shared/types";
import type { Env } from "./env";
import { deliverNotification } from "./notifications";

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
    expect(initial.channels).toEqual({ email: { available: false }, slack: { available: false } });

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
});
