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
  await insert.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: /Date:/ })).toHaveCount(0);

  await editor.click();
  await page.keyboard.type("@");
  await page.getByText("Choose date…").click();
  await insert.getByLabel("Date").fill("2026-10-10");
  await insert.getByRole("button", { name: "Save date" }).click();
  const chip = page.getByRole("button", { name: /Date:.*Oct 10, 2026/ });
  await expect(chip).toBeVisible();
  await chip.click();
  const edit = page.getByRole("dialog", { name: "Edit date mention" });
  await expect(edit).toBeVisible();
  await edit.getByLabel("Date").fill("2026-10-11");
  await edit.getByRole("button", { name: "Save date" }).click();
  await expect(page.getByRole("button", { name: /Date:.*Oct 11, 2026/ })).toBeVisible();
});
