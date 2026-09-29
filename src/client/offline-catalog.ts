import type { ClientMemberContext, Page, PageKind } from "../shared/types";
import { fetchUpdates, type IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

const DATABASE_NAME = "noteflare-offline-catalog";
const DATABASE_VERSION = 1;

export type OfflineAccount = {
  key: string;
  userId: string;
  userName: string;
  workspaceId: string;
  workspaceName: string;
  lastAuthenticatedAt: number;
  offlineEditingEnabled: boolean;
  purging?: boolean;
};

export type OfflinePage = {
  key: string;
  accountKey: string;
  pageId: string;
  title: string;
  spaceName: string;
  kind: PageKind;
  epoch: number;
  canEdit: boolean;
  pendingChanges?: boolean;
  pendingCopyKeys?: string[];
  revoked?: boolean;
  lastSyncedAt: number;
  storageKeys: string[];
};

const PENDING_MARKER = "noteflare-pending";
export { PENDING_MARKER };

function openExistingDocument(key: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(key);
    request.addEventListener("upgradeneeded", () => request.transaction?.abort());
    request.addEventListener("error", () => {
      if (request.error?.name === "AbortError") resolve(null);
      else reject(request.error ?? new Error("Offline document could not be opened."));
    });
    request.addEventListener("success", () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    });
    request.addEventListener("blocked", () => reject(new Error("Offline document storage is in use by another tab.")));
  });
}

export async function documentPendingMarker(key: string): Promise<boolean> {
  const db = await openExistingDocument(key);
  if (!db) return false;
  try {
    if (!db.objectStoreNames.contains("custom")) return false;
    const transaction = db.transaction("custom", "readonly");
    const result = await requestResult(transaction.objectStore("custom").get(PENDING_MARKER));
    await transactionDone(transaction);
    return Boolean(result);
  } finally {
    db.close();
  }
}

async function withPendingMarkers(page: OfflinePage): Promise<OfflinePage> {
  const marked = (
    await Promise.all(
      (page.storageKeys ?? []).map(async (key) => {
        try {
          return (await documentPendingMarker(key)) ? key : null;
        } catch (error) {
          // A broken document DB may still hold the only copy of local edits.
          console.error("Offline document marker could not be read", error);
          return key;
        }
      }),
    )
  ).filter((key): key is string => key !== null);
  if (!marked.length) return page;
  const keys = [...new Set([...pendingKeysOf(page), ...marked])];
  return { ...page, pendingCopyKeys: keys, pendingChanges: keys.includes(page.storageKeys?.at(-1) ?? "") };
}

async function clearDocumentPendingMarker(key: string) {
  const db = await openExistingDocument(key);
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains("custom")) return;
    const transaction = db.transaction("custom", "readwrite");
    transaction.objectStore("custom").delete(PENDING_MARKER);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export function persistPendingDocumentUpdate(db: IDBDatabase, update: Uint8Array): Promise<void> {
  const transaction = db.transaction(["updates", "custom"], "readwrite");
  transaction.objectStore("updates").add(update);
  transaction.objectStore("custom").put(true, PENDING_MARKER);
  return transactionDone(transaction);
}

/** Compact only updates already loaded into the Y.Doc; concurrent later rows survive. */
export async function compactDocumentUpdates(persistence: IndexeddbPersistence): Promise<void> {
  await fetchUpdates(persistence);
  const db = persistence.db;
  if (!db) throw new Error("Offline document storage is unavailable.");
  const lastLoaded = persistence["_dbref"];
  const transaction = db.transaction("updates", "readwrite");
  const store = transaction.objectStore("updates");
  store.add(Y.encodeStateAsUpdate(persistence.doc));
  store.delete(IDBKeyRange.upperBound(lastLoaded, true));
  await transactionDone(transaction);
  persistence["_dbsize"] = 1;
}

export function pendingKeysOf(page: OfflinePage): string[] {
  return page.pendingCopyKeys?.length
    ? page.pendingCopyKeys.filter(Boolean)
    : page.pendingChanges
      ? [page.storageKeys?.at(-1)].filter((key): key is string => !!key)
      : [];
}

