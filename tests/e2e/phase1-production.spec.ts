import { expect, test, type Locator, type Page } from "@playwright/test";
import { embedProviders } from "../../src/shared/embed-providers";
import type { ProseMirrorJson } from "../../src/shared/types";
import { signInOwner } from "./security-helpers";

test.setTimeout(90_000);

async function createDocument(page: Page) {
  const previousPage = new URL(page.url()).searchParams.get("page");
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
  await page.waitForURL((url) =>
    Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
  );
  await expect(page.getByLabel("Page title")).toHaveValue("Untitled");
}

async function insertSlashBlock(page: Page, name: string) {
  const paragraph = page.locator('.bn-editor [data-content-type="paragraph"]').last();
  await paragraph.click();
  await page.keyboard.type("/");
  await page.getByText(name, { exact: true }).last().click();
}

async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (event) => {
      const violations = JSON.parse(sessionStorage.getItem("phase1:csp") ?? "[]") as string[];
      violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
      sessionStorage.setItem("phase1:csp", JSON.stringify(violations));
    });
  });
}

async function expectNoCspViolations(page: Page) {
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("phase1:csp") ?? "[]"))).toEqual([]);
}

async function placeCaretAtEnd(code: Locator) {
  await code.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function expectCodeSynced(page: Page, text: string, language: string) {
  const pageId = new URL(page.url()).searchParams.get("page");
  const codeBlocks = (node: ProseMirrorJson): Array<{ text: string; language: string }> =>
    node.type === "codeBlock"
      ? [
          {
            text: (node.content ?? []).map((child) => child.text ?? "").join(""),
            language: typeof node.attrs?.language === "string" ? node.attrs.language : "text",
          },
        ]
      : (node.content ?? []).flatMap(codeBlocks);
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/pages/${pageId}/content`);
      if (!response.ok()) return [];
      const { document } = (await response.json()) as { document: ProseMirrorJson };
      return codeBlocks(document);
    })
    .toContainEqual({ text, language });
}

test("serves the built app with frame policy and editor shortcuts", async ({ page }) => {
  await watchCsp(page);
  const response = await page.request.get("/");
  expect(response.ok()).toBe(true);
  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("frame-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  for (const provider of embedProviders) expect(csp).toContain(provider.origin);

  await signInOwner(page);
  const editor = page.locator(".bn-editor");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Find a page or command" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toBeFocused();
  await expect(palette.getByRole("option", { name: /Create document/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();

  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByRole("dialog", { name: "Find a page" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect(page.getByRole("dialog", { name: "Run a command" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Page title").blur();
  await page.locator(".page-canvas").click({ position: { x: 10, y: 10 } });
  await page.keyboard.type("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Imports & exports" }).click();
  await expect(page.getByRole("dialog", { name: "Imports & exports" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Find a page or command" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await editor.click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        metaKey: true,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  await expect(page.getByRole("dialog", { name: "Find a page or command" })).toHaveCount(0);
  await expectNoCspViolations(page);
});

test("renders math, Mermaid, and highlighted code with the built policy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await watchCsp(page);
  await signInOwner(page);
  await createDocument(page);
  await insertSlashBlock(page, "Math");
  await expect(page.locator(".editor-math-block .katex")).toBeVisible();
  await insertSlashBlock(page, "Diagram");
  const diagram = page.getByTitle("Mermaid diagram preview");
  await expect(diagram).toBeVisible();
  await expect.poll(async () => diagram.getAttribute("srcdoc")).toContain("<svg");
  await insertSlashBlock(page, "Code Block");
  const block = page.locator('[data-content-type="codeBlock"]');
  const copy = block.getByRole("button", { name: "Copy code" });
  const code = block.locator("pre code");
  await expect(block).toBeVisible();
  await expect(copy).toHaveCount(1);
  await page.keyboard.type("const value = 1;");
  await block.locator("select").selectOption("javascript");
  await expect(code).toContainText("const value = 1;");
  await expect.poll(() => code.locator("span").count()).toBeGreaterThan(0);
  await copy.click();
  await expect(copy).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("const value = 1;");
  await expect(copy).toHaveCount(1);

  await code.click();
  await placeCaretAtEnd(code);
  await page.keyboard.type(" // edited after copying");
  const editedCode = "const value = 1; // edited after copying";
  await expect(code).toHaveText(editedCode);
  await expect(copy).toHaveCount(1);
  await expectCodeSynced(page, editedCode, "javascript");
  const documentUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(documentUrl);
  await expect(code).toHaveText(editedCode);
  await expect(block.locator("select")).toHaveValue("javascript");
  await expect.poll(() => code.locator("span").count()).toBeGreaterThan(0);
  await expect(copy).toHaveCount(1);
  await copy.click();
  await expect(copy).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(editedCode);
  await expectNoCspViolations(page);
});

test("canonicalizes every provider and keeps an original link", async ({ page }) => {
  await signInOwner(page);
  await createDocument(page);
  await page.route("https://www.youtube-nocookie.com/embed/**", (route) =>
    route.fulfill({ status: 200, headers: { "x-frame-options": "DENY" }, body: "blocked" }),
  );
  await insertSlashBlock(page, "Embed");
  const input = page.getByLabel("Embed URL");
  const frame = page.locator(".editor-embed iframe");
  for (const provider of embedProviders) {
    await input.fill(provider.fixture);
    await expect(frame).toBeVisible();
    await expect.poll(async () => new URL((await frame.getAttribute("src")) ?? "").origin).toBe(provider.origin);
    await expect(page.locator(".editor-embed a", { hasText: "Open original" })).toHaveAttribute(
      "href",
      provider.fixture,
    );
  }
  await input.fill("https://example.org/unframed");
  await expect(frame).toHaveCount(0);
  await expect(page.locator(".editor-embed a", { hasText: "Embedded link" })).toHaveAttribute(
    "href",
    "https://example.org/unframed",
  );
});

test("falls back to a link for remote PDFs", async ({ page }) => {
  await signInOwner(page);
  await createDocument(page);
  await insertSlashBlock(page, "PDF");
  await page.getByLabel("PDF URL").fill("https://example.org/report.pdf");
  await expect(page.locator(".editor-pdf iframe")).toHaveCount(0);
  await expect(page.locator(".editor-pdf a")).toHaveAttribute("href", "https://example.org/report.pdf");
});

test("offers safe paste choices and keeps the link when preview fetch fails", async ({ page }) => {
  await signInOwner(page);
  await createDocument(page);
  await page.route("**/api/link-previews", (route) => route.fulfill({ status: 503, body: "unavailable" }));
  const paragraph = page.locator('.bn-editor [data-content-type="paragraph"]').last();
  await paragraph.click();
  await page.locator(".bn-editor").focus();
  await expect(page.locator(".bn-editor")).toBeFocused();
  await page.evaluate((url) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", url);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, embedProviders[0]!.fixture);
  const choices = page.locator(".paste-url-choice");
  await expect(choices.getByRole("button", { name: "Link" })).toBeVisible();
  await expect(choices.getByRole("button", { name: "Preview card" })).toBeVisible();
  await expect(choices.getByRole("button", { name: "Embed" })).toBeVisible();
  await choices.getByRole("button", { name: "Preview card" }).click();
  await expect(page.locator(".editor-bookmark a")).toHaveAttribute("href", embedProviders[0]!.fixture);
  await expect(page.locator(".bn-editor")).toBeFocused();
});

test("does not overwrite a changed paragraph from a stale paste choice", async ({ page }) => {
  await signInOwner(page);
  await createDocument(page);
  const notice = page.locator(".document-paper").getByRole("status", { name: "Paste status" });
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText("");
  const originalNotice = await notice.elementHandle();
  expect(originalNotice).not.toBeNull();
  const paragraph = page.locator('.bn-editor [data-content-type="paragraph"]').last();
  await paragraph.click();
  await page.locator(".bn-editor").focus();
  await page.evaluate((url) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", url);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, embedProviders[0]!.fixture);
  const choices = page.locator(".paste-url-choice");
  await expect(choices.getByRole("button", { name: "Embed" })).toBeVisible();
  await paragraph.click();
  await page.keyboard.type("Keep this paragraph");
  await choices.getByRole("button", { name: "Embed" }).click();
  await expect(
    page.locator('.bn-editor [data-content-type="paragraph"]').filter({ hasText: "Keep this paragraph" }),
  ).toHaveCount(1);
  await expect(page.locator(".editor-embed")).toHaveCount(0);
  await expect(page.locator('.bn-editor [data-content-type="paragraph"] a').last()).toHaveAttribute(
    "href",
    embedProviders[0]!.fixture,
  );
  await expect(page.getByRole("status").filter({ hasText: /added as a link at the end of the page/ })).toBeVisible();
  expect(await notice.evaluate((current, original) => current === original, originalNotice)).toBe(true);
  await page.locator(".bn-editor").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.evaluate((url) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", url);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, embedProviders[0]!.fixture);
  await expect(choices).toBeVisible();
  await expect(notice).toHaveText("");
  expect(await notice.evaluate((current, original) => current === original, originalNotice)).toBe(true);
  await choices.getByRole("button", { name: "Cancel" }).click();
  await expect(choices).toHaveCount(0);
  await expect(notice).toHaveCount(1);
  expect(await notice.evaluate((current, original) => current === original, originalNotice)).toBe(true);
  await originalNotice?.dispose();
});

test("hides expanded paste actions when bootstrap disables them", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const member = (await response.json()) as { features?: { expandedEmbeds?: boolean } };
    await route.fulfill({
      status: response.status(),
      json: { ...member, features: { ...member.features, expandedEmbeds: false } },
    });
  });
  await signInOwner(page);
  await createDocument(page);
  const paragraph = page.locator('.bn-editor [data-content-type="paragraph"]').last();
  await paragraph.click();
  await page.locator(".bn-editor").focus();
  await expect(page.locator(".bn-editor")).toBeFocused();
  await page.evaluate((url) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", url);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, "https://www.loom.com/share/be3f4b20127d47be9f884c3fab71d030");
  const choices = page.locator(".paste-url-choice");
  await expect(choices).toHaveCount(0);
  await createDocument(page);
  await page.locator('.bn-editor [data-content-type="paragraph"]').last().click();
  await page.locator(".bn-editor").focus();
  await expect(page.locator(".bn-editor")).toBeFocused();
  await page.evaluate((url) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", url);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, embedProviders[0]!.fixture);
  await expect(choices.getByRole("button", { name: "Embed" })).toBeVisible();
  await expect(choices.getByRole("button", { name: "Preview card" })).toHaveCount(0);
  await expect(choices.getByRole("button", { name: "Link" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(choices).toHaveCount(0);
  await expect(page.locator(".bn-editor")).toBeFocused();
});

test("@touch opens the palette and runs a command", async ({ page }) => {
  await signInOwner(page);
  await page.getByRole("button", { name: /Find a page or command/ }).tap();
  const palette = page.getByRole("dialog", { name: "Find a page or command" });
  await expect(palette).toBeVisible();
  await palette.getByRole("option", { name: /Toggle theme/ }).tap();
  await expect(palette).toHaveCount(0);
});

test("@touch keeps code editing responsive through Enter and a language change", async ({ page }) => {
  await watchCsp(page);
  await signInOwner(page);
  await createDocument(page);
  await insertSlashBlock(page, "Code Block");
  const block = page.locator('[data-content-type="codeBlock"]');
  const code = block.locator("pre code");
  const copy = block.getByRole("button", { name: "Copy code" });
  await page.keyboard.type("const first = 1;");
  await expect(code).toHaveText("const first = 1;");
  await code.tap();
  await placeCaretAtEnd(code);
  await page.keyboard.press("Enter");
  await page.keyboard.type("const second = 2;");
  const codeText = "const first = 1;\nconst second = 2;";
  await expect.poll(() => code.textContent()).toBe(codeText);
  await block.locator("select").selectOption("javascript");
  await expect(block.locator("select")).toHaveValue("javascript");
  await expect.poll(() => code.textContent()).toBe(codeText);
  await expect.poll(() => code.locator("span").count()).toBeGreaterThan(0);
  await expect(copy).toHaveCount(1);
  await expectCodeSynced(page, codeText, "javascript");
  await page.reload();
  await expect.poll(() => code.textContent()).toBe(codeText);
  await expect(block.locator("select")).toHaveValue("javascript");
  await expect(copy).toHaveCount(1);
  await expectNoCspViolations(page);
});
