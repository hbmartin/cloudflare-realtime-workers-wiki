import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signInOwner } from "./security-helpers";

test.setTimeout(90_000);

async function catalogContainsPageTitle(page: Page, title: string) {
  return page.evaluate(async (expected) => {
    const opened = indexedDB.open("noteflare-offline-catalog");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.addEventListener("upgradeneeded", () => opened.transaction?.abort(), { once: true });
      opened.addEventListener("success", () => resolve(opened.result), { once: true });
      opened.addEventListener("error", () => reject(opened.error), { once: true });
      opened.addEventListener("blocked", () => reject(new Error("Catalog is blocked.")), { once: true });
    });
    try {
      const request = db.transaction("pages", "readonly").objectStore("pages").getAll();
      const entries = await new Promise<Array<{ title: string }>>((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      return entries.some((entry) => entry.title === expected);
    } finally {
      db.close();
    }
  }, title);
}

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
  await page.keyboard.type(" quick switch");
  await page.getByRole("button", { name: /Offline alpha/ }).click();
  await page.getByRole("button", { name: /Offline beta/ }).click();
  await expect(page.locator(".offline-document .bn-editor")).toContainText("quick switch");
  await page.locator(".offline-document .bn-editor").click();
  await page.keyboard.type(" with a local edit");
  await expect(page.locator(".offline-document .bn-editor")).toContainText("local edit");
  await expect(page.getByText("Saved locally · pending server sync")).toBeVisible();
  await page.reload();
  await expect(page.locator(".offline-document .bn-editor")).toContainText("local edit");
  await expect(page.locator(".offline-document .bn-editor")).toContainText("quick switch");
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
    page.getByText("This document's version changed. The local copy is preserved for export."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Markdown" })).toBeVisible();
  await page.unroute(`**/api/pages/${selectedPageId}`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByText("This document's version changed. The local copy is preserved for export."),
  ).toBeVisible();
  await expect(page.locator(".offline-document [contenteditable='true']")).toHaveCount(0);
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

test("retries a failed offline write without claiming a partial save", async ({ page, context }) => {
  await signInOwner(page);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 })
    .toBe(true);
  const previousPage = new URL(page.url()).searchParams.get("page");
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
  await page.waitForURL((url) =>
    Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
  );
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Online seed");
  await expect(page.locator(".bn-editor")).toContainText("Online seed");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        const read = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const entries = await new Promise<Array<{ pageId: string }>>((resolve) =>
          read.addEventListener("success", () => resolve(read.result)),
        );
        db.close();
        return entries.some((entry) => entry.pageId === id);
      }, new URL(page.url()).searchParams.get("page")),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Available offline" })).toBeVisible();
  await expect(page.locator(".offline-document .bn-editor")).toBeVisible();
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    let failOnce = true;
    IDBObjectStore.prototype.add = function (value, key) {
      if (this.name === "updates" && this.transaction.db.name.startsWith("account:") && failOnce) {
        failOnce = false;
        throw new DOMException("Storage is full", "QuotaExceededError");
      }
      return add.call(this, value, key);
    };
  });
  await page.locator(".offline-document .bn-editor").click();
  await page.keyboard.type("X");
  await expect(page.getByText("Local save failed. Export this copy before closing it.")).toBeVisible();
  await expect(page.getByText("Saved locally · pending server sync")).toHaveCount(0);
  await page.keyboard.type("Y");
  await expect(page.getByText("Saved locally · pending server sync")).toBeVisible();
  await page.reload();
  await expect(page.locator(".offline-document .bn-editor")).toContainText("Online seedXY");
});

