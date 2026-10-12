import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  CHANGE_RETENTION_MS,
  checkpointStatements,
  readComparison,
  digestComparison,
  pruneDocumentChanges,
} from "./document-changes";
import { notificationFanoutStatements, sendDueNotificationDigests } from "./notifications";
import { composePersonalDigest } from "./personal-diff-digest";
import { consumeDeliveryMessage, type DeliveryQueueMessage } from "./jobs";
import type { Env } from "./env";
import type { DocumentContentEnvelope } from "../shared/types";
import { logger } from "./observability";
import { encryptSlackToken } from "./slack";
import { countedD1 } from "../../tests/helpers/count-d1";
import { protectSlackFixtureUsers } from "../../tests/helpers/security";
const bindings = env as unknown as Env;
function emailRuntime(send = vi.fn(async (_message: unknown) => ({ messageId: "digest" }))) {
  return {
    configured: new Proxy(bindings, {
      get(target, property, receiver) {
        if (property === "SEND_EMAIL") return { send };
        if (property === "EMAIL_FROM") return "notes@example.test";
        return Reflect.get(target, property, receiver);
      },
    }),
    send,
  };
}
function digestTimestamp() {
  const date = new Date(Date.now() + 86400_000);
  date.setUTCHours(9, 1, 0, 0);
  return date.getTime();
}
function withDatabaseHook(configured: Env, hook: (query: string) => void) {
  const db = new Proxy(configured.DB, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          hook(query);
          return target.prepare(query);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(configured, {
    get(target, property, receiver) {
      return property === "DB" ? db : Reflect.get(target, property, receiver);
    },
  });
}
async function digestRuntime(
  channel: "email" | "slack",
  users = ["changes-viewer"],
  send = vi.fn(async (_message: unknown) => ({ messageId: "digest" })),
) {
  const configured = new Proxy(emailRuntime(send).configured, {
    get(target, property, receiver) {
      if (property === "DIFF_DIGESTS_ENABLED") return "true";
      if (property === "EMAIL_FROM" && channel === "slack") return undefined;
      if (property === "SLACK_TOKEN_ENCRYPTION_KEY") return "digest-test-key-with-enough-entropy";
      if (["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"].includes(String(property)))
        return "digest-slack-fixture";
      return Reflect.get(target, property, receiver);
    },
  });
  if (channel === "slack") {
    await protectSlackFixtureUsers(users);
    const token = await encryptSlackToken(configured, "xoxb-digest");
    await env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at,generation)
      VALUES('digest-installation','changes-workspace','TDIGEST','Digest','BDIGEST',?,'chat:write','changes-owner',1,1,1)`)
      .bind(token)
      .run();
    for (const user of users)
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO account(id,userId,providerId,accountId,createdAt,updatedAt) VALUES(? ,?,'slack',?,1,1)`,
        ).bind(`digest-account:${user}`, user, `TDIGEST:U${user}`),
        env.DB.prepare(`INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,verification_method,verified_at,better_auth_account_id,authorization_started_at,security_generation,installation_generation)
        SELECT 'digest-installation',?,?,1,'slack_openid',1,?,1,generation,1 FROM slack_protected_accounts WHERE user_id=?`).bind(
          user,
          `U${user}`,
          `digest-account:${user}`,
          user,
        ),
      ]);
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { channel: string };
      await send({ ...body, to: body.channel });
      return Response.json({ ok: true });
    });
  }
  return { configured, send };
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM page_change_projection_gc"),
    env.DB.prepare("DELETE FROM digest_delivery_cursors"),
    env.DB.prepare("UPDATE document_changes_cleanup_state SET lease_token=NULL,lease_until=0 WHERE id=1"),
  ]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await abortAllDurableObjects();
  await reset();
});
async function fixture(pageId: string = crypto.randomUUID()) {
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
async function digestFailureFixture(channel: "email" | "slack") {
  const page = await fixture();
  const due = digestTimestamp();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('changes-a','First','first@example.test',1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('changes-workspace','changes-a','viewer',1)",
    ),
    env.DB
      .prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,archived_at)
      VALUES('denied-page','changes-workspace','changes-workspace-general','document','a1','Denied','changes-owner',1,1,1)`),
    env.DB.prepare(`INSERT INTO notification_preferences(user_id,event_type,email,slack,timezone)
      VALUES('changes-a','mention',?,?,'UTC'),('changes-viewer','mention',?,?,'UTC')`).bind(
      channel === "email" ? "digest" : "off",
      channel === "slack" ? "digest" : "off",
      channel === "email" ? "digest" : "off",
      channel === "slack" ? "digest" : "off",
    ),
    env.DB.prepare(`INSERT INTO notifications(id,workspace_id,user_id,event_type,page_id,space_id,data_json,dedupe_key,created_at)
      VALUES('failure-first','changes-workspace','changes-a','mention',?,'changes-workspace-general','{}','failure-first',1),
        ('failure-denied','changes-workspace','changes-a','mention','denied-page','changes-workspace-general','{}','failure-denied',2),
        ('failure-second','changes-workspace','changes-viewer','mention',?,'changes-workspace-general','{}','failure-second',1)`).bind(
      page,
      page,
    ),
    env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
      SELECT 'outbox:'||id,workspace_id,'notification','{}',1,1 FROM notifications`),
  ]);
  return { ...(await digestRuntime(channel, ["changes-a", "changes-viewer"])), due };
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

