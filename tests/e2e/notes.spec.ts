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
  // Below the 760px breakpoint the sidebar is an off-canvas drawer. Decide from
  // the toggle and the scrim rather than the drawer's own visibility: the toggle only
  // renders below the breakpoint and the scrim only exists while the drawer is
  // open, so both track React state exactly, while the drawer stays visible for
  // the length of its slide-out transition. Clicking the toggle while it is already
  // open would also be swallowed by the scrim, which outranks the topbar.
  const toggle = page.getByRole("button", { name: "Open navigation" });
  const scrim = page.locator(".sidebar-scrim");
  if ((await toggle.isVisible()) && !(await scrim.isVisible())) await toggle.click();
  if (await toggle.isVisible()) {
    await expect(scrim).toBeVisible();
    await expect
      .poll(async () => (await page.getByLabel("Workspace navigation").boundingBox())?.x ?? -1)
      .toBeGreaterThanOrEqual(0);
  }
  await expect(page.getByRole("button", { name: /Members/ })).toBeVisible();
}

// A row's "Add child to <title>" and "Archive <title>" labels also carry the
// title, and below the 760px breakpoint they are laid out rather than hidden,
// so matching on the title alone is ambiguous there. Match the link itself.
function treeLink(page: Page, title: string) {
  return page.locator("button.page-link").filter({ hasText: title });
}

async function createDocument(page: Page, title: string) {
  await page.getByRole("button", { name: "+ Page", exact: true }).click();
  const titleInput = page.getByLabel("Page title");
  await expect(titleInput).toHaveValue("Untitled");
  await titleInput.fill(title);
  await titleInput.press("Enter");
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
  await openSidebar(page);

  const results = await new AxeBuilder({ page }).exclude(".bn-editor").analyze();
  const critical = results.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  expect(critical).toEqual([]);
});

test("opens the Activities tray with keyboard-safe focus and an accessible recent state", async ({ page }) => {
  await signIn(page);
  const trigger = page.getByRole("button", { name: "Activities" });
  await trigger.click();
  const tray = page.getByRole("dialog", { name: "Activities" });
  await expect(tray).toBeVisible();
  await expect(tray.locator(".activity-empty, .activity-list")).toBeVisible();
  await expect(tray.getByRole("button", { name: "Close activities" })).toBeFocused();

  const results = await new AxeBuilder({ page }).include(".activities-tray").analyze();
  expect(
    results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious"),
  ).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(tray).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("organizes pages with spaces, favorites, pins, and tags", async ({ page }, testInfo) => {
  await signIn(page);
  const title = `Organization ${testInfo.project.name} ${Date.now()}`;
  await createDocument(page, title);
  const switcher = page.getByLabel("Current space");
  await expect(switcher).toBeEnabled();
  await expect(switcher).toHaveValue(/.+/);

  await page.getByRole("button", { name: "Favorite" }).click();
  await page.getByRole("button", { name: "Pin" }).click();
  await openSidebar(page);
  await expect(page.getByLabel("Favorites").getByText(title)).toBeVisible();
  await expect(page.getByLabel("Pinned").getByText(title)).toBeVisible();
  const closeNavigation = page.getByRole("button", { name: "Close navigation" });
  if (await closeNavigation.isVisible()) await closeNavigation.click();

  const tagName = `Getting started ${testInfo.project.name}`;
  await page.getByRole("button", { name: "+ New tag" }).click();
  await page.getByLabel("Tag name").fill(tagName);
  await page.getByLabel("Tag color").selectOption("purple");
  await page.locator(".tag-create-form").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: `Remove ${tagName} tag` })).toBeVisible();

  const spaceName = `Private plans ${Date.now()}`;
  await openSidebar(page);
  await page.getByRole("button", { name: "Create space" }).click();
  await page.getByLabel("Space name").fill(spaceName);
  await page.getByLabel("Access").selectOption("private");
  await page.locator(".space-create-form").getByRole("button", { name: "Create", exact: true }).click();
  await expect(switcher).toHaveText(new RegExp(spaceName));
  await expect(page.getByRole("heading", { name: "A quiet workspace." })).toBeVisible();

  const results = await new AxeBuilder({ page }).exclude(".bn-editor").analyze();
  expect(
    results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious"),
  ).toEqual([]);
});

