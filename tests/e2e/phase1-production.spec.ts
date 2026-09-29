import { expect, test, type Page } from "@playwright/test";
import { embedProviders } from "../../src/shared/embed-providers";
import { signInOwner } from "./security-helpers";

test.setTimeout(90_000);

async function createDocument(page: Page) {
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
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

test("renders math, Mermaid, and highlighted code with the built policy", async ({ page }) => {
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
  await expect(page.locator('[data-content-type="codeBlock"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  const code = page.locator('[data-content-type="codeBlock"] pre code');
  await page.keyboard.type("const value = 1;");
  await page.locator('[data-content-type="codeBlock"] select').selectOption("javascript");
  await expect(code).toContainText("const value = 1;");
  await expect.poll(() => code.locator("span").count()).toBeGreaterThan(0);
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
});

test("hides expanded paste actions when bootstrap disables them", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const member = (await response.json()) as { features?: { expandedEmbeds?: boolean } };
    await route.fulfill({
      response,
      json: { ...member, features: { ...member.features, expandedEmbeds: false } },
    });
  });
  await signInOwner(page);
  await createDocument(page);
  const paragraph = page.locator('.bn-editor [data-content-type="paragraph"]').last();
  await paragraph.click();
  await page.evaluate((url) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", url);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, "https://www.loom.com/share/be3f4b20127d47be9f884c3fab71d030");
  const choices = page.locator(".paste-url-choice");
  await expect(choices.getByRole("button", { name: "Link" })).toBeVisible();
  await expect(choices.getByRole("button", { name: "Preview card" })).toHaveCount(0);
  await expect(choices.getByRole("button", { name: "Embed" })).toHaveCount(0);
});

test("@touch opens the palette and runs a command", async ({ page }) => {
  await signInOwner(page);
  await page.getByRole("button", { name: /Find a page or command/ }).tap();
  const palette = page.getByRole("dialog", { name: "Find a page or command" });
  await expect(palette).toBeVisible();
  await palette.getByRole("option", { name: /Toggle theme/ }).tap();
  await expect(palette).toHaveCount(0);
});
