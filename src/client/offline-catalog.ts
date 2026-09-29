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
  /** Set only on recovered reads until the catalog has accepted the storage key. */
  catalogNeedsRepair?: boolean;
};

const PENDING_MARKER = "noteflare-pending";
const DOCUMENT_REGISTRY_PREFIX = "noteflare-document-keys:";
export const LOCAL_SIGNOUT_KEY = "notes:local-signout";
const PURGING_ACCOUNT_PREFIX = "noteflare-purging-account:";

function isAccountSigningOut(accountKey: string) {
  return (
    localStorage.getItem(LOCAL_SIGNOUT_KEY) === accountKey ||
    localStorage.getItem(`${PURGING_ACCOUNT_PREFIX}${accountKey}`) === "1"
  );
}

function documentRegistryEntryPrefix(accountKey: string) {
  return `${DOCUMENT_REGISTRY_PREFIX}${accountKey}\u0000`;
}

function registeredDocumentKeys(accountKey: string): { keys: string[] | null; malformed: boolean } {
  const raw = localStorage.getItem(`${DOCUMENT_REGISTRY_PREFIX}${accountKey}`);
  const prefix = accountDocumentPrefix(accountKey);
  if (!prefix) throw new Error("Offline account key is invalid.");
  let legacy: unknown = [];
  let malformed = false;
  try {
    legacy = raw === null ? [] : JSON.parse(raw);
  } catch {
    malformed = true;
  }
  if (!Array.isArray(legacy)) {
    malformed = true;
    legacy = [];
  }
  const entries: string[] = [];
  for (const key of legacy as unknown[]) {
    if (typeof key === "string" && parseOfflineDocumentKey(key, prefix)) entries.push(key);
    else malformed = true;
  }
  const entryPrefix = documentRegistryEntryPrefix(accountKey);
  let hasEntry = false;
  for (let index = 0; index < localStorage.length; index += 1) {
    const name = localStorage.key(index);
    if (!name?.startsWith(entryPrefix)) continue;
    hasEntry = true;
    const key = name.slice(entryPrefix.length);
    if (parseOfflineDocumentKey(key, prefix)) entries.push(key);
    else malformed = true;
  }
  return { keys: raw === null && !hasEntry ? null : [...new Set(entries)], malformed };
}

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

async function clearDocumentPendingMarker(key: string, mayClear: () => boolean) {
  const db = await openExistingDocument(key);
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains("custom")) return;
    if (!mayClear()) return;
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
  const count = store.count();
  await transactionDone(transaction);
  persistence["_dbsize"] = count.result;
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

export function offlineAccountKey(member: { user: { id: string }; workspace: { id: string } }) {
  return `${member.user.id}\u0000${member.workspace.id}`;
}

export function offlineDocumentKey(userId: string, workspaceId: string, pageId: string, epoch: number) {
  return `account:${userId}:${workspaceId}:${pageId}:${epoch}:2`;
}

export function registerOfflineDocumentKey(userId: string, workspaceId: string, key: string) {
  if (typeof localStorage === "undefined") return;
  const accountKey = offlineAccountKey({ user: { id: userId }, workspace: { id: workspaceId } });
  if (isAccountSigningOut(accountKey)) throw new Error("Local sign-out is removing offline documents.");
  if (registeredDocumentKeys(accountKey).keys?.includes(key)) return;
  try {
    localStorage.setItem(`${documentRegistryEntryPrefix(accountKey)}${key}`, "1");
  } catch (error) {
    if (!indexedDB.databases) throw error;
    console.error("Offline document registry could not be updated", error);
  }
}

export function registerOfflineDocumentKeyFromKey(key: string) {
  const match = /^account:([^:]+):([^:]+):[^:]+:\d+:2$/.exec(key);
  if (!match) throw new Error("Offline document key is invalid.");
  registerOfflineDocumentKey(match[1]!, match[2]!, key);
}

function accountDocumentPrefix(accountKey: string) {
  const [userId, workspaceId] = accountKey.split("\u0000");
  return userId && workspaceId ? `account:${userId}:${workspaceId}:` : null;
}

function parseOfflineDocumentKey(key: string, prefix: string) {
  if (!key.startsWith(prefix)) return null;
  const match = /^([^:]+):(\d+):2$/.exec(key.slice(prefix.length));
  return match ? { pageId: match[1]!, epoch: Number(match[2]) } : null;
}

