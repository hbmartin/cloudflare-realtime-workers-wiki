import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { flattenDocumentBlocks, notionInputToBlockContainer } from "../shared/notion-blocks";
import { diagramRoots } from "../shared/diagram";
import { documentToYjsUpdate } from "../shared/import-content";
import type { ProseMirrorJson } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { pageContributorStatements, readPageInfo, versionContributors } from "./page-info";
import { listNotifications, notificationFanoutStatements } from "./notifications";
import { listActivity } from "./activity";

type TestDocument = {
  document: Y.Doc;
  onRequest(request: Request): Promise<Response>;
  compact(forceVersion?: boolean): Promise<void>;
  flushPendingUpdates(): void;
  bindings: Env;
  isReadOnly(connection: {
    state: { userId: string; role: "editor"; expiresAt: number; editorCapabilities?: string[] };
  }): boolean;
};

const member: MemberContext = {
  user: { id: "contributors-a", name: "Alice", email: "alice@example.test" },
  session: { id: "contributors-session", expiresAt: new Date(Date.now() + 100_000) },
  workspace: { id: "contributors-workspace", name: "Contributors", locationHint: null },
  role: "owner",
};

async function fixture(kind: "document" | "diagram" = "document") {
  const pageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('contributors-a','Alice','alice@example.test',1,1),('contributors-b','Bob','bob@example.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('contributors-workspace','Contributors',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('contributors-workspace','contributors-a','owner',1),('contributors-workspace','contributors-b','editor',1)",
    ),
    env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
      VALUES(?,'contributors-workspace','contributors-workspace-general',?,'a0','Contributions','contributors-a',1,1)`).bind(
      pageId,
      kind,
    ),
  ]);
  const stub = env.DOCUMENT.getByName(`${pageId}~1`);
  await stub.fetch(internalRequest("noop"));
  return { pageId, stub };
}

function internalRequest(path: string, body?: unknown) {
  return new Request(`https://document.internal/${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
  });
}

function paragraph(document: Y.Doc, actorId: string, id: string, text: string) {
  document.transact(
    () => {
      const root = document.getXmlFragment("document-store");
      let group = root.get(0) as Y.XmlElement | undefined;
      if (!group) {
        group = new Y.XmlElement("blockGroup");
        root.insert(0, [group]);
      }
      const container = new Y.XmlElement("blockContainer");
      container.setAttribute("id", id);
      const node = new Y.XmlElement("paragraph");
      const content = new Y.XmlText();
      content.insert(0, text);
      node.insert(0, [content]);
      container.insert(0, [node]);
      group.insert(group.length, [container]);
    },
    { state: { userId: actorId } },
  );
}

async function savedAuthors(pageId: string) {
  const versions = await env.DB.prepare("SELECT id FROM page_versions WHERE page_id=? ORDER BY sequence")
    .bind(pageId)
    .all<{ id: string }>();
  const authors = await versionContributors(
    env,
    member,
    pageId,
    versions.results.map((version) => version.id),
  );
  return versions.results.map((version) => (authors.get(version.id) ?? []).map((author) => author.id));
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([env.DB.prepare("DELETE FROM workspaces"), env.DB.prepare("DELETE FROM user")]);
});
afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.batch([env.DB.prepare("DELETE FROM workspaces"), env.DB.prepare("DELETE FROM user")]);
  await reset();
});

