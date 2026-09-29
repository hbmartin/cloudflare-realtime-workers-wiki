import { expect, test } from "@playwright/test";

test("installed app shell opens offline without caching API responses", async ({ page, context }) => {
  const workerScript = await page.request.get("/sw.js");
  expect(workerScript.ok()).toBe(true);
  expect(workerScript.headers()["cache-control"]).toContain("no-cache");
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const shellCache = await page.evaluate(async () => {
    const keys = await caches.keys();
    const key = keys.find((candidate) => candidate.startsWith("noteflare-shell-"));
    if (!key) return null;
    const cache = await caches.open(key);
    const requests = await cache.keys();
    return requests.map((request) => new URL(request.url).pathname);
  });
  expect(shellCache).toContain("/");
  expect(shellCache).toContain("/manifest.webmanifest");
  expect(shellCache?.some((path) => path.startsWith("/api/"))).toBe(false);
  expect(await page.evaluate(async () => Boolean(await caches.match("/")))).toBe(true);

  const onlineResponse = await page.reload({ waitUntil: "domcontentloaded" });
  expect(onlineResponse?.fromServiceWorker()).toBe(true);

  await context.setOffline(true);
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("NoteFlare");
  expect(
    await page.evaluate(async () => {
      try {
        await fetch("/api/me");
        return "cached";
      } catch {
        return "offline";
      }
    }),
  ).toBe("offline");

  await page.close();
  const reopened = await context.newPage();
  const coldResponse = await reopened.goto("/", { waitUntil: "domcontentloaded" });
  expect(coldResponse?.fromServiceWorker()).toBe(true);
  await expect(reopened).toHaveTitle("NoteFlare");
});
