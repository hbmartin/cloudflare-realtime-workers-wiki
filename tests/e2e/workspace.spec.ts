import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signInOwner } from "./security-helpers";

test("task values stay consistent across table, board, My Tasks, and locked retries", async ({ page, browser }) => {
  await signInOwner(page);
  await page.getByRole("button", { name: /^New page in / }).click();
  await page.getByRole("button", { name: "Task List", exact: true }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Untitled tasks");
  const title = `Release tasks ${Date.now()}`;
  await page.getByLabel("Page title").fill(title);
  await page.getByLabel("Page title").press("Tab");
  await expect(page.getByRole("treeitem", { name: title, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit tasks", exact: true }).click();
  const taskTitle = `Ship the coordinated release ${Date.now()}`;
  await page.getByLabel("New task title").fill(taskTitle);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel(`Assignee for ${taskTitle}`).selectOption({ label: "E2E Owner" });
  await expect(page.getByLabel(`Status for ${taskTitle}`)).toBeEnabled();
  await page.getByLabel(`Status for ${taskTitle}`).selectOption("doing");
  await expect(page.getByLabel(`Due date for ${taskTitle}`)).toBeEnabled();
  await page.getByLabel(`Due date for ${taskTitle}`).fill("2026-10-01");
  await expect(page.getByLabel(`Due date for ${taskTitle}`)).toHaveValue("2026-10-01");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "In progress", exact: true }).getByRole("button", { name: taskTitle }),
  ).toBeVisible();
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await signInOwner(second);
    await second.getByRole("button", { name: "My Tasks", exact: true }).click();
    await expect(second.getByLabel(`Due date for ${taskTitle}`)).toHaveValue("2026-10-01");
    await second.getByLabel(`Status for ${taskTitle}`).selectOption("done");
    await expect(second.getByRole("alert")).toContainText("editing");
    await page.getByRole("button", { name: "Finish editing", exact: true }).click();
    await second.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(second.getByLabel(`Status for ${taskTitle}`)).toHaveValue("done");
    await expect(second.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: taskTitle }),
    ).toBeVisible();
    await second.getByRole("button", { name: taskTitle, exact: true }).click();
    await expect(second.getByLabel("Page title")).toHaveValue(taskTitle);
    await expect(second.getByLabel("Page title")).toHaveAttribute("readonly");
    await second.locator(".bn-editor[contenteditable=true]").fill("Release details remain collaborative.");
    await second.reload();
    await expect(second.locator(".bn-editor")).toContainText("Release details remain collaborative.");
  } finally {
    await other.close();
  }
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("finds nested pages by keyboard, creates a child, and resumes after reload", async ({ page }) => {
  await signInOwner(page);
  const stamp = Date.now();
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const spaceId = await page.getByLabel("Current space").inputValue();
  for (const [index, id] of ids.entries()) {
    const response = await page.request.post("/api/pages", {
      data: {
        id,
        kind: "document",
        spaceId,
        parentId: index ? ids[index - 1] : null,
        title: `Nested ${index} ${stamp}`,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Find a page" }).fill(`Nested 2 ${stamp}`);
  await page.getByRole("combobox", { name: "Find a page" }).press("Enter");
  await expect(page.getByLabel("Page title")).toHaveValue(`Nested 2 ${stamp}`);
  await page.getByRole("button", { name: `Add child to Nested 2 ${stamp}`, exact: true }).click();
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Untitled");
  await page.getByLabel("Page title").fill(`Child ${stamp}`);
  await page.getByLabel("Page title").press("Enter");
  await expect(page.getByRole("treeitem", { name: `Child ${stamp}`, exact: true })).toBeVisible();
  await page.locator(".bn-editor[contenteditable=true]").fill("A useful nested document.");
  await page.reload();
  await expect(page.getByLabel("Page title")).toHaveValue(`Child ${stamp}`);
  await expect(page.locator(".bn-editor")).toContainText("A useful nested document.");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("main").getByRole("button", { name: `Child ${stamp}`, exact: true })).toBeVisible();
});

test("keeps documents and the page panel usable at phone, tablet, and desktop widths", async ({ page }) => {
  test.setTimeout(90000);
  await signInOwner(page);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["Light", "Dark"]) {
      const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
      if (await navigation.isVisible()) await navigation.click();
      for (let attempt = 0; attempt < 3; attempt++) {
        const toggle = page.getByRole("button", { name: /^Theme:/ });
        if ((await toggle.getAttribute("aria-label"))?.startsWith(`Theme: ${theme}.`)) break;
        await toggle.click();
      }
      const close = page.getByRole("button", { name: "Close navigation", exact: true });
      if (await close.isVisible()) await close.click();
      await expect(page.getByLabel("Page title")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Page details", exact: true }).click();
      await page.getByRole("button", { name: "Comments", exact: true }).click();
      await expect(page.getByRole("button", { name: "Close page panel", exact: true })).toBeInViewport();
      await page.screenshot({ path: `test-results/workspace-${width}-${theme.toLowerCase()}.png` });
      const audit = await new AxeBuilder({ page }).exclude(".bn-editor").analyze();
      expect(audit.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
      await page.getByRole("button", { name: "Close page panel", exact: true }).click();
    }
  }
});
