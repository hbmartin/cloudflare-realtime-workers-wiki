import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { IndexeddbPersistence } from "y-indexeddb";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import type { ClientMemberContext, Page, Space } from "../shared/types";
import { api, ApiClientError } from "./api";
import { EmbedFeatureContext } from "./editor-blocks";
import { notesSchema } from "./mentions";
import { downloadOfflineMarkdown, exportPendingOfflinePages, offlineCopyMarkdown } from "./offline-export";
import { useEffectiveColorScheme } from "./ThemeControl";
import {
  compactDocumentUpdates,
  clearRevokedOfflinePages,
  getOfflinePage,
  listPendingOfflinePages,
  markOfflinePagePending,
  markOfflinePageRevoked,
  pendingKeysOf,
  persistPendingDocumentUpdate,
  type OfflineAccount,
  type OfflinePage,
} from "./offline-catalog";

type RecoveryState = "checking" | "finalizing" | "offline";

export function OfflineWorkspace({
  account,
  pages,
  onRetry,
  onSignOut,
}: {
  account: OfflineAccount;
  pages: OfflinePage[];
  onRetry: () => void;
  onSignOut: () => void;
}) {
  const [availablePages, setAvailablePages] = useState(pages);
  const [selected, setSelected] = useState<OfflinePage | null>(() => {
    const requested = new URL(window.location.href).searchParams.get("page");
    return requested ? (pages.find((page) => page.pageId === requested) ?? null) : (pages[0] ?? null);
  });
  const [recovery, setRecovery] = useState<RecoveryState>("offline");
  const [quarantined, setQuarantined] = useState<
    Record<string, { kind: "epoch" | "access" | "unknown"; message: string }>
  >({});
  const [notice, setNotice] = useState("");
  const selectedId = useRef(selected?.pageId ?? null);
  const reconnectController = useRef<AbortController | null>(null);
  const selectedQuarantine = selected ? quarantined[selected.pageId] : undefined;
  const selectedReason = selected?.revoked
    ? "Access to this copy must be confirmed online. Its unsynced edits remain available for export."
    : selectedQuarantine?.message;

  const discardRevokedCopy = useCallback(
    async (pageId: string) => {
      try {
        if (!(await markOfflinePageRevoked(account.key, pageId))) {
          setQuarantined((current) => ({
            ...current,
            [pageId]: {
              kind: "unknown",
              message: "The server could not confirm access to this edited copy. It remains available for export.",
            },
          }));
          return;
        }
        setAvailablePages((current) => current.filter((page) => page.pageId !== pageId));
        if (selectedId.current === pageId) {
          selectedId.current = null;
          setSelected(null);
          const next = new URL(window.location.href);
          next.searchParams.delete("page");
          window.history.replaceState(null, "", next);
        }
        setNotice("Access to that document was removed. Its local copy is being deleted.");
        window.setTimeout(() => {
          void clearRevokedOfflinePages(account.key).catch((error) =>
            console.error("Unable to remove a revoked offline copy", error),
          );
        }, 100);
      } catch (error) {
        console.error("Unable to remove a revoked offline copy", error);
        setQuarantined((current) => ({
          ...current,
          [pageId]: {
            kind: "unknown",
            message: "The server could not confirm access to this edited copy. It remains available for export.",
          },
        }));
      } finally {
        if (selectedId.current === pageId || selectedId.current === null) setRecovery("offline");
      }
    },
    [account.key],
  );

  const reconnect = useCallback(async () => {
    reconnectController.current?.abort();
    const controller = new AbortController();
    reconnectController.current = controller;
    const deadline = window.setTimeout(() => controller.abort(), 10_000);
    const ownsSelection = () =>
      reconnectController.current === controller && selectedId.current === (selected?.pageId ?? null);
    const isCurrent = () => !controller.signal.aborted && ownsSelection();
    setRecovery("checking");
    try {
      const member = await api<ClientMemberContext>("/api/me", { signal: controller.signal });
      if (!isCurrent()) return;
      if (member.user.id !== account.userId || member.workspace.id !== account.workspaceId) {
        onRetry();
        return;
      }
      if (selected) {
        const [{ page }, { spaces }] = await Promise.all([
          api<{ page: Page }>(`/api/pages/${encodeURIComponent(selected.pageId)}`, { signal: controller.signal }),
          api<{ spaces: Space[] }>("/api/spaces", { signal: controller.signal }),
        ]);
        if (!isCurrent()) return;
        flushSync(() => setRecovery("finalizing"));
        const stored = await getOfflinePage(account.key, selected.pageId);
        if (!isCurrent()) return;
        const hasDraft = Boolean((stored && pendingKeysOf(stored).length) || pendingKeysOf(selected).length);
        const space = spaces.find((item) => item.id === page.spaceId);
        if (!space && !hasDraft) {
          await discardRevokedCopy(selected.pageId);
          return;
        }
        if (!space || (hasDraft && space.effectiveRole === "viewer")) {
          setQuarantined((current) => ({
            ...current,
            [selected.pageId]: {
              kind: "access",
              message: "Your access changed. The local copy is preserved for export.",
            },
          }));
          setRecovery("offline");
          return;
        }
        if (hasDraft && page.contentEpoch !== selected.epoch) {
          setQuarantined((current) => ({
            ...current,
            [selected.pageId]: {
              kind: "epoch",
              message: "This document's version changed. The local copy is preserved for export.",
            },
          }));
          setRecovery("offline");
          return;
        }
        const next = new URL(window.location.href);
        next.searchParams.set("page", selected.pageId);
        window.history.replaceState(null, "", next);
      }
      onRetry();
    } catch (error) {
      if (!ownsSelection()) return;
      if (controller.signal.aborted) {
        setRecovery("offline");
        return;
      }
      if (error instanceof ApiClientError && error.status === 401) {
        onRetry();
        return;
      }
      if (selected && error instanceof ApiClientError && [403, 404, 410].includes(error.status)) {
        await discardRevokedCopy(selected.pageId);
        return;
      }
      if (
        error instanceof TypeError ||
        (error instanceof Error && error.name === "AbortError") ||
        (error instanceof ApiClientError && error.status >= 500)
      ) {
        setRecovery("offline");
        return;
      }
      if (selected) {
        setQuarantined((current) => ({
          ...current,
          [selected.pageId]: {
            kind: "unknown",
            message: "The server could not confirm access to this copy. It remains available for export.",
          },
        }));
      }
      setRecovery("offline");
    } finally {
      window.clearTimeout(deadline);
      if (reconnectController.current === controller) {
        reconnectController.current = null;
        if (controller.signal.aborted && selectedId.current === (selected?.pageId ?? null)) setRecovery("offline");
      }
    }
  }, [account.key, account.userId, account.workspaceId, discardRevokedCopy, onRetry, selected]);

  useEffect(() => {
    const handleOnline = () => void reconnect();
    const interval = window.setInterval(() => void reconnect(), 15_000);
    window.addEventListener("online", handleOnline);
    return () => {
      reconnectController.current?.abort();
      window.removeEventListener("online", handleOnline);
      window.clearInterval(interval);
    };
  }, [reconnect]);

  return (
    <div className="offline-workspace">
      <header className="offline-header">
        <div>
          <strong>{account.workspaceName}</strong>
          <span>Offline copy for {account.userName}</span>
        </div>
        <button type="button" onClick={() => void reconnect()} disabled={recovery !== "offline"}>
          {recovery !== "offline" ? "Checking access…" : "Reconnect"}
        </button>
        {selectedReason && (
          <button
            type="button"
            onClick={() => {
              const next = new URL(window.location.href);
              if (selectedQuarantine?.kind === "epoch" && selected) next.searchParams.set("page", selected.pageId);
              else next.searchParams.delete("page");
              window.history.replaceState(null, "", next);
              onRetry();
            }}
          >
            Open online workspace
          </button>
        )}
        <button type="button" onClick={onSignOut}>
          Sign out and remove local copies
        </button>
      </header>
      <div className="offline-layout">
        <nav aria-label="Cached documents" className="offline-list">
          <h1>Available offline</h1>
          <p>Only documents opened on this device appear here. Server actions require a connection.</p>
          {notice && <output>{notice}</output>}
          {availablePages.length === 0 && <p>No document copies remain on this device.</p>}
          {availablePages.map((page) => (
            <button
              type="button"
              key={page.pageId}
              aria-current={selected?.pageId === page.pageId ? "page" : undefined}
              onClick={() => {
                reconnectController.current?.abort();
                selectedId.current = page.pageId;
                setSelected(page);
                const next = new URL(window.location.href);
                next.searchParams.set("page", page.pageId);
                window.history.replaceState(null, "", next);
                setRecovery("offline");
              }}
            >
              <strong>{page.title}</strong>
              <span>{page.spaceName}</span>
              {page.lastSyncedAt > 0 ? (
                <time dateTime={new Date(page.lastSyncedAt).toISOString()}>
                  Synced {new Date(page.lastSyncedAt).toLocaleString()}
                </time>
              ) : (
                <span>Not yet synced</span>
              )}
            </button>
          ))}
        </nav>
        <main className="offline-document">
          {selected ? (
            <>
              <output className="notice">
                {selectedReason
                  ? selectedReason
                  : "Offline copy. Changes stay on this device until access is checked and server sync is confirmed."}
              </output>
              {selectedReason && (
                <button
                  type="button"
                  onClick={() => {
                    void listPendingOfflinePages(account.key)
                      .then(async (pending) => {
                        const copies = pending.filter((page) => page.pageId === selected.pageId);
                        if (!copies.length) {
                          setNotice("No unsynced copy is available to export for this page.");
                          return;
                        }
                        await exportPendingOfflinePages(copies);
                      })
                      .catch((error) =>
                        setNotice(error instanceof Error ? error.message : "Unable to export local changes."),
                      );
                  }}
                >
                  Export all unsynced copies of this page
                </button>
              )}
              <OfflineEditor
                key={selected.pageId}
                page={selected}
                accountKey={account.key}
                quarantined={Boolean(selectedReason)}
                editingEnabled={account.offlineEditingEnabled && recovery !== "finalizing"}
              />
            </>
          ) : (
            <p>This page is unavailable offline. Tables, diagrams, and uncached documents need a connection.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function OfflineEditor({
  page,
  accountKey,
  quarantined,
  editingEnabled,
}: {
  page: OfflinePage;
  accountKey: string;
  quarantined: boolean;
  editingEnabled: boolean;
}) {
  const [copy, setCopy] = useState<{ doc: Y.Doc; persistence: IndexeddbPersistence; provider: YProvider } | null>(null);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((flush: () => Promise<void>) => {
    flushRef.current = flush;
  }, []);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const doc = new Y.Doc();
    const key = page.storageKeys.at(-1);
    if (!key) return undefined;
    const persistence = new IndexeddbPersistence(key, doc);
    doc.off("update", persistence["_storeUpdate"]);
    const provider = new YProvider(window.location.host, `${page.pageId}~${page.epoch}`, doc, {
      party: "document",
      connect: false,
    });
    void persistence.whenSynced.then(
      () => {
        if (active) setCopy({ doc, persistence, provider });
      },
      () => {
        if (active) setError("This document copy could not be read from this device.");
      },
    );
    return () => {
      active = false;
      void (flushRef.current?.() ?? Promise.resolve())
        .catch((cause: unknown) => {
          console.error("Offline edits could not be saved before closing the editor", cause);
        })
        .finally(() => {
          provider.destroy();
          void persistence.destroy();
          doc.destroy();
        });
    };
  }, [page]);

  const markdown = () => {
    if (!copy) return "";
    return offlineCopyMarkdown(copy.doc, page.title);
  };
  const exportMarkdown = () => {
    downloadOfflineMarkdown(markdown(), `${page.title}-offline.md`);
  };

  return (
    <>
      <div className="offline-document-heading">
        <h2>{page.title}</h2>
        <button type="button" onClick={exportMarkdown} disabled={!copy}>
          Export Markdown
        </button>
        <button type="button" onClick={() => void navigator.clipboard.writeText(markdown())} disabled={!copy}>
          Copy Markdown
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {copy ? (
        <OfflineBlockEditor
          copy={copy}
          page={page}
          accountKey={accountKey}
          editable={page.canEdit && editingEnabled && !quarantined}
          registerFlush={registerFlush}
        />
      ) : (
        !error && <p>Opening local document…</p>
      )}
    </>
  );
}

function OfflineBlockEditor({
  copy,
  page,
  accountKey,
  editable,
  registerFlush,
}: {
  copy: { doc: Y.Doc; persistence: IndexeddbPersistence; provider: YProvider };
  page: OfflinePage;
  accountKey: string;
  editable: boolean;
  registerFlush: (flush: () => Promise<void>) => void;
}) {
  const storageKey = page.storageKeys.at(-1) ?? "";
  const initialPending = pendingKeysOf(page).includes(storageKey);
  const edited = useRef(false);
  const [saveState, setSaveState] = useState<"ready" | "saving" | "saved" | "failed">(
    initialPending ? "saved" : "ready",
  );
  useEffect(() => {
    let live = true;
    void getOfflinePage(accountKey, page.pageId)
      .then((current) => {
        if (live && current && !edited.current)
          setSaveState(pendingKeysOf(current).includes(storageKey) ? "saved" : "ready");
      })
      .catch((error) => console.error("Offline save status could not be read", error));
    return () => {
      live = false;
    };
  }, [accountKey, page.pageId, storageKey]);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const updates: Uint8Array[] = [];
    let writing: Promise<void> | null = null;
    let pendingCommitted = false;
    let pendingMark: Promise<void> | null = null;
    let persistedBatches = copy.persistence["_dbsize"];
    const markPending = () => {
      if (pendingCommitted) return Promise.resolve();
      pendingMark ??= markOfflinePagePending(accountKey, page.pageId, storageKey, true)
        .then(() => {
          pendingCommitted = true;
        })
        .finally(() => {
          pendingMark = null;
        });
      return pendingMark;
    };
    const persistUpdates = (): Promise<void> => {
      if (writing) return writing;
      let failed = false;
      writing = (async () => {
        const db = copy.persistence.db;
        if (!db) throw new Error("Offline document storage is unavailable.");
        while (updates.length) {
          const batch = updates.slice();
          const target = generation;
          // Start the document transaction before the first await. The marker
          // is atomic with the Yjs update and recovers an interrupted catalog write.
          await persistPendingDocumentUpdate(db, batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch));
          updates.splice(0, batch.length);
          await markPending();
          if (++persistedBatches >= 500) {
            persistedBatches = 0;
            void compactDocumentUpdates(copy.persistence).catch((error) =>
              console.error("Unable to compact offline document storage", error),
            );
          }
          if (active && target === generation) setSaveState("saved");
        }
      })()
        .catch((error: unknown) => {
          failed = true;
          if (active) setSaveState("failed");
          throw error;
        })
        .finally(() => {
          writing = null;
          if (!failed && updates.length && active) void persistUpdates().catch(() => {});
        });
      return writing;
    };
    registerFlush(async () => {
      while (updates.length) await persistUpdates();
    });
    const flushOnHide = () => {
      if (!updates.length || !copy.persistence.db) return;
      try {
        void persistPendingDocumentUpdate(copy.persistence.db, Y.mergeUpdates(updates)).catch((error) =>
          console.error("Offline edits could not be queued during page unload", error),
        );
      } catch (error) {
        console.error("Offline edits could not be queued during page unload", error);
      }
    };
    const updated = (update: Uint8Array, origin: unknown) => {
      if (origin === copy.persistence || origin === copy.provider) return;
      edited.current = true;
      generation += 1;
      updates.push(update);
      setSaveState("saving");
      void persistUpdates().catch(() => {});
    };
    copy.doc.on("update", updated);
    window.addEventListener("pagehide", flushOnHide);
    return () => {
      active = false;
      copy.doc.off("update", updated);
      window.removeEventListener("pagehide", flushOnHide);
      // OfflineEditor waits for this queue before closing IndexedDB.
    };
    // The catalog identity and document epoch are part of this writer's lease.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [accountKey, copy, page.pageId, registerFlush, storageKey]);
  const options = useMemo(
    () =>
      withCollaboration({
        schema: notesSchema,
        uploadFile: async () => {
          throw new Error("Uploads require a connection.");
        },
        collaboration: {
          fragment: copy.doc.getXmlFragment("document-store"),
          provider: copy.provider,
          user: { name: "Offline", color: "#64748b" },
        },
      }),
    [copy],
  );
  const editor = useCreateBlockNote(options, [copy]);
  const theme = useEffectiveColorScheme();
  return (
    <EmbedFeatureContext.Provider value={false}>
      <BlockNoteView editor={editor} editable={editable} theme={theme} slashMenu={false} className="notes-editor" />
      <output className="muted">
        {saveState === "saving"
          ? "Saving locally…"
          : saveState === "saved"
            ? "Saved locally · pending server sync"
            : saveState === "failed"
              ? "Local save failed. Export this copy before closing it."
              : editable
                ? "Offline copy ready for editing"
                : "Read-only local copy"}
      </output>
    </EmbedFeatureContext.Provider>
  );
}
