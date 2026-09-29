import { expect, test } from "@playwright/test";
import { signInOwner } from "./security-helpers";

test("date picker leaves no token on cancel and edits a saved token", async ({ page }) => {
  await signInOwner(page);
  const previousPage = new URL(page.url()).searchParams.get("page");
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
  await page.waitForURL((url) =>
    Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
  );
  const editor = page.locator(".bn-editor");
  await editor.click();
  await page.keyboard.type("@");
  await page.getByText("Choose date…").click();
  const insert = page.getByRole("dialog", { name: "Insert date mention" });
  await expect(insert).toBeVisible();
  const originalDate = await insert.getByLabel("Date", { exact: true }).inputValue();
  await insert.getByLabel("Date phrase").fill("next Friday");
  await expect(insert.getByLabel("Date", { exact: true })).not.toHaveValue(originalDate);
  await insert.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: /Date:/ })).toHaveCount(0);

  await editor.click();
  await page.keyboard.type("@");
  await page.getByText("Choose date…").click();
  await insert.getByLabel("Date", { exact: true }).fill("2026-10-10");
  await insert.getByRole("button", { name: "Save date" }).click();
  const chip = page.getByRole("button", { name: /Date:.*Oct 10, 2026/ });
  await expect(chip).toBeVisible();
  const secondTab = await page.context().newPage();
  await secondTab.goto(page.url());
  await expect(secondTab.getByRole("button", { name: /Date:.*Oct 10, 2026/ })).toBeVisible();
  await chip.click();
  const edit = page.getByRole("dialog", { name: "Edit date mention" });
  await expect(edit).toBeVisible();
  await edit.getByLabel("Date", { exact: true }).fill("2026-10-11");
  await edit.getByRole("button", { name: "Save date" }).click();
  await expect(page.getByRole("button", { name: /Date:.*Oct 11, 2026/ })).toBeVisible();
  await expect(secondTab.getByRole("button", { name: /Date:.*Oct 11, 2026/ })).toBeVisible();

  await page.getByRole("button", { name: /Remind me about/ }).click();
  const reminder = page.getByRole("dialog", { name: "Remind me" });
  await expect(reminder).toBeVisible();
  const saving = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().includes("/date-reminders/"),
  );
  await reminder.getByRole("button", { name: "Save reminder" }).click();
  const saved = await saving;
  expect(saved.status()).toBe(200);
  const path = new URL(saved.url()).pathname;
  const read = await page.evaluate(async (reminderPath) => (await fetch(reminderPath)).json(), path);
  expect(read.reminder).toMatchObject({ generation: 1, state: "active" });

  await page.getByRole("button", { name: /Remind me about/ }).click();
  await expect(reminder.getByRole("button", { name: "Remove reminder" })).toBeVisible();
  await reminder.getByRole("button", { name: "Remove reminder" }).click();
  await expect(reminder).toBeHidden();
  const removed = await page.evaluate(async (reminderPath) => (await fetch(reminderPath)).json(), path);
  expect(removed.reminder).toBeNull();
  await secondTab.close();
});
