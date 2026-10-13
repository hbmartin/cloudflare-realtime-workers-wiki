import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { diagramFromYDoc, diagramNodeMap, diagramRoots } from "../shared/diagram";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import type { Env, MemberContext } from "./env";
import { checkWorkspaceIntegrity } from "./integrity";

const member: MemberContext = {
  user: { id: "integrity-owner", name: "Owner", email: "integrity@example.test" },
  session: { id: "integrity-session", expiresAt: new Date(Date.now() + 100_000) },
  workspace: { id: "integrity-workspace", name: "Integrity", locationHint: null },
  role: "owner",
};

async function fixture() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('integrity-owner','Owner','integrity@example.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('integrity-workspace','Integrity',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('integrity-workspace','integrity-owner','owner',1)",
    ),
  ]);
  for (const id of ["integrity-a", "integrity-b", "integrity-c"])
    await env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
      VALUES(?,'integrity-workspace','integrity-workspace-general','document','a0','Integrity','integrity-owner',1,1)`)
      .bind(id)
      .run();
}

function mutation(children: unknown[]) {
  return new Request("https://document.internal/api-mutate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
    body: JSON.stringify({ actorId: member.user.id, operations: [{ type: "append_children", children }] }),
  });
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

describe("read-only owner integrity inspection", () => {
  it("validates legacy table values, property names, options and cross-table cells", async () => {
    await fixture();
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET kind='table' WHERE id IN ('integrity-a','integrity-b')"),
      env.DB.prepare("INSERT INTO table_state(page_id,revision) VALUES('integrity-a',1),('integrity-b',1)"),
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('text-a','integrity-a','Name','text',0),('number-a','integrity-a','Amount','number',1),('select-a','integrity-a','Status','select',2)",
      ),
      env.DB.prepare(
        "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) VALUES('row-a','integrity-a',0,'integrity-owner',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO table_select_options(id,column_id,label,position) VALUES('option-a','select-a','Ready',0)",
      ),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,text_value,updated_at) VALUES('row-a','text-a','Text',1)",
      ),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,number_value,updated_at) VALUES('row-a','number-a',2,1)",
      ),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,select_value,updated_at) VALUES('row-a','select-a','option-a',1)",
      ),
    ]);
    expect(await checkWorkspaceIntegrity(env, member, { mode: "content" })).toMatchObject({ ok: true, complete: true });
    await env.DB.batch([
      env.DB.prepare("UPDATE table_columns SET name=' name ' WHERE id='number-a'"),
      env.DB.prepare("UPDATE table_cells SET json_value='\"invalid\"' WHERE column_id='number-a'"),
      env.DB.prepare("UPDATE table_columns SET page_id='integrity-b' WHERE id='text-a'"),
      env.DB.prepare(
        "INSERT INTO table_select_options(id,column_id,label,position) VALUES('option-duplicate','select-a','Ready',1)",
      ),
    ]);
    const result = await checkWorkspaceIntegrity(env, member, { mode: "content" });
    expect(result.ok).toBe(false);
    expect(result.failures.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["invalid_table_option", "invalid_table_cell_value", "table_cell_scope"]),
    );
    // Add an actual normalized collision after moving the original property away.
    await env.DB.prepare(
      "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('collision','integrity-a','ＮＡＭＥ','text',3)",
    ).run();
    expect((await checkWorkspaceIntegrity(env, member, { mode: "content" })).failures).toContainEqual({
      code: "duplicate_table_property_name",
      pageId: "integrity-a",
      detail: "number-a",
    });
  });

  it("cannot pass a table authority transition, stale projection or bounded content truncation", async () => {
    await fixture();
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET kind='table' WHERE id='integrity-a'"),
      env.DB.prepare("INSERT INTO table_state(page_id,revision) VALUES('integrity-a',2)"),
      env.DB.prepare(
        "INSERT INTO table_authority(page_id,state,generation,seed_revision,projected_revision) VALUES('integrity-a','seeding',1,1,1)",
      ),
    ]);
    expect((await checkWorkspaceIntegrity(env, member, { mode: "content" })).incomplete).toContainEqual({
      code: "table_authority_transition",
      pageId: "integrity-a",
    });
    await env.DB.prepare("UPDATE table_authority SET state='do' WHERE page_id='integrity-a'").run();
    expect((await checkWorkspaceIntegrity(env, member, { mode: "content" })).incomplete).toContainEqual({
      code: "table_projection_revision_changed",
      pageId: "integrity-a",
    });
    await env.DB.prepare("UPDATE table_authority SET state='d1' WHERE page_id='integrity-a'").run();
    await env.DB.prepare(
      "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<201) INSERT INTO table_columns(id,page_id,name,type,position) SELECT 'column-'||v,'integrity-a','Property '||v,'text',v FROM n",
    ).run();
    expect(await checkWorkspaceIntegrity(env, member, { mode: "content" })).toMatchObject({
      ok: false,
      complete: false,
      incomplete: [{ code: "table_content_limit", pageId: "integrity-a" }],
    });
  });

  it("compares stored diagram snapshots and checks page and saved-view references", async () => {
    await fixture();
    await env.DB.prepare("UPDATE pages SET kind='diagram',indexed_seq=1 WHERE id='integrity-a'").run();
    const document = new Y.Doc();
    diagramRoots(document).nodes.set(
      "card",
      diagramNodeMap({
        id: "card",
        type: "process",
        x: 0,
        y: 0,
        width: 160,
        height: 80,
        zIndex: 0,
        parentId: null,
        label: "Card",
        notes: "",
        color: "slate",
        assetId: null,
        references: [],
        mentions: [],
        linkedPageId: "missing-page",
        linkedViewId: "missing-view",
      }),
    );
    const projection = diagramFromYDoc(document, { pageId: "integrity-a", contentEpoch: 1, sequence: 1 });
    const bytes = new TextEncoder().encode(canonicalJson(projection));
    await env.BUCKET.put("diagrams/integrity-a/epochs/1/current.bin", Y.encodeStateAsUpdate(document), {
      customMetadata: { sequence: "1" },
    });
    await env.BUCKET.put("diagram-projection", bytes);
    await env.DB.prepare(
      "INSERT INTO diagram_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,thumbnail_r2_key,thumbnail_hash,thumbnail_byte_size,updated_at) VALUES('integrity-a',1,1,1,'diagram-projection',?,?,'thumbnail','hash',1,1)",
    )
      .bind(await sha256Hex(bytes), bytes.length)
      .run();
    const result = await checkWorkspaceIntegrity(env, member, { mode: "content" });
    expect(result.failures).toEqual(
      expect.arrayContaining([
        { code: "missing_canonical_reference", pageId: "integrity-a", detail: "missing-page" },
        { code: "invalid_diagram_view_reference", pageId: "integrity-a", detail: "card" },
      ]),
    );
    document.getMap("diagram:nodes").clear();
    await env.BUCKET.put("diagrams/integrity-a/epochs/1/current.bin", Y.encodeStateAsUpdate(document), {
      customMetadata: { sequence: "1" },
    });
    expect((await checkWorkspaceIntegrity(env, member, { mode: "content" })).failures).toContainEqual({
      code: "snapshot_projection_mismatch",
      pageId: "integrity-a",
    });
    document.destroy();
  });

  it("requires ownership, bounds pagination and binds cursors to the inspection mode", async () => {
    await fixture();
    await expect(checkWorkspaceIntegrity(env, { ...member, role: "editor" })).rejects.toMatchObject({ status: 403 });
    const first = await checkWorkspaceIntegrity(env, member, { limit: 1 });
    expect(first).toMatchObject({
      checkedPages: 1,
      complete: false,
      ok: false,
      totalPages: 3,
      failures: [],
      incomplete: [],
    });
    expect(first.nextCursor).toBeTruthy();
    const second = await checkWorkspaceIntegrity(env, member, { limit: 1, cursor: first.nextCursor! });
    const final = await checkWorkspaceIntegrity(env, member, { limit: 1, cursor: second.nextCursor! });
    expect(final).toMatchObject({ complete: true, ok: true, nextCursor: null });
    await expect(
      checkWorkspaceIntegrity(env, member, { mode: "content", cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(checkWorkspaceIntegrity(env, member, { mode: "content", limit: 6 })).rejects.toMatchObject({
      status: 422,
    });
  });

  it("cannot pass after metadata changes during a cursor scan", async () => {
    await fixture();
    const first = await checkWorkspaceIntegrity(env, member, { limit: 2 });
    await env.DB.prepare("UPDATE pages SET revision=revision+1 WHERE id='integrity-a'").run();
    expect(await checkWorkspaceIntegrity(env, member, { limit: 2, cursor: first.nextCursor! })).toMatchObject({
      complete: false,
      ok: false,
      incomplete: [{ code: "workspace_revision_changed" }],
    });
  });

  it("detects ancestor cycles and includes archived and template roots", async () => {
    await fixture();
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET parent_id='integrity-b' WHERE id='integrity-a'"),
      env.DB.prepare("UPDATE pages SET parent_id='integrity-a' WHERE id='integrity-b'"),
      env.DB.prepare("UPDATE pages SET is_template=1 WHERE id='integrity-c'"),
    ]);
    const result = await checkWorkspaceIntegrity(env, member);
    expect(result.ok).toBe(false);
    expect(result.failures.map((finding) => finding.code)).toEqual(["ancestor_cycle", "ancestor_cycle"]);
    expect(result.classifications.template).toBe(1);
  });

  it("checks canonical snapshots and references without flushing pending room edits", async () => {
    await fixture();
    const stub = env.DOCUMENT.getByName("integrity-a~1");
    expect(
      (
        await stub.fetch(
          mutation([
            {
              type: "blockContainer",
              attrs: { id: "canonical" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Committed" }] }],
            },
          ]),
        )
      ).status,
    ).toBe(200);
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as { document: Y.Doc; bindings: Env };
      const group = room.document.getXmlFragment("document-store").get(0) as Y.XmlElement;
      const block = new Y.XmlElement("blockContainer");
      block.setAttribute("id", "pending");
      block.insert(0, [new Y.XmlElement("paragraph")]);
      group.insert(group.length, [block]);
      const before = state.storage.sql.exec("SELECT * FROM update_events").toArray();
      expect(await checkWorkspaceIntegrity(env, member, { mode: "content" })).toMatchObject({
        scope: "stored_canonical_content",
        ok: true,
        complete: true,
      });
      expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toEqual(before);
    });
    expect(
      (
        await stub.fetch(
          mutation([
            {
              type: "blockContainer",
              attrs: { id: "bad-reference" },
              content: [{ type: "linkToPage", attrs: { pageId: "missing-target" } }],
            },
          ]),
        )
      ).status,
    ).toBe(200);
    const result = await checkWorkspaceIntegrity(env, member, { mode: "content" });
    expect(result.failures).toContainEqual({
      code: "missing_canonical_reference",
      pageId: "integrity-a",
      detail: "missing-target",
    });
  });

  it("rejects missing projection objects and attachment artifacts", async () => {
    await fixture();
    const stub = env.DOCUMENT.getByName("integrity-a~1");
    expect(
      (
        await stub.fetch(
          mutation([{ type: "blockContainer", attrs: { id: "block" }, content: [{ type: "paragraph" }] }]),
        )
      ).status,
    ).toBe(200);
    const projection = await env.DB.prepare(
      "SELECT r2_key FROM document_projections WHERE page_id='integrity-a'",
    ).first<{ r2_key: string }>();
    await env.BUCKET.delete(projection!.r2_key);
    await env.DB.prepare(`INSERT INTO attachments(id,workspace_id,page_id,r2_key,name,mime,size,created_by,created_at)
      VALUES('missing-file','integrity-workspace','integrity-a','missing-file','Missing','text/plain',1,'integrity-owner',1)`).run();
    const result = await checkWorkspaceIntegrity(env, member, { mode: "content" });
    expect(result.ok).toBe(false);
    expect(result.failures.map((finding) => finding.code)).toEqual([
      "missing_projection_object",
      "missing_attachment_object",
    ]);
  });
});