it.each(["not-json", "null", "[]", '{"first":1,"last":2}', '{"first":"one"}'])(
  "repairs malformed frozen receipts before sending and finalizing (%s)",
  async (frozen) => {
    const page = await fixture();
    const baseline = await checkpoint(page, 1, "Before", null);
    await env.DB.prepare("UPDATE page_change_recipients SET emailed_at=1").run();
    const last = await checkpoint(page, 2, "After", baseline);
    const id = `outbox:change:${last.id}:changes-viewer`;
    await env.DB.prepare(`INSERT INTO deliveries(idempotency_key,outbox_id,channel,status,updated_at,comparison_json)
    VALUES(?,?,'email','failed',1,?)`)
      .bind(`${id}:email`, id, frozen)
      .run();
    const { configured, send } = emailRuntime();
    await sendDueNotificationDigests(configured, digestTimestamp());
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("After: After") }));
    const delivery = await env.DB.prepare("SELECT status,comparison_json FROM deliveries WHERE outbox_id=?")
      .bind(id)
      .first<{ status: string; comparison_json: string }>();
    expect(delivery?.status).toBe("sent");
    expect(JSON.parse(delivery!.comparison_json)).toEqual({ first: last.id, last: last.id });
    await sendDueNotificationDigests(configured, digestTimestamp());
    expect(send).toHaveBeenCalledOnce();
  },
);

it("preserves valid frozen fallback receipts and underscore URLs", async () => {
  const page = await fixture("team_notes");
  const last = await checkpoint(page, 1, "New", null);
  const id = `change:${last.id}:changes-viewer`;
  await env.DB.prepare(`INSERT INTO deliveries(idempotency_key,outbox_id,channel,status,updated_at,claim_token,comparison_json)
    VALUES('url-delivery',?,'slack','pending',1,'url-claim','{"first":"","last":""}')`)
    .bind(`outbox:${id}`)
    .run();
  const composed = await composePersonalDigest(
    bindings,
    [
      {
        id,
        user_id: "changes-viewer",
        workspace_id: "changes-workspace",
        page_id: page,
        page_title: "Changes",
        event_type: "page_edit",
        data_json: "{}",
        actor_name: "Owner",
      },
    ],
    "slack",
    "url-claim",
    () => "Summary",
  );
  expect(composed.text).toContain("?page=team_notes|Open page>");
  expect(composed.text).not.toContain("team＿notes");
  expect(
    await env.DB.prepare("SELECT comparison_json FROM deliveries WHERE idempotency_key='url-delivery'").first(),
  ).toEqual({ comparison_json: '{"first":"","last":""}' });
});

