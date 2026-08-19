import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const owner = {
  email: "owner@example.test",
  password: "password123",
};

async function signIn(page: Page) {
  await page.goto("/");
  const initialized = await page.request
    .get("/api/install")
    .then(async (response) => (await response.json()) as { initialized: boolean });
  if (!initialized.initialized) {
    await page.getByLabel("Workspace name").fill("E2E Notes");
    await page.getByLabel("Your name").fill("E2E Owner");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill(owner.password);
    await page.getByLabel("Bootstrap token").fill("e2e-bootstrap-token");
    await page.getByRole("button", { name: "Create workspace" }).click();
  } else {
    // The app settles on the sign-in screen or the workspace only after it has
    // checked the session, so wait for one of them before deciding: an instant
    // isVisible() races that render and skips the sign-in form entirely.
    const signInHeading = page.getByRole("heading", { name: "Sign in" });
    await expect(signInHeading.or(page.getByLabel("Page title")).first()).toBeVisible();
    if (await signInHeading.isVisible()) {
      await page.getByLabel("Email").fill(owner.email);
      await page.getByLabel("Password").fill(owner.password);
      await page.getByRole("button", { name: "Continue" }).click();
    }
  }
  await expect(page.getByLabel("Page title")).toBeVisible();
}

async function openSidebar(page: Page) {
  const members = page.getByRole("button", { name: /Members/ });
  if (!(await members.isVisible())) await page.getByRole("button", { name: "☰" }).click();
  await expect(members).toBeVisible();
}

async function createInvite(page: Page, role: "editor" | "viewer") {
  await openSidebar(page);
  await page.getByRole("button", { name: /Members/ }).click();
  const inviteInput = page.locator(".invite-link input");
  const previousURL = (await inviteInput.count()) > 0 ? await inviteInput.inputValue() : "";
  await page.getByRole("button", { name: `Invite ${role}` }).click();
  await expect.poll(() => inviteInput.inputValue()).not.toBe(previousURL);
  return inviteInput.inputValue();
}

async function acceptInvite(context: BrowserContext, inviteURL: string, role: "editor" | "viewer", suffix: string) {
  const page = await context.newPage();
  await page.goto(inviteURL);
  await page.getByLabel("Your name").fill(`E2E ${role}`);
  await page.getByLabel("Email").fill(`${role}-${suffix}@example.test`);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Accept invite" }).click();
  await expect(page.getByLabel("Page title")).toBeVisible();
  return page;
}

test.describe.configure({ mode: "serial" });

test("bootstraps or signs in and passes critical accessibility checks", async ({ page }) => {
  await signIn(page);
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome");

  const results = await new AxeBuilder({ page }).exclude(".bn-editor").analyze();
  const critical = results.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  expect(critical).toEqual([]);
});

test("creates, renames, archives, and restores a page through the UI", async ({ page }, testInfo) => {
  await signIn(page);
  const title = `Lifecycle ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole("button", { name: "+ Page", exact: true }).click();
  const titleInput = page.getByLabel("Page title");
  await expect(titleInput).toHaveValue("Untitled");
  await titleInput.fill(title);
  await titleInput.press("Enter");
  const pageLink = page.getByRole("button", { name: new RegExp(title) });
  await expect(pageLink).toBeVisible();

  await pageLink.locator("..").hover();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `Archive ${title}` }).click();
  await expect(pageLink).toHaveCount(0, { timeout: 10_000 });
  await openSidebar(page);
  await page.getByRole("button", { name: /Trash/ }).click();
  const trashEntry = page.locator(".trash-list > div").filter({ hasText: title });
  await expect(trashEntry).toBeVisible();
  const restored = page.waitForResponse(
    (response) => /\/api\/pages\/[^/]+\/restore$/.test(response.url()) && response.request().method() === "POST",
  );
  await trashEntry.getByRole("button", { name: "Restore" }).click();
  expect((await restored).ok()).toBe(true);
  await expect(trashEntry).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("Trash is empty.")).toBeVisible();
});

test("propagates page metadata to an invited editor in realtime", async ({ browser, page }, testInfo) => {
  await signIn(page);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const inviteURL = await createInvite(page, "editor");
  const editorContext = await browser.newContext();
  try {
    const editorPage = await acceptInvite(editorContext, inviteURL, "editor", suffix);
    await page.getByRole("button", { name: "+ Page", exact: true }).click();
    const title = `Realtime ${suffix}`;
    await expect(page.getByLabel("Page title")).toHaveValue("Untitled");
    await page.getByLabel("Page title").fill(title);
    await page.getByLabel("Page title").press("Enter");
    await openSidebar(editorPage);
    await expect(editorPage.getByRole("button", { name: new RegExp(title) })).toBeVisible({ timeout: 15_000 });
  } finally {
    await editorContext.close();
  }
});

test("enforces viewer UI permissions and table edit leases", async ({ browser, page }, testInfo) => {
  await signIn(page);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const viewerURL = await createInvite(page, "viewer");
  const viewerContext = await browser.newContext();
  try {
    const viewerPage = await acceptInvite(viewerContext, viewerURL, "viewer", suffix);
    await expect(viewerPage.getByRole("button", { name: "+ Page", exact: true })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: "+ Table", exact: true })).toHaveCount(0);
    await expect(viewerPage.getByLabel("Page title")).toHaveAttribute("readonly");
  } finally {
    await viewerContext.close();
  }

  const editorURL = await createInvite(page, "editor");
  const editorContext = await browser.newContext();
  try {
    const editorPage = await acceptInvite(editorContext, editorURL, "editor", `${suffix}-lease`);
    await page.getByRole("button", { name: "+ Table", exact: true }).click();
    await expect(page.getByText("Editing lease active")).toBeVisible();
    const tableTitle = `Lease ${suffix}`;
    await expect(page.locator("input.page-title")).toHaveValue("Untitled");
    await page.locator("input.page-title").fill(tableTitle);
    await page.locator("input.page-title").press("Enter");
    await openSidebar(editorPage);
    await editorPage.getByRole("button", { name: new RegExp(tableTitle) }).click();
    await expect(editorPage.getByText("Another editor has this table open for editing.")).toBeVisible();
  } finally {
    await editorContext.close();
  }
});
