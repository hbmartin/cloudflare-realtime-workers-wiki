import type { ClientMemberContext, Page, PageKind } from "../shared/types";

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
  revoked?: boolean;
  lastSyncedAt: number;
  storageKeys: string[];
};

let connection: Promise<IDBDatabase> | null = null;

export function offlineAccountKey(member: Pick<ClientMemberContext, "user" | "workspace">) {
  return `${member.user.id}\u0000${member.workspace.id}`;
}

export function offlineDocumentKey(userId: string, workspaceId: string, pageId: string, epoch: number) {
  return `account:${userId}:${workspaceId}:${pageId}:${epoch}:2`;
}

export function legacyOfflineDocumentKey(workspaceId: string, pageId: string, epoch: number) {
  return `${workspaceId}:${pageId}:${epoch}:1`;
}

export async function legacyOfflineCopies(workspaceId: string, pageId: string, epoch: number) {
  const candidates = new Set([legacyOfflineDocumentKey(workspaceId, pageId, epoch)]);
  try {
    const pointer = JSON.parse(localStorage.getItem(`notes:recovery:${workspaceId}:${pageId}`) ?? "null") as {
      key?: unknown;
    } | null;
    if (
      typeof pointer?.key === "string" &&
      pointer.key.startsWith(`${workspaceId}:${pageId}:`) &&
      /^\d+:1$/.test(pointer.key.slice(`${workspaceId}:${pageId}:`.length))
    )
      candidates.add(pointer.key);
  } catch {
    // A corrupt pointer must not hide the current-epoch legacy copy.
  }
  const copies = await Promise.all(
    [...candidates].map(async (key) =>
      (await hasOfflineDocument(key)) ? { key, epoch: Number(key.split(":").at(-2)) } : null,
    ),
  );
  return copies.filter((copy): copy is { key: string; epoch: number } => copy !== null);
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
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(key);
    request.addEventListener("upgradeneeded", () => request.transaction?.abort());
    request.addEventListener("success", () => {
      request.result.close();
      resolve(true);
    });
    request.addEventListener("error", () => {
      if (request.error?.name === "AbortError") resolve(false);
      else reject(request.error ?? new Error("Offline document lookup failed."));
    });
    request.addEventListener("blocked", () => reject(new Error("Offline document storage is in use by another tab.")));
  });
}

export async function listOfflinePages(accountKey: string): Promise<OfflinePage[]> {
  const pages = await readAccountPages(accountKey);
  const valid = pages.filter(
    (page) =>
      page.accountKey === accountKey && page.kind === "document" && !page.revoked && Array.isArray(page.storageKeys),
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

async function readAccountPages(accountKey: string): Promise<OfflinePage[]> {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readonly");
  const pages = await requestResult(
    transaction.objectStore("pages").index("byAccount").getAll(accountKey) as IDBRequest<OfflinePage[]>,
  );
  await transactionDone(transaction);
  return pages;
}

export async function getOfflinePage(accountKey: string, pageId: string): Promise<OfflinePage | null> {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readonly");
  const page = await requestResult(
    transaction.objectStore("pages").get(`${accountKey}\u0000${pageId}`) as IDBRequest<OfflinePage | undefined>,
  );
  await transactionDone(transaction);
  return page ?? null;
}

export async function rememberOfflinePage(
  member: ClientMemberContext,
  page: Page,
  spaceName: string,
  canEdit: boolean,
) {
  if (page.kind !== "document") return undefined;
  const db = await openCatalog();
  const accountKey = offlineAccountKey(member);
  const key = `${accountKey}\u0000${page.id}`;
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
  const entry: OfflinePage = {
    key,
    accountKey,
    pageId: page.id,
    title: page.title,
    spaceName,
    kind: page.kind,
    epoch: page.contentEpoch,
    canEdit,
    pendingChanges: previous?.epoch === page.contentEpoch && previous.pendingChanges === true,
    revoked: false,
    lastSyncedAt: Date.now(),
    storageKeys: [...new Set([...(previous?.storageKeys ?? []), storageKey])],
  };
  store.put(entry);
  await transactionDone(transaction);
  return entry;
}

export async function markOfflinePagePending(accountKey: string, pageId: string, pendingChanges: boolean) {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readwrite");
  const store = transaction.objectStore("pages");
  const key = `${accountKey}\u0000${pageId}`;
  const page = await requestResult(store.get(key) as IDBRequest<OfflinePage | undefined>);
  if (page) store.put({ ...page, pendingChanges });
  await transactionDone(transaction);
}

export async function markOfflinePageRevoked(accountKey: string, pageId: string) {
  const db = await openCatalog();
  const transaction = db.transaction("pages", "readwrite");
  const store = transaction.objectStore("pages");
  const key = `${accountKey}\u0000${pageId}`;
  const page = await requestResult(store.get(key) as IDBRequest<OfflinePage | undefined>);
  const revoked = Boolean(page && !page.pendingChanges);
  if (page && !page.pendingChanges) store.put({ ...page, revoked: true });
  await transactionDone(transaction);
  return revoked;
}

export async function clearRevokedOfflinePages(accountKey: string) {
  const db = await openCatalog();
  for (const page of (await readAccountPages(accountKey)).filter((entry) => entry.revoked && !entry.pendingChanges)) {
    for (const key of page.storageKeys) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(key);
        request.addEventListener("success", () => resolve());
        request.addEventListener("error", () => reject(request.error ?? new Error("Offline document removal failed.")));
        request.addEventListener("blocked", () =>
          reject(new Error("Close other NoteFlare tabs to remove old copies.")),
        );
      });
    }
    const transaction = db.transaction("pages", "readwrite");
    transaction.objectStore("pages").delete(page.key);
    await transactionDone(transaction);
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
  const pages = await readAccountPages(accountKey);
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
