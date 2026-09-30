// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
let latestOfflineAccount: typeof import("./offline-catalog").latestOfflineAccount;

function database() {
  const stores = new Set<string>();
  return {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: vi.fn((name: string) => {
      stores.add(name);
      return { createIndex: vi.fn() };
    }),
    close: vi.fn(),
    onversionchange: null as (() => void) | null,
    transaction: vi.fn(() => {
      const transaction = new EventTarget();
      return Object.assign(transaction, {
        objectStore: () => ({
          getAll: () => {
            const request = Object.assign(new EventTarget(), { result: [] });
            void Promise.resolve().then(() => {
              request.dispatchEvent(new Event("success"));
              void Promise.resolve().then(() => transaction.dispatchEvent(new Event("complete")));
            });
            return request;
          },
        }),
      });
    }),
  };
}

const databases: ReturnType<typeof database>[] = [];
let requests: Array<EventTarget & { result: ReturnType<typeof database>; error: Error | null }>;
let open: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  ({ latestOfflineAccount } = await import("./offline-catalog"));
  vi.useFakeTimers();
  requests = [];
  open = vi.fn(() => {
    const db = database();
    databases.push(db);
    const request = Object.assign(new EventTarget(), { result: db, error: null as Error | null });
    requests.push(request);
    return request;
  });
  vi.stubGlobal("indexedDB", { open });
});

afterEach(() => {
  for (const db of databases) db.onversionchange?.();
  databases.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("rejects a stalled catalog open for all waiting callers and allows a retry", async () => {
  const first = latestOfflineAccount().catch((error: unknown) => error);
  const second = latestOfflineAccount().catch((error: unknown) => error);
  expect(open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(first).resolves.toEqual(new Error("Offline catalog open timed out."));
  await expect(second).resolves.toEqual(new Error("Offline catalog open timed out."));
  expect(vi.getTimerCount()).toBe(0);

  const retry = latestOfflineAccount();
  expect(open).toHaveBeenCalledTimes(2);
  requests[1]!.dispatchEvent(new Event("success"));
  await expect(retry).resolves.toBeNull();
});

it("closes a late success without disturbing a successful retry", async () => {
  const failed = latestOfflineAccount().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(failed).resolves.toEqual(new Error("Offline catalog open timed out."));
  const expired = requests[0]!;
  const abort = vi.fn();
  Object.assign(expired, { transaction: { abort } });
  expired.dispatchEvent(new Event("upgradeneeded"));
  expect(abort).toHaveBeenCalledOnce();

  const retry = latestOfflineAccount();
  const current = requests[1]!;
  current.dispatchEvent(new Event("success"));
  await expect(retry).resolves.toBeNull();
  expired.dispatchEvent(new Event("success"));
  expired.dispatchEvent(new Event("error"));
  expect(expired.result.close).toHaveBeenCalledOnce();
  expect(expired.result.transaction).not.toHaveBeenCalled();
  expect(current.result.close).not.toHaveBeenCalled();
  await expect(latestOfflineAccount()).resolves.toBeNull();
  expect(open).toHaveBeenCalledTimes(2);
});

it("closes a slow initial catalog creation after its deadline", async () => {
  const failed = latestOfflineAccount().catch((error: unknown) => error);
  const request = requests[0]!;
  request.dispatchEvent(new Event("upgradeneeded"));
  expect(request.result.createObjectStore.mock.calls).toEqual([
    ["accounts", { keyPath: "key" }],
    ["pages", { keyPath: "key" }],
  ]);
  expect(request.result.createObjectStore.mock.results[1]!.value.createIndex).toHaveBeenCalledWith(
    "byAccount",
    "accountKey",
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(failed).resolves.toEqual(new Error("Offline catalog open timed out."));
  request.dispatchEvent(new Event("success"));
  expect(request.result.close).toHaveBeenCalledOnce();
  expect(request.result.transaction).not.toHaveBeenCalled();
});

it("clears the deadline after a successful open and reuses the connection", async () => {
  const loaded = latestOfflineAccount();
  const request = requests[0]!;
  await vi.advanceTimersByTimeAsync(4_999);
  request.dispatchEvent(new Event("success"));
  await expect(loaded).resolves.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request.result.close).not.toHaveBeenCalled();
  await expect(latestOfflineAccount()).resolves.toBeNull();
  expect(open).toHaveBeenCalledOnce();
});

it.each(["error", "blocked"])("clears the deadline on %s and closes a subsequent success", async (event) => {
  const expected = event === "error" ? "Open failed" : "Offline catalog is in use by another tab.";
  const failed = latestOfflineAccount().catch((error: unknown) => error);
  const request = requests[0]!;
  request.error = new Error("Open failed");
  request.dispatchEvent(new Event(event));
  await expect(failed).resolves.toEqual(new Error(expected));
  expect(vi.getTimerCount()).toBe(0);
  request.dispatchEvent(new Event("success"));
  expect(request.result.close).toHaveBeenCalledOnce();
  expect(request.result.transaction).not.toHaveBeenCalled();

  const retry = latestOfflineAccount();
  expect(open).toHaveBeenCalledTimes(2);
  requests[1]!.dispatchEvent(new Event("success"));
  await expect(retry).resolves.toBeNull();
});