async function seedCheckpointRows(page: string, count: number, timestamp: number) {
  await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?)
    INSERT INTO page_change_checkpoints(id,page_id,workspace_id,content_epoch,sequence,after_key,created_at)
    SELECT ?||':1:'||n,?,'changes-workspace',1,n,'expired-'||n,? FROM numbers`)
    .bind(count, page, page, timestamp)
    .run();
}

it.each(["checkpoints", "projections"])("drains bounded %s batches through queue continuation", async (kind) => {
  const page = await fixture();
  const count = kind === "checkpoints" ? 701 : 1301;
  await seedCheckpointRows(page, count, Date.now() - CHANGE_RETENTION_MS - 1);
  if (kind === "projections") await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(page).run();
  const send = vi.fn(async () => undefined);
  const configured = { ...bindings, DELIVERY_QUEUE: { send } } as unknown as Env;
  expect(await pruneDocumentChanges(configured)).toBe("completed");
  const table = kind === "checkpoints" ? "page_change_checkpoints" : "page_change_projection_gc";
  expect(await env.DB.prepare(`SELECT count(*) count FROM ${table}`).first()).toEqual({
    count: kind === "checkpoints" ? 201 : 301,
  });
  expect(send).toHaveBeenCalledExactlyOnceWith({ documentChangesCleanup: true });
  const ack = vi.fn(),
    retry = vi.fn();
  await consumeDeliveryMessage(configured, {
    body: { documentChangesCleanup: true },
    ack,
    retry,
    attempts: 1,
  } as unknown as Message<DeliveryQueueMessage>);
  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(await env.DB.prepare(`SELECT count(*) count FROM ${table}`).first()).toEqual({ count: 0 });
  expect(send).toHaveBeenCalledOnce();
});

it("retries contended cleanup and recovers when continuation enqueue fails", async () => {
  const page = await fixture();
  await seedCheckpointRows(page, 501, Date.now() - CHANGE_RETENTION_MS - 1);
  await env.DB.prepare("UPDATE document_changes_cleanup_state SET lease_token='other',lease_until=?")
    .bind(Date.now() + 60000)
    .run();
  const ack = vi.fn(),
    retry = vi.fn();
  await consumeDeliveryMessage(bindings, {
    body: { documentChangesCleanup: true },
    ack,
    retry,
    attempts: 2,
  } as unknown as Message<DeliveryQueueMessage>);
  expect(ack).not.toHaveBeenCalled();
  expect(retry).toHaveBeenCalledWith({ delaySeconds: 4 });
  await env.DB.prepare("UPDATE document_changes_cleanup_state SET lease_until=0").run();
  const failed = {
    ...bindings,
    DELIVERY_QUEUE: {
      send: vi.fn(async () => {
        throw new Error("Queue unavailable");
      }),
    },
  } as unknown as Env;
  await expect(pruneDocumentChanges(failed)).rejects.toThrow("Queue unavailable");
  expect(await env.DB.prepare("SELECT lease_token,lease_until FROM document_changes_cleanup_state").first()).toEqual({
    lease_token: null,
    lease_until: 0,
  });
  await pruneDocumentChanges(bindings);
  expect(await env.DB.prepare("SELECT count(*) count FROM page_change_checkpoints").first()).toEqual({ count: 0 });
});

it("does not acknowledge GC keys or release a replacement lease after lease loss", async () => {
  await env.DB.prepare("INSERT INTO page_change_projection_gc VALUES('orphan')").run();
  const configured = {
    ...bindings,
    BUCKET: {
      delete: vi.fn(async () => {
        await env.DB.prepare("UPDATE document_changes_cleanup_state SET lease_token='replacement',lease_until=?")
          .bind(Date.now() + 60000)
          .run();
      }),
    },
  } as unknown as Env;
  expect(await pruneDocumentChanges(configured)).toBe("lease-lost");
  expect(await env.DB.prepare("SELECT r2_key FROM page_change_projection_gc").first()).toEqual({ r2_key: "orphan" });
  expect(await env.DB.prepare("SELECT lease_token FROM document_changes_cleanup_state").first()).toEqual({
    lease_token: "replacement",
  });
});

it.each(["email", "slack"] as const)(
  "suppresses inaccessible recipients and legacy notifications for %s only",
  async (channel) => {
    const page = await fixture();
    const due = digestTimestamp();
    await seedCheckpointRows(page, 2001, Date.now());
    await env.DB.prepare(`INSERT INTO page_change_recipients(id,checkpoint_id,user_id)
    SELECT 'change:'||id||':changes-viewer',id,'changes-viewer' FROM page_change_checkpoints`).run();
    await env.DB.prepare(`INSERT INTO notifications(id,workspace_id,user_id,event_type,page_id,space_id,data_json,dedupe_key,created_at)
    SELECT 'page_edit:'||id||':changes-viewer','changes-workspace','changes-viewer','page_edit',page_id,'changes-workspace-general','{}',id,created_at FROM page_change_checkpoints`).run();
    await env.DB.prepare("UPDATE page_change_checkpoints SET created_at=? WHERE sequence=2001").bind(due).run();
    await env.DB.prepare("UPDATE notifications SET created_at=? WHERE id LIKE 'page_edit:%:2001:changes-viewer'")
      .bind(due)
      .run();
    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(page).run();
    await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
    VALUES('accessible-page','changes-workspace','changes-workspace-general','document','a1','Accessible','changes-owner',1,1)`).run();
    const accessible = await checkpoint("accessible-page", 1, "Still accessible", null);
    await env.DB.prepare(
      `INSERT INTO notification_preferences(user_id,event_type,email,slack,timezone) VALUES('changes-viewer','page_edit',?,?,'UTC')`,
    )
      .bind(channel === "email" ? "digest" : "off", channel === "slack" ? "digest" : "off")
      .run();
    const { configured, send } = await digestRuntime(channel);
    await sendDueNotificationDigests(configured, due);
    expect(send).toHaveBeenCalledOnce();
    const column = channel === "email" ? "emailed_at" : "slack_at";
    const other = channel === "email" ? "slack_at" : "emailed_at";
    expect(
      await env.DB.prepare(
        `SELECT count(*) count FROM page_change_recipients r JOIN page_change_checkpoints c ON c.id=r.checkpoint_id WHERE c.page_id=? AND r.${column} IS NOT NULL`,
      )
        .bind(page)
        .first(),
    ).toEqual({ count: 2000 });
    expect(
      await env.DB.prepare(`SELECT count(*) count FROM notifications WHERE ${column} IS NOT NULL`).first(),
    ).toEqual({ count: 2000 });
    expect(
      await env.DB.prepare(`SELECT count(*) count FROM page_change_recipients WHERE ${other} IS NULL`).first(),
    ).toEqual({ count: 2002 });
    expect(
      await env.DB.prepare(`SELECT ${column} delivered FROM page_change_recipients WHERE checkpoint_id=?`)
        .bind(accessible.id)
        .first(),
    ).toEqual({ delivered: expect.any(Number) });
  },
);

