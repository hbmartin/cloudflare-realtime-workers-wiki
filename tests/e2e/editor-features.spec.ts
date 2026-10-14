import { test, expect, type Page } from "@playwright/test";
import { signInOwner } from "./security-helpers";

test.setTimeout(60000);
test.use({ serviceWorkers: "block" });
async function documentPage(page: Page, title: string) {
  const result = await page.request.post("/api/pages", { data: { kind: "document", title: `${title} ${Date.now()}` } });
  expect(result.ok()).toBeTruthy();
  const { page: created } = await result.json();
  await page.goto(`/?page=${created.id}`);
  await expect(page.locator(".bn-editor")).toBeVisible();
  return created;
}
async function features(page: Page) {
  await page.context().route("**/api/me", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, features: { ...data.features, editorBlocksV2: true } } });
  });
}

test("migrated code text converges through real disconnected editor bindings without duplicating tails", async ({
  page,
}) => {
  await signInOwner(page);
  const results = await page.evaluate(async () => {
    const path = "/tests/e2e/fixtures/editor-code-reconciliation.mjs";
    const { reconcileCodeReplicas } = await import(path);
    return reconcileCodeReplicas();
  });
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.disconnected).toEqual(["left\nright A", "left\nright B"]);
    expect(result.merged[0]).toBe(result.merged[1]);
    expect(result.merged[0]).toMatch(/^left\nright (?:A B|B A)$/);
    expect(result.identitiesRetained).toBe(true);
    expect(result.anchorsRetained).toBe(true);
    expect(result.annotationsRetained, JSON.stringify(result.annotationDeltas)).toBe(true);
    expect(result.annotationAliasesRetained, JSON.stringify(result.annotationDeltas)).toBe(true);
    expect(result.undone).toEqual(["left\nright B", "left\nright B"]);
    expect(result.redone).toEqual(result.merged);
  }
});

test("unsupported initial and received code embeds preserve shared bytes and block editor writes", async ({ page }) => {
  await signInOwner(page);
  const results = await page.evaluate(async () => {
    const path = "/tests/e2e/fixtures/editor-code-reconciliation.mjs";
    const { rejectUnsupportedCode } = await import(path);
    return rejectUnsupportedCode();
  });
  expect(results).toEqual([
    { received: false, controlledError: true, bytesRetained: true, identityRetained: true },
    {
      received: true,
      controlledError: true,
      bytesRetained: true,
      writesBlocked: true,
      identityRetained: true,
      anchorRetained: true,
      repaired: true,
    },
  ]);
});

test("ordinary edits inspect only changed code scopes and structural changes retain full validation", async ({
  page,
}) => {
  await signInOwner(page);
  const result = await page.evaluate(async () => {
    const path = "/tests/e2e/fixtures/editor-code-reconciliation.mjs";
    const { inspectChangedCodeScopes } = await import(path);
    return inspectChangedCodeScopes();
  });
  expect(result.unrelated).toEqual([0, 0]);
  expect(result.affected).toBeGreaterThan(0);
  expect(result.untouched).toBe(0);
  expect(result.structural).toEqual([1, 1]);
  expect(result.forced).toEqual([2, 2]);
  expect(result.listenerRemoved).toBe(true);
});