describe("durable page contributors", () => {
  it("retains every authenticated author in a merged flush and its saved version", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "contributors-a", "first", "One");
      paragraph(room.document, "contributors-b", "second", "Two");
      room.flushPendingUpdates();
      expect(state.storage.sql.exec("SELECT author_id,author_ids_json FROM update_events").toArray()).toEqual([
        { author_id: "contributors-b", author_ids_json: '["contributors-a","contributors-b"]' },
      ]);
      await room.compact(true);
      expect(state.storage.sql.exec("SELECT * FROM version_authors").toArray()).toEqual([]);
    });
    expect(await savedAuthors(pageId)).toEqual([["contributors-a", "contributors-b"]]);
    const info = await readPageInfo(env, member, pageId);
    expect(info.createdBy).toEqual({ id: "contributors-a", name: "Alice" });
    expect(info.lastEditedBy).toEqual({ id: "contributors-b", name: "Bob" });
    expect(info.contributors.map((author) => author.id).sort()).toEqual(["contributors-a", "contributors-b"]);
    expect(info.wordCount).toBe(2);
    expect(info.contributorHistoryComplete).toBe(false);
    expect(info.contributorAttribution).toBe("authenticated_uploaders");
  });

  it("keeps unsaved version authors through compaction, restart and a failed snapshot write", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "contributors-a", "initial", "Initial");
      await room.compact(true);
      paragraph(room.document, "contributors-a", "interval", "Between versions");
      await room.compact(false);
      expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT user_id FROM version_authors").toArray()).toEqual([
        { user_id: "contributors-a" },
      ]);
    });
    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(`${pageId}~1`);
    await restarted.fetch(internalRequest("noop"));
    await runInDurableObject(restarted, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "contributors-b", "latest", "Latest");
      const bucket = room.bindings.BUCKET;
      room.bindings.BUCKET = new Proxy(bucket, {
        get(target, key) {
          if (key === "put") return () => Promise.reject(new Error("R2 unavailable"));
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(room.compact(true)).rejects.toThrow("R2 unavailable");
        expect(state.storage.sql.exec("SELECT user_id FROM version_authors ORDER BY user_id").toArray()).toEqual([
          { user_id: "contributors-a" },
          { user_id: "contributors-b" },
        ]);
      } finally {
        room.bindings.BUCKET = bucket;
      }
      await room.compact(true);
    });
    expect(await savedAuthors(pageId)).toEqual([["contributors-a"], ["contributors-a", "contributors-b"]]);
  });

  it("guards epoch writes and keeps first and last edit evidence monotonic", async () => {
    const { pageId } = await fixture();
    await env.DB.batch(pageContributorStatements(env.DB, pageId, 2, ["contributors-b"], 100));
    expect((await readPageInfo(env, member, pageId)).contributors).toHaveLength(1);
    for (const timestamp of [100, 50, 75])
      await env.DB.batch(pageContributorStatements(env.DB, pageId, 1, ["contributors-b", "contributors-b"], timestamp));
    expect(
      (await readPageInfo(env, member, pageId)).contributors.find((row) => row.id === "contributors-b"),
    ).toMatchObject({ firstEditedAt: 50, lastEditedAt: 100 });
  });

  it("keeps all observed authors on a pre-restore backup after ordinary compaction", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "contributors-a", "initial", "Initial");
      await room.compact(true);
      paragraph(room.document, "contributors-a", "alice-interval", "Alice interval");
      await room.compact(false);
      paragraph(room.document, "contributors-b", "bob-interval", "Bob interval");
      await room.compact(false);
    });
    const original = await env.DB.prepare("SELECT id FROM page_versions WHERE page_id=? ORDER BY sequence LIMIT 1")
      .bind(pageId)
      .first<{ id: string }>();
    const response = await stub.fetch(
      internalRequest("restore-version", { versionId: original!.id, userId: "contributors-a" }),
    );
    expect(response.status).toBe(200);
    expect(await savedAuthors(pageId)).toEqual([["contributors-a"], ["contributors-a", "contributors-b"]]);
    const backup = await env.DB.prepare(
      "SELECT last_editor_id FROM page_versions WHERE page_id=? ORDER BY sequence DESC LIMIT 1",
    )
      .bind(pageId)
      .first<{ last_editor_id: string }>();
    expect(backup?.last_editor_id).toBe("contributors-b");
    expect((await readPageInfo(env, member, pageId)).lastEditedBy?.id).toBe("contributors-a");
  });

  it("paginates historical identities with bound cursors and denies invisible pages", async () => {
    const { pageId } = await fixture();
    const ids = Array.from({ length: 55 }, (_, index) => `former-${String(index).padStart(2, "0")}`);
    await env.DB.batch(pageContributorStatements(env.DB, pageId, 1, ids, 100));
    const first = await readPageInfo(env, member, pageId);
    expect(first.contributors).toHaveLength(50);
    expect(first.contributors[0]?.name).toBe("Former collaborator");
    const second = await readPageInfo(env, member, pageId, first.nextCursor!);
    expect(second.contributors).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.contributors, ...second.contributors].map((author) => author.id)).size).toBe(56);
    await expect(
      readPageInfo(env, { ...member, user: { ...member.user, id: "contributors-b" } }, pageId, first.nextCursor!),
    ).rejects.toMatchObject({ status: 422 });
    await env.DB.prepare("UPDATE spaces SET visibility='private' WHERE id='contributors-workspace-general'").run();
    await expect(
      readPageInfo(env, { ...member, role: "editor", user: { ...member.user, id: "contributors-b" } }, pageId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(readPageInfo(env, member, pageId, "tampered")).rejects.toMatchObject({ status: 422 });
  });
});

