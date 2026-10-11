import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CHANGE_RETENTION_MS, checkpointStatements, readComparison, pruneDocumentChanges } from "./document-changes";
import { notificationFanoutStatements, sendDueNotificationDigests } from "./notifications";
import { composePersonalDigest } from "./personal-diff-digest";
import type { Env } from "./env";
import type { DocumentContentEnvelope } from "../shared/types";
const bindings = env as unknown as Env;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM page_change_projection_gc"),
  ]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
  await reset();
});
async function fixture() {
  const pageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('changes-owner','Owner','changes-owner@example.test',1,1),('changes-viewer','Viewer','changes-viewer@example.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('changes-workspace','Changes',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('changes-workspace','changes-owner','owner',1),('changes-workspace','changes-viewer','viewer',1)",
    ),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES(?,'changes-workspace','changes-workspace-general','document','a0','Changes <test>','changes-owner',1,1)",
    ).bind(pageId),
    env.DB.prepare(
      "INSERT INTO subscriptions(id,workspace_id,user_id,resource_type,resource_id,created_at) VALUES('changes-watch','changes-workspace','changes-viewer','page',?,1)",
    ).bind(pageId),
  ]);
  return pageId;
}
function envelope(pageId: string, sequence: number, text: string, epoch = 1): DocumentContentEnvelope {
  return {
    schemaVersion: 1,
    pageId,
    sequence,
    contentEpoch: epoch,
    document: {
      type: "doc",
      content: [
        {
          type: "blockGroup",
          content: [
            {
              type: "blockContainer",
              attrs: { id: "stable" },
              content: [{ type: "paragraph", content: [{ type: "text", text }] }],
            },
          ],
        },
      ],
    },
  };
}
async function checkpoint(
  pageId: string,
  sequence: number,
  text: string,
  before: { r2_key: string; content_epoch: number; sequence: number } | null,
  timestamp = Date.now(),
  epoch = 1,
) {
  const key = `documents/${pageId}/epochs/${epoch}/projections/${sequence}.json`;
  const json = JSON.stringify(envelope(pageId, sequence, text, epoch));
  await env.BUCKET.put(key, json);
  await env.DB.batch([
    env.DB.prepare("UPDATE pages SET content_epoch=? WHERE id=?").bind(epoch, pageId),
    env.DB.prepare(
      `INSERT INTO document_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,updated_at) VALUES(?,?,?,1,?,'hash',?,?) ON CONFLICT(page_id) DO UPDATE SET content_epoch=excluded.content_epoch,sequence=excluded.sequence,r2_key=excluded.r2_key`,
    ).bind(pageId, epoch, sequence, key, json.length, timestamp),
    ...checkpointStatements(bindings, {
      pageId,
      epoch,
      sequence,
      afterKey: key,
      before,
      actorId: "changes-owner",
      recipients: ["changes-owner", "changes-viewer"],
      timestamp,
    }),
  ]);
  return { r2_key: key, content_epoch: epoch, sequence, id: `${pageId}:${epoch}:${sequence}` };
}
describe("retained exact document comparisons", () => {
  it("keeps independent eligible changes, excludes the actor and compares across restored epochs", async () => {
    const page = await fixture();
    const baseline = await checkpoint(page, 1, "Before", null);
    const first = await checkpoint(page, 2, "Intermediate", baseline);
    const last = await checkpoint(page, 1, "After", first, Date.now() + 1, 2);
    const diff = await readComparison(bindings, page, first.id, last.id);
    expect(diff?.changes).toMatchObject([{ id: "stable", kind: "modified", before: "Before", after: "After" }]);
    const recipients = await env.DB.prepare("SELECT user_id FROM page_change_recipients").all();
    expect(recipients.results).toHaveLength(3);
    expect(recipients.results.every((row) => row.user_id === "changes-viewer")).toBe(true);
    await expect(readComparison(bindings, page, last.id, first.id)).rejects.toMatchObject({ status: 422 });
    await env.DB.prepare("UPDATE page_change_checkpoints SET created_at=? WHERE id=?")
      .bind(Date.now() - 1000, last.id)
      .run();
    await expect(readComparison(bindings, page, last.id, first.id)).rejects.toMatchObject({ status: 422 });
    await expect(readComparison(bindings, "another-page", first.id, last.id)).rejects.toMatchObject({ status: 410 });
  });
  it("freezes personal delivery inputs before sending and retries the same comparison", async () => {
    const page = await fixture();
    const baseline = await checkpoint(page, 1, "Old", null);
    const first = await checkpoint(page, 2, "New <script>", baseline);
    const id = `change:${first.id}:changes-viewer`;
    await env.DB.prepare(
      "INSERT INTO deliveries(idempotency_key,outbox_id,channel,status,updated_at,claim_token) VALUES('changes-delivery',?,'email','pending',1,'claim')",
    )
      .bind(`outbox:${id}`)
      .run();
    const row = {
      id,
      user_id: "changes-viewer",
      workspace_id: "changes-workspace",
      page_id: page,
      page_title: "Changes",
      event_type: "page_edit",
      data_json: JSON.stringify({ checkpointId: first.id }),
      actor_name: "Owner",
    };
    const composed = await composePersonalDigest(bindings, [row], "email", "claim", () => "Owner edited Changes");
    expect(composed.html).toContain("New &lt;script&gt;");
    expect(composed.text).toContain("Before: Old");
    const later = await checkpoint(page, 3, "Later", first);
    const retry = await composePersonalDigest(
      bindings,
      [{ ...row, data_json: JSON.stringify({ checkpointId: later.id }) }],
      "email",
      "claim",
      () => "Owner edited Changes",
    );
    expect(retry).toEqual(composed);
    await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='changes-viewer'").run();
    expect((await composePersonalDigest(bindings, [row], "email", "claim", () => "Old summary")).empty).toBe(true);
  });
  it("reports unavailable input honestly and prunes only unreferenced projections", async () => {
    const page = await fixture();
    const baseline = await checkpoint(page, 1, "Old", null, Date.now() - CHANGE_RETENTION_MS - 10);
    const first = await checkpoint(page, 2, "Current", baseline);
    expect(await readComparison(bindings, page, first.id, first.id)).not.toBeNull();
    await pruneDocumentChanges(bindings);
    expect(await env.BUCKET.get(baseline.r2_key)).not.toBeNull();
    await env.BUCKET.delete(baseline.r2_key);
    expect(await readComparison(bindings, page, first.id, first.id)).toBeNull();
    await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(page).run();
    await pruneDocumentChanges(bindings);
    expect(await env.BUCKET.get(first.r2_key)).toBeNull();
    expect(
      (await env.DB.prepare("SELECT id FROM outbox WHERE topic='notification_digest_change'").all()).results,
    ).toHaveLength(0);
  });
  it("publishes compaction checkpoints transactionally and retains the previous projection", async () => {
    const page = await fixture();
    const stub = env.DOCUMENT.getByName(`${page}~1`);
    const warm = () =>
      new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } });
    await stub.fetch(warm());
    for (const value of ["One", "Two"]) {
      await runInDurableObject(stub, async (instance) => {
        const doc = (instance as unknown as { document: Y.Doc }).document;
        doc.transact(
          () => {
            const fragment = doc.getXmlFragment("document-store");
            if (fragment.length) fragment.delete(0, fragment.length);
            const group = new Y.XmlElement("blockGroup"),
              container = new Y.XmlElement("blockContainer"),
              paragraph = new Y.XmlElement("paragraph"),
              text = new Y.XmlText();
            container.setAttribute("id", "stable");
            text.insert(0, value);
            paragraph.insert(0, [text]);
            container.insert(0, [paragraph]);
            group.insert(0, [container]);
            fragment.insert(0, [group]);
          },
          { state: { userId: "changes-owner" } },
        );
      });
      expect((await stub.fetch(warm())).status).toBe(200);
    }
    const rows = await env.DB.prepare(
      "SELECT id,before_key,after_key FROM page_change_checkpoints WHERE page_id=? ORDER BY sequence",
    )
      .bind(page)
      .all<{ id: string; before_key: string | null; after_key: string }>();
    expect(rows.results.length).toBeGreaterThanOrEqual(2);
    const last = rows.results.at(-1)!;
    expect(await env.BUCKET.get(last.before_key!)).not.toBeNull();
    expect((await readComparison(bindings, page, last.id, last.id))?.counts.modified).toBe(1);
  });
});

