import { expect, test } from "@playwright/test";
import { signInOwner } from "./security-helpers";

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
  expect(shellCache?.length).toBeLessThan(90);
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
  await expect(page.getByRole("heading", { name: "Offline access locked" })).toBeVisible();
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
  await expect(reopened.getByRole("heading", { name: "Offline access locked" })).toBeVisible();
});

test("retires the shell cache when the worker script is removed", async ({ page, context }) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 })
    .toBe(true);
  await context.route("**/sw.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: '<title>Older release</title><div id="root"></div>' }),
  );
  await context.route("**/assets/rollback.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "window.rollbackAssetLoaded = true" }),
  );
  await context.route(`${new URL(page.url()).origin}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<title>Older release</title><body><div id="root">Rollback</div><script src="/assets/rollback.js"></script></body>',
    }),
  );
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page.getByText("Rollback")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as Window & { rollbackAssetLoaded?: boolean }).rollbackAssetLoaded)),
    )
    .toBe(true);
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(await page.evaluate(async () => (await caches.keys()).some((key) => key.startsWith("noteflare-shell-")))).toBe(
    false,
  );
});

test("opens two visited documents offline and keeps local edits through refresh", async ({ page, context }) => {
  await signInOwner(page);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 })
    .toBe(true);
  for (const [title, text] of [
    ["Offline alpha", "First online copy"],
    ["Offline beta", "Second online copy"],
  ] as const) {
    const previousPage = new URL(page.url()).searchParams.get("page");
    await page.getByRole("button", { name: /Find a page or command/ }).click();
    await page
      .getByRole("dialog", { name: "Find a page or command" })
      .getByRole("option", { name: /Create document/ })
      .click();
    await page.waitForURL((url) =>
      Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
    );
    const heading = page.getByLabel("Page title");
    await expect(heading).toHaveValue("Untitled");
    await heading.fill(title);
    await heading.blur();
    await expect(page.locator(`[data-tree-page="${new URL(page.url()).searchParams.get("page")}"]`)).toContainText(
      title,
    );
    await page.locator(".bn-editor").click();
    await page.keyboard.type(text);
    await expect(page.locator(".bn-editor")).toContainText(text);
  }
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () => reject(request.error));
        });
        const transaction = db.transaction("pages", "readonly");
        const pages = transaction.objectStore("pages").getAll();
        const result = await new Promise<Array<{ title: string }>>((resolve, reject) => {
          pages.addEventListener("success", () => resolve(pages.result));
          pages.addEventListener("error", () => reject(pages.error));
        });
        db.close();
        return result.filter((item) => item.title.startsWith("Offline ")).length;
      }),
    )
    .toBe(2);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Available offline" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Offline alpha/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Offline beta/ })).toBeVisible();
  await page.getByRole("button", { name: /Offline beta/ }).click();
  await expect(page.locator(".offline-document .bn-editor")).toContainText("Second online copy");
  await page.locator(".offline-document .bn-editor").click();
  await page.keyboard.type(" with a local edit");
  await expect(page.locator(".offline-document .bn-editor")).toContainText("local edit");
  await expect(page.getByText("Saved locally · pending server sync")).toBeVisible();
  await page.reload();
  await expect(page.locator(".offline-document .bn-editor")).toContainText("local edit");
  const selectedPageId = new URL(page.url()).searchParams.get("page");
  await page.route(`**/api/pages/${selectedPageId}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { page: { contentEpoch: number } };
    await route.fulfill({
      response,
      json: { ...body, page: { ...body.page, contentEpoch: body.page.contentEpoch + 1 } },
    });
  });
  await context.setOffline(false);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(
    page.getByText("Your access or this document's version changed. The local copy is preserved for export."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Markdown" })).toBeVisible();
  await page.unroute(`**/api/pages/${selectedPageId}`);
  await page.route("**/api/spaces", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { spaces: Array<{ effectiveRole: string }> };
    await route.fulfill({
      response,
      json: { spaces: body.spaces.map((space) => ({ ...space, effectiveRole: "viewer" })) },
    });
  });
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(
    page.getByText("Your access or this document's version changed. The local copy is preserved for export."),
  ).toBeVisible();
  await page.unroute("**/api/spaces");
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByLabel("Page title")).toHaveValue("Offline beta", { timeout: 30_000 });
  await expect(page.locator(".bn-editor")).toContainText("local edit");
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const opened = indexedDB.open("noteflare-offline-catalog");
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            opened.addEventListener("success", () => resolve(opened.result));
            opened.addEventListener("error", () => reject(opened.error));
          });
          const request = db.transaction("pages", "readonly").objectStore("pages").getAll();
          const entries = await new Promise<Array<{ title: string; pendingChanges?: boolean }>>((resolve, reject) => {
            request.addEventListener("success", () => resolve(request.result));
            request.addEventListener("error", () => reject(request.error));
          });
          db.close();
          return entries.find((item) => item.title === "Offline beta")?.pendingChanges;
        }),
      { timeout: 30_000 },
    )
    .toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Available offline" })).toBeVisible();
  await page.evaluate(async () => {
    const opened = indexedDB.open("noteflare-offline-catalog");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.addEventListener("success", () => resolve(opened.result));
      opened.addEventListener("error", () => reject(opened.error));
    });
    const request = db.transaction("pages", "readonly").objectStore("pages").getAll();
    const pages = await new Promise<Array<{ title: string; storageKeys: string[] }>>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    db.close();
    const key = pages.find((item) => item.title === "Offline alpha")?.storageKeys.at(-1);
    if (!key) throw new Error("The first offline document was not cached.");
    const removed = indexedDB.deleteDatabase(key);
    await new Promise<void>((resolve, reject) => {
      removed.addEventListener("success", () => resolve());
      removed.addEventListener("error", () => reject(removed.error));
      removed.addEventListener("blocked", () => reject(new Error("Offline document storage is still open.")));
    });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: /Offline alpha/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out and remove local copies" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
  expect(
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      const catalog = indexedDB.open("noteflare-offline-catalog");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        catalog.addEventListener("success", () => resolve(catalog.result));
        catalog.addEventListener("error", () => reject(catalog.error));
      });
      const accounts = db.transaction("accounts", "readonly").objectStore("accounts").getAll();
      const result = await new Promise<unknown[]>((resolve, reject) => {
        accounts.addEventListener("success", () => resolve(accounts.result));
        accounts.addEventListener("error", () => reject(accounts.error));
      });
      db.close();
      return { accounts: result.length, copies: databases.filter((item) => item.name?.startsWith("account:")).length };
    }),
  ).toEqual({ accounts: 0, copies: 0 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("shows an online-required state for table and diagram links", async ({ page, context }) => {
  await signInOwner(page);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 })
    .toBe(true);
  const ids: string[] = [];
  for (const command of ["Create table", "Create diagram"]) {
    const previousPage = new URL(page.url()).searchParams.get("page");
    await page.getByRole("button", { name: /Find a page or command/ }).click();
    await page.getByRole("dialog", { name: "Find a page or command" }).getByRole("option", { name: command }).click();
    await page.waitForURL((url) =>
      Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
    );
    ids.push(new URL(page.url()).searchParams.get("page")!);
  }
  await context.setOffline(true);
  for (const id of ids) {
    await page.goto(`/?page=${id}`);
    await expect(
      page.getByText("This page is unavailable offline. Tables, diagrams, and uncached documents need a connection."),
    ).toBeVisible();
    await expect(page.locator(".bn-editor")).toHaveCount(0);
  }
});