describe("additive contributor event attribution", () => {
  it("derives contributors from compatible payloads, excludes every author and resolves activity names", async () => {
    const { pageId } = await fixture();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('contributors-c','Carol','carol@example.test',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('contributors-workspace','contributors-c','viewer',1)",
      ),
      env.DB.prepare("UPDATE round2_runtime SET activity_enabled=1 WHERE id=1"),
    ]);
    const fanout = {
      workspaceId: member.workspace.id,
      spaceId: "contributors-workspace-general",
      pageId,
      contentEpoch: 1,
      actorId: "contributors-b",
      eventType: "page_edit" as const,
      sourceId: "authors:first",
      threadId: null,
      contributorIds: ["contributors-a"],
      data: { contributorIds: ["contributors-b"] },
      recipientIds: ["contributors-a", "contributors-b", "contributors-c"],
      emitSlackChannel: false,
      createdAt: Date.now(),
    };
    await env.DB.batch(notificationFanoutStatements(env.DB, fanout));
    expect((await env.DB.prepare("SELECT user_id FROM notifications ORDER BY user_id").all()).results).toEqual([
      { user_id: "contributors-c" },
    ]);
    const viewer = {
      ...member,
      user: { id: "contributors-c", name: "Carol", email: "carol@example.test" },
      role: "viewer" as const,
    };
    expect(
      (await listNotifications(env, viewer, { unreadOnly: false, limit: 10, offset: 0 })).notifications[0]?.data
        .contributors,
    ).toEqual([
      { id: "contributors-a", name: "Alice" },
      { id: "contributors-b", name: "Bob" },
    ]);
    const activity = await listActivity({ ...env, WORKSPACE_ACTIVITY_ENABLED: "true" }, member, {});
    expect(activity.items[0]).toMatchObject({
      actorId: "contributors-b",
      actorName: "Bob",
      contributors: [
        { id: "contributors-a", name: "Alice" },
        { id: "contributors-b", name: "Bob" },
      ],
    });
    await env.DB.batch(
      notificationFanoutStatements(env.DB, {
        ...fanout,
        sourceId: "authors:second",
        contributorIds: [],
        data: { contributorIds: ["historical-author"] },
        createdAt: fanout.createdAt + 1,
      }),
    );
    expect(
      (await env.DB.prepare("SELECT id FROM notifications WHERE user_id='contributors-c'").all()).results,
    ).toHaveLength(1);
    const merged = (await listNotifications(env, viewer, { unreadOnly: false, limit: 10, offset: 0 })).notifications[0]!
      .data.contributors as Array<{ id: string; name: string }>;
    expect(merged).toContainEqual({ id: "historical-author", name: "Former collaborator" });
  });

  it("retains contributor evidence in checkpoint-backed personal digest rows", async () => {
    const { pageId } = await fixture();
    await env.DB.prepare(`INSERT INTO page_change_checkpoints(id,page_id,workspace_id,content_epoch,sequence,after_key,actor_id,created_at,contributor_ids_json)
      VALUES('contributor-checkpoint',?,'contributors-workspace',1,1,'stored-after','contributors-b',1,'["contributors-a","contributors-b"]')`)
      .bind(pageId)
      .run();
    await env.DB.prepare(
      "INSERT INTO page_change_recipients(id,checkpoint_id,user_id) VALUES('contributor-recipient','contributor-checkpoint','contributors-a')",
    ).run();
    const row = await env.DB.prepare(
      "SELECT actor_id,data_json FROM digest_notifications WHERE id='contributor-recipient'",
    ).first<{ actor_id: string; data_json: string }>();
    expect(row?.actor_id).toBe("contributors-b");
    expect(JSON.parse(row!.data_json).contributorIds).toEqual(["contributors-a", "contributors-b"]);
  });
});