test("inserts the custom editor block pack from the slash menu", async ({ page }, testInfo) => {
  await signIn(page);
  await createDocument(page, `Custom blocks ${testInfo.project.name} ${Date.now()}`);
  const editor = page.locator(".bn-editor");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");

  await expect(page.getByText("Callout", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Math", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Diagram", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Columns", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Embed", { exact: true }).last()).toBeVisible();
  await page.getByText("Callout", { exact: true }).last().click();

  await expect(page.getByLabel("Callout icon")).toBeVisible();
  await expect(page.getByLabel("Callout tone")).toHaveValue("info");
  await page.getByLabel("Callout tone").selectOption("warning");
  await expect(page.locator(".editor-callout.tone-warning")).toBeVisible();
});

test("creates and instantiates a space-scoped template through the background workflow", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Save as template" }).click();
  const tray = page.getByRole("dialog", { name: "Activities" });
  await expect(tray).toBeVisible();
  const creation = tray.locator(".activity-list > li").first();
  await expect(creation).toContainText("Template copy");
  await expect(creation.locator(".job-status")).toHaveText("succeeded", { timeout: 30_000 });
  await page.keyboard.press("Escape");

  await openSidebar(page);
  await page.getByRole("button", { name: "Templates" }).click();
  const card = page.locator(".template-grid article").filter({ hasText: "Welcome" }).first();
  await expect(card).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include(".template-library").analyze();
  expect(
    accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious"),
  ).toEqual([]);

  await card.getByRole("button", { name: "Use template" }).click();
  await expect(tray).toBeVisible();
  const instantiation = tray.locator(".activity-list > li").first();
  await expect(instantiation.locator(".job-status")).toHaveText("succeeded", { timeout: 30_000 });
  await instantiation.getByRole("button", { name: "Open page" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Welcome");
});

test("renders server comments, watch state, notifications, and Slack configuration accessibly", async ({ page }) => {
  await signIn(page);
  const pagesResponse = await page.request.get("/api/pages/tree");
  expect(pagesResponse.ok()).toBe(true);
  const { pages } = (await pagesResponse.json()) as { pages: Array<{ id: string; title: string }> };
  const welcome = pages.find((candidate) => candidate.title === "Welcome");
  expect(welcome).toBeDefined();

  const commentText = `Browser comment ${Date.now()}`;
  const commentResponse = await page.request.post(`/api/pages/${welcome!.id}/comments`, {
    data: {
      initialComment: {
        body: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: commentText, styles: {} }],
            children: [],
          },
        ],
      },
    },
  });
  expect(commentResponse.status()).toBe(201);

  // The request API simulates a second client, so reload before asserting the
  // server-backed thread and the automatic watcher enrollment in this client.
  await page.reload();
  await expect(page.getByLabel("Page title")).toBeVisible();
  await page.getByRole("button", { name: "Comments" }).click();
  const comments = page.locator(".comments-panel");
  await expect(comments).toContainText(commentText);
  await expect(page.getByRole("button", { name: "Mute this page" })).toBeVisible();
  const commentsAccessibility = await new AxeBuilder({ page }).include(".comments-panel").analyze();
  expect(
    commentsAccessibility.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: /^Notifications/ }).click();
  const notifications = page.getByRole("dialog", { name: "Notifications" });
  await expect(notifications).toBeVisible();
  await notifications.getByRole("button", { name: "Notification settings" }).click();
  await expect(notifications.getByText(/Email is unavailable until a sending domain is configured/)).toBeVisible();
  await expect(notifications.getByText("Slack unavailable").first()).toBeVisible();
  const notificationAccessibility = await new AxeBuilder({ page }).include(".notifications-tray").analyze();
  expect(
    notificationAccessibility.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
  await page.keyboard.press("Escape");

  await openSidebar(page);
  await page.getByRole("button", { name: /Members/ }).click();
  const slack = page.locator(".slack-settings");
  await expect(slack.getByRole("heading", { name: "Slack" })).toBeVisible();
  await expect(slack.getByText(/Slack is unavailable until an operator configures/)).toBeVisible();
  await expect(slack.getByRole("button", { name: "Add to Slack" })).toHaveCount(0);
  const slackAccessibility = await new AxeBuilder({ page }).include(".slack-settings").analyze();
  expect(
    slackAccessibility.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
});