it("delivers later watched edits despite an unread coalesced notification", async () => {
  const page = await fixture();
  const baseline = await checkpoint(page, 1, "Original", null);
  await env.DB.prepare("UPDATE page_change_recipients SET emailed_at=1,slack_at=1").run();
  const first = await checkpoint(page, 2, "Intermediate", baseline),
    last = await checkpoint(page, 3, "Final", first);
  await env.DB.prepare(
    "INSERT INTO notification_preferences(user_id,event_type,in_app,email,slack,timezone) VALUES('changes-viewer','page_edit',1,'digest','off','UTC')",
  ).run();
  for (const change of [first, last])
    await env.DB.batch(
      notificationFanoutStatements(env.DB, {
        workspaceId: "changes-workspace",
        spaceId: "changes-workspace-general",
        pageId: page,
        actorId: "changes-owner",
        eventType: "page_edit",
        sourceId: change.id,
        recipientIds: ["changes-viewer"],
        emitSlackChannel: false,
        threadId: null,
        createdAt: Date.now(),
      }),
    );
  expect((await env.DB.prepare("SELECT id FROM notifications").all()).results).toHaveLength(1);
  const send = vi.fn(async () => ({ messageId: "test-message" }));
  const configured = new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "SEND_EMAIL") return { send };
      if (property === "EMAIL_FROM") return "notes@example.test";
      return Reflect.get(target, property, receiver);
    },
  });
  const tomorrow = new Date(Date.now() + 86400000);
  tomorrow.setUTCHours(9, 1, 0, 0);
  await sendDueNotificationDigests(configured, tomorrow.getTime());
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Before: Original") }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("After: Final") }));
  const recipients = await env.DB.prepare("SELECT emailed_at FROM page_change_recipients WHERE checkpoint_id IN (?,?)")
    .bind(first.id, last.id)
    .all<{ emailed_at: number | null }>();
  expect(recipients.results.every((row) => row.emailed_at !== null)).toBe(true);
  await sendDueNotificationDigests(configured, tomorrow.getTime() + 1000);
  expect(send).toHaveBeenCalledOnce();
  expect(await env.DB.prepare("SELECT emailed_at FROM notifications").first()).toMatchObject({
    emailed_at: expect.any(Number),
  });
  await pruneDocumentChanges(configured, Date.now() + CHANGE_RETENTION_MS + 1);
  expect((await env.DB.prepare("SELECT id FROM page_change_checkpoints").all()).results).toHaveLength(0);
  await sendDueNotificationDigests(configured, tomorrow.getTime() + 2 * 86400000);
  expect(send).toHaveBeenCalledOnce();
});