export function storageEpoch(key: string) {
  return Number(key.split(":").at(-2)) || 0;
}

function withStorageKey(keys: string[], key: string) {
  return [...new Set([...keys, key])].sort((left, right) => storageEpoch(left) - storageEpoch(right));
}

let connection: Promise<IDBDatabase> | null = null;
const pageLocks = new Map<string, Promise<void>>();

async function withPageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const run = async () => {
    const previous = pageLocks.get(key);
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    pageLocks.set(key, finished);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (pageLocks.get(key) === finished) pageLocks.delete(key);
    }
  };
  if (navigator.locks) return navigator.locks.request(`noteflare-offline:${encodeURIComponent(key)}`, run);
  return run();
}

export function offlineAccountKey(member: Pick<ClientMemberContext, "user" | "workspace">) {
  return `${member.user.id}\u0000${member.workspace.id}`;
}

export function offlineDocumentKey(userId: string, workspaceId: string, pageId: string, epoch: number) {
  return `account:${userId}:${workspaceId}:${pageId}:${epoch}:2`;
}

function openCatalog() {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("accounts")) db.createObjectStore("accounts", { keyPath: "key" });
        if (!db.objectStoreNames.contains("pages")) {
          db.createObjectStore("pages", { keyPath: "key" }).createIndex("byAccount", "accountKey");
        }
      });
      request.addEventListener("success", () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        resolve(db);
      });
      request.addEventListener("error", () => reject(request.error ?? new Error("Offline catalog is unavailable.")));
      request.addEventListener("blocked", () => reject(new Error("Offline catalog is in use by another tab.")));
    }).catch((error: unknown) => {
      connection = null;
      throw error;
    });
  }
  return connection;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Offline catalog request failed.")));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Offline catalog transaction was aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Offline catalog transaction failed.")),
    );
  });
}

export async function rememberOfflineAccount(member: ClientMemberContext) {
  const db = await openCatalog();
  const transaction = db.transaction("accounts", "readwrite");
  const store = transaction.objectStore("accounts");
  const account: OfflineAccount = {
    key: offlineAccountKey(member),
    userId: member.user.id,
    userName: member.user.name,
    workspaceId: member.workspace.id,
    workspaceName: member.workspace.name,
    lastAuthenticatedAt: Date.now(),
    offlineEditingEnabled: member.features?.offlineEditing === true,
  };
  const existing = await requestResult(store.get(account.key) as IDBRequest<OfflineAccount | undefined>);
  if (existing?.purging) {
    await transactionDone(transaction);
    return existing;
  }
  store.put(account);
  await transactionDone(transaction);
  return account;
}

export async function latestOfflineAccount(): Promise<OfflineAccount | null> {
  const db = await openCatalog();
  const transaction = db.transaction("accounts", "readonly");
  const accounts = await requestResult(transaction.objectStore("accounts").getAll() as IDBRequest<OfflineAccount[]>);
  await transactionDone(transaction);
  return (
    accounts
      .filter((account) => !account.purging)
      .sort((left, right) => right.lastAuthenticatedAt - left.lastAuthenticatedAt)[0] ?? null
  );
}

export async function hasOfflineDocument(key: string): Promise<boolean> {
  const db = await openExistingDocument(key);
  db?.close();
  return Boolean(db);
}

export async function listOfflinePages(accountKey: string): Promise<OfflinePage[]> {
  const pages = await readAccountPages(accountKey);
  const valid = pages.filter(
    (page) =>
      page.accountKey === accountKey &&
      page.kind === "document" &&
      (!page.revoked || pendingKeysOf(page).length > 0) &&
      Array.isArray(page.storageKeys) &&
      (page.lastSyncedAt > 0 || pendingKeysOf(page).length > 0),
  );
  const available = await Promise.all(
    valid.map(async (page) => {
      const key = page.storageKeys.at(-1);
      return key && (await hasOfflineDocument(key)) ? page : null;
    }),
  );
  return available
    .filter((page): page is OfflinePage => page !== null)
    .sort((left, right) => right.lastSyncedAt - left.lastSyncedAt);
}