it("keeps forty ordinary items while limiting comparisons to ten pages", async () => {
  await fixture();
  await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<12)
    INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
    SELECT 'limit-page-'||n,'changes-workspace','changes-workspace-general','document','a0','Page '||n,'changes-owner',1,1 FROM numbers`).run();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO page_change_checkpoints(id,page_id,workspace_id,content_epoch,sequence,after_key,created_at)
      SELECT id||':1:1',id,workspace_id,1,1,'missing',? FROM pages WHERE id LIKE 'limit-page-%'`).bind(
      Date.now() - 1000,
    ),
    env.DB.prepare(`INSERT INTO page_change_recipients(id,checkpoint_id,user_id)
      SELECT 'change:'||id||':changes-viewer',id,'changes-viewer' FROM page_change_checkpoints`),
    env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
      SELECT 'outbox:'||r.id,c.workspace_id,'notification_digest_change','{}',9007199254740991,c.created_at
      FROM page_change_recipients r JOIN page_change_checkpoints c ON c.id=r.checkpoint_id`),
    env.DB.prepare(
      `INSERT INTO notification_preferences(user_id,event_type,email,slack,timezone) VALUES('changes-viewer','mention','digest','off','UTC')`,
    ),
    env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<40)
      INSERT INTO notifications(id,workspace_id,user_id,event_type,actor_id,space_id,page_id,data_json,dedupe_key,created_at)
      SELECT 'ordinary-'||n,'changes-workspace','changes-viewer','mention','changes-owner','changes-workspace-general','limit-page-1','{}','ordinary-'||n,? FROM numbers`).bind(
      Date.now(),
    ),
    env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
      SELECT 'outbox:'||id,workspace_id,'notification','{}',1,created_at FROM notifications`),
  ]);
  const { configured, send } = emailRuntime();
  await sendDueNotificationDigests(configured, digestTimestamp());
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: "40 NoteFlare updates" }));
  expect(
    await env.DB.prepare("SELECT count(*) count FROM page_change_recipients WHERE emailed_at IS NOT NULL").first(),
  ).toEqual({ count: 10 });
  expect(await env.DB.prepare("SELECT count(*) count FROM notifications WHERE emailed_at IS NOT NULL").first()).toEqual(
    { count: 30 },
  );
  await sendDueNotificationDigests(configured, digestTimestamp());
  expect(await env.DB.prepare("SELECT count(*) count FROM notifications WHERE emailed_at IS NOT NULL").first()).toEqual(
    { count: 40 },
  );
});

it.each(
  (["email", "slack"] as const).flatMap((channel) =>
    [false, true].map((multipleTimezones) => ({ channel, multipleTimezones })),
  ),
)(
  "preserves $channel budget-deferred comparisons across ticks with multiple timezones=$multipleTimezones",
  async ({ channel, multipleTimezones }) => {
    await fixture();
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<8)
      INSERT INTO user(id,name,email,createdAt,updatedAt)
      SELECT printf('cost-user-%02d',n),'Viewer',printf('cost-%02d@example.test',n),1,1 FROM numbers`),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
      SELECT 'changes-workspace',id,'viewer',1 FROM user WHERE id LIKE 'cost-user-%'`),
      env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<10)
      INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
      SELECT 'cost-page-'||n,'changes-workspace','changes-workspace-general','document','a0','Page '||n,'changes-owner',1,1 FROM numbers`),
      env.DB.prepare(`INSERT INTO page_change_checkpoints(id,page_id,workspace_id,content_epoch,sequence,after_key,created_at)
      SELECT id||':1:1',id,workspace_id,1,1,'missing',? FROM pages WHERE id LIKE 'cost-page-%'`).bind(Date.now()),
      env.DB.prepare(`INSERT INTO page_change_recipients(id,checkpoint_id,user_id)
      SELECT 'change:'||c.id||':'||u.id,c.id,u.id FROM page_change_checkpoints c JOIN user u WHERE u.id LIKE 'cost-user-%'`),
      env.DB.prepare(`INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
      SELECT 'outbox:'||r.id,c.workspace_id,'notification_digest_change','{}',9007199254740991,c.created_at
      FROM page_change_recipients r JOIN page_change_checkpoints c ON c.id=r.checkpoint_id`),
    ]);
    await env.DB.prepare(`INSERT INTO notification_preferences(user_id,event_type,email,slack,timezone)
      SELECT id,'page_edit',?,?,CASE WHEN ? AND id<='cost-user-04' THEN 'Africa/Abidjan' ELSE 'UTC' END FROM user WHERE id LIKE 'cost-user-%'`)
      .bind(channel === "email" ? "digest" : "off", channel === "slack" ? "digest" : "off", multipleTimezones)
      .run();
    const { database: db, statements } = countedD1(bindings.DB);
    const { configured, send } = await digestRuntime(
      channel,
      Array.from({ length: 8 }, (_, n) => `cost-user-${String(n + 1).padStart(2, "0")}`),
    );
    const counted = new Proxy(configured, {
      get(target, property, receiver) {
        return property === "DB" ? db : Reflect.get(target, property, receiver);
      },
    });
    const recipientsPerTick = channel === "email" ? 2 : 1;
    for (let tick = 1; tick <= 8 / recipientsPerTick; tick++) {
      statements.length = 0;
      await sendDueNotificationDigests(counted, digestTimestamp());
      expect(send).toHaveBeenCalledTimes(tick * recipientsPerTick);
      expect(statements.length).toBeLessThanOrEqual(120);
      const recipient = (send.mock.lastCall![0] as { to: string }).to;
      const number = Number(/(\d+)(?:@example.test)?$/.exec(recipient)![1]);
      const timezone = multipleTimezones && number <= 4 ? "Africa/Abidjan" : "UTC";
      expect(
        await env.DB.prepare("SELECT user_id FROM digest_delivery_cursors WHERE channel=? AND timezone=?")
          .bind(channel, timezone)
          .first(),
      ).toEqual({ user_id: `cost-user-${String(number).padStart(2, "0")}` });
    }
    expect(
      await env.DB.prepare(
        `SELECT count(*) count FROM page_change_recipients WHERE ${channel === "email" ? "emailed_at" : "slack_at"} IS NULL`,
      ).first(),
    ).toEqual({ count: 0 });
  },
);

