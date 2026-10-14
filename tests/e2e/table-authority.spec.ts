import { expect, test, type Page } from "@playwright/test";
import { completeEnrollment, signInOwner } from "./security-helpers";

async function migratedTable(page: Page) {
  await signInOwner(page);
  const spaces = await (await page.request.get("/api/spaces")).json();
  const created = await page.request.post("/api/pages", {
    data: { kind: "table", title: `Collaborative ${Date.now()}`, spaceId: spaces.spaces[0].id, parentId: null },
  });
  expect(created.status()).toBe(201);
  const table = (await created.json()).page;
  const enabled = await page.request.post(`/api/tables/${table.id}/authority`);
  expect(enabled.status()).toBe(200);
  const command = async (kind: string, payload: Record<string, unknown>) => {
    const response = await page.request.post(`/api/tables/${table.id}/commands`, {
      data: { operationId: crypto.randomUUID(), kind, payload },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const title = `${table.id}-title`,
    state = `${table.id}-state`,
    amount = `${table.id}-amount`;
  const todo = `${table.id}-todo`,
    done = `${table.id}-done`;
  await command("create_column", { id: title, name: "Title", type: "text" });
  await command("create_column", { id: amount, name: "Amount", type: "number" });
  await command("create_column", { id: state, name: "State", type: "select" });
  await command("add_option", { columnId: state, id: todo, label: "Todo" });
  await command("add_option", { columnId: state, id: done, label: "Done" });
  return { table, title, state, amount, todo, done, command };
}

test("migrated Grid and Board insert the explicit group over saved equality defaults", async ({ page }) => {
  const f = await migratedTable(page);
  const viewId = `${f.table.id}-board`;
  await f.command("save_view", {
    id: viewId,
    name: "Ready board",
    kind: "board",
    columnId: f.state,
    filters: {
      kind: "group",
      operator: "and",
      filters: [{ kind: "condition", columnId: f.state, operator: "eq", value: f.todo }],
    },
  });
  await page.goto(`/?page=${f.table.id}`);
  await expect(page.getByLabel("Saved table view")).toBeVisible();
  await page.getByLabel("Saved table view").selectOption(viewId);
  await page.getByLabel("New row title").fill("Board insertion");
  await page.getByRole("button", { name: "Add in Done", exact: true }).click();
  await expect
    .poll(async () => {
      const query = await (await page.request.get(`/api/tables/${f.table.id}/query`)).json();
      return query.rows.find((row: { cells: Record<string, unknown> }) => row.cells[f.title] === "Board insertion")
        ?.cells[f.state];
    })
    .toBe(f.done);
  const filtered = await (await page.request.get(`/api/tables/${f.table.id}/query?viewId=${viewId}`)).json();
  expect(filtered.rowCount).toBe(0);
  await page.getByLabel("Saved table view").selectOption("");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Board insertion");
  await expect(page.getByLabel("State", { exact: true })).toHaveValue(f.done);
});

test("two browser writers converge on ordered cells and reload canonical data after reconnect", async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const f = await migratedTable(page);
  await f.command("create_row", { values: { [f.title]: "Initial", [f.amount]: 1 } });
  await page.goto(`/?page=${f.table.id}`);
  const baseURL = new URL(page.url()).origin;
  const inviteResponse = await page.request.post("/api/invites", { data: { role: "editor" } });
  expect(inviteResponse.ok()).toBe(true);
  const { invite } = await inviteResponse.json();
  const peerContext = await browser.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const peer = await peerContext.newPage();
  try {
    const signup = await peerContext.request.post("/api/invites/accept", {
      data: {
        token: invite.token,
        name: "Table editor",
        email: `table-${crypto.randomUUID()}@example.test`,
        password: "password123",
      },
    });
    expect(signup.ok()).toBe(true);
    await peer.goto("/");
    await completeEnrollment(peer);
    await expect(peer.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    const owner = await (await page.request.get("/api/me")).json();
    const editorResponse = await peer.request.get("/api/me");
    expect(editorResponse.status()).toBe(200);
    const editor = await editorResponse.json();
    expect(editor.role).toBe("editor");
    expect(editor.user.id).not.toBe(owner.user.id);
    await peer.goto(`/?page=${f.table.id}`);
    await expect(peer.getByLabel("Title", { exact: true })).toHaveValue("Initial");
    const title = page.getByLabel("Title", { exact: true });
    await title.fill("First writer");
    await title.press("Tab");
    await expect(peer.getByLabel("Title", { exact: true })).toHaveValue("First writer");
    const amount = peer.getByLabel("Amount", { exact: true });
    await amount.fill("42");
    await amount.press("Tab");
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("42");
    await peer.getByLabel("Title", { exact: true }).fill("Second writer");
    await peer.getByLabel("Title", { exact: true }).press("Tab");
    await expect(title).toHaveValue("Second writer");
    await peerContext.setOffline(true);
    await title.fill("During reconnect");
    await title.press("Tab");
    await expect
      .poll(
        async () => (await (await page.request.get(`/api/tables/${f.table.id}/query`)).json()).rows[0].cells[f.title],
      )
      .toBe("During reconnect");
    await peerContext.setOffline(false);
    await expect(peer.getByLabel("Title", { exact: true })).toHaveValue("During reconnect", { timeout: 25000 });
    const query = await (await page.request.get(`/api/tables/${f.table.id}/query`)).json();
    expect(query.rows[0].cells[f.amount]).toBe(42);
    expect(query.projectedRevision).toBe(query.revision);
  } finally {
    await peerContext.close();
  }
});

test("reverted property drafts follow server updates while different formula edits retain conflicts", async ({
  page,
}) => {
  const f = await migratedTable(page);
  const formulaId = `${f.table.id}-formula`;
  await f.command("create_column", { id: formulaId, name: "Twice", type: "formula", source: "2" });
  const changeProperty = async (columnId: string, payload: Record<string, unknown>) => {
    const query = await (await page.request.get(`/api/tables/${f.table.id}/query`)).json();
    const column = query.columns.find((item: { id: string }) => item.id === columnId);
    await f.command("update_column", { columnId, revision: column.revision, ...payload });
  };
  await page.goto(`/?page=${f.table.id}`);
  await page.getByRole("button", { name: "Properties", exact: true }).click();

  const name = page.getByLabel("Name for Title", { exact: true });
  await name.fill("Temporary name");
  await name.fill("Title");
  await name.press("Tab");
  await changeProperty(f.title, { name: "Remote title" });
  await expect(page.getByLabel("Name for Remote title", { exact: true })).toHaveValue("Remote title");
  await expect(page.getByRole("button", { name: "Reload latest settings", exact: true })).toHaveCount(0);

  const source = page.getByLabel("Formula for Twice", { exact: true });
  await expect(source).toHaveValue("2");
  await source.fill("3");
  await source.fill("2");
  await changeProperty(formulaId, { source: "4" });
  await expect(source).toHaveValue("4");
  await expect(page.getByRole("button", { name: "Reload latest settings", exact: true })).toHaveCount(0);

  await source.fill("5");
  await changeProperty(formulaId, { source: "6" });
  await expect(page.getByRole("button", { name: "Reload latest settings", exact: true })).toBeVisible();
  await expect(source).toHaveValue("5");
  await page.getByRole("button", { name: "Update formula", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload latest settings", exact: true })).toBeVisible();
  const query = await (await page.request.get(`/api/tables/${f.table.id}/query`)).json();
  expect(query.columns.find((column: { id: string }) => column.id === formulaId).config.source).toBe("6");
  await page.getByRole("button", { name: "Reload latest settings", exact: true }).click();
  await expect(source).toHaveValue("6");
});
