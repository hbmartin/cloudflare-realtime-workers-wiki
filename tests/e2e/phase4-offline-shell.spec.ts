import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

test("installed app shell opens offline without caching API responses", async ({ page, context }) => {
  const workerScript = await page.request.get("/sw.js");
  expect(workerScript.ok()).toBe(true);
  expect(workerScript.headers()["cache-control"]).toContain("no-cache");
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 })
    .toBe(true);

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
  expect(shellCache?.length).toBeLessThan(70);
  expect(shellCache?.some((path) => path.startsWith("/api/"))).toBe(false);
  expect(await page.evaluate(async () => Boolean(await caches.match("/")))).toBe(true);

  const onlineResponse = await page.reload({ waitUntil: "domcontentloaded" });
  expect(onlineResponse?.fromServiceWorker()).toBe(true);
  await page.evaluate(async () => {
    await fetch("/assets/missing-version.js").catch(() => undefined);
  });
  expect(await page.evaluate(async () => Boolean(await caches.match("/assets/missing-version.js")))).toBe(false);

  await context.setOffline(true);
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("NoteFlare");
  await expect(page.getByRole("heading", { name: "NoteFlare is unavailable" })).toBeVisible();
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
  await expect(reopened.getByRole("heading", { name: "NoteFlare is unavailable" })).toBeVisible();
});

test("retires the shell cache when the worker script is removed", async ({ page, context }) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 })
    .toBe(true);
  await context.route("**/sw.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>NoteFlare</title>" }),
  );
  await context.route("http://localhost:4173/", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>NoteFlare</title><body>Rollback</body>" }),
  );
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page.getByText("Rollback")).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(await page.evaluate(async () => (await caches.keys()).some((key) => key.startsWith("noteflare-shell-")))).toBe(
    false,
  );
});