test("HTML code imports preserve whitespace and reopen with plain text line breaks", async ({ page }) => {
  await signInOwner(page);
  const toggle = page.getByRole("button", { name: "Open navigation" });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("button", { name: "Import notes", exact: true }).click();
  const title = `code-import-${Date.now()}`;
  const dialog = page.getByRole("dialog", { name: "Import notes" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: `${title}.html`,
    mimeType: "text/html",
    buffer: Buffer.from(
      '<pre><code>\n  <strong>first</strong><br><a href="https://example.test">second</a>\n\tend</code></pre>',
    ),
  });
  await dialog.getByRole("button", { name: "Upload and inspect" }).click();
  const job = page.getByRole("dialog", { name: "Imports & exports" }).locator(".activity-list > li").first();
  await expect(job.locator(".job-status")).toHaveText("awaiting confirmation", { timeout: 30_000 });
  await job.getByRole("button", { name: "Confirm import" }).click();
  await expect(job.locator(".job-status")).toHaveText("succeeded", { timeout: 30_000 });
  await job.getByRole("button", { name: "Open page" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
  const code = page.locator('.bn-editor [data-content-type="codeBlock"] code');
  await expect(code).toBeVisible();
  expect(await code.textContent()).toBe("\n  first\nsecond\n\tend");
  await expect(code.locator("strong,em,a")).toHaveCount(0);
  await page.reload();
  await expect(code).toBeVisible();
  expect(await code.textContent()).toBe("\n  first\nsecond\n\tend");
});

test("native API tables reopen and collaborative editing preserves stable row identities", async ({
  page,
  context,
}) => {
  await signInOwner(page);
  const created = await documentPage(page, "Native API table");
  const tokenResponse = await page.request.post("/api/integrations", { data: { name: `Table browser ${Date.now()}` } });
  expect(tokenResponse.ok()).toBeTruthy();
  const { integration, token } = await tokenResponse.json();
  expect(
    (
      await page.request.patch(`/api/integrations/${integration.id}`, {
        data: { readContent: true, insertContent: true, updateContent: true },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.put(`/api/integrations/${integration.id}/grants`, { data: { rootPageIds: [created.id] } })
    ).ok(),
  ).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": "2026-03-11" };
  const rich = (text: string) => [{ type: "text", text: { content: text } }];
  const appended = await page.request.patch(`/v1/blocks/${created.id}/children`, {
    headers,
    data: {
      children: [
        {
          object: "block",
          type: "table",
          table: {
            table_width: 2,
            has_column_header: true,
            children: [
              { object: "block", type: "table_row", table_row: { cells: [rich("Heading A"), rich("Heading B")] } },
              { object: "block", type: "table_row", table_row: { cells: [rich("Cell A"), rich("Cell B")] } },
            ],
          },
        },
      ],
    },
  });
  expect(appended.ok(), await appended.text()).toBeTruthy();
  const tableId = (await appended.json()).results[0].id;
  const rows = await (await page.request.get(`/v1/blocks/${tableId}/children`, { headers })).json();
  await page.reload();
  await expect(page.locator(".bn-editor table")).toBeVisible();
  await expect(page.locator(".bn-editor table")).toContainText("Cell A");
  const other = await context.newPage();
  await other.goto(`/?page=${created.id}`);
  await expect(other.locator(".bn-editor table")).toContainText("Cell A");
  await page.locator(".bn-editor table td").last().hover();
  await page.locator(".bn-extend-button-add-remove-rows").click();
  await expect(page.locator(".bn-editor table tr")).toHaveCount(3);
  await expect(other.locator(".bn-editor table tr")).toHaveCount(3);
  await expect
    .poll(async () => {
      const response = await page.request.get(`/v1/blocks/${tableId}/children`, { headers });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).results.length;
    })
    .toBe(3);
  const extended = await (await page.request.get(`/v1/blocks/${tableId}/children`, { headers })).json();
  expect(extended.results.slice(0, 2).map((row: { id: string }) => row.id)).toEqual(
    rows.results.map((row: { id: string }) => row.id),
  );
  expect(new Set(extended.results.map((row: { id: string }) => row.id)).size).toBe(3);
  for (const row of rows.results as Array<{ id: string }>) {
    const response = await page.request.get(`/v1/blocks/${row.id}`, { headers });
    expect(response.ok(), `Original native row ${row.id} remains addressable after row extension`).toBeTruthy();
    expect((await response.json()).id).toBe(row.id);
  }
  const cell = page.locator(".bn-editor table td").filter({ hasText: "Cell A" }).first();
  await cell.click();
  await cell.evaluate(async (element) => {
    const inline = element.querySelector(".bn-inline-content") ?? element;
    (element.closest("[contenteditable=true]") as HTMLElement)?.focus();
    const range = document.createRange();
    range.selectNodeContents(inline);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    // Let the native selectionchange update ProseMirror before typing. Home
    // scrolls rather than collapsing selected table text on some platforms.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.keyboard.insertText("Edited ");
  await expect(other.locator(".bn-editor table")).toContainText(/Edited .*Cell A/);
  const after = await (await page.request.get(`/v1/blocks/${tableId}/children`, { headers })).json();
  expect(after.results.map((row: { id: string }) => row.id)).toEqual(
    extended.results.map((row: { id: string }) => row.id),
  );
  await page.reload();
  await expect(page.locator(".bn-editor table")).toContainText(/Edited .*Cell A/);
  await other.close();
});

test("find replacement reveals hidden tabs, supports undo and converges remotely", async ({ page, context }) => {
  await features(page);
  await signInOwner(page);
  const created = await documentPage(page, "Tabbed search");
  const editor = page.locator(".bn-editor");
  await editor.click();
  await page.keyboard.type("/tabs", { delay: 80 });
  await page.getByText("Tabs", { exact: true }).last().click();
  await expect(page.getByRole("tab", { name: "Tab 1", exact: true })).toBeVisible();
  const panelParagraph = () =>
    editor
      .locator('[data-content-type="tabPanel"]')
      .locator('xpath=ancestor::*[@data-node-type="blockContainer"][1]')
      .locator('[data-content-type="paragraph"]:visible')
      .first();
  const empty = panelParagraph();
  await empty.click();
  await empty.evaluate(async (element) => {
    const content = element.querySelector("p") ?? element;
    (element.closest("[contenteditable=true]") as HTMLElement)?.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.keyboard.type("/tabs", { delay: 80 });
  await expect(page.getByText("Tabs", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (let index = 0; index < 5; index++) await page.keyboard.press("Backspace");
  await page.keyboard.insertText("Alpha needle");
  await page.getByRole("tab", { name: "Tab 2", exact: true }).click();
  await panelParagraph().click();
  await panelParagraph().evaluate(async (element) => {
    const range = document.createRange();
    range.selectNodeContents(element.querySelector("p") ?? element);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.keyboard.insertText("Beta needle");
  await page.getByRole("tab", { name: "Tab 1", exact: true }).click();
  const other = await context.newPage();
  await other.goto(`/?page=${created.id}`);
  await expect(other.locator(".bn-editor")).toContainText("Beta needle");
  await page.getByRole("button", { name: "Find and replace", exact: true }).click();
  await page.getByLabel("Find text", { exact: true }).fill("needle");
  await expect(page.getByRole("search")).toContainText("1 of 2");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.getByRole("tab", { name: "Tab 2", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Replace with").fill("replaced");
  await page.getByRole("button", { name: "Replace all", exact: true }).click();
  await expect(other.locator(".bn-editor")).toContainText("Beta replaced");
  await page.getByRole("button", { name: "Close find" }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(other.locator(".bn-editor")).toContainText("Beta needle");
  await expect(page.locator(".notes-search-result")).toHaveCount(0);
  await page.getByRole("button", { name: "Present page" }).click();
  const presentation = page.getByRole("dialog", { name: "Presentation mode" });
  await expect(presentation).toBeVisible();
  await expect(presentation).toContainText("Slide 1 of");
  await presentation.getByRole("button", { name: "Next slide" }).click();
  await expect(presentation).toContainText("Alpha needle");
  await page.setViewportSize({ width: 950, height: 700 });
  await presentation.getByRole("button", { name: "Close presentation" }).click();
  await expect(presentation).toBeHidden();
  await expect(page.getByRole("button", { name: "Present page" })).toBeFocused();
  await page.getByRole("tab", { name: "Tab 2", exact: true }).click();
  await page.getByRole("button", { name: "Move tab left", exact: true }).click();
  await expect(page.getByRole("tab").first()).toHaveText("Tab 2");
  await page.getByRole("button", { name: "Duplicate tab", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.getByLabel("Tab label", { exact: true }).fill("Copied panel");
  await expect(page.getByRole("tab", { name: "Copied panel", exact: true })).toHaveAttribute("aria-selected", "true");
  page.once("dialog", (confirmation) => confirmation.accept());
  await page.getByRole("button", { name: "Delete tab", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("button", { name: "Add tab", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(other.locator(".bn-editor")).toContainText("Alpha needle");
  await expect(other.locator(".bn-editor")).toContainText("Beta needle");
  await other.close();
});

test("removing a presentation source unmounts its snapshot and restores access to the shell", async ({ page }) => {
  await signInOwner(page);
  const created = await documentPage(page, "Presentation source access");
  await page.locator(".bn-editor").click();
  await page.keyboard.insertText("Private source text");
  await page.getByRole("button", { name: "Present page" }).click();
  await expect(page.getByRole("dialog", { name: "Presentation mode" })).toBeVisible();
  expect((await page.request.delete(`/api/pages/${created.id}`)).ok()).toBeTruthy();
  await expect(page.getByRole("dialog", { name: "Presentation mode" })).toHaveCount(0);
  await expect.poll(() => page.locator("#root").evaluate((root) => (root as HTMLElement).inert)).toBe(false);
});

test("slash conversion stays in place and deleting then undoing restores remote content", async ({ page, context }) => {
  await signInOwner(page);
  const created = await documentPage(page, "Block positioning");
  const editor = page.locator(".bn-editor");
  await editor.click();
  await page.keyboard.insertText("First paragraph");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Middle paragraph");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Last paragraph");
  const other = await context.newPage();
  await other.goto(`/?page=${created.id}`);
  await expect(other.locator(".bn-editor")).toContainText("Middle paragraph");
  const middle = editor.locator(".bn-inline-content").filter({ hasText: "Middle paragraph" }).first();
  await middle.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type("/callout", { delay: 80 });
  await page.getByText("Callout", { exact: true }).last().click();
  const blocks = editor.locator(":scope > .bn-block-group > .bn-block-outer");
  await expect(blocks.nth(0)).toContainText("First paragraph");
  await expect(blocks.nth(1).locator(".editor-callout")).toBeVisible();
  await expect(blocks.nth(2)).toContainText("Last paragraph");
  const inline = blocks.nth(1).locator(".bn-inline-content").first();
  await inline.click();
  await page.keyboard.insertText("Converted content");
  await expect(other.locator(".bn-editor")).toContainText("Converted content");
  // Separate the typing group from removal using Yjs's documented 500ms
  // capture window, then exercise the native whole-block delete action.
  await page.waitForTimeout(550);
  await inline.hover();
  await page.locator('[data-test="dragHandle"]').click();
  await page.getByText("Delete", { exact: true }).last().click();
  await expect(other.locator(".bn-editor")).not.toContainText("Converted content");
  await editor.locator(".bn-inline-content").first().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(other.locator(".bn-editor")).toContainText("Converted content");
  await expect(blocks.nth(0)).toContainText("First paragraph");
  await expect(blocks.last()).toContainText("Last paragraph");
  await other.close();
});

test("status and footnotes persist, navigate, converge, and remain readable with creation disabled", async ({
  page,
  context,
}) => {
  await features(page);
  await signInOwner(page);
  const created = await documentPage(page, "Status footnotes");
  const editor = page.locator(".bn-editor");
  await editor.click();
  await page.keyboard.type("/status", { delay: 80 });
  await page.getByText("Status badge", { exact: true }).last().click();
  await page.getByLabel("Status label", { exact: true }).fill("Approved");
  await page.getByLabel("Status color", { exact: true }).selectOption("green");
  const paragraph = editor.locator(".bn-inline-content").first();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (element.closest("[contenteditable=true]") as HTMLElement)?.focus();
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("/footnote", { delay: 80 });
  await page.getByText("Footnote", { exact: true }).last().click();
  const reference = editor.locator("[data-footnote-reference]");
  await expect(reference).toHaveText("1");
  await reference.click();
  const definition = editor.locator(".editor-footnote-definition .bn-inline-content");
  await expect(definition).toBeVisible();
  await definition.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.insertText("Evidence for approval");
  const other = await context.newPage();
  await other.goto(`/?page=${created.id}`);
  await expect(other.getByLabel("Status label", { exact: true })).toHaveValue("Approved");
  await expect(other.locator(".editor-footnote-definition")).toContainText("Evidence for approval");
  await page.getByRole("button", { name: "Back to footnote reference" }).click();
  await expect(reference).toBeFocused();
  // Focus-triggered member refreshes may still be inside route.fetch(). Drain
  // the feature override before navigation cancels their original requests.
  await context.unrouteAll({ behavior: "wait" });
  const disabledFeatures = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/me" && response.ok(),
  );
  await page.reload();
  expect((await (await disabledFeatures).json()).features.editorBlocksV2).toBe(false);
  await expect(page.getByLabel("Status label", { exact: true })).toHaveValue("Approved");
  await expect(page.locator(".editor-footnote-definition")).toContainText("Evidence for approval");
  await expect(page.locator("[data-footnote-reference]")).toHaveText("1");
  await other.close();
});

test("diagram page cards resolve titles, preserve aliases, and discard denied previews", async ({ page }) => {
  await features(page);
  await signInOwner(page);
  const source = await documentPage(page, "Card source");
  await page.locator(".bn-editor").click();
  await page.keyboard.insertText("Source preview text");
  await expect
    .poll(async () => {
      const result = await page.request.get(`/api/pages/${source.id}/card-preview`);
      return (await result.json()).text;
    })
    .toContain("Source preview text");
  const result = await page.request.post("/api/pages", { data: { kind: "diagram", title: `Cards ${Date.now()}` } });
  expect(result.ok()).toBeTruthy();
  const { page: diagram } = await result.json();
  await page.goto(`/?page=${diagram.id}`);
  await page
    .getByRole("navigation", { name: "Diagram stencils" })
    .getByRole("button", { name: /Process/ })
    .click();
  await page.locator(".react-flow__node").click({ position: { x: 15, y: 15 } });
  await page.getByLabel("Find a page", { exact: true }).first().fill(source.title);
  await page
    .locator(".diagram-suggestions")
    .getByRole("button", { name: new RegExp(source.title) })
    .click();
  const preview = page.locator(".diagram-card-preview");
  await expect(preview).toContainText("Source preview text");
  await expect(preview.getByRole("link")).toHaveText(source.title);
  await expect(preview.locator("[contenteditable]")).toHaveCount(0);
  await page.getByLabel("Node label", { exact: true }).fill("Personal alias");
  await expect(preview.getByRole("link")).toHaveText("Personal alias");
  await page.route(`**/api/pages/${source.id}/card-preview*`, (route) =>
    route.fulfill({ status: 403, json: { error: "forbidden" } }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: { type: "workspace-invalidated" } })),
  );
  await expect(preview).toContainText("Linked page unavailable.");
  await expect(preview).not.toContainText("Source preview text");
  await expect(preview).not.toContainText(source.title);
});