test("recovers a saved draft when the catalog pending write fails", async ({ page, context }) => {
  await signInOwner(page);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const previousPage = new URL(page.url()).searchParams.get("page");
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
  await page.waitForURL((url) =>
    Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
  );
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Online seed");
  await expect(page.locator(".bn-editor")).toContainText("Online seed");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        const read = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const pages = await new Promise<Array<{ pageId: string; pendingChanges?: boolean }>>((resolve) =>
          read.addEventListener("success", () => resolve(read.result)),
        );
        db.close();
        return pages.some((entry) => entry.pageId === id && !entry.pendingChanges);
      }, new URL(page.url()).searchParams.get("page")),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".offline-document .bn-editor")).toBeVisible();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    let failOnce = true;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "pages" && this.transaction.db.name === "noteflare-offline-catalog" && failOnce) {
        failOnce = false;
        throw new DOMException("Catalog unavailable", "QuotaExceededError");
      }
      return put.call(this, value, key);
    };
  });
  await page.locator(".offline-document .bn-editor").click();
  await page.keyboard.type("Z");
  await expect(page.getByText("Local save failed. Export this copy before closing it.")).toBeVisible();
  await page.reload();
  await expect(page.locator(".offline-document .bn-editor")).toContainText("Online seedZ");
  await page.evaluate(async (id) => {
    const opened = indexedDB.open("noteflare-offline-catalog");
    const db = await new Promise<IDBDatabase>((resolve) =>
      opened.addEventListener("success", () => resolve(opened.result)),
    );
    const transaction = db.transaction("pages", "readwrite");
    const store = transaction.objectStore("pages");
    const entries = await new Promise<Array<{ key: string; pageId: string }>>((resolve) => {
      const request = store.getAll();
      request.addEventListener("success", () => resolve(request.result));
    });
    const entry = entries.find((candidate) => candidate.pageId === id);
    if (!entry) throw new Error("Expected an offline catalog entry.");
    store.delete(entry.key);
    await new Promise<void>((resolve) => transaction.addEventListener("complete", () => resolve()));
    db.close();
  }, pageId);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Recovered local draft" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out and remove local copies" }).click();
  await expect(page.getByRole("heading", { name: "Review local changes" })).toBeVisible();
  await expect(page.getByText("Recovered local draft", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Available offline" })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByRole("heading", { name: "Available offline" })).toHaveCount(0);
  await expect(page.locator(".bn-editor")).toContainText("Online seedZ");
});

test("keeps an online editor draft when its catalog write fails", async ({ page, context }) => {
  await signInOwner(page);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const previousPage = new URL(page.url()).searchParams.get("page");
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
  await page.waitForURL((url) =>
    Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
  );
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Online seed");
  await expect(page.locator(".bn-editor")).toContainText("Online seed");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        const read = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const pages = await new Promise<Array<{ pageId: string; pendingChanges?: boolean; storageKeys: string[] }>>(
          (resolve) => read.addEventListener("success", () => resolve(read.result)),
        );
        db.close();
        const entry = pages.find((item) => item.pageId === id);
        const key = entry?.storageKeys.at(-1);
        if (!entry || !key || entry.pendingChanges) return false;
        const documentRequest = indexedDB.open(key);
        const documentDb = await new Promise<IDBDatabase>((resolve) =>
          documentRequest.addEventListener("success", () => resolve(documentRequest.result)),
        );
        const marker = documentDb.transaction("custom", "readonly").objectStore("custom").get("noteflare-pending");
        const pending = await new Promise<boolean>((resolve) =>
          marker.addEventListener("success", () => resolve(Boolean(marker.result))),
        );
        documentDb.close();
        return !pending;
      }, pageId),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "pages" && this.transaction.db.name === "noteflare-offline-catalog") {
        throw new DOMException("Catalog unavailable", "QuotaExceededError");
      }
      return put.call(this, value, key);
    };
  });
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Z");
  await expect(
    page.getByText("Local changes are saved, but the offline page list could not be updated yet."),
  ).toBeVisible();
  await page.keyboard.type("Q");
  await page.reload();
  await expect(page.locator(".offline-document .bn-editor")).toContainText("Online seedZQ");
  await page.getByRole("button", { name: "Sign out and remove local copies" }).click();
  await expect(page.getByRole("heading", { name: "Review local changes" })).toBeVisible();
});