describe("validated document mutations", () => {
  it("rejects invalid staged initialization without writes and accepts normalized legacy tables on retry", async () => {
    const { pageId, stub } = await fixture();
    const jobId = "validation-import";
    const inputKey = `jobs/${jobId}/input.bin`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO jobs(id,workspace_id,space_id,type,status,requested_by,options_json,created_at,updated_at) VALUES(?,'contributors-workspace','contributors-workspace-general','import','running','contributors-a','{}',1,1)",
      ).bind(jobId),
      env.DB.prepare("UPDATE pages SET import_job_id=? WHERE id=?").bind(jobId, pageId),
    ]);
    await env.BUCKET.put(
      inputKey,
      documentToYjsUpdate({ type: "doc", content: [{ type: "image", attrs: { url: "/api/attachments/malformed" } }] }),
    );
    const invalid = await stub.fetch(internalRequest("initialize", { jobId, inputKey }));
    expect(invalid.status).toBe(422);
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      expect(room.document.getXmlFragment("document-store").length).toBe(0);
      expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM version_authors").toArray()).toEqual([]);
    });
    const legacy: ProseMirrorJson = {
      type: "doc",
      content: [
        {
          type: "blockGroup",
          content: [
            {
              type: "blockContainer",
              attrs: { id: "import-table" },
              content: [
                { type: "table" },
                {
                  type: "blockGroup",
                  content: [
                    {
                      type: "blockContainer",
                      attrs: { id: "import-row" },
                      content: [
                        {
                          type: "tableRow",
                          content: [{ type: "tableHeader", content: [{ type: "text", text: "Imported" }] }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await env.BUCKET.put(inputKey, documentToYjsUpdate(legacy));
    expect((await stub.fetch(internalRequest("initialize", { jobId, inputKey }))).status).toBe(200);
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      const content = yXmlFragmentToProsemirrorJSON(room.document.getXmlFragment("document-store")) as ProseMirrorJson;
      const row = flattenDocumentBlocks(content).find((block) => block.type === "tableRow");
      expect(row?.internalId).toBe("import-row");
      expect(row?.node.content?.[0]?.content?.[0]?.type).toBe("tableParagraph");
    });
  });

  it("preserves existing content and receipts when complete replacement operations are invalid", async () => {
    const { stub } = await fixture();
    const existing = {
      type: "blockContainer",
      attrs: { id: "existing" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this" }] }],
    };
    expect(
      (
        await stub.fetch(
          internalRequest("api-mutate", {
            actorId: member.user.id,
            operationId: "existing-receipt",
            operations: [{ type: "append_children", children: [existing] }],
          }),
        )
      ).status,
    ).toBe(200);
    const bad = { ...existing, attrs: { id: "duplicate" } };
    const result = await stub.fetch(
      internalRequest("api-mutate", {
        actorId: member.user.id,
        operationId: "invalid-replacement",
        operations: [
          { type: "delete_block", internalId: "existing" },
          { type: "append_children", children: [bad, bad] },
        ],
      }),
    );
    expect(result.status).toBe(422);
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      expect(JSON.stringify(yXmlFragmentToProsemirrorJSON(room.document.getXmlFragment("document-store")))).toContain(
        "Keep this",
      );
      expect([...room.document.getMap("api-operation-receipts").keys()]).toEqual(["existing-receipt"]);
      expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toEqual([]);
    });
  });

  it("protects diagram card references from clients without diagram link support", async () => {
    const { stub } = await fixture("diagram");
    const older = { state: { userId: member.user.id, role: "editor" as const, expiresAt: Date.now() + 100_000 } };
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      expect(room.isReadOnly(older)).toBe(false);
      const node = new Y.Map<unknown>();
      diagramRoots(room.document).nodes.set("linked-card", node);
      node.set("linkedPageId", "referenced-page");
      expect(room.isReadOnly(older)).toBe(true);
      expect(room.isReadOnly({ state: { ...older.state, editorCapabilities: ["diagram-links-v1"] } })).toBe(false);
      // Even an invalid stored link is preserved until a capable reader can recover it.
      node.set("linkedPageId", 42);
      expect(room.isReadOnly(older)).toBe(true);
    });
  });

  it("requires newer schema capabilities only when the current document uses them", async () => {
    const { stub } = await fixture();
    const older = { state: { userId: member.user.id, role: "editor" as const, expiresAt: Date.now() + 100_000 } };
    await runInDurableObject(stub, async (instance) =>
      expect((instance as unknown as TestDocument).isReadOnly(older)).toBe(false),
    );
    const table = notionInputToBlockContainer({
      id: "capability-table",
      type: "table",
      table: { table_width: 1, children: [{ type: "table_row", table_row: { cells: [[]] } }] },
    });
    expect(
      (
        await stub.fetch(
          internalRequest("api-mutate", {
            actorId: member.user.id,
            operations: [{ type: "append_children", children: [table] }],
          }),
        )
      ).status,
    ).toBe(200);
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      expect(room.isReadOnly(older)).toBe(true);
      expect(room.isReadOnly({ state: { ...older.state, editorCapabilities: ["native-tables-v1"] } })).toBe(false);
    });
  });

  it("rejects an invalid complete tree without publishing content or an idempotency receipt", async () => {
    const { stub } = await fixture();
    const response = await stub.fetch(
      internalRequest("api-mutate", {
        actorId: member.user.id,
        operationId: "invalid-tree",
        operations: [
          {
            type: "append_children",
            children: [
              { type: "blockContainer", attrs: { id: "duplicate" }, content: [{ type: "paragraph" }] },
              { type: "blockContainer", attrs: { id: "duplicate" }, content: [{ type: "paragraph" }] },
            ],
          },
        ],
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "invalid_document" });
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      expect(room.document.getXmlFragment("document-store").length).toBe(0);
      expect(room.document.getMap("api-operation-receipts").has("invalid-tree")).toBe(false);
      expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toEqual([]);
    });
  });

  it("uses native table structure while keeping virtual row IDs stable through updates and append", async () => {
    const { pageId, stub } = await fixture();
    const richText = (text: string) => [{ type: "text", text: { content: text } }];
    const table = notionInputToBlockContainer({
      id: "native-table",
      type: "table",
      table: {
        table_width: 2,
        has_column_header: true,
        children: [{ type: "table_row", table_row: { cells: [richText("A"), richText("B")] } }],
      },
    });
    expect(
      (
        await stub.fetch(
          internalRequest("api-mutate", {
            actorId: member.user.id,
            operations: [{ type: "append_children", children: [table] }],
          }),
        )
      ).status,
    ).toBe(200);
    const before = await env.DB.prepare(
      "SELECT id,internal_id FROM api_blocks WHERE page_id=? AND internal_id<>'native-table' AND deleted_at IS NULL",
    )
      .bind(pageId)
      .first<{ id: string; internal_id: string }>();
    expect(before).not.toBeNull();
    const row = notionInputToBlockContainer({
      id: before!.internal_id,
      type: "table_row",
      table_row: { cells: [richText("Updated"), richText("B")] },
    });
    const added = notionInputToBlockContainer({
      id: "native-row-added",
      type: "table_row",
      table_row: { cells: [richText("C"), richText("D")] },
    });
    expect(
      (
        await stub.fetch(
          internalRequest("api-mutate", {
            actorId: "contributors-b",
            operations: [
              { type: "update_block", internalId: before!.internal_id, node: row.content![0] },
              { type: "append_children", parentInternalId: "native-table", children: [added] },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      const json = yXmlFragmentToProsemirrorJSON(room.document.getXmlFragment("document-store")) as ProseMirrorJson;
      const rows = flattenDocumentBlocks(json).filter((block) => block.type === "tableRow");
      expect(rows.map((block) => block.internalId)).toEqual([before!.internal_id, "native-row-added"]);
      expect(rows[0]?.node.content?.[0]?.type).toBe("tableHeader");
      expect(rows[0]?.node.content?.[0]?.content?.[0]?.type).toBe("tableParagraph");
    });
    expect(await env.DB.prepare("SELECT id,internal_id FROM api_blocks WHERE id=?").bind(before!.id).first()).toEqual(
      before,
    );
  });

  it("rejects a corrupt saved tree before changing the epoch", async () => {
    const { pageId, stub } = await fixture();
    const corrupt = new Y.Doc();
    const root = new Y.XmlElement("blockGroup");
    root.insert(0, [new Y.XmlElement("unknownBlock")]);
    corrupt.getXmlFragment("document-store").insert(0, [root]);
    const bytes = Y.encodeStateAsUpdate(corrupt);
    corrupt.destroy();
    const key = `tests/invalid-version-${pageId}`;
    await env.BUCKET.put(key, bytes);
    await env.DB.prepare(`INSERT INTO page_versions(id,page_id,epoch,sequence,title,r2_key,byte_size,created_at)
      VALUES('invalid-saved',?,1,1,'Invalid',?,?,1)`)
      .bind(pageId, key, bytes.byteLength)
      .run();
    const response = await stub.fetch(
      internalRequest("restore-version", { versionId: "invalid-saved", userId: member.user.id }),
    );
    expect(response.status).toBe(422);
    expect(await env.DB.prepare("SELECT content_epoch FROM pages WHERE id=?").bind(pageId).first()).toEqual({
      content_epoch: 1,
    });
  });
});
