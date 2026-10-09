import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signInOwner } from "./security-helpers";
import type { AiConversation, AiGenerate, AiStatus } from "../../src/shared/ai";
import type { Page } from "../../src/shared/types";

test("writing streams into a read-only preview, applies with undo, preserves conflicts, and opens private history", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signInOwner(page);
  const tree = (await (await page.request.get("/api/pages/tree")).json()) as { pages: Page[] };
  const created = await page.request.post("/api/pages", {
    data: { kind: "document", title: `Writing acceptance ${Date.now()}`, spaceId: tree.pages[0]!.spaceId },
  });
  expect(created.ok()).toBe(true);
  const document = ((await created.json()) as { page: Page }).page;
  const status: AiStatus = {
    settings: {
      enabled: true,
      apiEnabled: true,
      dailyQuota: 20,
      models: {
        api: { fast: { id: "mock-fast", maxCharacters: 10000 }, best: { id: "mock-best", maxCharacters: 10000 } },
        chatgpt: { fast: { id: "", maxCharacters: 10000 }, best: { id: "", maxCharacters: 10000 } },
      },
    },
    chatgptConfigured: false,
    apiConfigured: true,
    connected: false,
    accountLabel: null,
    preference: null,
    quota: { remaining: 20, limit: 20, resetsAt: Date.now() + 86400000 },
  };
  let saved: AiConversation | null = null,
    requests = 0;
  await page.route("**/api/ai/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/ai/status") return route.fulfill({ json: status });
    if (path === "/api/ai/models") return route.fulfill({ json: { fast: true, best: true } });
    if (path === "/api/ai/generate") {
      const input = route.request().postDataJSON() as AiGenerate;
      expect(input.funding).toBe("api");
      expect(input.quality).toBe("fast");
      requests++;
      const sources = [
        {
          pageId: document.id,
          title: document.title,
          url: `/?page=${document.id}`,
          kind: "document" as const,
          revision: 1,
          contentEpoch: document.contentEpoch,
          sequence: 1,
        },
      ];
      const output = "## Improved draft\n\nClear **writing** result.";
      saved = {
        id: "browser-conversation",
        pageId: document.id,
        title: "Browser writing",
        locked: false,
        updatedAt: Date.now(),
        expiresAt: Date.now() + 30 * 86400000,
        sources: input.sources,
        messages: [
          {
            id: input.operationId,
            action: input.action,
            prompt: input.prompt,
            output,
            status: "complete",
            funding: input.funding,
            quality: input.quality,
            sources,
            createdAt: Date.now(),
          },
        ],
      };
      const events = [
        {
          type: "start",
          conversationId: saved.id,
          messageId: input.operationId,
          sources,
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        },
        { type: "delta", text: output },
        { type: "complete" },
      ];
      return route.fulfill({
        contentType: "text/event-stream",
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      });
    }
    if (path.endsWith("/apply-check"))
      return route.fulfill({ json: { contentEpoch: document.contentEpoch, protectedBlockIds: [] } });
    if (path === "/api/ai/conversations")
      return route.fulfill({ json: { conversations: saved ? [saved] : [], nextCursor: null } });
    if (path.includes("/conversations/"))
      return route.fulfill({ json: path.endsWith("/access") ? { locked: false } : { conversation: saved } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?page=${document.id}`);
  const editor = page.locator('.notes-editor [contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.fill("Original writing source.");
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/pages/${document.id}/content`)).json()))
    .toContain("Original writing source.");
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.locator(".action-menu-portal").getByRole("button", { name: "Writing", exact: true }).click();
  const writing = page.getByRole("complementary", { name: "AI writing" });
  await expect(writing).toBeVisible();
  await writing.getByLabel("Workspace API").check();
  await expect(writing.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await writing.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(writing.getByRole("heading", { name: "Improved draft" }).first()).toBeVisible();
  await expect(writing.locator('[contenteditable="true"]')).toHaveCount(0);
  await writing.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(editor).toContainText("Clear writing result.");
  await writing.getByRole("button", { name: "Close writing" }).click();
  await editor.click();
  await page.keyboard.press(
    await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta+z" : "Control+z")),
  );
  await expect(editor).toContainText("Original writing source.");
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.locator(".action-menu-portal").getByRole("button", { name: "Writing", exact: true }).click();
  await writing.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/pages/${document.id}/content`)).json()))
    .toContain("Original writing source.");
  await writing.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(writing.getByRole("button", { name: "Replace", exact: true })).toBeEnabled();
  await writing.getByRole("button", { name: "Close writing" }).click();
  await editor.fill("Collaborator changed this source.");
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.locator(".action-menu-portal").getByRole("button", { name: "Writing", exact: true }).click();
  await writing.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(writing.getByRole("alert")).toContainText("target changed");
  await expect(editor).toContainText("Collaborator changed this source.");
  await writing.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(editor).toContainText("Collaborator changed this source.");
  await expect(editor).toContainText("Clear writing result.");
  expect(requests).toBe(2);
  const accessibility = await new AxeBuilder({ page }).include(".writing-panel").analyze();
  expect(accessibility.violations).toEqual([]);
  await writing.getByRole("button", { name: "Close writing" }).click();
  const navigation = page.getByRole("button", { name: "Open navigation" });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("button", { name: "My writing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My writing library" })).toBeVisible();
  await page.getByRole("button", { name: "Browser writing", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "AI writing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace", exact: true })).toBeDisabled();
  await writing.getByRole("button", { name: "Close writing" }).click();
  await editor.click();
  await page.keyboard.press(
    await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta+a" : "Control+a")),
  );
  await page.getByRole("button", { name: "Writing with selection", exact: true }).click();
  await expect(writing.getByText("Selected text", { exact: true })).toBeVisible();
  await expect(writing.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  await writing.getByRole("button", { name: "Close writing" }).click();
  await editor.click();
  await page.keyboard.press(
    await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta+End" : "Control+End")),
  );
  await page.keyboard.press("Enter");
  await page.keyboard.type("/ai");
  await page.getByRole("option", { name: /AI writing/ }).click();
  await expect(writing).toBeVisible();
  await expect(writing.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
});