test("opens the online workspace from a quarantined offline draft", async ({ page, context }) => {
  await signInOwner(page);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const previousPage = new URL(page.url()).searchParams.get("page");
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
  await page.waitForURL((url) =>
    Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
  );
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Online seed");
  await expect(page.locator(".bn-editor")).toContainText("Online seed");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        const read = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const pages = await new Promise<Array<{ pageId: string; pendingChanges?: boolean }>>((resolve) =>
          read.addEventListener("success", () => resolve(read.result)),
        );
        db.close();
        return pages.some((entry) => entry.pageId === id && !entry.pendingChanges);
      }, pageId),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".offline-document .bn-editor")).toBeVisible();
  await page.locator(".offline-document .bn-editor").click();
  await page.keyboard.type(" offline draft");
  await expect(page.getByText("Saved locally · pending server sync")).toBeVisible();
  await page.route(`**/api/pages/${pageId}`, async (route) => {
    const upstream = await route.fetch();
    const body = (await upstream.json()) as { page: { contentEpoch: number } };
    body.page.contentEpoch += 1;
    await route.fulfill({ response: upstream, json: body });
  });
  await context.setOffline(false);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(
    page.getByText("This document's version changed. The local copy is preserved for export."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open online workspace" }).click();
  await expect(page.getByRole("navigation", { name: "Cached documents" })).toHaveCount(0);
  await expect(page.locator(`[data-tree-page="${pageId}"]`)).toBeVisible();
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

test("warns and offers export before offline sign-out removes pending edits", async ({ page, context }) => {
  await signInOwner(page);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 })
    .toBe(true);
  const previousPage = new URL(page.url()).searchParams.get("page");
  await page.getByRole("button", { name: /Find a page or command/ }).click();
  await page
    .getByRole("dialog", { name: "Find a page or command" })
    .getByRole("option", { name: /Create document/ })
    .click();
  await page.waitForURL((url) =>
    Boolean(url.searchParams.get("page") && url.searchParams.get("page") !== previousPage),
  );
  await page.getByLabel("Page title").fill("Pending sign-out draft");
  await page.getByLabel("Page title").blur();
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Online seed");
  await expect(page.locator(".bn-editor")).toContainText("Online seed");
  await expect.poll(() => catalogContainsPageTitle(page, "Pending sign-out draft")).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Available offline" })).toBeVisible();
  await page.locator(".offline-document .bn-editor").click();
  await page.keyboard.type(" unsynced");
  await expect(page.getByText("Saved locally · pending server sync")).toBeVisible();
  await page.getByRole("button", { name: "Sign out and remove local copies" }).click();
  await expect(page.getByRole("heading", { name: "Review local changes" })).toBeVisible();
  await expect(page.getByText("Pending sign-out draft")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export pending copies as Markdown" }).click();
  expect((await download).suggestedFilename()).toMatch(/noteflare-offline-copies-.*\.md/);
  await page.getByRole("button", { name: "Sign out and delete local copies" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("notes:local-signout"))).toBeTruthy();
  expect(
    await page.evaluate(
      async () => (await indexedDB.databases()).filter((entry) => entry.name?.startsWith("account:")).length,
    ),
  ).toBe(0);
});

test("can finish offline sign-out when database enumeration is unavailable", async ({ page, context }) => {
  await signInOwner(page);
  await page.getByLabel("Page title").fill("Enumeration fallback draft");
  await page.getByLabel("Page title").blur();
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Cached before sign-out");
  await expect(page.locator(".bn-editor")).toContainText("Cached before sign-out");
  await expect.poll(() => catalogContainsPageTitle(page, "Enumeration fallback draft")).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Available offline" })).toBeVisible();
  await page.evaluate(() => {
    const original = indexedDB.databases.bind(indexedDB);
    (window as Window & { restoreDatabases?: () => void }).restoreDatabases = () =>
      Object.defineProperty(indexedDB, "databases", { value: original, configurable: true });
    Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
  });
  await page.locator(".offline-document .bn-editor").click();
  await page.keyboard.type(" unsynced");
  await expect(page.getByText("Saved locally · pending server sync")).toBeVisible();
  await page.getByRole("button", { name: "Sign out and remove local copies" }).click();
  await expect(page.getByRole("heading", { name: "Review local changes" })).toBeVisible();
  await expect(page.getByText("Enumeration fallback draft")).toBeVisible();
  await page.getByRole("button", { name: "Sign out and delete local copies" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("may remain on this device");
  await context.addInitScript(() => {
    const original = indexedDB.databases.bind(indexedDB);
    (window as Window & { restoreDatabases?: () => void }).restoreDatabases = () =>
      Object.defineProperty(indexedDB, "databases", { value: original, configurable: true });
    Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("may remain on this device");
  await context.setOffline(false);
  await context.clearCookies();
  await page.evaluate(() => localStorage.removeItem("notes:local-signout"));
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(reopened.getByRole("status")).toContainText("may remain on this device");
  await reopened.close();
  expect(
    await page.evaluate(async () => {
      (window as Window & { restoreDatabases?: () => void }).restoreDatabases?.();
      return (await indexedDB.databases()).filter((entry) => entry.name?.startsWith("account:")).length;
    }),
  ).toBe(0);
});

test("removes document copies despite a corrupt legacy registry when enumeration works", async ({ page }) => {
  await signInOwner(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((key) => key.startsWith("noteflare-document-keys:") && key.includes("\u0000")),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const entry = Object.keys(localStorage).find(
      (key) => key.startsWith("noteflare-document-keys:") && key.includes("\u0000"),
    )!;
    const accountKey = entry.slice("noteflare-document-keys:".length).split("\u0000").slice(0, 2).join("\u0000");
    localStorage.setItem(`noteflare-document-keys:${accountKey}`, "corrupt legacy entry");
    localStorage.setItem(`noteflare-document-keys:${accountKey}\u0000unknown-key-format`, "1");
  });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(
    await page.evaluate(
      async () => (await indexedDB.databases()).filter((entry) => entry.name?.startsWith("account:")).length,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("noteflare-document-keys:"))),
  ).toEqual([]);
});

test("retains drafts from both epochs in the sign-out review", async ({ page, context }) => {
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
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await page.getByLabel("Page title").fill("Older epoch draft");
  await page.getByLabel("Page title").blur();
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Draft from prior epoch");
  await expect(page.locator(".bn-editor")).toContainText("Draft from prior epoch");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        const read = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const entries = await new Promise<Array<{ pageId: string }>>((resolve) =>
          read.addEventListener("success", () => resolve(read.result)),
        );
        db.close();
        return entries.some((entry) => entry.pageId === id);
      }, pageId),
    )
    .toBe(true);

  const olderKey = await page.evaluate(async (id) => {
    const catalogRequest = indexedDB.open("noteflare-offline-catalog");
    const catalog = await new Promise<IDBDatabase>((resolve) =>
      catalogRequest.addEventListener("success", () => resolve(catalogRequest.result)),
    );
    const read = catalog.transaction("pages", "readonly").objectStore("pages").getAll();
    const entries = await new Promise<Array<{ key: string; pageId: string; storageKeys: string[]; epoch: number }>>(
      (resolve) => read.addEventListener("success", () => resolve(read.result)),
    );
    const entry = entries.find((item) => item.pageId === id);
    if (!entry) throw new Error("Offline catalog entry is missing.");
    const currentKey = entry.storageKeys.at(-1)!;
    const draftKey = currentKey.replace(`:${entry.epoch}:2`, ":0:2");
    const sourceRequest = indexedDB.open(currentKey);
    const source = await new Promise<IDBDatabase>((resolve) =>
      sourceRequest.addEventListener("success", () => resolve(sourceRequest.result)),
    );
    const updatesRequest = source.transaction("updates", "readonly").objectStore("updates").getAll();
    const updates = await new Promise<Uint8Array[]>((resolve) =>
      updatesRequest.addEventListener("success", () => resolve(updatesRequest.result)),
    );
    source.close();
    const olderRequest = indexedDB.open(draftKey);
    olderRequest.addEventListener("upgradeneeded", () => {
      olderRequest.result.createObjectStore("updates", { autoIncrement: true });
      olderRequest.result.createObjectStore("custom");
    });
    const older = await new Promise<IDBDatabase>((resolve) =>
      olderRequest.addEventListener("success", () => resolve(olderRequest.result)),
    );
    const write = older.transaction("updates", "readwrite");
    for (const update of updates) write.objectStore("updates").add(update);
    await new Promise<void>((resolve) => write.addEventListener("complete", () => resolve()));
    older.close();
    const catalogWrite = catalog.transaction("pages", "readwrite");
    catalogWrite
      .objectStore("pages")
      .put({ ...entry, epoch: 0, pendingChanges: true, pendingCopyKeys: [draftKey], storageKeys: [draftKey] });
    await new Promise<void>((resolve) => catalogWrite.addEventListener("complete", () => resolve()));
    catalog.close();
    return draftKey;
  }, pageId);

  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        const read = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const entries = await new Promise<
          Array<{ pageId: string; epoch: number; pendingChanges?: boolean; pendingCopyKeys?: string[] }>
        >((resolve) => read.addEventListener("success", () => resolve(read.result)));
        db.close();
        return entries.find((entry) => entry.pageId === id);
      }, pageId),
    )
    .toMatchObject({ epoch: 1, pendingChanges: false, pendingCopyKeys: [olderKey] });

  await context.setOffline(true);
  await page.locator(".bn-editor").click();
  await page.keyboard.type(" Current epoch draft");
  await expect(page.locator(".bn-editor")).toContainText("Current epoch draft");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const request = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        const read = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const entries = await new Promise<Array<{ pageId: string; pendingCopyKeys: string[] }>>((resolve) =>
          read.addEventListener("success", () => resolve(read.result)),
        );
        db.close();
        return entries.find((entry) => entry.pageId === id)?.pendingCopyKeys.length ?? 0;
      }, pageId),
    )
    .toBe(2);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Review local changes" })).toBeVisible();
  await expect(page.getByText("Older epoch draft")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export pending copies as Markdown" }).click();
  const path = await (await download).path();
  expect(path).toBeTruthy();
  expect(await readFile(path!, "utf8")).toContain("Draft from prior epoch");
  expect(await readFile(path!, "utf8")).toContain("Current epoch draft");
});