async function accountDocumentNames(accountKey: string, strict: boolean): Promise<string[]> {
  let registered: string[] | null = null;
  let registryError: unknown;
  let malformed = false;
  try {
    ({ keys: registered, malformed } = registeredDocumentKeys(accountKey));
  } catch (error) {
    registryError = error;
    console.error("Offline document registry could not be read", error);
  }
  if (!indexedDB.databases) {
    if (strict && registryError) throw registryError;
    if (strict && malformed) throw new Error("Offline document registry is invalid.");
    if (strict && !registered) throw new Error("This browser cannot verify every saved document before sign-out.");
    return registered ?? [];
  }
  try {
    const databases = await indexedDB.databases();
    return [
      ...new Set([
        ...databases.map((database) => database.name).filter((name): name is string => !!name),
        ...(registered ?? []),
      ]),
    ];
  } catch (error) {
    if (strict && registryError) throw registryError;
    if (strict && malformed) throw new Error("Offline document registry is invalid.", { cause: error });
    if (strict && !registered) throw error;
    console.error("Offline document enumeration failed", error);
    return registered ?? [];
  }
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
  const accountKey = offlineAccountKey(member);
  if (isAccountSigningOut(accountKey)) return undefined;
  const db = await openCatalog();
  const transaction = db.transaction("accounts", "readwrite");
  const store = transaction.objectStore("accounts");
  const account: OfflineAccount = {
    key: accountKey,
    userId: member.user.id,
    userName: member.user.name,
    workspaceId: member.workspace.id,
    workspaceName: member.workspace.name,
    lastAuthenticatedAt: Date.now(),
    offlineEditingEnabled: member.features?.offlineEditing === true,
  };
  const existing = await requestResult(store.get(account.key) as IDBRequest<OfflineAccount | undefined>);
  if (existing?.purging || isAccountSigningOut(accountKey)) {
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

export async function listPendingOfflinePages(accountKey: string, strict = true): Promise<OfflinePage[]> {
  const pages = await readAccountPages(accountKey, true, strict);
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

async function withOrphanDocuments(accountKey: string, marked: OfflinePage[], targetPageId?: string, strict = false) {
  const prefix = accountDocumentPrefix(accountKey);
  if (!prefix) return marked;
  const names = await accountDocumentNames(accountKey, strict);
  const knownKeys = new Set(marked.flatMap((page) => page.storageKeys ?? []));
  const byPage = new Map(marked.map((page) => [page.pageId, page]));
  const discovered = await Promise.all(
    names.map(async (name) => {
      if (knownKeys.has(name)) return null;
      const parsed = parseOfflineDocumentKey(name, prefix);
      if (!parsed || (targetPageId !== undefined && parsed.pageId !== targetPageId)) return null;
      try {
        return (await documentPendingMarker(name)) ? { name, ...parsed } : null;
      } catch (error) {
        console.error("Offline orphan marker could not be read", error);
        return { name, ...parsed };
      }
    }),
  );
  for (const orphan of discovered) {
    if (!orphan) continue;
    const { name, pageId, epoch } = orphan;
    const current = byPage.get(pageId);
    if (current) {
      const pendingBefore = pendingKeysOf(current);
      current.storageKeys = withStorageKey(current.storageKeys ?? [], name);
      current.pendingCopyKeys = [...new Set([...pendingBefore, name])];
      current.pendingChanges = current.pendingCopyKeys.includes(current.storageKeys.at(-1) ?? "");
      if (epoch > current.epoch) {
        current.epoch = epoch;
        current.canEdit = false;
      }
      current.catalogNeedsRepair = true;
    } else {
      const recovered: OfflinePage = {
        key: `${accountKey}\u0000${pageId}`,
        accountKey,
        pageId,
        title: "Recovered local draft",
        spaceName: "Unknown space",
        kind: "document",
        epoch,
        canEdit: false,
        pendingChanges: true,
        pendingCopyKeys: [name],
        revoked: false,
        lastSyncedAt: 0,
        storageKeys: [name],
        catalogNeedsRepair: true,
      };
      marked.push(recovered);
      byPage.set(pageId, recovered);
    }
    knownKeys.add(name);
  }
  return marked;
}

async function readAccountPages(accountKey: string, includeMarkers = true, strict = false): Promise<OfflinePage[]> {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readonly");
  const pages = await requestResult(
    transaction.objectStore("pages").index("byAccount").getAll(accountKey) as IDBRequest<OfflinePage[]>,
  );
  await transactionDone(transaction);
  if (!includeMarkers) return pages;
  return withOrphanDocuments(accountKey, await Promise.all(pages.map(withPendingMarkers)), undefined, strict);
}

export async function getOfflinePage(accountKey: string, pageId: string): Promise<OfflinePage | null> {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readonly");
  const page = await requestResult(
    transaction.objectStore("pages").get(`${accountKey}\u0000${pageId}`) as IDBRequest<OfflinePage | undefined>,
  );
  await transactionDone(transaction);
  const marked = page ? [await withPendingMarkers(page)] : [];
  return (await withOrphanDocuments(accountKey, marked, pageId))[0] ?? null;
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
  mayClearMarker: () => boolean = () => true,
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
    if (!pendingChanges) await clearDocumentPendingMarker(storageKey, mayClearMarker);
    return Boolean(page);
  });
}

export async function markOfflinePageRevoked(accountKey: string, pageId: string) {
  const key = `${accountKey}\u0000${pageId}`;
  return withPageLock(key, async () => {
    const recovered = await getOfflinePage(accountKey, pageId);
    if (!recovered || pendingKeysOf(recovered).length) return false;
    const db = await openCatalog();
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
      // Keep registry entries until sign-out. Another tab can reopen a document
      // after this deletion, and the registry must still name that copy.
    });
  }
}