it("does not finalize recipients after a delivery claim is replaced", async () => {
  const page = await fixture();
  await checkpoint(page, 1, "Edit", null);
  const send = vi.fn(async (_message: unknown) => {
    await env.DB.prepare("UPDATE deliveries SET claim_token='replacement'").run();
    return { messageId: "sent" };
  });
  await sendDueNotificationDigests(emailRuntime(send).configured, digestTimestamp());
  expect(send).toHaveBeenCalledOnce();
  expect(await env.DB.prepare("SELECT status,claim_token FROM deliveries").first()).toEqual({
    status: "pending",
    claim_token: "replacement",
  });
  expect(await env.DB.prepare("SELECT emailed_at FROM page_change_recipients").first()).toEqual({ emailed_at: null });
});

it("finalizes checkpoint ranges by index without changing unrelated notification history", async () => {
  const page = await fixture();
  const before = await checkpoint(page, 1, "Before", null);
  await env.DB.prepare("UPDATE page_change_recipients SET emailed_at=1").run();
  const after = await checkpoint(page, 2, "After", before);
  await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<10000)
    INSERT INTO notifications(id,workspace_id,user_id,event_type,space_id,page_id,data_json,dedupe_key,created_at,emailed_at)
    SELECT 'unrelated-'||n,'changes-workspace','changes-viewer','mention','changes-workspace-general',?,'{}','unrelated-'||n,1,7 FROM numbers`)
    .bind(page)
    .run();
  const queries: string[] = [];
  const db = new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          if (query.startsWith("WITH claimed AS")) queries.push(query);
          return target.prepare(query);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { configured } = emailRuntime();
  await sendDueNotificationDigests(
    new Proxy(configured, {
      get(target, property, receiver) {
        return property === "DB" ? db : Reflect.get(target, property, receiver);
      },
    }),
    digestTimestamp(),
  );
  const outboxId = `outbox:change:${after.id}:changes-viewer`;
  const delivery = await env.DB.prepare("SELECT claim_token FROM deliveries WHERE outbox_id=?")
    .bind(outboxId)
    .first<{ claim_token: string }>();
  expect(queries).toHaveLength(2);
  for (const query of queries) {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`)
      .bind(JSON.stringify([outboxId]), "email", delivery!.claim_token, Date.now())
      .all<{ detail: string }>();
    expect(plan.results.some((row) => /SCAN (notifications|page_change_recipients)\b/.test(row.detail))).toBe(false);
    expect(plan.results.some((row) => /SEARCH .*page_change_window/.test(row.detail))).toBe(true);
  }
  expect(await env.DB.prepare("SELECT count(*) count FROM notifications WHERE emailed_at=7").first()).toEqual({
    count: 10000,
  });
  expect(
    await env.DB.prepare("SELECT emailed_at FROM page_change_recipients WHERE checkpoint_id=?").bind(before.id).first(),
  ).toEqual({ emailed_at: 1 });
});