test("keeps an unscoped Yjs copy hidden without deleting it", async ({ page }) => {
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
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await page.getByLabel("Page title").fill("Legacy recovery probe");
  await page.getByLabel("Page title").blur();
  await expect(page.locator(`[data-tree-page="${pageId}"]`)).toContainText("Legacy recovery probe");
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Older local content");
  await expect(page.locator(".bn-editor")).toContainText("Older local content");
  const legacyName = await page.evaluate(async (id) => {
    const member = (await (await fetch("/api/me")).json()) as { workspace: { id: string } };
    const metadata = (await (await fetch(`/api/pages/${id}`)).json()) as { page: { contentEpoch: number } };
    const catalogRequest = indexedDB.open("noteflare-offline-catalog");
    const catalog = await new Promise<IDBDatabase>((resolve) =>
      catalogRequest.addEventListener("success", () => resolve(catalogRequest.result)),
    );
    const pages = catalog.transaction("pages", "readonly").objectStore("pages").getAll();
    const entries = await new Promise<Array<{ pageId: string; storageKeys: string[] }>>((resolve) =>
      pages.addEventListener("success", () => resolve(pages.result)),
    );
    catalog.close();
    const sourceKey = entries.find((entry) => entry.pageId === id)?.storageKeys.at(-1);
    if (!sourceKey) throw new Error("The source document is not available locally.");
    const sourceRequest = indexedDB.open(sourceKey);
    const source = await new Promise<IDBDatabase>((resolve) =>
      sourceRequest.addEventListener("success", () => resolve(sourceRequest.result)),
    );
    const updatesRequest = source.transaction("updates", "readonly").objectStore("updates").getAll();
    const updates = await new Promise<Uint8Array[]>((resolve) =>
      updatesRequest.addEventListener("success", () => resolve(updatesRequest.result)),
    );
    source.close();
    const name = `${member.workspace.id}:${id}:${metadata.page.contentEpoch}:1`;
    const legacyRequest = indexedDB.open(name);
    legacyRequest.addEventListener("upgradeneeded", () => {
      legacyRequest.result.createObjectStore("updates", { autoIncrement: true });
      legacyRequest.result.createObjectStore("custom");
    });
    const legacy = await new Promise<IDBDatabase>((resolve) =>
      legacyRequest.addEventListener("success", () => resolve(legacyRequest.result)),
    );
    const transaction = legacy.transaction("updates", "readwrite");
    for (const update of updates) transaction.objectStore("updates").add(update);
    await new Promise<void>((resolve) => transaction.addEventListener("complete", () => resolve()));
    legacy.close();
    return name;
  }, pageId);
  await page.reload();
  await expect(page.getByLabel("Page title")).toHaveValue("Legacy recovery probe");
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name))).toContain(
    legacyName,
  );
  const currentLegacyName = await page.evaluate(async (id) => {
    const member = (await (await fetch("/api/me")).json()) as { workspace: { id: string } };
    const metadata = (await (await fetch(`/api/pages/${id}`)).json()) as { page: { contentEpoch: number } };
    return `${member.workspace.id}:${id}:${metadata.page.contentEpoch}:1`;
  }, pageId);
  expect(legacyName).toBe(currentLegacyName);
  await expect(page.getByText("Earlier local copy available")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Export earlier copy from epoch/ })).toHaveCount(0);
  expect(
    await page.evaluate(async (name) => (await indexedDB.databases()).some((entry) => entry.name === name), legacyName),
  ).toBe(true);
});

