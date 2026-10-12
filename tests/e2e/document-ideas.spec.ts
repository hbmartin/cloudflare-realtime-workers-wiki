import * as Y from "yjs";
import { expect, test, type Route } from "@playwright/test";
import { signInOwner, completeEnrollment } from "./security-helpers";
test.setTimeout(60000);

test("block links remain usable through fragment history and clipboard denial", async ({ page, context }) => {
  await signInOwner(page);
  const tree = await (await page.request.get("/api/pages/tree")).json();
  const created = await (
    await page.request.post("/api/pages", {
      data: { kind: "document", title: `Block links ${Date.now()}`, spaceId: tree.pages[0].spaceId },
    })
  ).json();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await page.goto(`/?page=${created.page.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.insertText("Linked target");
  const block = editor.locator("[data-id]").filter({ hasText: "Linked target" }).first();
  const id = await block.getAttribute("data-id");
  expect(id).toBeTruthy();
  await page.getByRole("button", { name: "Block actions", exact: true }).click();
  await editor.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Block actions" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Block actions", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Block actions", exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Copy link to block" }).click();
  await expect(page.getByRole("textbox", { name: "Block link", exact: true })).toHaveValue(new RegExp(`#block=${id}`));
  await page.evaluate((target) => {
    location.hash = `block=${target}`;
  }, id!);
  await expect(block).toHaveCSS("outline-style", "solid");
  await page.evaluate(() => {
    location.hash = "block=deleted";
  });
  await expect(page.getByLabel("Block link status")).toHaveText("This block is no longer available.");
  await page.goBack();
  await expect(block).toHaveCSS("outline-style", "solid");
  await context.setOffline(true);
  await page.evaluate(() => {
    location.hash = "block=uncached";
  });
  await expect(page.getByLabel("Block link status")).toContainText("not in the cached copy");
  await context.setOffline(false);
});

test("live diagram embeds show remote edits with local zoom", async ({ page, context }) => {
  await signInOwner(page);
  const tree = await (await page.request.get("/api/pages/tree")).json();
  const diagram = await (
    await page.request.post("/api/pages", {
      data: { kind: "diagram", title: `Embedded ${Date.now()}`, spaceId: tree.pages[0].spaceId },
    })
  ).json();
  const document = await (
    await page.request.post("/api/pages", {
      data: { kind: "document", title: `Live embed ${Date.now()}`, spaceId: tree.pages[0].spaceId },
    })
  ).json();
  await page.goto(`/?page=${document.page.id}`);
  await expect(page.locator(".bn-editor")).toBeVisible();
  await page.locator(".bn-editor").click();
  await page.keyboard.type("/whiteboard", { delay: 30 });
  await page
    .getByRole("option", { name: /Linked whiteboard/i })
    .first()
    .click();
  await page.getByLabel("Find a diagram").fill(diagram.page.title);
  await page
    .locator(".editor-linked-diagram-options")
    .getByRole("button", { name: new RegExp(`◇ ${diagram.page.title}`) })
    .click();
  const embed = page.getByLabel(`Live diagram: ${diagram.page.title}`);
  await expect(embed).toBeVisible();
  await expect(embed.getByText("Live", { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(`/?page=${diagram.page.id}`);
  await other
    .getByRole("navigation", { name: "Diagram stencils" })
    .getByRole("button", { name: /Process/ })
    .click();
  await page.bringToFront();
  await expect(embed.locator(".react-flow__node")).toHaveCount(1);
  await expect(embed.getByRole("link", { name: "Open diagram" })).toHaveAttribute("href", `/?page=${diagram.page.id}`);
  await expect(other.locator(".react-flow__node")).toHaveCount(1);
  await other.close();
  const before = await (await page.request.get(`/api/pages/${diagram.page.id}/content`)).json();
  await embed.getByRole("button", { name: "Zoom Out", exact: true }).click();
  await embed.getByRole("button", { name: "Fit View", exact: true }).click();
  const after = await (await page.request.get(`/api/pages/${diagram.page.id}/content`)).json();
  expect(after.nodes).toEqual(before.nodes);
  expect(after.edges).toEqual(before.edges);
  expect(after.sequence).toEqual(before.sequence);
});

test("comparison links open History with an honest expired state", async ({ page }) => {
  await signInOwner(page);
  const id = new URL(page.url()).searchParams.get("page")!;
  await page.goto(`/?page=${id}&compareFrom=expired&compareTo=expired`);
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Digest comparison" })).toContainText(
    "This comparison is no longer available.",
  );
});

test("History previews the full saved version before restore", async ({ page }) => {
  await signInOwner(page);
  const created = await (
    await page.request.post("/api/pages", { data: { kind: "document", title: `Saved preview ${Date.now()}` } })
  ).json();
  await page.goto(`/?page=${created.page.id}`);
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.insertText("Unchanged paragraph");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Original paragraph");
  const ids = await editor
    .locator(".bn-block-outer")
    .evaluateAll((blocks) => blocks.map((block) => block.getAttribute("data-id")!));
  const saved = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  ["Unchanged paragraph", "Original paragraph"].forEach((value, index) => {
    const container = new Y.XmlElement("blockContainer"),
      paragraph = new Y.XmlElement("paragraph"),
      text = new Y.XmlText();
    container.setAttribute("id", ids[index]!);
    text.insert(0, value);
    paragraph.insert(0, [text]);
    container.insert(0, [paragraph]);
    group.insert(index, [container]);
  });
  saved.getXmlFragment("document-store").insert(0, [group]);
  const bytes = Y.encodeStateAsUpdate(saved);
  saved.destroy();
  await page.route(`**/api/pages/${created.page.id}/versions`, (route) =>
    route.fulfill({
      json: {
        versions: [
          {
            id: "saved-preview",
            title: created.page.title,
            epoch: 1,
            sequence: 1,
            byteSize: bytes.length,
            createdAt: Date.now(),
          },
          { id: "late-preview", title: "Older version", epoch: 1, sequence: 0, byteSize: 0, createdAt: 1 },
        ],
      },
    }),
  );
  await page.route("**/api/versions/saved-preview", (route) =>
    route.fulfill({ body: Buffer.from(bytes), contentType: "application/octet-stream" }),
  );
  const second = editor.locator(".bn-inline-content").filter({ hasText: "Original paragraph" });
  await second.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText("Changed paragraph");
  await page.getByRole("button", { name: "Page details", exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".version-list button").first().click();
  const preview = page.getByRole("region", { name: "Saved version preview" });
  await expect(preview).toContainText("Unchanged paragraph");
  await expect(preview).toContainText("Original paragraph");
  await expect(page.getByLabel("Block-level version comparison")).not.toContainText("Unchanged paragraph");
  await expect(page.getByRole("button", { name: "Restore this version" })).toBeVisible();
  let receiveLate!: (route: Route) => void;
  const lateRequest = new Promise<Route>((resolve) => {
    receiveLate = resolve;
  });
  await page.route("**/api/versions/late-preview", (route) => {
    receiveLate(route);
  });
  await page.locator(".version-list button").nth(1).click();
  const lateRoute = await lateRequest;
  await expect(page.getByRole("button", { name: "Restore this version" })).not.toBeVisible();
  await expect(page.getByText("Loading saved version…", { exact: true })).toBeVisible();
  await page.locator(".version-list button").first().click();
  await expect(preview).toContainText("Original paragraph");
  await lateRoute.fulfill({ body: Buffer.from([0, 0]), contentType: "application/octet-stream" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(preview).toContainText("Original paragraph");
});

test("nested block links expand local toggles and remain keyboard-accessible to viewers", async ({ page, browser }) => {
  await signInOwner(page);
  const created = await (
    await page.request.post("/api/pages", { data: { kind: "document", title: `Nested links ${Date.now()}` } })
  ).json();
  await page.goto(`/?page=${created.page.id}`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("/toggle", { delay: 30 });
  await page
    .getByRole("option", { name: /Toggle List/i })
    .first()
    .click();
  await page.keyboard.insertText("Parent toggle");
  const toggle = editor.locator(".bn-toggle-button").first();
  await toggle.click();
  await editor.locator(".bn-toggle-add-block-button").click();
  await page.keyboard.insertText("Nested target");
  const child = editor.locator(".bn-inline-content").filter({ hasText: "Nested target" });
  const id = await child.evaluate((element) => element.closest(".bn-block-outer")!.getAttribute("data-id"));
  await page.request.get(`/api/pages/${created.page.id}/content`);
  await toggle.click();
  await expect(child).not.toBeVisible();
  await page.evaluate((target) => {
    location.hash = `block=${target}`;
  }, id!);
  await expect(child).toBeVisible();
  const invitation = await (await page.request.post("/api/invites", { data: { role: "viewer" } })).json();
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await guest.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
    });
    await guest.goto(`/?invite=${invitation.invite.token}`);
    await guest.getByLabel("Your name").fill("Block viewer");
    await guest.getByLabel("Email", { exact: true }).fill(`block-viewer-${Date.now()}@example.test`);
    await guest.getByLabel("Password", { exact: true }).fill("password123");
    await guest.getByRole("button", { name: "Accept invite" }).click();
    await completeEnrollment(guest);
    await guest.goto(`/?page=${created.page.id}#block=${id}`);
    await expect(guest.locator(".bn-inline-content").filter({ hasText: "Nested target" })).toBeVisible();
    await expect(guest.locator(".bn-editor")).toHaveAttribute("contenteditable", "false");
    await guest.getByRole("button", { name: "Block actions", exact: true }).press("Enter");
    await expect(guest.getByRole("menuitem", { name: "Copy link to block" })).toBeFocused();
    await guest.keyboard.press("Shift+Tab");
    await expect(guest.getByLabel("Block to link")).toBeFocused();
    await guest.getByLabel("Block to link").selectOption(id!);
    await expect(guest.getByLabel("Block to link")).toHaveValue(id!);
    await guest.keyboard.press("Tab");
    await expect(guest.getByRole("menuitem", { name: "Copy link to block" })).toBeFocused();
    await guest.keyboard.press("Enter");
    await expect(guest.getByRole("textbox", { name: "Block link", exact: true })).toHaveValue(
      new RegExp(`#block=${id}`),
    );
  } finally {
    await guestContext.close();
  }
});
