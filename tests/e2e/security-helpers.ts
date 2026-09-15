import { expect, type Page } from "@playwright/test";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ownerCookies = ".wrangler/e2e/owner-cookies.json";
const WORKSPACE_READY_TIMEOUT_MS = 20_000;

export async function completeEnrollment(page: Page, trust = false) {
  await expect(page.getByRole("heading", { name: "Protect your account" })).toBeVisible();
  await page.getByLabel("Account password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  await expect(page.getByLabel("Setup key")).toBeVisible();
  const secret = new TextDecoder().decode(base32.decode(await page.getByLabel("Setup key").inputValue()));
  await page.getByLabel("Authenticator code").fill(await createOTP(secret).totp());
  if (trust) await page.getByLabel("Trust this browser for 30 days").check();
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await page.getByLabel("I saved my recovery codes").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

export async function signInOwner(page: Page) {
  const { initialized } = (await page.request.get("/api/install").then((response) => response.json())) as {
    initialized: boolean;
  };
  if (initialized && existsSync(ownerCookies))
    await page.context().addCookies(JSON.parse(readFileSync(ownerCookies, "utf8")));
  await page.goto("/");
  if (!initialized) {
    await page.getByLabel("Workspace name").fill("E2E Notes");
    await page.getByLabel("Your name").fill("E2E Owner");
    await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByLabel("Bootstrap token").fill("e2e-bootstrap-token");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await completeEnrollment(page, true);
  } else {
    const heading = page.getByRole("heading", { name: "Sign in", exact: true });
    await expect(heading.or(page.getByLabel("Page title")).first()).toBeVisible({
      timeout: WORKSPACE_READY_TIMEOUT_MS,
    });
    if (await heading.isVisible()) {
      await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
      await page.getByLabel("Password", { exact: true }).fill("password123");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
  }
  await expect(page.getByLabel("Page title")).toBeVisible({ timeout: WORKSPACE_READY_TIMEOUT_MS });
  writeFileSync(ownerCookies, JSON.stringify(await page.context().cookies()), { mode: 0o600 });
}