test("searches with URL-persisted scope filters", async ({ page }) => {
  await signIn(page);
  await openSidebar(page);
  await page.getByRole("button", { name: /Search/ }).click();
  await page.getByLabel("Search workspace").fill("Welcome");
  await page.getByText(/^Filters/).click();
  await page.getByLabel("Page type").selectOption("document");
  await page.getByLabel("Comments").selectOption("true");

  const chips = page.getByLabel("Active search filters");
  await expect(chips.getByRole("button", { name: "Remove Documents" })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Remove Has comments" })).toBeVisible();
  await expect(page).toHaveURL(/(?:\?|&)q=Welcome(?:&|$)/);
  await expect(page).toHaveURL(/(?:\?|&)kind=document(?:&|$)/);
  await expect(page).toHaveURL(/(?:\?|&)hasComments=true(?:&|$)/);
  const result = page.locator(".search-results > button").filter({ hasText: "Welcome" }).first();
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result).toContainText("General / Page");

  const resultsAccessibility = await new AxeBuilder({ page }).include(".search-view").analyze();
  expect(
    resultsAccessibility.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
});

test("exports and imports Markdown through resumable jobs", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: /Export “Welcome”/ });
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole("button", { name: "Start export" }).click();

  const activities = page.getByRole("dialog", { name: "Activities" });
  await expect(activities).toBeVisible();
  const exportJob = activities.locator(".activity-list > li").first();
  await expect(exportJob).toContainText("Export");
  await expect(exportJob.locator(".job-status")).toHaveText("succeeded", { timeout: 30_000 });
  await expect(exportJob.getByRole("link", { name: "Download" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Import/ }).click();
  const importDialog = page.getByRole("dialog", { name: "Import notes" });
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: "browser-import.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Browser import\n\nImported through the browser workflow."),
  });
  await importDialog.getByRole("button", { name: "Upload and inspect" }).click();

  await expect(activities).toBeVisible();
  const importJob = activities.locator(".activity-list > li").first();
  await expect(importJob).toContainText("Import");
  await expect(importJob.locator(".job-status")).toHaveText("awaiting confirmation", { timeout: 30_000 });
  await expect(importJob.getByText("Pages").locator("..").getByText("1", { exact: true })).toBeVisible();
  await importJob.getByRole("button", { name: "Confirm import" }).click();
  await expect(importJob.locator(".job-status")).toHaveText("succeeded", { timeout: 30_000 });
  await importJob.getByRole("button", { name: "Open page" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("browser-import");
  await expect(page.locator(".bn-editor")).toContainText("Imported through the browser workflow.");
});

test("creates, renames, archives, and restores a page through the UI @mobile-sidebar", async ({ page }, testInfo) => {
  await signIn(page);
  const title = `Lifecycle ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole("button", { name: "+ Page", exact: true }).click();
  const titleInput = page.getByLabel("Page title");
  await expect(titleInput).toHaveValue("Untitled");
  await titleInput.fill(title);
  await titleInput.press("Enter");
  // Creating a page closes the mobile drawer, and the tree lives inside it.
  await openSidebar(page);
  // Calling the helper for an already-open drawer must not click through its scrim.
  await openSidebar(page);
  if (testInfo.project.name === "mobile-chromium") await expect(page.locator(".sidebar-scrim")).toBeVisible();
  const pageLink = treeLink(page, title);
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
    await expect(treeLink(editorPage, title)).toBeVisible({ timeout: 15_000 });
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

  // "+ Table" is hidden below the 760px breakpoint, so the lease half of this
  // scenario has no mobile entry point. The viewer assertions above still run
  // everywhere; skipping here keeps viewerContext.close() above it.
  test.skip(testInfo.project.name === "mobile-chromium", "+ Table is hidden at mobile widths");

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
    await treeLink(editorPage, tableTitle).click();
    await expect(editorPage.getByText("Another editor has this table open for editing.")).toBeVisible();
  } finally {
    await editorContext.close();
  }
});
