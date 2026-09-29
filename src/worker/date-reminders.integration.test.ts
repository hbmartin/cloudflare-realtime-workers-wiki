import { enrollAccount } from "../../tests/helpers/security";
import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { DateMention } from "../shared/date-mentions";
import { dateTokens } from "../shared/document-projection";
import { flattenDocumentBlocks } from "../shared/notion-blocks";
import type { Env } from "./env";
import { processDueDateReminders, reconcileDateRemindersForPage } from "./date-reminders";

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Reminder Notes",
      name: "Owner",
      email: "reminder-owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = await enrollAccount(response);
  const me = await (
    await SELF.fetch(request(cookie, "/api/me"))
  ).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const tree = await (
    await SELF.fetch(request(cookie, "/api/pages/tree"))
  ).json<{
    pages: Array<{ id: string; spaceId: string }>;
  }>();
  return { cookie, userId: me.user.id, workspaceId: me.workspace.id, page: tree.pages[0]! };
}

async function addToken(pageId: string, token: DateMention) {
  const stub = env.DOCUMENT.getByName(`${pageId}~1`);
  await stub.fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }),
  );
  await runInDurableObject(stub, async (instance) => {
    const document = (instance as unknown as { document: Y.Doc }).document;
    document.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      const mention = new Y.XmlElement("dateMention");
      mention.setAttribute("payload", JSON.stringify(token));
      paragraph.insert(0, [mention]);
      document.getXmlFragment("document-store").insert(0, [paragraph]);
    });
  });
  await stub.fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }),
  );
}

async function addStructuredTokenBlock(pageId: string, token: DateMention, atStart = false) {
  const stub = env.DOCUMENT.getByName(`${pageId}~1`);
  await stub.fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }),
  );
  const id = crypto.randomUUID();
  await runInDurableObject(stub, async (instance) => {
    const document = (instance as unknown as { document: Y.Doc }).document;
    document.transact(() => {
      const root = document.getXmlFragment("document-store");
      let group = root
        .toArray()
        .find((child): child is Y.XmlElement => child instanceof Y.XmlElement && child.nodeName === "blockGroup");
      if (!group) {
        group = new Y.XmlElement("blockGroup");
        root.insert(0, [group]);
      }
      const container = new Y.XmlElement("blockContainer");
      container.setAttribute("id", id);
      const paragraph = new Y.XmlElement("paragraph");
      const mention = new Y.XmlElement("dateMention");
      mention.setAttribute("payload", JSON.stringify(token));
      paragraph.insert(0, [mention]);
      container.insert(0, [paragraph]);
      group.insert(atStart ? 0 : group.length, [container]);
    });
  });
  await stub.fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }),
  );
  return id;
}