it.each(
  (["email", "slack"] as const).flatMap((channel) =>
    ["ids", "access", "suppression", "claim", "claim-selection", "finalization"].map((stage) => ({ channel, stage })),
  ),
)(
  "continues after a $channel candidate fails during $stage and retries its pending work",
  async ({ channel, stage }) => {
    const { configured, send, due } = await digestFailureFixture(channel);
    const failure = new Error(`Injected ${stage} failure`);
    const log = vi.spyOn(logger, "error");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failed = false;
    const matches: Record<string, (query: string) => boolean> = {
      ids: (query) => query.startsWith("WITH eligible AS"),
      access: (query) => query.includes("recipient.name recipient_name"),
      suppression: (query) => query.startsWith("UPDATE notifications SET"),
      claim: (query) => query.includes("INSERT OR IGNORE INTO deliveries"),
      "claim-selection": (query) => query.startsWith("SELECT outbox_id FROM deliveries"),
      finalization: (query) =>
        query.startsWith("UPDATE deliveries SET status =") && query.includes("RETURNING outbox_id"),
    };
    const failing = withDatabaseHook(configured, (query) => {
      if (!failed && matches[stage]!(query)) {
        failed = true;
        throw failure;
      }
    });
    await expect(sendDueNotificationDigests(failing, due)).rejects.toBe(failure);
    expect(failed).toBe(true);
    expect(send).toHaveBeenCalledTimes(stage === "finalization" ? 2 : 1);
    expect(log).toHaveBeenCalledWith(
      `notification.digest_${channel}.infrastructure_failed`,
      "notifications",
      expect.any(String),
      expect.objectContaining({ userId: "changes-a" }),
      failure,
    );
    const column = channel === "email" ? "emailed_at" : "slack_at";
    expect(
      await env.DB.prepare(
        `SELECT id,${column} delivered FROM notifications WHERE id IN ('failure-first','failure-second') ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: "failure-first", delivered: null },
        { id: "failure-second", delivered: expect.any(Number) },
      ],
    });
    expect(
      await env.DB.prepare("SELECT user_id FROM digest_delivery_cursors WHERE channel=?").bind(channel).first(),
    ).toEqual({ user_id: "changes-viewer" });
    const delivery = await env.DB.prepare(
      "SELECT status FROM deliveries WHERE outbox_id='outbox:failure-first'",
    ).first<{ status: string }>();
    expect(delivery?.status ?? null).toBe(stage === "finalization" ? "failed" : null);
    await sendDueNotificationDigests(configured, due);
    expect(
      await env.DB.prepare(`SELECT ${column} delivered FROM notifications WHERE id='failure-first'`).first(),
    ).toEqual({ delivered: expect.any(Number) });
  },
);

it("reports failure-recording errors while preserving the primary delivery log", async () => {
  const { configured, send, due } = await digestFailureFixture("email");
  const primary = new Error("Mailbox failed");
  const secondary = new Error("Failure recording failed");
  send.mockRejectedValueOnce(primary);
  const log = vi.spyOn(logger, "error");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let failed = false;
  await expect(
    sendDueNotificationDigests(
      withDatabaseHook(configured, (query) => {
        if (!failed && query.startsWith("UPDATE deliveries SET status =") && query.includes("RETURNING outbox_id")) {
          failed = true;
          throw secondary;
        }
      }),
      due,
    ),
  ).rejects.toBe(secondary);
  expect(send).toHaveBeenCalledTimes(2);
  expect(log.mock.calls.map((call) => call[4])).toEqual([primary, secondary]);
  expect(
    await env.DB.prepare("SELECT emailed_at delivered FROM notifications WHERE id='failure-second'").first(),
  ).toEqual({ delivered: expect.any(Number) });
});

it("does not overwrite a replacement claim while recording a delivery failure", async () => {
  const page = await fixture();
  await checkpoint(page, 1, "Edit", null);
  const failure = new Error("Send failed after claim replacement");
  const send = vi.fn(async (_message: unknown) => {
    await env.DB.prepare("UPDATE deliveries SET claim_token='replacement'").run();
    throw failure;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await sendDueNotificationDigests(emailRuntime(send).configured, digestTimestamp());
  expect(await env.DB.prepare("SELECT status,claim_token FROM deliveries").first()).toEqual({
    status: "pending",
    claim_token: "replacement",
  });
});

it.each(["discovery", "cursor", "scan-and-save"])("still sends Slack after email %s fails", async (stage) => {
  const { configured, send, due } = await digestFailureFixture("slack");
  await env.DB.prepare("UPDATE notification_preferences SET email='digest'").run();
  const both = new Proxy(configured, {
    get(target, property, receiver) {
      return property === "EMAIL_FROM" ? "notes@example.test" : Reflect.get(target, property, receiver);
    },
  });
  const primary = new Error(`Email ${stage} failed`);
  const secondary = new Error("Email cursor save failed too");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let cursorWrites = 0;
  const failing = withDatabaseHook(both, (query) => {
    if (stage === "discovery" && query.includes("cursor_updated_at") && query.includes("n.emailed_at")) throw primary;
    if (stage === "scan-and-save" && query.includes("recipient.name, recipient.email")) throw primary;
    if (query.startsWith("INSERT INTO digest_delivery_cursors") && cursorWrites++ === 0) {
      if (stage === "cursor") throw primary;
      if (stage === "scan-and-save") throw secondary;
    }
  });
  const failure: unknown = await sendDueNotificationDigests(failing, due).catch((error: unknown) => error);
  expect(failure instanceof AggregateError ? failure.errors : [failure]).toEqual(
    stage === "scan-and-save" ? [primary, secondary] : [primary],
  );
  expect(send.mock.calls.filter(([message]) => String((message as { to: string }).to).startsWith("U"))).toHaveLength(2);
});

it("reports both independent digest channel failures", async () => {
  const { configured, due } = await digestFailureFixture("slack");
  const both = new Proxy(configured, {
    get(target, property, receiver) {
      return property === "EMAIL_FROM" ? "notes@example.test" : Reflect.get(target, property, receiver);
    },
  });
  const email = new Error("Email discovery failed"),
    slack = new Error("Slack discovery failed");
  const failing = withDatabaseHook(both, (query) => {
    if (query.includes("cursor_updated_at")) throw query.includes("n.emailed_at") ? email : slack;
  });
  await expect(sendDueNotificationDigests(failing, due)).rejects.toMatchObject({ errors: [email, slack] });
});

it.each((["email", "slack"] as const).flatMap((channel) => ["D1", "R2", "body"].map((stage) => ({ channel, stage }))))(
  "retries $channel comparisons after temporary $stage errors without changing frozen references",
  async ({ channel, stage }) => {
    const page = await fixture();
    const baseline = await checkpoint(page, 1, "Before", null);
    const first = await checkpoint(page, 2, "Original after", baseline);
    const column = channel === "email" ? "emailed_at" : "slack_at";
    await env.DB.prepare(`UPDATE page_change_recipients SET ${column}=1 WHERE checkpoint_id=?`).bind(baseline.id).run();
    await env.DB.prepare(`INSERT INTO notification_preferences(user_id,event_type,email,slack,timezone)
      VALUES('changes-viewer','page_edit',?,?,'UTC')`)
      .bind(channel === "email" ? "digest" : "off", channel === "slack" ? "digest" : "off")
      .run();
    const { configured, send } = await digestRuntime(channel);
    const failure = new Error(`${stage} temporarily unavailable`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failed = false;
    const bucket = new Proxy(configured.BUCKET, {
      get(target, property) {
        if (property === "get")
          return async (key: string) => {
            if (stage === "R2" && !failed) {
              failed = true;
              throw failure;
            }
            const object = await target.get(key);
            if (stage === "body" && object && !failed) {
              failed = true;
              return new Proxy(object, {
                get(value, name) {
                  if (name === "text")
                    return async () => {
                      throw failure;
                    };
                  const member: unknown = Reflect.get(value, name, value);
                  return typeof member === "function" ? member.bind(value) : member;
                },
              });
            }
            return object;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = withDatabaseHook(
      new Proxy(configured, {
        get(target, property, receiver) {
          return property === "BUCKET" ? bucket : Reflect.get(target, property, receiver);
        },
      }),
      (query) => {
        if (stage === "D1" && !failed && query.includes("WHERE page_id=? AND id IN (?,?)")) {
          failed = true;
          throw failure;
        }
      },
    );
    await expect(sendDueNotificationDigests(failing, digestTimestamp())).rejects.toBe(failure);
    expect(failed).toBe(true);
    expect(send).not.toHaveBeenCalled();
    const frozen = await env.DB.prepare("SELECT comparison_json,status FROM deliveries").first<{
      comparison_json: string;
      status: string;
    }>();
    expect(frozen!.status).toBe("failed");
    expect(JSON.parse(frozen!.comparison_json)).toEqual({ first: first.id, last: first.id });
    const later = await checkpoint(page, 3, "Later edit", first);
    await sendDueNotificationDigests(configured, digestTimestamp());
    expect(send).toHaveBeenCalledOnce();
    const text = (send.mock.calls[0]![0] as { text: string }).text;
    expect(text).toContain("Before: Before");
    expect(text).toContain("After: Original after");
    expect(text).not.toContain("Later edit");
    expect(await env.DB.prepare("SELECT comparison_json,status FROM deliveries").first()).toEqual({
      comparison_json: frozen!.comparison_json,
      status: "sent",
    });
    expect(
      await env.DB.prepare(`SELECT ${column} delivered FROM page_change_recipients WHERE checkpoint_id=?`)
        .bind(later.id)
        .first(),
    ).toEqual({ delivered: null });
  },
);

it.each(["missing", "malformed", "expired", "invalid"])(
  "keeps the digest summary fallback for %s comparison inputs",
  async (kind) => {
    const page = await fixture();
    const before = await checkpoint(page, 1, "Before", null);
    const after = await checkpoint(page, 2, "After", before);
    if (kind === "missing") await env.BUCKET.delete(before.r2_key);
    if (kind === "malformed") await env.BUCKET.put(before.r2_key, "{broken");
    if (kind === "expired")
      await env.DB.prepare("UPDATE page_change_checkpoints SET created_at=?")
        .bind(Date.now() - CHANGE_RETENTION_MS - 1)
        .run();
    const comparison =
      kind === "invalid"
        ? await digestComparison(bindings, page, after.id, before.id)
        : await digestComparison(bindings, page, after.id, after.id);
    expect(comparison.diff).toBeNull();
  },
);

it("releases the cleanup lease before an immediately consumed continuation", async () => {
  const page = await fixture();
  await seedCheckpointRows(page, 501, Date.now() - CHANGE_RETENTION_MS - 1);
  const ack = vi.fn(),
    retry = vi.fn();
  const configured: Env = new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "DELIVERY_QUEUE")
        return {
          send: async (body: DeliveryQueueMessage) => {
            expect(
              await env.DB.prepare("SELECT lease_token,lease_until FROM document_changes_cleanup_state").first(),
            ).toEqual({ lease_token: null, lease_until: 0 });
            await consumeDeliveryMessage(configured, {
              body,
              ack,
              retry,
              attempts: 1,
            } as unknown as Message<DeliveryQueueMessage>);
          },
        };
      return Reflect.get(target, property, receiver);
    },
  });
  expect(await pruneDocumentChanges(configured)).toBe("completed");
  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT count(*) count FROM page_change_checkpoints").first()).toEqual({ count: 0 });
});

it("does not enqueue a continuation when releasing the cleanup lease fails", async () => {
  const page = await fixture();
  await seedCheckpointRows(page, 501, Date.now() - CHANGE_RETENTION_MS - 1);
  const send = vi.fn();
  const failure = new Error("Lease release failed");
  const configured = withDatabaseHook(
    new Proxy(bindings, {
      get(target, property, receiver) {
        return property === "DELIVERY_QUEUE" ? { send } : Reflect.get(target, property, receiver);
      },
    }),
    (query) => {
      if (query.includes("SET lease_token=NULL,lease_until=0")) throw failure;
    },
  );
  await expect(pruneDocumentChanges(configured)).rejects.toBe(failure);
  expect(send).not.toHaveBeenCalled();
});
