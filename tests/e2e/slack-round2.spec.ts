import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signInOwner } from "./security-helpers";
import { CHANNEL_EVENT_TYPES } from "../../src/shared/activity";

test("workspace Activity records mutations and shows current open work without Slack", async ({ page }) => {
  await signInOwner(page);
  const title = `Activity regression ${Date.now()}`;
  const created = await page.request.post("/api/pages", { data: { kind: "document", title } });
  expect(created.status()).toBe(201);
  const result = (await created.json()) as { page: { id: string; spaceId: string } };
  const comment = await page.request.post(`/api/pages/${result.page.id}/comments`, {
    data: {
      initialComment: {
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Please review" }] }] },
      },
    },
  });
  expect(comment.ok(), await comment.text()).toBe(true);
  await page.reload();
  if (test.info().project.name === "mobile-chromium")
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Workspace activity" });
  await expect(activity.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(activity.getByRole("button", { name: title, exact: true }).first()).toBeVisible();
  await activity.getByRole("combobox", { name: "Page", exact: true }).selectOption(result.page.id);
  await activity.getByRole("tab", { name: "Open work", exact: true }).click();
  await expect(activity.getByRole("button", { name: title, exact: true })).toHaveCount(1);
  await expect(activity.getByRole("button", { name: title, exact: true })).toBeVisible();
  await expect(activity).toContainText("1 unresolved threads");
  const audit = await new AxeBuilder({ page }).include(".activity-view").analyze();
  expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await activity.getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByLabel("Page title")).toHaveValue(title);
});

test("Slack owners find later-page channels and edit daily mapping settings", async ({ page }) => {
  await signInOwner(page);
  let saved: Record<string, unknown> | undefined;
  let updated: Record<string, unknown> | undefined;
  const subscriptions: Record<string, unknown>[] = [];
  await page.route("**/api/slack/status", (route) =>
    route.fulfill({
      json: {
        available: true,
        missing: [],
        linked: true,
        identity: { state: "verified", slackUserId: "UOWNER", verifiedAt: 1 },
        installation: {
          connected: true,
          teamId: "T123",
          teamName: "Test Slack",
          botUserId: "B123",
          scopes: [],
          createdAt: 1,
          updatedAt: 1,
        },
        round2: { channels: true, shares: true, richDigests: true, defaultTimezone: "America/Los_Angeles" },
      },
    }),
  );
  await page.route("**/api/slack/delivery-health", (route) => route.fulfill({ json: { orphanedFailures: [] } }));
  await page.route("**/api/slack/channel-directory*", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).searchParams.has("cursor")
        ? { channels: [{ id: "GSECOND", name: "launch-private", private: true }], nextCursor: null }
        : { channels: [{ id: "CFIRST", name: "general", private: false }], nextCursor: "second-page" },
    }),
  );
  await page.route("**/api/slack/channels", async (route) => {
    if (route.request().method() === "POST") {
      saved = route.request().postDataJSON() as Record<string, unknown>;
      subscriptions.push({
        ...saved,
        id: "round2-mapping",
        channelName: "launch-private",
        validationState: "valid",
        mutedAt: 1,
        mirrorEnabled: false,
      });
      await route.fulfill({ json: { subscription: subscriptions[0] } });
    } else await route.fulfill({ json: { subscriptions } });
  });
  await page.route("**/api/slack/channels/round2-mapping", async (route) => {
    updated = route.request().postDataJSON() as Record<string, unknown>;
    Object.assign(subscriptions[0]!, updated);
    await route.fulfill({ json: { subscription: subscriptions[0] } });
  });
  if (test.info().project.name === "mobile-chromium")
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Members & settings", exact: true }).click();
  const slack = page.getByRole("region", { name: "Slack", exact: true });
  await slack.getByLabel("Search Slack channels").fill("launch");
  await expect(slack.getByRole("option", { name: "Private #launch-private" })).toBeAttached();
  await slack.getByRole("combobox", { name: "Slack channel", exact: true }).selectOption("GSECOND");
  await slack.getByRole("combobox", { name: "Cadence", exact: true }).selectOption("digest");
  await slack.getByRole("button", { name: "Save channel mapping" }).click();
  await expect(slack).toContainText("Slack channel mapping saved.");
  expect(saved).toMatchObject({
    channelId: "GSECOND",
    digestTime: "09:00",
    digestTimezone: "America/Los_Angeles",
    digestOpenWork: true,
    eventTypes: [...CHANNEL_EVENT_TYPES],
  });
  const editor = slack.locator("details");
  await editor.locator("summary").click();
  await editor.getByLabel("Daily send time").fill("17:45");
  await editor.getByLabel("Include unresolved comments and unfinished tasks").uncheck();
  await editor.getByRole("button", { name: "Save mapping settings" }).click();
  await expect.poll(() => updated).toMatchObject({ digestTime: "17:45", digestOpenWork: false });
  await expect(slack).toContainText("Muted until you unmute this mapping.");
  const audit = await new AxeBuilder({ page }).include(".slack-settings").analyze();
  expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
