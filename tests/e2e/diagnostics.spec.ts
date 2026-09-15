import { expect, test } from "@playwright/test";

test("restores inherited session storage after the blocked-storage diagnostic", async ({ page }) => {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    if (!descriptor) return;
    Object.defineProperty(Object.getPrototypeOf(window), "sessionStorage", descriptor);
    Reflect.deleteProperty(window, "sessionStorage");
  });
  await page.goto("/tests/diagnostics/login.html");
  await expect(page.getByRole("heading", { name: "Login startup diagnostics" })).toBeVisible();

  await page.getByLabel("Scenario").selectOption("storage");
  await page.getByRole("button", { name: "Run scenario" }).click();
  await expect(page.getByLabel("Diagnostic results")).toContainText("SecurityError");

  await page.getByRole("button", { name: "Probe browser storage" }).click();
  await expect
    .poll(async () => JSON.parse((await page.getByLabel("Diagnostic results").textContent()) || "[]"))
    .toEqual([
      { check: "localStorage", outcome: "PASS" },
      { check: "sessionStorage", outcome: "PASS" },
    ]);
});
