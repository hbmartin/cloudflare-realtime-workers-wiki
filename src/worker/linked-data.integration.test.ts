import { applyD1Migrations, createExecutionContext, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enrollAccount } from "../../tests/helpers/security";
import type { Page, Space } from "../shared/types";
import type { TableQueryResult } from "../shared/table-protocol";
import worker from "./index";
import type { Env } from "./env";

function request(cookie: string, path: string, body?: unknown) {
  return new Request(`http://example.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function fixture() {
  const installed = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Linked data",
      name: "Owner",
      email: "linked-owner@example.test",
      password: "password123",
    }),
  });
  expect(installed.status).toBe(200);
  const owner = await enrollAccount(installed);
  const me = await (
    await SELF.fetch(request(owner, "/api/me"))
  ).json<{ user: { id: string }; workspace: { id: string } }>();
  const spaces = await (await SELF.fetch(request(owner, "/api/spaces"))).json<{ spaces: Space[] }>();
  const privateSpace = await (
    await SELF.fetch(request(owner, "/api/spaces", { name: "Private source", visibility: "private" }))
  ).json<{ space: Space }>();
  const page = async (title: string, spaceId: string, kind: string) => {
    const response = await SELF.fetch(request(owner, "/api/pages", { title, spaceId, kind, parentId: null }));
    expect(response.status).toBe(201);
    return (await response.json<{ page: Page }>()).page;
  };
  const host = await page("Public host", spaces.spaces[0]!.id, "document");
  const source = await page("Secret source", privateSpace.space.id, "table");
  const migrated = await SELF.fetch(request(owner, `/api/tables/${source.id}/authority`, {}));
  expect(migrated.status).toBe(200);
  const command = async (kind: string, payload: unknown) =>
    SELF.fetch(
      request(owner, `/api/tables/${source.id}/commands`, { operationId: crypto.randomUUID(), kind, payload }),
    );
  expect((await command("create_column", { id: "amount", name: "Amount", type: "number" })).status).toBe(200);
  expect(
    (
      await command("save_view", {
        id: "shared-grid",
        name: "Shared grid",
        kind: "grid",
        ownerId: null,
        columnId: null,
        filters: null,
        sorts: [],
        visibleColumnIds: ["amount"],
      })
    ).status,
  ).toBe(200);
  const invite = await (
    await SELF.fetch(request(owner, "/api/invites", { role: "editor" }))
  ).json<{ invite: { token: string } }>();
  const accepted = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      token: invite.invite.token,
      name: "Editor",
      email: "linked-editor@example.test",
      password: "password123",
    }),
  });
  expect(accepted.status).toBe(200);
  const editor = await enrollAccount(accepted, invite.invite.token);
  const editorMe = await (await SELF.fetch(request(editor, "/api/me"))).json<{ user: { id: string } }>();
  return {
    owner,
    editor,
    editorId: editorMe.user.id,
    workspaceId: me.workspace.id,
    privateSpaceId: privateSpace.space.id,
    host,
    source,
  };
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("linked data authorization", () => {
  it.each(["archive", "private", "viewer"] as const)(
    "rechecks host %s changes at the source command boundary",
    async (change) => {
      const f = await fixture();
      await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES(?,?,'editor',?)")
        .bind(f.privateSpaceId, f.editorId, Date.now())
        .run();
      const privateHost =
        change === "private"
          ? await (
              await SELF.fetch(
                request(f.owner, "/api/spaces", {
                  name: "Revoked host",
                  visibility: "private",
                }),
              )
            ).json<{ space: Space }>()
          : null;
      const bindings = {
        ...env,
        TABLE: {
          getByName(pageId: string) {
            const room = env.TABLE.getByName(pageId);
            return {
              async fetch(input: Request) {
                if (change === "archive")
                  await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(f.host.id).run();
                else if (change === "private")
                  await env.DB.prepare("UPDATE pages SET space_id=? WHERE id=?")
                    .bind(privateHost!.space.id, f.host.id)
                    .run();
                else
                  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND user_id=?")
                    .bind(f.workspaceId, f.editorId)
                    .run();
                return room.fetch(input);
              },
            };
          },
        } as unknown as Env["TABLE"],
      };
      const response = await worker.fetch(
        request(f.editor, `/api/pages/${f.host.id}/linked-tables/${f.source.id}/commands`, {
          operationId: `concurrent-${change}`,
          kind: "create_row",
          payload: { values: { amount: 12 } },
        }),
        bindings,
        createExecutionContext(),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "table_forbidden" } });
      const current = await (
        await SELF.fetch(request(f.owner, `/api/tables/${f.source.id}/query`))
      ).json<TableQueryResult>();
      expect(current.rowCount).toBe(0);
    },
  );
  it("checks host and source independently on reads, cards and edits, including permission loss", async () => {
    const f = await fixture();
    const linked = `/api/pages/${f.host.id}/linked-tables/${f.source.id}`;
    const card = `/api/pages/${f.source.id}/card-preview?viewId=shared-grid`;
    const command = { operationId: "linked-write", kind: "create_row", payload: { values: { amount: 12 } } };
    const denied = await SELF.fetch(request(f.editor, `${linked}?viewId=shared-grid`));
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("Secret source");
    expect((await SELF.fetch(request(f.editor, card))).status).toBe(404);
    expect((await SELF.fetch(request(f.editor, `${linked}/commands`, command))).status).toBe(404);
    await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES(?,?,'viewer',?)")
      .bind(f.privateSpaceId, f.editorId, Date.now())
      .run();
    expect((await SELF.fetch(request(f.editor, `${linked}?viewId=shared-grid`))).status).toBe(200);
    expect((await SELF.fetch(request(f.editor, card))).status).toBe(200);
    expect((await SELF.fetch(request(f.editor, `${linked}/commands`, command))).status).toBe(403);
    await env.DB.prepare("UPDATE space_members SET role='editor' WHERE space_id=? AND user_id=?")
      .bind(f.privateSpaceId, f.editorId)
      .run();
    expect((await SELF.fetch(request(f.editor, `${linked}/commands`, command))).status).toBe(200);
    const current = await (
      await SELF.fetch(request(f.owner, `/api/tables/${f.source.id}/query?viewId=shared-grid`))
    ).json<TableQueryResult>();
    expect(current.rowCount).toBe(1);
    const privateHost = await (
      await SELF.fetch(request(f.owner, "/api/spaces", { name: "Private host", visibility: "private" }))
    ).json<{ space: Space }>();
    await env.DB.prepare("UPDATE pages SET space_id=? WHERE id=?").bind(privateHost.space.id, f.host.id).run();
    expect((await SELF.fetch(request(f.editor, linked))).status).toBe(404);
    expect(
      (await SELF.fetch(request(f.editor, `${linked}/commands`, { ...command, operationId: "after-host-revocation" })))
        .status,
    ).toBe(404);
    expect((await SELF.fetch(request(f.editor, card))).status).toBe(200);
    expect((await SELF.fetch(request(f.owner, `/api/pages/${f.host.id}/card-preview?viewId=shared-grid`))).status).toBe(
      422,
    );
  });
  it("shows only saved-view visible properties in their saved order", async () => {
    const f = await fixture();
    const command = async (kind: string, payload: unknown) =>
      SELF.fetch(
        request(f.owner, `/api/tables/${f.source.id}/commands`, { operationId: crypto.randomUUID(), kind, payload }),
      );
    expect((await command("create_column", { id: "hidden", name: "Hidden property", type: "text" })).status).toBe(200);
    expect((await command("create_column", { id: "shown", name: "Shown property", type: "text" })).status).toBe(200);
    expect(
      (
        await command("save_view", {
          id: "ordered",
          name: "Ordered",
          kind: "grid",
          ownerId: null,
          columnId: null,
          filters: null,
          sorts: [],
          visibleColumnIds: ["shown", "amount"],
        })
      ).status,
    ).toBe(200);
    expect(
      (await command("create_row", { values: { amount: 12, hidden: "Private display", shown: "Visible value" } }))
        .status,
    ).toBe(200);
    const response = await SELF.fetch(request(f.owner, `/api/pages/${f.source.id}/card-preview?viewId=ordered`));
    expect(response.status).toBe(200);
    const card = await response.json<{
      table: { columns: Array<{ id: string }>; rows: Array<{ cells: Record<string, unknown> }> };
    }>();
    expect(card.table.columns.map((column) => column.id)).toEqual(["shown", "amount"]);
    expect(card.table.rows[0]?.cells).toEqual({ shown: "Visible value", amount: 12 });
    expect(JSON.stringify(card)).not.toContain("Private display");
  });
  it("disabling migration preserves existing authoritative readers", async () => {
    const f = await fixture();
    const bindings = { ...env, TABLE_AUTHORITY_ENABLED: "false" as const };
    const disabled = await worker.fetch(
      request(f.owner, `/api/tables/${f.source.id}/authority`, {}),
      bindings,
      createExecutionContext(),
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: { code: "table_cutover_disabled" } });
    const read = await worker.fetch(
      request(f.owner, `/api/tables/${f.source.id}/query?viewId=shared-grid`),
      bindings,
      createExecutionContext(),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ pageId: f.source.id, rowCount: 0 });
  });
});