export async function listPendingOfflinePages(accountKey: string): Promise<OfflinePage[]> {
  const pages = await readAccountPages(accountKey);
  const available = await Promise.all(
    pages.map(async (page) => {
      const keys = pendingKeysOf(page);
      const pendingCopyKeys = (
        await Promise.all(keys.map(async (key) => (key && (await hasOfflineDocument(key)) ? key : null)))
      ).filter((key): key is string => key !== null);
      return pendingCopyKeys.length ? { ...page, pendingCopyKeys } : null;
    }),
  );
  return available.filter((page): page is OfflinePage & { pendingCopyKeys: string[] } => page !== null);
}

async function readAccountPages(accountKey: string, includeMarkers = true): Promise<OfflinePage[]> {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readonly");
  const pages = await requestResult(
    transaction.objectStore("pages").index("byAccount").getAll(accountKey) as IDBRequest<OfflinePage[]>,
  );
  await transactionDone(transaction);
  return includeMarkers ? Promise.all(pages.map(withPendingMarkers)) : pages;
}

export async function getOfflinePage(accountKey: string, pageId: string): Promise<OfflinePage | null> {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readonly");
  const page = await requestResult(
    transaction.objectStore("pages").get(`${accountKey}\u0000${pageId}`) as IDBRequest<OfflinePage | undefined>,
  );
  await transactionDone(transaction);
  return page ? withPendingMarkers(page) : null;
}

export async function rememberOfflinePage(
  member: ClientMemberContext,
  page: Page,
  spaceName: string,
  canEdit: boolean,
  confirmed = true,
) {
  if (page.kind !== "document") return undefined;
  const accountKey = offlineAccountKey(member);
  const key = `${accountKey}\u0000${page.id}`;
  return withPageLock(key, async () => {
    const db = await openCatalog();
    const storageKey = offlineDocumentKey(member.user.id, member.workspace.id, page.id, page.contentEpoch);
    const transaction = db.transaction(["accounts", "pages"], "readwrite");
    const account = await requestResult(
      transaction.objectStore("accounts").get(accountKey) as IDBRequest<OfflineAccount | undefined>,
    );
    if (!account || account.purging) {
      await transactionDone(transaction);
      return undefined;
    }
    const store = transaction.objectStore("pages");
    const previous = await requestResult(store.get(key) as IDBRequest<OfflinePage | undefined>);
    const previousPendingKeys = previous ? pendingKeysOf(previous) : [];
    const currentOrNewer = !previous || page.contentEpoch >= previous.epoch;
    const storageKeys = withStorageKey(previous?.storageKeys ?? [], storageKey);
    const entry: OfflinePage = {
      key,
      accountKey,
      pageId: page.id,
      title: currentOrNewer ? page.title : previous.title,
      spaceName: currentOrNewer ? spaceName : previous.spaceName,
      kind: page.kind,
      epoch: currentOrNewer ? page.contentEpoch : previous.epoch,
      canEdit: currentOrNewer ? canEdit : previous.canEdit,
      pendingChanges: previousPendingKeys.includes(storageKeys.at(-1) ?? ""),
      pendingCopyKeys: previousPendingKeys,
      revoked: confirmed && currentOrNewer ? false : (previous?.revoked ?? false),
      lastSyncedAt: confirmed && currentOrNewer ? Date.now() : (previous?.lastSyncedAt ?? 0),
      storageKeys,
    };
    store.put(entry);
    await transactionDone(transaction);
    return entry;
  });
}

export async function markOfflinePagePending(
  accountKey: string,
  pageId: string,
  storageKey: string,
  pendingChanges: boolean,
) {
  const key = `${accountKey}\u0000${pageId}`;
  return withPageLock(key, async () => {
    const db = await openCatalog();
    const transaction = db.transaction("pages", "readwrite");
    const store = transaction.objectStore("pages");
    const page = await requestResult(store.get(key) as IDBRequest<OfflinePage | undefined>);
    if (page) {
      const keys = new Set(pendingKeysOf(page));
      if (pendingChanges) keys.add(storageKey);
      else keys.delete(storageKey);
      const storageKeys = withStorageKey(page.storageKeys ?? [], storageKey);
      store.put({
        ...page,
        storageKeys,
        pendingChanges: keys.has(storageKeys.at(-1) ?? ""),
        pendingCopyKeys: [...keys],
      });
    }
    await transactionDone(transaction);
    if (!pendingChanges) await clearDocumentPendingMarker(storageKey);
  });
}