it("groups more than forty edits into one frozen page comparison and leaves later edits pending", async () => {
  const page = await fixture();
  let previous = await checkpoint(page, 1, "Baseline", null);
  await env.DB.prepare("UPDATE page_change_recipients SET emailed_at=1").run();
  const firstId = `${page}:1:2`;
  for (let sequence = 2; sequence <= 52; sequence++)
    previous = await checkpoint(page, sequence, `Edit ${sequence}`, previous);
  const selectedLast = previous;
  await env.DB.prepare(
    "INSERT INTO notification_preferences(user_id,event_type,in_app,email,slack,timezone) VALUES('changes-viewer','page_edit',1,'digest','off','UTC')",
  ).run();
  const tomorrow = new Date(Date.now() + 86400000);
  tomorrow.setUTCHours(9, 1, 0, 0);
  const send = vi.fn(async () => {
    // An edit arriving during delivery belongs to the next invocation.
    previous = await checkpoint(page, 53, "Later edit", previous, tomorrow.getTime());
    return { messageId: "test" };
  });
  const configured = new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "SEND_EMAIL") return { send };
      if (property === "EMAIL_FROM") return "notes@example.test";
      return Reflect.get(target, property, receiver);
    },
  });
  await sendDueNotificationDigests(configured, tomorrow.getTime());
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]).toBeDefined();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Before: Baseline") }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("After: Edit 52") }));
  const frozen = await env.DB.prepare("SELECT comparison_json FROM deliveries WHERE channel='email'").first<{
    comparison_json: string;
  }>();
  expect(JSON.parse(frozen!.comparison_json)).toEqual({ first: firstId, last: selectedLast.id });
  const pending = await env.DB.prepare(
    "SELECT checkpoint_id FROM page_change_recipients WHERE emailed_at IS NULL",
  ).all<{ checkpoint_id: string }>();
  expect(pending.results).toEqual([{ checkpoint_id: previous.id }]);
});

it("bounds oversized comparison inputs and retries failed projection cleanup", async () => {
  const page = await fixture();
  const baseline = await checkpoint(page, 1, "Before", null);
  const last = await checkpoint(page, 2, "x".repeat(2 * 1024 * 1024), baseline);
  expect(await readComparison(bindings, page, last.id, last.id)).toBeNull();
  await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(page).run();
  const configured = new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "BUCKET")
        return {
          delete: vi.fn(async () => {
            throw new Error("R2 unavailable");
          }),
        };
      return Reflect.get(target, property, receiver);
    },
  });
  await expect(pruneDocumentChanges(configured)).rejects.toThrow("R2 unavailable");
  expect((await env.DB.prepare("SELECT r2_key FROM page_change_projection_gc").all()).results.length).toBeGreaterThan(
    0,
  );
  await pruneDocumentChanges(bindings);
  expect(await env.BUCKET.get(last.r2_key)).toBeNull();
  expect((await env.DB.prepare("SELECT r2_key FROM page_change_projection_gc").all()).results).toHaveLength(0);
});

it("bounds personal Slack sections after escaping while retaining comparison links", async () => {
  const page = await fixture();
  const baseline = await checkpoint(page, 1, "<".repeat(240), null);
  const last = await checkpoint(page, 2, "&".repeat(240), baseline);
  const id = `change:${last.id}:changes-viewer`;
  await env.DB.prepare(
    "INSERT INTO deliveries(idempotency_key,outbox_id,channel,status,updated_at,claim_token) VALUES(?,?,'slack','pending',1,'slack-claim')",
  )
    .bind(`${id}:slack`, `outbox:${id}`)
    .run();
  const row = {
    id,
    user_id: "changes-viewer",
    workspace_id: "changes-workspace",
    page_id: page,
    page_title: "Changes",
    event_type: "page_edit",
    data_json: JSON.stringify({ checkpointId: last.id }),
    actor_name: "Owner",
  };
  const composed = await composePersonalDigest(bindings, [row], "slack", "slack-claim", () => "Old summary");
  expect(composed.text).toContain("&lt;");
  expect(composed.text).not.toContain("&amp;lt;");
  expect(composed.slackSections?.every((section) => section.length <= 3000)).toBe(true);
  expect(composed.text).toContain("compareFrom=");
});