export async function markOfflineAccountPurging(accountKey: string) {
  try {
    localStorage.setItem(`${PURGING_ACCOUNT_PREFIX}${accountKey}`, "1");
  } catch (error) {
    if (localStorage.getItem(LOCAL_SIGNOUT_KEY) !== accountKey) throw error;
  }
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
  const pending = new Set(accounts.filter((account) => account.purging).map((account) => account.key));
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(PURGING_ACCOUNT_PREFIX)) pending.add(key.slice(PURGING_ACCOUNT_PREFIX.length));
  }
  return [...pending];
}

export async function forgetOfflineAccount(accountKey: string) {
  await markOfflineAccountPurging(accountKey);
  const prefix = accountDocumentPrefix(accountKey);
  const entryPrefix = documentRegistryEntryPrefix(accountKey);
  const registryEntries = () =>
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
      (name): name is string => !!name?.startsWith(entryPrefix),
    );
  const entryNamesAtStart = new Set(registryEntries());
  const db = await openCatalog();
  const pages = await readAccountPages(accountKey, false);
  const accountTransaction = db.transaction("accounts", "readonly");
  const account = await requestResult(
    accountTransaction.objectStore("accounts").get(accountKey) as IDBRequest<OfflineAccount | undefined>,
  );
  await transactionDone(accountTransaction);
  // A retry after a completed purge has no catalog or registry to inspect.
  const completedWithoutEnumeration =
    !indexedDB.databases && !account && !pages.length && registeredDocumentKeys(accountKey).keys === null;
  const names = completedWithoutEnumeration ? [] : await accountDocumentNames(accountKey, true);
  const keys = new Set(pages.flatMap((page) => page.storageKeys ?? []));
  // Catalog writes and Yjs store creation are separate transactions. Include
  // stores left behind by an interrupted catalog write or a previous purge.
  for (const name of names) if (prefix && name.startsWith(prefix)) keys.add(name);
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
  if (prefix && indexedDB.databases) {
    let remaining: IDBDatabaseInfo[] | null = null;
    try {
      remaining = await indexedDB.databases();
    } catch (error) {
      console.error("Offline document enumeration failed during sign-out", error);
      throw error;
    }
    if (remaining.some((database) => database.name?.startsWith(prefix)))
      throw new Error("New local document storage appeared during sign-out. Retry removal.");
  }
  const newlyRegistered = (completedWithoutEnumeration ? [] : await accountDocumentNames(accountKey, true)).filter(
    (key) => prefix && key.startsWith(prefix) && !keys.has(key),
  );
  if (newlyRegistered.length) throw new Error("New local document storage appeared during sign-out. Retry removal.");
  if (registryEntries().some((name) => !entryNamesAtStart.has(name)))
    throw new Error("New local document storage appeared during sign-out. Retry removal.");
  if (prefix && indexedDB.databases) {
    const remaining = await indexedDB.databases();
    if (remaining.some((database) => database.name?.startsWith(prefix)))
      throw new Error("New local document storage appeared during sign-out. Retry removal.");
  }
  const transaction = db.transaction(["accounts", "pages"], "readwrite");
  transaction.objectStore("accounts").delete(accountKey);
  const store = transaction.objectStore("pages");
  for (const page of pages) store.delete(page.key);
  await transactionDone(transaction);
  try {
    localStorage.removeItem(`${DOCUMENT_REGISTRY_PREFIX}${accountKey}`);
    for (const name of entryNamesAtStart) localStorage.removeItem(name);
    if (registryEntries().length)
      throw new Error("New local document storage appeared during sign-out. Retry removal.");
    localStorage.removeItem(`${PURGING_ACCOUNT_PREFIX}${accountKey}`);
  } catch (error) {
    console.error("Offline document registry could not be cleared", error);
    throw error;
  }
}
