import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import YProvider from "y-partyserver/provider";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import type { ClientMemberContext, Page, Space } from "../shared/types";
import { serializeDocument, type ProseMirrorJson } from "../shared/document-projection";
import { api, ApiClientError } from "./api";
import { EmbedFeatureContext } from "./editor-blocks";
import { notesSchema } from "./mentions";
import { useEffectiveColorScheme } from "./ThemeControl";
import {
  clearRevokedOfflinePages,
  getOfflinePage,
  markOfflinePagePending,
  markOfflinePageRevoked,
  type OfflineAccount,
  type OfflinePage,
} from "./offline-catalog";

type RecoveryState = "checking" | "offline";

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
  const [quarantined, setQuarantined] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const selectedReason = selected ? quarantined[selected.pageId] : undefined;

  const discardRevokedCopy = useCallback(
    async (pageId: string) => {
      if (!(await markOfflinePageRevoked(account.key, pageId))) {
        setQuarantined((current) => ({
          ...current,
          [pageId]: "The server could not confirm access to this edited copy. It remains available for export.",
        }));
        setRecovery("offline");
        return;
      }
      setAvailablePages((current) => current.filter((page) => page.pageId !== pageId));
      setSelected(null);
      setNotice("Access to that document was removed. Its local copy is being deleted.");
      const next = new URL(window.location.href);
      next.searchParams.delete("page");
      window.history.replaceState(null, "", next);
      window.setTimeout(() => {
        void clearRevokedOfflinePages(account.key).catch((error) =>
          console.error("Unable to remove a revoked offline copy", error),
        );
      }, 100);
    },
    [account.key],
  );

  const reconnect = useCallback(async () => {
    if (selectedReason) return;
    setRecovery("checking");
    try {
      const member = await api<ClientMemberContext>("/api/me");
      if (member.user.id !== account.userId || member.workspace.id !== account.workspaceId) {
        onRetry();
        return;
      }
      if (selected) {
        const stored = await getOfflinePage(account.key, selected.pageId);
        const [{ page }, { spaces }] = await Promise.all([
          api<{ page: Page }>(`/api/pages/${encodeURIComponent(selected.pageId)}`),
          api<{ spaces: Space[] }>("/api/spaces"),
        ]);
        const space = spaces.find((item) => item.id === page.spaceId);
        if (!space && !stored?.pendingChanges) {
          await discardRevokedCopy(selected.pageId);
          return;
        }
        if (
          !space ||
          (stored?.pendingChanges && (page.contentEpoch !== selected.epoch || space.effectiveRole === "viewer"))
        ) {
          setQuarantined((current) => ({
            ...current,
            [selected.pageId]:
              "Your access or this document's version changed. The local copy is preserved for export.",
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
          [selected.pageId]: "The server could not confirm access to this copy. It remains available for export.",
        }));
      }
      setRecovery("offline");
    }
  }, [account.key, account.userId, account.workspaceId, discardRevokedCopy, onRetry, selected, selectedReason]);

  useEffect(() => {
    const handleOnline = () => void reconnect();
    const interval = window.setInterval(() => void reconnect(), 15_000);
    window.addEventListener("online", handleOnline);
    return () => {
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
        <button
          type="button"
          onClick={selectedReason ? onRetry : () => void reconnect()}
          disabled={recovery === "checking"}
        >
          {selectedReason ? "Open online workspace" : recovery === "checking" ? "Checking access…" : "Reconnect"}
        </button>
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
                setSelected(page);
                const next = new URL(window.location.href);
                next.searchParams.set("page", page.pageId);
                window.history.replaceState(null, "", next);
                setRecovery("offline");
              }}
            >
              <strong>{page.title}</strong>
              <span>{page.spaceName}</span>
              <time dateTime={new Date(page.lastSyncedAt).toISOString()}>
                Synced {new Date(page.lastSyncedAt).toLocaleString()}
              </time>
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
              <OfflineEditor
                key={selected.pageId}
                page={selected}
                accountKey={account.key}
                quarantined={Boolean(selectedReason) || recovery === "checking"}
                editingEnabled={account.offlineEditingEnabled}
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
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const doc = new Y.Doc();
    const key = page.storageKeys.at(-1);
    if (!key) return undefined;
    const persistence = new IndexeddbPersistence(key, doc);
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
      provider.destroy();
      void persistence.destroy();
      doc.destroy();
    };
  }, [page]);

  const markdown = () => {
    if (!copy) return "";
    const document = yXmlFragmentToProsemirrorJSON(copy.doc.getXmlFragment("document-store")) as ProseMirrorJson;
    return `# ${page.title.replaceAll("\n", " ")}\n\n${serializeDocument(document).markdown}`;
  };
  const exportMarkdown = () => {
    const blob = new Blob([markdown()], { type: "text/markdown; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${page.title.replaceAll(/[\\/:*?"<>|]/g, "-")}-offline.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
}: {
  copy: { doc: Y.Doc; persistence: IndexeddbPersistence; provider: YProvider };
  page: OfflinePage;
  accountKey: string;
  editable: boolean;
}) {
  const [saveState, setSaveState] = useState<"ready" | "saving" | "saved" | "failed">(
    page.pendingChanges ? "saved" : "ready",
  );
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let generation = 0;
    let pendingCommitted = page.pendingChanges === true;
    let pendingMark: Promise<void> | null = null;
    let pendingError = false;
    const verifyStored = async (target: number) => {
      try {
        await pendingMark;
        if (pendingError) throw new Error("Offline catalog could not record pending changes.");
        const db = copy.persistence.db;
        if (!db) throw new Error("Offline document storage is unavailable.");
        // y-indexeddb writes each update first. A later transaction on the
        // same store completes only after those update transactions commit.
        const transaction = db.transaction("updates", "readonly");
        await new Promise<void>((resolve, reject) => {
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("abort", () => reject(transaction.error));
          transaction.addEventListener("error", () => reject(transaction.error));
        });
        if (active && target === generation) setSaveState("saved");
      } catch {
        if (active) setSaveState("failed");
      }
    };
    const updated = (_update: Uint8Array, origin: unknown) => {
      if (origin === copy.persistence || origin === copy.provider) return;
      generation += 1;
      setSaveState("saving");
      if (!pendingCommitted && !pendingMark) {
        pendingError = false;
        pendingMark = markOfflinePagePending(accountKey, page.pageId, true)
          .then(
            () => {
              pendingCommitted = true;
            },
            () => {
              pendingError = true;
            },
          )
          .finally(() => {
            pendingMark = null;
          });
      }
      if (timer !== undefined) window.clearTimeout(timer);
      const target = generation;
      timer = window.setTimeout(() => void verifyStored(target), 100);
    };
    copy.doc.on("update", updated);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      copy.doc.off("update", updated);
    };
  }, [accountKey, copy, page.pageId, page.pendingChanges]);
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