export async function markOfflinePageRevoked(accountKey: string, pageId: string) {
  const key = `${accountKey}\u0000${pageId}`;
  return withPageLock(key, async () => {
    const db = await openCatalog();
    const read = db.transaction("pages", "readonly");
    const page = await requestResult(read.objectStore("pages").get(key) as IDBRequest<OfflinePage | undefined>);
    await transactionDone(read);
    if (!page || pendingKeysOf(await withPendingMarkers(page)).length) return false;
    const write = db.transaction("pages", "readwrite");
    const store = write.objectStore("pages");
    const current = await requestResult(store.get(key) as IDBRequest<OfflinePage | undefined>);
    if (current && !pendingKeysOf(current).length) store.put({ ...current, revoked: true });
    await transactionDone(write);
    return Boolean(current && !pendingKeysOf(current).length);
  });
}

export async function clearRevokedOfflinePages(accountKey: string) {
  const db = await openCatalog();
  for (const page of (await readAccountPages(accountKey, false)).filter((entry) => entry.revoked)) {
    await withPageLock(page.key, async () => {
      const current = await getOfflinePage(accountKey, page.pageId);
      if (!current?.revoked || pendingKeysOf(current).length) return;
      for (const key of current.storageKeys) {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(key);
          request.addEventListener("success", () => resolve());
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("Offline document removal failed.")),
          );
          request.addEventListener("blocked", () =>
            reject(new Error("Close other NoteFlare tabs to remove old copies.")),
          );
        });
      }
      const transaction = db.transaction("pages", "readwrite");
      transaction.objectStore("pages").delete(current.key);
      await transactionDone(transaction);
    });
  }
}

export async function markOfflineAccountPurging(accountKey: string) {
  const db = await openCatalog();
  const transaction = db.transaction("accounts", "readwrite");
  const store = transaction.objectStore("accounts");
  const account = await requestResult(store.get(accountKey) as IDBRequest<OfflineAccount | undefined>);
  if (account) store.put({ ...account, purging: true });
  await transactionDone(transaction);
}

export async function purgingOfflineAccounts() {
  const db = await openCatalog();
  const transaction = db.transaction("accounts", "readonly");
  const accounts = await requestResult(transaction.objectStore("accounts").getAll() as IDBRequest<OfflineAccount[]>);
  await transactionDone(transaction);
  return accounts.filter((account) => account.purging).map((account) => account.key);
}

export async function forgetOfflineAccount(accountKey: string) {
  const db = await openCatalog();
  await markOfflineAccountPurging(accountKey);
  const pages = await readAccountPages(accountKey, false);
  const keys = new Set(pages.flatMap((page) => page.storageKeys ?? []));
  // Catalog writes and Yjs store creation are separate transactions. Include
  // stores left behind by an interrupted catalog write or a previous purge.
  const [userId, workspaceId] = accountKey.split("\u0000");
  if (userId && workspaceId && indexedDB.databases) {
    const databases = await indexedDB.databases();
    for (const database of databases) {
      if (database.name?.startsWith(`account:${userId}:${workspaceId}:`)) keys.add(database.name);
    }
  }
  for (const key of keys) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(key);
      request.addEventListener("success", () => resolve());
      request.addEventListener("error", () => reject(request.error ?? new Error("Offline document removal failed.")));
      request.addEventListener("blocked", () =>
        reject(new Error("Close other NoteFlare tabs to remove offline documents.")),
      );
    });
  }
  if (userId && workspaceId && indexedDB.databases) {
    const remaining = await indexedDB.databases();
    if (remaining.some((database) => database.name?.startsWith(`account:${userId}:${workspaceId}:`)))
      throw new Error("New local document storage appeared during sign-out. Retry removal.");
  }
  const transaction = db.transaction(["accounts", "pages"], "readwrite");
  transaction.objectStore("accounts").delete(accountKey);
  const store = transaction.objectStore("pages");
  for (const page of pages) store.delete(page.key);
  await transactionDone(transaction);
}