async function removeTokens(pageId: string) {
  const stub = env.DOCUMENT.getByName(`${pageId}~1`);
  await runInDurableObject(stub, async (instance) => {
    const document = (instance as unknown as { document: Y.Doc }).document;
    const root = document.getXmlFragment("document-store");
    document.transact(() => root.delete(0, root.length));
  });
  await stub.fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }),
  );
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM install_state`),
    env.DB.prepare(`DELETE FROM workspaces`),
    env.DB.prepare(`DELETE FROM verification`),
    env.DB.prepare(`DELETE FROM user`),
  ]);
  await reset();
});

describe("date reminders", () => {
  it("requires authentication and a current authored token revision", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    const body = (revision: string) => ({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, choice: "5m_before" }),
    });
    expect((await SELF.fetch(request("", path, body(token.revision)))).status).toBe(401);
    expect((await SELF.fetch(request(installed.cookie, path, body("stale")))).status).toBe(409);
    const created = await SELF.fetch(request(installed.cookie, path, body(token.revision)));
    expect(created.status).toBe(200);
    const first = await created.json<{ reminder: { generation: number; dueAt: number } }>();
    expect(first.reminder).toMatchObject({ generation: 1, dueAt: Date.parse(token.value) - 300_000 });
    const repeated = await SELF.fetch(request(installed.cookie, path, body(token.revision)));
    expect((await repeated.json<{ reminder: { generation: number } }>()).reminder.generation).toBe(1);
    const privateRead = await SELF.fetch(request(installed.cookie, path));
    expect((await privateRead.json<{ reminder: { id: string } }>()).reminder.id).toBeTruthy();
    expect((await SELF.fetch(request(installed.cookie, path, { method: "DELETE" }))).status).toBe(204);
    expect(
      (await (await SELF.fetch(request(installed.cookie, path))).json<{ reminder: unknown }>()).reminder,
    ).toBeNull();
  });

  it("claims each due generation once and creates one notification through fanout", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const reminderId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO date_reminders
        (id,workspace_id,page_id,content_epoch,token_id,user_id,token_revision,timezone,choice_json,
         due_at,generation,state,checked_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?)`,
    )
      .bind(
        reminderId,
        installed.workspaceId,
        installed.page.id,
        1,
        token.tokenId,
        installed.userId,
        token.revision,
        token.timezone,
        JSON.stringify("at_time"),
        Date.parse(token.value),
        timestamp - 60 * 60_000,
        timestamp,
        timestamp,
      )
      .run();
    await processDueDateReminders(env as unknown as Env);
    await processDueDateReminders(env as unknown as Env);
    expect(
      await env.DB.prepare(`SELECT state,generation,delivery_receipt_id FROM date_reminders WHERE id=?`)
        .bind(reminderId)
        .first(),
    ).toEqual({
      state: "delivered",
      generation: 1,
      delivery_receipt_id: `${reminderId}:1`,
    });
    const feed = await SELF.fetch(request(installed.cookie, "/api/notifications"));
    expect(
      (await feed.json<{ notifications: Array<{ eventType: string; page: { id: string } }> }>()).notifications,
    ).toEqual([
      expect.objectContaining({
        eventType: "reminder",
        page: { id: installed.page.id, title: expect.any(String), icon: null },
      }),
    ]);
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM notifications WHERE event_type='reminder'`).first<{
          count: number;
        }>()
      )?.count,
    ).toBe(1);
  });

  it("keeps a due reminder when a date edit changes only its revision", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO date_reminders
        (id,workspace_id,page_id,content_epoch,token_id,user_id,token_revision,timezone,choice_json,
         due_at,generation,state,checked_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?)`,
    )
      .bind(
        id,
        installed.workspaceId,
        installed.page.id,
        1,
        token.tokenId,
        installed.userId,
        token.revision,
        token.timezone,
        JSON.stringify("at_time"),
        Date.parse(token.value),
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
    const newRevision = crypto.randomUUID();
    const stub = env.DOCUMENT.getByName(`${installed.page.id}~1`);
    await runInDurableObject(stub, async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      const paragraph = document.getXmlFragment("document-store").get(0) as Y.XmlElement;
      const mention = paragraph.get(0) as Y.XmlElement;
      mention.setAttribute("payload", JSON.stringify({ ...token, revision: newRevision }));
    });
    await processDueDateReminders(env as unknown as Env);
    expect(
      await env.DB.prepare(`SELECT state,token_revision,generation FROM date_reminders WHERE id=?`).bind(id).first(),
    ).toEqual({ state: "delivered", token_revision: newRevision, generation: 1 });
  });

  it("rejects a different token author and keeps another member's setting private", async () => {
    const installed = await bootstrap();
    const otherId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
      VALUES (?,'Other','reminder-other@example.test',1,1)`)
      .bind(otherId)
      .run();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: otherId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    const put = await SELF.fetch(
      request(installed.cookie, path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
      }),
    );
    expect(put.status).toBe(404);
    await env.DB.prepare(`INSERT INTO date_reminders
      (id,workspace_id,page_id,content_epoch,token_id,user_id,token_revision,timezone,choice_json,
       due_at,generation,state,checked_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?)`)
      .bind(
        crypto.randomUUID(),
        installed.workspaceId,
        installed.page.id,
        1,
        token.tokenId,
        otherId,
        token.revision,
        token.timezone,
        JSON.stringify("at_time"),
        Date.parse(token.value),
        1,
        1,
        1,
      )
      .run();
    expect(
      (await (await SELF.fetch(request(installed.cookie, path))).json<{ reminder: unknown }>()).reminder,
    ).toBeNull();
    expect((await SELF.fetch(request(installed.cookie, path, { method: "DELETE" }))).status).toBe(404);
  });

  it("does not deliver a missing token and cancels it after the absence window", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    expect(
      (
        await SELF.fetch(
          request(installed.cookie, path, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
          }),
        )
      ).status,
    ).toBe(200);
    await removeTokens(installed.page.id);
    await env.DB.prepare(`UPDATE date_reminders SET due_at=?,checked_at=? WHERE token_id=?`)
      .bind(Date.now() - 60_000, 1, token.tokenId)
      .run();
    await processDueDateReminders(env as unknown as Env);
    expect(
      await env.DB.prepare(`SELECT state,missing_since FROM date_reminders WHERE token_id=?`)
        .bind(token.tokenId)
        .first<{ state: string; missing_since: number | null }>(),
    ).toMatchObject({ state: "active", missing_since: expect.any(Number) });
    await env.DB.prepare(`UPDATE date_reminders SET missing_since=?,checked_at=? WHERE token_id=?`)
      .bind(Date.now() - 3 * 60_000, 1, token.tokenId)
      .run();
    await processDueDateReminders(env as unknown as Env);
    expect(
      await env.DB.prepare(`SELECT state FROM date_reminders WHERE token_id=?`).bind(token.tokenId).first(),
    ).toEqual({ state: "canceled" });
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM notifications WHERE event_type='reminder'`).first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("keeps the same reminder when a cut token is pasted back after a save", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    expect(
      (
        await SELF.fetch(
          request(installed.cookie, path, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
          }),
        )
      ).status,
    ).toBe(200);
    await removeTokens(installed.page.id);
    await env.DB.prepare(`UPDATE date_reminders SET checked_at=1 WHERE token_id=?`).bind(token.tokenId).run();
    await processDueDateReminders(env as unknown as Env);
    await addToken(installed.page.id, token);
    await env.DB.prepare(`UPDATE date_reminders SET checked_at=1 WHERE token_id=?`).bind(token.tokenId).run();
    await processDueDateReminders(env as unknown as Env);
    expect(
      await env.DB.prepare(`SELECT state,missing_since,generation FROM date_reminders WHERE token_id=?`)
        .bind(token.tokenId)
        .first(),
    ).toEqual({ state: "active", missing_since: null, generation: 1 });
  });

  it("gives a concurrent duplicate a new identity before reconciling reminders", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    const saved = await SELF.fetch(
      request(installed.cookie, path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
      }),
    );
    expect(saved.status).toBe(200);
    await addToken(installed.page.id, token);
    const response = await env.DOCUMENT.getByName(`${installed.page.id}~1`).fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    const content = await response.json<{ document: Parameters<typeof dateTokens>[0] }>();
    const tokens = dateTokens(content.document);
    expect(tokens.size).toBe(2);
    expect(tokens.get(token.tokenId)).toBeTruthy();
    expect(Array.from(tokens.values()).every(Boolean)).toBe(true);
    const retained = await SELF.fetch(request(installed.cookie, path));
    expect(retained.status).toBe(200);
    expect((await retained.json<{ reminder: { state: string } | null }>()).reminder?.state).toBe("active");
  });

  it("keeps the reminder identity on the original block when a copy is inserted above it", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    const originalId = await addStructuredTokenBlock(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    const saved = await SELF.fetch(
      request(installed.cookie, path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
      }),
    );
    expect(saved.status).toBe(200);
    await addStructuredTokenBlock(installed.page.id, token, true);
    const response = await env.DOCUMENT.getByName(`${installed.page.id}~1`).fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    const content = await response.json<{ document: Parameters<typeof dateTokens>[0] }>();
    const blocks = flattenDocumentBlocks(content.document);
    expect(dateTokens(blocks.find((block) => block.id === originalId)!.node).get(token.tokenId)).toBeTruthy();
    expect(blocks.filter((block) => dateTokens(block.node).has(token.tokenId))).toHaveLength(1);
  });

  it("does not overwrite a reminder when the document projection changes before saving", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    const put = (choice: string) =>
      SELF.fetch(
        request(installed.cookie, path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: token.revision, choice }),
        }),
      );
    expect((await put("5m_before")).status).toBe(200);
    await env.DB.prepare(`UPDATE document_projections SET sequence=sequence+1 WHERE page_id=?`)
      .bind(installed.page.id)
      .run();
    expect((await put("at_time")).status).toBe(409);
    expect(
      (
        await env.DB.prepare(`SELECT choice_json FROM date_reminders WHERE token_id=?`)
          .bind(token.tokenId)
          .first<{ choice_json: string }>()
      )?.choice_json,
    ).toBe('"5m_before"');
  });

  it("reports a stale reconciliation snapshot so the sweep can advance", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const reminder = await SELF.fetch(
      request(installed.cookie, `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: token.revision, choice: "5m_before" }),
      }),
    );
    expect(reminder.status).toBe(200);
    const envelope = await (
      await env.DOCUMENT.getByName(`${installed.page.id}~1`).fetch(
        new Request("https://document.internal/content", {
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      )
    ).json<{ document: Parameters<typeof dateTokens>[0]; sequence: number }>();
    await env.DB.prepare(`UPDATE document_projections SET sequence=sequence+1 WHERE page_id=?`)
      .bind(installed.page.id)
      .run();
    await expect(
      reconcileDateRemindersForPage(env, installed.page.id, 1, envelope.document, envelope.sequence),
    ).rejects.toThrow("projection changed");
  });

  it("does not deliver when the author loses workspace access before the due scan", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    expect(
      (
        await SELF.fetch(
          request(installed.cookie, path, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
          }),
        )
      ).status,
    ).toBe(200);
    const replacementOwner = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
        VALUES (?,'Replacement','replacement-owner@example.test',1,1)`).bind(replacementOwner),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
        VALUES (?,?,'owner',1)`).bind(installed.workspaceId, replacementOwner),
    ]);
    await env.DB.batch([
      env.DB.prepare(`UPDATE date_reminders SET due_at=? WHERE token_id=?`).bind(Date.now() - 60_000, token.tokenId),
      env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?`).bind(
        installed.workspaceId,
        installed.userId,
      ),
    ]);
    await processDueDateReminders(env as unknown as Env);
    expect(
      await env.DB.prepare(`SELECT state FROM date_reminders WHERE token_id=?`).bind(token.tokenId).first(),
    ).toEqual({ state: "canceled" });
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM notifications WHERE event_type='reminder'`).first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("reschedules a claimed generation without delivering the old due time", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    const put = (choice: string) =>
      SELF.fetch(
        request(installed.cookie, path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: token.revision, choice }),
        }),
      );
    expect((await put("5m_before")).status).toBe(200);
    await env.DB.prepare(`UPDATE date_reminders SET state='claimed',claim_id='old-claim',claimed_at=?
      WHERE token_id=?`)
      .bind(Date.now() - 5 * 60_000, token.tokenId)
      .run();
    const rescheduled = await put("at_time");
    expect(rescheduled.status).toBe(200);
    expect(
      (await rescheduled.json<{ reminder: { generation: number; state: string; dueAt: number } }>()).reminder,
    ).toMatchObject({ generation: 2, state: "active", dueAt: Date.parse(token.value) });
    await processDueDateReminders(env as unknown as Env);
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM notifications WHERE event_type='reminder'`).first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("cancels an archived page's reminder before notification fanout", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    expect(
      (
        await SELF.fetch(
          request(installed.cookie, path, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
          }),
        )
      ).status,
    ).toBe(200);
    await env.DB.batch([
      env.DB.prepare(`UPDATE pages SET archived_at=? WHERE id=?`).bind(Date.now(), installed.page.id),
      env.DB.prepare(`UPDATE date_reminders SET due_at=?,checked_at=1 WHERE token_id=?`).bind(
        Date.now() - 60_000,
        token.tokenId,
      ),
    ]);
    await processDueDateReminders(env as unknown as Env);
    expect(
      await env.DB.prepare(`SELECT state FROM date_reminders WHERE token_id=?`).bind(token.tokenId).first(),
    ).toEqual({ state: "canceled" });
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM notifications WHERE event_type='reminder'`).first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("keeps existing reminder rows when migrations are replayed", async () => {
    const installed = await bootstrap();
    const token: DateMention = {
      tokenId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      createdBy: installed.userId,
      kind: "timed",
      value: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: "UTC",
    };
    await addToken(installed.page.id, token);
    const path = `/api/pages/${installed.page.id}/date-reminders/${token.tokenId}`;
    expect(
      (
        await SELF.fetch(
          request(installed.cookie, path, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision: token.revision, choice: "at_time" }),
          }),
        )
      ).status,
    ).toBe(200);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(`SELECT state,generation FROM date_reminders WHERE token_id=?`).bind(token.tokenId).first(),
    ).toEqual({ state: "active", generation: 1 });
  });
});