test("removes a clean cached copy when live page access is revoked", async ({ page, context }) => {
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
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await page.getByLabel("Page title").fill("Revoked offline copy");
  await page.getByLabel("Page title").blur();
  await expect(page.locator(`[data-tree-page="${pageId}"]`)).toContainText("Revoked offline copy");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const opened = indexedDB.open("noteflare-offline-catalog");
        const db = await new Promise<IDBDatabase>((resolve) =>
          opened.addEventListener("success", () => resolve(opened.result)),
        );
        const request = db.transaction("pages", "readonly").objectStore("pages").getAll();
        const pages = await new Promise<Array<{ pageId: string; pendingChanges?: boolean }>>((resolve) =>
          request.addEventListener("success", () => resolve(request.result)),
        );
        db.close();
        const entry = pages.find((item) => item.pageId === id);
        return Boolean(entry && !entry.pendingChanges);
      }, pageId),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: /Revoked offline copy/ })).toBeVisible();
  await page.route(`**/api/pages/${pageId}`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "forbidden", message: "Access removed." } }),
    }),
  );
  await context.setOffline(false);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText("Access to that document was removed. Its local copy is being deleted.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Revoked offline copy/ })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await indexedDB.databases()).some((entry) => entry.name?.includes(`:${id}:`)),
        pageId,
      ),
    )
    .toBe(false);
});
