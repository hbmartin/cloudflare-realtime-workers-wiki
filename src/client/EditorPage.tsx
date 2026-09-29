import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { ActionMenu, PageTools } from "./WorkspaceUI";
import { CommentsExtension } from "@blocknote/core/comments";
import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
  SyntaxHighlightingExtension,
} from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  ThreadsSidebar,
  useCreateBlockNote,
} from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import type { ClientMemberContext, Space } from "../shared/types";
import type { MentionSuggestion, Page } from "../shared/types";
import { projectDocument, serializeDocument, type ProseMirrorJson } from "../shared/document-projection";
import { diffBlockIds } from "../shared/block-diff";
import { ApiClientError, api, apiErrorMessage, json } from "./api";
import { BacklinksPanel } from "./BacklinksPanel";
import { createCollaboration, loadOfflineCopy, type CollaborationBundle, userColor } from "./collaboration";
import { exportOfflineCopyMarkdown } from "./offline-export";
import { createDocumentCloseReconciler } from "./document-connection";
import { editorBlockFactories, EmbedFeatureContext, safeBookmarkUrl } from "./editor-blocks";
import { resolveEmbed } from "../shared/embed-providers";
import { notesCommentSchema, notesSchema } from "./mentions";
import { ServerThreadStore } from "./server-thread-store";
import { resolveAttachmentUrl, uploadAttachment } from "./uploads";
import { useEffectiveColorScheme } from "./ThemeControl";
import {
  getOfflinePage,
  markOfflinePagePending,
  offlineAccountKey,
  offlineDocumentKey,
  pendingKeysOf,
  persistPendingDocumentUpdate,
  rememberOfflinePage,
  setDocumentPendingMarker,
  storageEpoch,
} from "./offline-catalog";

export type EditorPageProps = {
  page: Page;
  metadata?: ReactNode;
  taskList?: Page | undefined;
  member: ClientMemberContext;
  spaceName?: string;
  onPageChanged: (page: Page) => void;
  onPageUnavailable: (pageId: string) => void;
  onAccessDenied: (pageId: string, error: ApiClientError) => void;
  onSelectPage: (pageId: string) => void;
  backlinksRevision: number;
  commentsRevision?: number;
};

export function EditorPage({
  page,
  metadata,
  taskList,
  member,
  spaceName = "Space",
  onPageChanged,
  onPageUnavailable,
  onAccessDenied,
  onSelectPage,
  backlinksRevision,
  commentsRevision = 0,
}: EditorPageProps) {
  const [bundle, setBundle] = useState<CollaborationBundle | null>(null);
  const [status, setStatus] = useState<"offline" | "connecting" | "connected">("connecting");
  const [hasConfirmedSync, setHasConfirmedSync] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [accessQuarantine, setAccessQuarantine] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [sizeWarning, setSizeWarning] = useState<{ bytes: number; readOnly: boolean } | null>(null);
  const recoveryKey = `notes:recovery:${member.user.id}:${member.workspace.id}:${page.id}`;
  type RecoveryEntry = { key: string; epoch: number; reason?: "access" | "storage" | "epoch" };
  const [recovery, setRecovery] = useState<RecoveryEntry[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(recoveryKey) ?? "null");
      const entries = Array.isArray(saved) ? saved : saved ? [saved] : [];
      return entries.filter(
        (entry): entry is RecoveryEntry =>
          entry !== null && typeof entry === "object" && typeof entry.key === "string" && Number.isInteger(entry.epoch),
      );
    } catch {
      return [];
    }
  });
  const recoveryRef = useRef(recovery);
  const replaceRecovery = useCallback(
    (next: RecoveryEntry[]) => {
      recoveryRef.current = next;
      try {
        localStorage.setItem(recoveryKey, JSON.stringify(next));
      } catch (error) {
        console.error("Unable to persist offline recovery details", error);
      }
      setRecovery(next);
    },
    [recoveryKey],
  );
  const dismissedRecovery = useRef<Record<string, number>>({});
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`${recoveryKey}:dismissed`) ?? "{}");
      dismissedRecovery.current = Array.isArray(saved)
        ? Object.fromEntries(saved.filter((key): key is string => typeof key === "string").map((key) => [key, -1]))
        : saved && typeof saved === "object"
          ? Object.fromEntries(Object.entries(saved).filter(([key, value]) => key && Number.isInteger(value)))
          : {};
    } catch {
      dismissedRecovery.current = {};
    }
  }, [recoveryKey]);
  const [recoveryPreview, setRecoveryPreview] = useState<{ key: string; text: string } | null>(null);
  const [title, setTitle] = useState(page.title);
  const [titleError, setTitleError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [iconError, setIconError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const titlePageIdRef = useRef(page.id);
  const titleRevisionRef = useRef(page.revision);
  const titleDirtyRef = useRef(false);
  const editable = member.role !== "viewer" && !sizeWarning?.readOnly && !storageError && !accessQuarantine;
  const commentsVisible = commentsOpen;
  const [panelTarget, setPanelTarget] = useState<HTMLDivElement | null>(null);
  const offlineMetadata = useRef({ page, spaceName });
  const offlineMember = useRef(member);
  useEffect(() => {
    offlineMetadata.current = { page, spaceName };
  }, [page, spaceName]);
  useEffect(() => {
    offlineMember.current = member;
  }, [member]);
  const offlineTitle = page.title;
  const offlineRole = member.role;
  useEffect(() => {
    if (!hasConfirmedSync) return;
    void rememberOfflinePage(
      offlineMember.current,
      { ...offlineMetadata.current.page, title: offlineTitle },
      spaceName,
      offlineRole !== "viewer",
    ).catch((error) => console.error("Unable to remember this document for offline use", error));
  }, [hasConfirmedSync, offlineTitle, spaceName, offlineRole]);

  useEffect(() => {
    if (titlePageIdRef.current !== page.id) {
      titlePageIdRef.current = page.id;
      titleDirtyRef.current = false;
      titleRevisionRef.current = page.revision;
      setTitle(page.title);
      setTitleError("");
      setEditorError("");
      setIconError("");
      return;
    }
    if (!titleDirtyRef.current && document.activeElement !== titleRef.current) {
      titleRevisionRef.current = page.revision;
      setTitle(page.title);
    }
  }, [page.id, page.revision, page.title]);

  useEffect(() => {
    let active = true;
    let pendingWrite = Promise.resolve();
    const currentStorageKey = offlineDocumentKey(member.user.id, member.workspace.id, page.id, page.contentEpoch);
    const quarantine = (key = currentStorageKey, reason: RecoveryEntry["reason"] = "epoch") => {
      if (!active) return;
      const value = {
        key,
        epoch: storageEpoch(key) || page.contentEpoch,
        reason,
      };
      if (dismissedRecovery.current[key] !== undefined && reason === "epoch") return;
      const current = recoveryRef.current;
      if (current.some((entry) => entry.key === key && entry.epoch === value.epoch && entry.reason === reason)) return;
      replaceRecovery([...current.filter((entry) => entry.key !== key), value].sort((a, b) => a.epoch - b.epoch));
    };
    let next: CollaborationBundle;
    let catalogFailures = 0;
    let pendingActive = false;
    let pendingRevision = 0;
    let storageFailed = false;
    const beforeConnect = async () => {
      await pendingWrite;
      if (!active) return false;
      const readingRevision = pendingRevision;
      const accountKey = offlineAccountKey(offlineMember.current);
      let catalogPage;
      try {
        catalogPage = await getOfflinePage(accountKey, page.id);
        catalogFailures = 0;
      } catch (error) {
        console.error("Unable to read offline document state", error);
        if (++catalogFailures >= 3 && active) {
          setStorageError("Offline storage is unavailable, so editing and collaboration are disabled for this page.");
          return false;
        }
        throw error;
      }
      const pendingKeys = catalogPage ? pendingKeysOf(catalogPage) : [];
      if (readingRevision === pendingRevision) pendingActive = pendingKeys.includes(currentStorageKey);
      const olderDrafts = pendingKeys.filter((key) => key !== currentStorageKey);
      for (const key of olderDrafts) quarantine(key);
      const hasLocalDraft =
        pendingKeys.includes(currentStorageKey) || pendingActive || (!catalogPage && next.hasUnsyncedChanges);
      const controller = new AbortController();
      const deadline = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const currentMember = await api<ClientMemberContext>("/api/me", { signal: controller.signal });
        if (currentMember.user.id !== member.user.id || currentMember.workspace.id !== member.workspace.id) {
          window.location.reload();
          return false;
        }
        // A clean copy can rely on the document room's page access check.
        if (!hasLocalDraft && !olderDrafts.length) return true;
        const [{ page: currentPage }, { spaces }] = await Promise.all([
          api<{ page: Page }>(`/api/pages/${encodeURIComponent(page.id)}`, { signal: controller.signal }),
          api<{ spaces: Space[] }>("/api/spaces", { signal: controller.signal }),
        ]);
        if (!active) return false;
        if (currentPage.contentEpoch !== page.contentEpoch) {
          if (hasLocalDraft) quarantine(currentStorageKey);
          onPageChanged(currentPage);
          return false;
        }
        const space = spaces.find((item) => item.id === currentPage.spaceId);
        if (!space || (space.effectiveRole === "viewer" && hasLocalDraft)) {
          if (hasLocalDraft || olderDrafts.length) {
            if (hasLocalDraft) quarantine(currentStorageKey, "access");
            setAccessQuarantine(true);
          } else {
            onPageUnavailable(page.id);
          }
          return false;
        }
        return true;
      } catch (error) {
        if (error instanceof ApiClientError && [401, 403, 404, 410].includes(error.status)) {
          if (error.status === 401) {
            if (hasLocalDraft) quarantine(currentStorageKey, "access");
          } else if (hasLocalDraft || olderDrafts.length) {
            if (hasLocalDraft) quarantine(currentStorageKey, "access");
            setAccessQuarantine(true);
          } else if (error.status === 403) onAccessDenied(page.id, error);
          else onPageUnavailable(page.id);
          return false;
        }
        throw error;
      } finally {
        window.clearTimeout(deadline);
      }
    };
    next = createCollaboration(
      member.workspace.id,
      page.id,
      page.contentEpoch,
      setStatus,
      member.user.id,
      beforeConnect,
    );
    const clearCurrentRecovery = () => {
      if (!active) return;
      const current = recoveryRef.current;
      const remaining = current.filter((entry) => entry.key !== currentStorageKey);
      if (remaining.length !== current.length) replaceRecovery(remaining);
      setStorageError("");
    };
    const writePending = (pending: boolean) => {
      if (!pending && storageFailed) return;
      if (pending && pendingActive) return;
      if (!pending && !pendingActive) {
        clearCurrentRecovery();
        return;
      }
      pendingActive = pending;
      pendingRevision += 1;
      pendingWrite = pendingWrite
        .then(async () => {
          if (!pending && storageFailed) return;
          const currentMember = offlineMember.current;
          if (pending) {
            await setDocumentPendingMarker(currentStorageKey);
            await rememberOfflinePage(
              currentMember,
              offlineMetadata.current.page,
              offlineMetadata.current.spaceName,
              currentMember.role !== "viewer",
              false,
            );
          }
          await markOfflinePagePending(offlineAccountKey(currentMember), page.id, currentStorageKey, pending);
          if (!pending) {
            await rememberOfflinePage(
              currentMember,
              offlineMetadata.current.page,
              offlineMetadata.current.spaceName,
              currentMember.role !== "viewer",
              true,
            );
            clearCurrentRecovery();
          }
        })
        .catch((error) => {
          console.error("Unable to update offline sync state", error);
          if (pending && active) {
            quarantine(currentStorageKey, "storage");
            setStorageError("Offline storage could not record these local changes. Export this copy before leaving.");
          }
        });
    };
    const documentUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== next.provider && origin !== next.indexeddb) {
        if (dismissedRecovery.current[currentStorageKey] !== undefined) {
          delete dismissedRecovery.current[currentStorageKey];
          try {
            localStorage.setItem(`${recoveryKey}:dismissed`, JSON.stringify(dismissedRecovery.current));
          } catch (error) {
            console.error("Unable to update dismissed recovery details", error);
          }
        }
        try {
          const db = next.indexeddb.db;
          if (!db) throw new Error("Offline document storage is unavailable.");
          const stored = persistPendingDocumentUpdate(db, _update);
          pendingWrite = pendingWrite
            .then(() => stored)
            .catch((error) => {
              storageFailed = true;
              console.error("Unable to persist local document update", error);
              if (active) {
                quarantine(currentStorageKey, "storage");
                setStorageError(
                  "Offline storage could not record these local changes. Export this copy before leaving.",
                );
              }
            });
          writePending(true);
        } catch (error) {
          storageFailed = true;
          console.error("Unable to persist local document update", error);
          quarantine(currentStorageKey, "storage");
          setStorageError("Offline storage could not record these local changes. Export this copy before leaving.");
        }
      }
    };
    next.doc.on("update", documentUpdate);
    const customMessage = (message: string) => {
      try {
        const value = JSON.parse(message) as { type: string; bytes: number; readOnly: boolean };
        if (value.type === "document-size") setSizeWarning(value);
        if (value.type === "document-update-ack" && !next.hasUnsyncedChanges) writePending(false);
      } catch {
        // Ignore custom messages from future server versions.
      }
    };
    next.provider.on("custom-message", customMessage);
    const closeReconciler = createDocumentCloseReconciler({
      page: { id: page.id, contentEpoch: page.contentEpoch },
      provider: next.provider,
      canQuarantine: member.role !== "viewer",
      hasUnsyncedChanges: () => next.hasUnsyncedChanges,
      quarantine,
      onPageChanged,
      onPageUnavailable,
      onAccessDenied,
    });
    const connectionClose = (event: CloseEvent) => closeReconciler.handleClose(event);
    const connectionSync = (synced: boolean) => {
      closeReconciler.handleSync(synced);
      if (synced && active) setHasConfirmedSync(true);
    };
    next.provider.on("connection-close", connectionClose);
    next.provider.on("sync", connectionSync);
    void (async () => {
      try {
        await next.ready;
        if (active) setBundle(next);
      } catch {
        if (!active) return;
        setStorageError("Offline storage is unavailable, so editing and collaboration are disabled for this page.");
      }
    })();
    return () => {
      active = false;
      closeReconciler.destroy();
      next.provider.off("custom-message", customMessage);
      next.provider.off("connection-close", connectionClose);
      next.provider.off("sync", connectionSync);
      next.doc.off("update", documentUpdate);
      next.destroy();
      setBundle(null);
    };
  }, [
    member.role,
    member.user.id,
    member.workspace.id,
    onAccessDenied,
    onPageChanged,
    onPageUnavailable,
    page.id,
    page.contentEpoch,
    recoveryKey,
    replaceRecovery,
  ]);

  async function saveTitle() {
    if (!titleDirtyRef.current) {
      titleRevisionRef.current = page.revision;
      setTitle(page.title);
      return;
    }
    const normalized = title.trim() || "Untitled";
    if (normalized === page.title) {
      titleDirtyRef.current = false;
      titleRevisionRef.current = page.revision;
      setTitle(page.title);
      return;
    }
    try {
      const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
        method: "PATCH",
        body: json({ title: normalized, revision: titleRevisionRef.current }),
      });
      titleDirtyRef.current = false;
      titleRevisionRef.current = result.page.revision;
      setTitleError("");
      onPageChanged(result.page);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        try {
          const latest = await api<{ page: Page }>(`/api/pages/${page.id}`);
          titleRevisionRef.current = latest.page.revision;
          onPageChanged(latest.page);
        } catch {
          // Keep the draft even when refreshing the conflicting metadata fails.
        }
        setTitleError("Page metadata changed. Your title was kept; review it and try again.");
        return;
      }
      setTitleError(apiErrorMessage(error, "The title could not be saved."));
    }
  }

  return (
    <main className={`page-canvas ${page.fullWidth ? "full-width" : ""}`}>
      <PageTools>
        {status !== "connected" && (
          <output className={`sync-state sync-${status}`}>{status === "connecting" ? "Connecting…" : "Offline"}</output>
        )}
        <ActionMenu label="Page details" icon="comment">
          {editable && (
            <button
              data-close-menu
              className="quiet-button"
              onClick={async () => {
                const icon = prompt("Page icon (one emoji, or leave blank to remove)", page.icon ?? "")?.trim();
                if (icon === undefined) return;
                try {
                  const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
                    method: "PATCH",
                    body: json({ icon: icon || null, revision: page.revision }),
                  });
                  onPageChanged(result.page);
                  setIconError("");
                } catch (error) {
                  setIconError(apiErrorMessage(error, "The page icon could not be saved."));
                }
              }}
            >
              {page.icon ?? "Add icon"}
            </button>
          )}
          <button
            data-close-menu
            className="quiet-button"
            onClick={() => {
              setCommentsOpen((open) => !open);
              setAttachmentsOpen(false);
              setHistoryOpen(false);
              setBacklinksOpen(false);
            }}
          >
            Comments
          </button>
          <button
            data-close-menu
            className="quiet-button"
            onClick={() => {
              setAttachmentsOpen((open) => !open);
              setCommentsOpen(false);
              setHistoryOpen(false);
              setBacklinksOpen(false);
            }}
          >
            Files
          </button>
          <button
            data-close-menu
            className="quiet-button"
            onClick={() => {
              setHistoryOpen((open) => !open);
              setCommentsOpen(false);
              setAttachmentsOpen(false);
              setBacklinksOpen(false);
            }}
          >
            History
          </button>
          <button
            data-close-menu
            className="quiet-button"
            onClick={() => {
              setBacklinksOpen((open) => !open);
              setCommentsOpen(false);
              setAttachmentsOpen(false);
              setHistoryOpen(false);
            }}
          >
            Backlinks
          </button>
        </ActionMenu>
      </PageTools>
      {sizeWarning && (
        <div className={`notice ${sizeWarning.readOnly ? "notice-danger" : ""}`}>
          This document is {(sizeWarning.bytes / 1024 / 1024).toFixed(1)} MiB.
          {sizeWarning.readOnly
            ? " It is read-only at the 24 MiB safety limit."
            : " Consider splitting it before it reaches 24 MiB."}
        </div>
      )}
      {storageError && <div className="notice notice-danger">{storageError}</div>}
      {recovery
        .filter((entry) => entry.epoch !== page.contentEpoch || accessQuarantine || storageError)
        .map((entry) => (
          <div className="notice recovery-notice" key={entry.key}>
            <div>
              <strong>Offline copy quarantined</strong>
              <span>
                {entry.reason === "storage" && entry.epoch === page.contentEpoch
                  ? "Offline storage could not record these edits. Export this copy before leaving."
                  : entry.reason === "access" || accessQuarantine
                    ? "Current access could not be confirmed for these edits. They were not sent to the server."
                    : `Edits from epoch ${entry.epoch} were not merged after this page was restored.`}
              </span>
            </div>
            <button
              className="quiet-button"
              onClick={async () => {
                const doc = await loadOfflineCopy(entry.key);
                setRecoveryPreview({ key: entry.key, text: plainYDoc(doc) });
                doc.destroy();
              }}
            >
              Preview
            </button>
            <button
              className="quiet-button"
              onClick={() => void exportOfflineCopyMarkdown(entry.key, page.title, `offline-epoch-${entry.epoch}`)}
            >
              Export Markdown
            </button>
            <button
              className="quiet-button"
              onClick={async () => {
                const doc = await loadOfflineCopy(entry.key);
                const projection = yXmlFragmentToProsemirrorJSON(
                  doc.getXmlFragment("document-store"),
                ) as ProseMirrorJson;
                await navigator.clipboard.writeText(serializeDocument(projection).markdown);
                doc.destroy();
              }}
            >
              Copy Markdown
            </button>
            {(entry.epoch !== page.contentEpoch || (entry.reason !== "access" && !accessQuarantine)) && (
              <button
                className="quiet-button"
                onClick={() => {
                  dismissedRecovery.current[entry.key] = page.contentEpoch;
                  localStorage.setItem(`${recoveryKey}:dismissed`, JSON.stringify(dismissedRecovery.current));
                  replaceRecovery(recoveryRef.current.filter((item) => item.key !== entry.key));
                  setRecoveryPreview(null);
                }}
              >
                Dismiss
              </button>
            )}
            {recoveryPreview?.key === entry.key && <p>{recoveryPreview.text}</p>}
          </div>
        ))}
      {taskList && (
        <button className="quiet-button task-detail-link" onClick={() => onSelectPage(taskList.id)}>
          ← {taskList.title} · Task properties
        </button>
      )}
      <div
        className={`document-layout ${commentsVisible || historyOpen || attachmentsOpen || backlinksOpen ? "with-panel" : ""}`}
      >
        <article className="document-paper">
          {page.icon && <div className="page-heading-icon">{page.icon}</div>}
          <input
            ref={titleRef}
            className="page-title"
            value={title}
            onChange={(event) => {
              if (!titleDirtyRef.current && title === page.title) titleRevisionRef.current = page.revision;
              titleDirtyRef.current = true;
              setTitleError("");
              setTitle(event.target.value);
            }}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            readOnly={!editable || Boolean(taskList)}
            aria-label="Page title"
          />
          {metadata}
          {titleError && <p className="form-error">{titleError}</p>}
          {editorError && (
            <p className="form-error" role="alert">
              {editorError}
            </p>
          )}
          {iconError && (
            <p className="form-error" role="alert">
              {iconError}
            </p>
          )}
          {bundle ? (
            <CollaborativeEditor
              bundle={bundle}
              member={member}
              editable={editable}
              panelTarget={panelTarget}
              commentsOpen={commentsVisible}
              pageId={page.id}
              commentsRevision={commentsRevision}
              onPageCreated={onPageChanged}
              onError={setEditorError}
            />
          ) : storageError ? (
            <div className="editor-loading">
              This document cannot be opened safely until offline storage is available.
            </div>
          ) : (
            <div className="editor-loading">Opening your offline copy…</div>
          )}
        </article>
        {(commentsVisible || historyOpen || attachmentsOpen || backlinksOpen) && (
          <aside className="side-panel page-side-panel" aria-label="Page panel">
            <button
              className="icon-button page-panel-close"
              aria-label="Close page panel"
              onClick={() => {
                setCommentsOpen(false);
                setHistoryOpen(false);
                setAttachmentsOpen(false);
                setBacklinksOpen(false);
              }}
            >
              ×
            </button>
            <div ref={setPanelTarget} />
            {historyOpen && (
              <HistoryPanel
                page={page}
                member={member}
                current={bundle?.doc ?? null}
                onRestored={(epoch) => onPageChanged({ ...page, contentEpoch: epoch, revision: page.revision + 1 })}
              />
            )}
            {attachmentsOpen && <AttachmentsPanel page={page} editable={editable} />}
            {backlinksOpen && <BacklinksPanel pageId={page.id} revision={backlinksRevision} onSelect={onSelectPage} />}
          </aside>
        )}
      </div>
    </main>
  );
}

type Attachment = { id: string; name: string; mime: string; size: number; createdAt: number };

function AttachmentsPanel({ page, editable }: { page: Page; editable: boolean }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(
    () =>
      api<{ attachments: Attachment[] }>(`/api/pages/${page.id}/attachments`).then((data) =>
        setAttachments(data.attachments),
      ),
    [page.id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File) {
    setBusy(true);
    try {
      await uploadAttachment(page.id, file);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="side-panel attachments-panel">
      <h2>Files</h2>
      <p className="muted">Private workspace files. Large files upload in parts.</p>
      {editable && (
        <>
          <input
            ref={input}
            hidden
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
          <button className="quiet-button" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading…" : "Upload file"}
          </button>
        </>
      )}
      <div className="attachment-list">
        {attachments.map((attachment) => (
          <div key={attachment.id}>
            <a href={`/api/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
              {attachment.name}
            </a>
            <span>{(attachment.size / 1024).toFixed(1)} KiB</span>
            {editable && (
              <button
                onClick={async () => {
                  await api(`/api/attachments/${attachment.id}`, { method: "DELETE" });
                  await load();
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {!attachments.length && <p className="empty-copy">No files on this page.</p>}
      </div>
    </aside>
  );
}

function editorOptions(
  bundle: CollaborationBundle,
  member: ClientMemberContext,
  editable: boolean,
  pageId: string,
  threadStore: ServerThreadStore,
) {
  return withCollaboration({
    schema: notesSchema,
    // Media dropped or pasted into the body becomes a real attachment on this page, so
    // the subtree delete that already collects attachments covers inline media too.
    uploadFile: async (file: File) => {
      if (!editable) throw new Error("This document is read-only.");
      const attachment = await uploadAttachment(pageId, file);
      return `/api/attachments/${attachment.id}`;
    },
    resolveFileUrl: async (url: string) => resolveAttachmentUrl(url),
    collaboration: {
      fragment: bundle.doc.getXmlFragment("document-store"),
      provider: bundle.provider,
      user: { name: member.user.name, color: userColor(member.user.id) },
      showCursorLabels: "activity" as const,
    },
    extensions: [
      SyntaxHighlightingExtension({
        createHighlighter: async () => {
          const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark, ...langs] = await Promise.all(
            [
              import("shiki/core"),
              import("@shikijs/engine-javascript"),
              import("@shikijs/themes/github-light"),
              import("@shikijs/themes/github-dark"),
              import("@shikijs/langs/javascript"),
              import("@shikijs/langs/typescript"),
              import("@shikijs/langs/json"),
              import("@shikijs/langs/html"),
              import("@shikijs/langs/css"),
              import("@shikijs/langs/bash"),
              import("@shikijs/langs/python"),
              import("@shikijs/langs/sql"),
              import("@shikijs/langs/markdown"),
            ],
          );
          return createHighlighterCore({
            themes: [light.default, dark.default],
            langs: langs.map((language) => language.default),
            engine: createJavaScriptRegexEngine(),
          });
        },
      }),
      CommentsExtension({
        threadStore,
        schema: notesCommentSchema,
        resolveUsers: async (ids: string[]) =>
          threadStore.resolveUsers(ids).map((user) => ({ ...user, color: userColor(user.id) })),
      }),
    ],
  });
}

function CollaborativeEditor({
  bundle,
  member,
  editable,
  commentsOpen,
  panelTarget,
  pageId,
  commentsRevision,
  onPageCreated,
  onError,
}: {
  bundle: CollaborationBundle;
  member: ClientMemberContext;
  editable: boolean;
  commentsOpen: boolean;
  panelTarget: HTMLDivElement | null;
  pageId: string;
  commentsRevision: number;
  onPageCreated: (page: Page) => void;
  onError: (message: string) => void;
}) {
  const [commentError, setCommentError] = useState("");
  const [pasteChoice, setPasteChoice] = useState<{ url: string; blockId: string } | null>(null);
  const [pasteNotice, setPasteNotice] = useState("");
  const editorShellRef = useRef<HTMLDivElement>(null);
  const pasteChoiceRef = useRef<HTMLFieldSetElement>(null);
  const commentsPanel = useRef<HTMLDivElement>(null);
  const threadStore = useMemo(
    () => new ServerThreadStore(pageId, member.user.id, setCommentError),
    [member.user.id, pageId],
  );
  useEffect(() => {
    void threadStore.refresh(commentsRevision);
  }, [commentsRevision, threadStore]);
  useEffect(() => {
    const panel = commentsPanel.current;
    if (!commentsOpen || !panelTarget || !panel) return undefined;
    const labelGeneratedEditors = () => {
      for (const textbox of panel.querySelectorAll<HTMLElement>('[role="textbox"]:not([aria-label])')) {
        textbox.setAttribute(
          "aria-label",
          textbox.getAttribute("contenteditable") === "false" ? "Comment content" : "Write a reply",
        );
      }
    };
    labelGeneratedEditors();
    const observer = new MutationObserver(labelGeneratedEditors);
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [commentsOpen, panelTarget]);
  const options = useMemo(
    () => editorOptions(bundle, member, editable, pageId, threadStore),
    [bundle, editable, member, pageId, threadStore],
  );
  const editor = useCreateBlockNote(options, [bundle, editable, pageId]);
  useEffect(() => {
    if (!pasteChoice) return undefined;
    const choice = pasteChoiceRef.current;
    choice?.querySelector("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPasteChoice(null);
      setPasteNotice("");
      editor.focus();
    };
    choice?.addEventListener("keydown", onKeyDown);
    return () => choice?.removeEventListener("keydown", onKeyDown);
  }, [editor, pasteChoice]);
  useEffect(() => {
    const root = editorShellRef.current;
    if (!root) return undefined;
    const attachCopyButtons = () => {
      for (const content of root.querySelectorAll<HTMLElement>('[data-content-type="codeBlock"]')) {
        if (content.querySelector(".code-copy-button")) continue;
        const code = content.querySelector("pre code");
        if (!code) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "code-copy-button";
        button.textContent = "Copy code";
        button.contentEditable = "false";
        button.setAttribute("aria-label", "Copy code");
        button.addEventListener("click", () => {
          void navigator.clipboard
            .writeText(code.textContent ?? "")
            .then(() => {
              button.textContent = "Copied";
              window.setTimeout(() => {
                if (button.isConnected) button.textContent = "Copy code";
              }, 2_000);
            })
            .catch(() => {
              button.textContent = "Copy failed";
            });
        });
        content.appendChild(button);
      }
    };
    attachCopyButtons();
    const observer = new MutationObserver(attachCopyButtons);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const choosePaste = (kind: "link" | "preview" | "embed") => {
    if (!pasteChoice) return;
    const { url, blockId } = pasteChoice;
    if (!editable || !editor.isEditable) {
      setPasteNotice(`This page is read-only. Paste this URL when editing is available: ${url}`);
      setPasteChoice(null);
      editor.focus();
      return;
    }
    const block = editor.getBlock(blockId);
    const linkBlock = { type: "paragraph", content: [{ type: "link", href: url, content: url }] };
    if (!block || block.type !== "paragraph" || (Array.isArray(block.content) && block.content.length)) {
      const alreadyHasUrl =
        Array.isArray(block?.content) &&
        block.content.some(
          (item) =>
            item &&
            typeof item === "object" &&
            (("href" in item && item.href === url) || ("text" in item && item.text === url)),
        );
      if (alreadyHasUrl) {
        setPasteNotice(
          `The paragraph changed and already contains this URL. Paste it again to choose a different format: ${url}`,
        );
      } else {
        const last = editor.document.at(-1);
        try {
          if (!last) throw new Error("No block to insert after.");
          editor.insertBlocks([linkBlock] as never, last, "after");
          setPasteNotice(`The paragraph changed, so the URL was added as a link at the end of the page: ${url}`);
        } catch {
          setPasteNotice(`The paragraph changed. Paste this URL again: ${url}`);
        }
      }
      setPasteChoice(null);
      editor.focus();
      return;
    }
    if (kind === "link") {
      editor.replaceBlocks([block], [linkBlock] as never);
    } else if (kind === "embed") {
      editor.replaceBlocks([block], [{ type: "embed", props: { url, title: "Embedded link" } }] as never);
    } else {
      // Store the URL immediately; the bookmark resolves disposable metadata in the background.
      editor.replaceBlocks([block], [{ type: "bookmark", props: { url, title: url } }] as never);
    }
    setPasteNotice("");
    setPasteChoice(null);
    editor.focus();
  };
  const colorScheme = useEffectiveColorScheme();
  const getSlashItems = async (query: string) =>
    filterSuggestionItems(
      [
        ...getDefaultReactSlashMenuItems(editor),
        ...editorBlockFactories.map((item) => ({
          title: item.label,
          subtext: item.description,
          aliases: [item.type],
          group: "NoteFlare blocks",
          icon: <span>{item.icon}</span>,
          onItemClick: () => {
            if (item.type === "columnList") {
              insertOrUpdateBlockForSlashMenu(editor, {
                type: "columnList",
                children: [
                  { type: "column", children: [{ type: "paragraph" }] },
                  { type: "column", children: [{ type: "paragraph" }] },
                ],
              } as never);
              return;
            }
            insertOrUpdateBlockForSlashMenu(editor, { type: item.type });
          },
        })),
        ...(
          [
            ["document", "Sub-page"],
            ["table", "Table page"],
            ["tasks", "Task List"],
            ["diagram", "Diagram page"],
          ] as const
        ).map(([kind, title]) => ({
          title,
          subtext: "Create inside this page and insert a link",
          aliases: [kind, "child page", "page inside"],
          group: "NoteFlare blocks",
          icon: <span>⊞</span>,
          onItemClick: () => {
            void (async () => {
              let createdPage: Page;
              try {
                const result = await api<{ page: Page }>("/api/pages", {
                  method: "POST",
                  body: json({
                    id: crypto.randomUUID(),
                    kind: kind === "tasks" ? "table" : kind,
                    parentId: pageId,
                    ...(kind === "tasks" ? { taskList: true } : {}),
                  }),
                });
                createdPage = result.page;
              } catch (error) {
                onError(apiErrorMessage(error, "The sub-page could not be created."));
                return;
              }
              try {
                const current = editor.getTextCursorPosition().block;
                editor.replaceBlocks([current], [
                  { type: "linkToPage", props: { pageId: createdPage.id, title: createdPage.title } },
                  { type: "paragraph" },
                ] as never);
              } catch (error) {
                onError(
                  `${apiErrorMessage(error, "The sub-page link could not be inserted.")} ` +
                    `The created page is “${createdPage.title}” (ID: ${createdPage.id}); remove it from the sidebar if it is not needed.`,
                );
                return;
              }
              onError("");
              onPageCreated(createdPage);
            })();
          },
        })),
        {
          title: "Inline math",
          subtext: "Insert a KaTeX formula in this line",
          aliases: ["formula", "latex"],
          group: "NoteFlare blocks",
          icon: <span>𝑥</span>,
          onItemClick: () =>
            editor.insertInlineContent([{ type: "inlineMath", props: { formula: "x" } }], {
              updateSelection: true,
            }),
        },
      ],
      query,
    );
  const getMentionItems = async (query: string) => {
    const data = await api<{ suggestions: MentionSuggestion[] }>(
      `/api/mentions/suggestions?q=${encodeURIComponent(query)}`,
    );
    return data.suggestions.map((suggestion) => ({
      title: suggestion.label,
      subtext: suggestion.detail,
      group: suggestion.entityType === "page" ? "Pages" : "People",
      icon: <span>{suggestion.icon ?? (suggestion.entityType === "page" ? "□" : "@")}</span>,
      onItemClick: () =>
        editor.insertInlineContent(
          [
            {
              type: "mention",
              props: {
                entityType: suggestion.entityType,
                entityId: suggestion.entityId,
                label: suggestion.label,
              },
            },
            " ",
          ],
          { updateSelection: true },
        ),
    }));
  };
  return (
    <EmbedFeatureContext.Provider value={member.features?.expandedEmbeds ?? false}>
      <div
        ref={editorShellRef}
        onPasteCapture={(event) => {
          if (!editable || event.clipboardData.files.length || event.isDefaultPrevented()) return;
          if (
            !(event.target instanceof Element) ||
            !editorShellRef.current?.contains(event.target) ||
            !event.target.closest('.bn-editor[contenteditable="true"]')
          )
            return;
          const value = event.clipboardData.getData("text/plain").trim();
          if (!safeBookmarkUrl(value) || /\s/.test(value)) return;
          if (
            !(
              (member.features?.expandedEmbeds && value.startsWith("https://")) ||
              resolveEmbed(value, member.features?.expandedEmbeds)
            )
          )
            return;
          const block = editor.getTextCursorPosition().block;
          if (block.type !== "paragraph" || (Array.isArray(block.content) && block.content.length)) return;
          event.preventDefault();
          event.stopPropagation();
          setPasteNotice("");
          setPasteChoice({ url: value, blockId: block.id });
        }}
      >
        <BlockNoteView
          editor={editor}
          editable={editable}
          className="notes-editor"
          theme={colorScheme}
          slashMenu={false}
        >
          {editable && <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />}
          {editable && <SuggestionMenuController triggerCharacter="@" getItems={getMentionItems} />}
          {commentsOpen &&
            panelTarget &&
            createPortal(
              <div ref={commentsPanel} className="comments-panel">
                <h2>Comments</h2>
                <p className="muted">
                  {editable
                    ? "Select text and use the formatting toolbar to start a thread."
                    : "You can comment and reply even while the document is read-only."}
                </p>
                {commentError && <p className="form-error">{commentError}</p>}
                <ThreadsSidebar filter="all" sort="position" />
              </div>,
              panelTarget,
            )}
        </BlockNoteView>
        {pasteChoice && (
          <fieldset ref={pasteChoiceRef} className="paste-url-choice">
            <legend>Paste as</legend>
            <button type="button" disabled={!editable || !editor.isEditable} onClick={() => choosePaste("link")}>
              Link
            </button>
            {member.features?.expandedEmbeds && pasteChoice.url.startsWith("https://") && (
              <button type="button" disabled={!editable || !editor.isEditable} onClick={() => choosePaste("preview")}>
                Preview card
              </button>
            )}
            {resolveEmbed(pasteChoice.url, member.features?.expandedEmbeds) && (
              <button type="button" disabled={!editable || !editor.isEditable} onClick={() => choosePaste("embed")}>
                Embed
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setPasteChoice(null);
                setPasteNotice("");
                editor.focus();
              }}
            >
              Cancel
            </button>
          </fieldset>
        )}
        {pasteNotice && <output className="muted">{pasteNotice}</output>}
      </div>
    </EmbedFeatureContext.Provider>
  );
}

type Version = { id: string; title: string; epoch: number; sequence: number; byteSize: number; createdAt: number };

function HistoryPanel({
  page,
  member,
  current,
  onRestored,
}: {
  page: Page;
  member: ClientMemberContext;
  current: Y.Doc | null;
  onRestored: (epoch: number) => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<Version | null>(null);
  const [snapshot, setSnapshot] = useState<Y.Doc | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ versions: Version[] }>(`/api/pages/${page.id}/versions`).then((data) => setVersions(data.versions));
  }, [page.id]);

  async function choose(version: Version) {
    setSelected(version);
    const response = await fetch(`/api/versions/${version.id}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    setSnapshot((previous) => {
      previous?.destroy();
      return doc;
    });
  }

  async function restore() {
    if (!selected || !confirm(`Restore “${selected.title}” from ${new Date(selected.createdAt).toLocaleString()}?`))
      return;
    setBusy(true);
    try {
      const result = await api<{ contentEpoch: number }>(`/api/pages/${page.id}/restore-version`, {
        method: "POST",
        body: json({ versionId: selected.id }),
      });
      onRestored(result.contentEpoch);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="side-panel history-panel">
      <h2>History</h2>
      <p className="muted">Automatic snapshots are kept for 30 days, up to 200.</p>
      <div className="version-list">
        {versions.map((version) => (
          <button
            key={version.id}
            className={selected?.id === version.id ? "selected" : ""}
            onClick={() => void choose(version)}
          >
            <strong>{new Date(version.createdAt).toLocaleString()}</strong>
            <span>
              {(version.byteSize / 1024).toFixed(1)} KiB · epoch {version.epoch}
            </span>
          </button>
        ))}
        {!versions.length && <p className="empty-copy">No compacted versions yet.</p>}
      </div>
      {snapshot && current && <BlockDiff oldDoc={snapshot} currentDoc={current} />}
      {member.role === "owner" && selected && (
        <button className="danger-button" onClick={() => void restore()} disabled={busy}>
          {busy ? "Restoring…" : "Restore this version"}
        </button>
      )}
    </aside>
  );
}

function BlockDiff({ oldDoc, currentDoc }: { oldDoc: Y.Doc; currentDoc: Y.Doc }) {
  const oldXml = oldDoc.getXmlFragment("document-store").toString();
  const currentXml = currentDoc.getXmlFragment("document-store").toString();
  const diff = diffBlockIds(oldXml, currentXml);
  return (
    <div className="block-diff" aria-label="Block-level version comparison">
      <span className="diff-added">+{diff.added.length} blocks</span>
      <span className="diff-removed">−{diff.removed.length} blocks</span>
      <span>{diff.identical ? "No content changes" : "Changed blocks are shown by stable block ID"}</span>
      <div className="diff-columns">
        <pre>{plainYDoc(oldDoc)}</pre>
        <pre>{plainYDoc(currentDoc)}</pre>
      </div>
    </div>
  );
}

function plainYDoc(doc: Y.Doc) {
  const projection = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("document-store")) as ProseMirrorJson;
  return projectDocument(projection).plainText || "Empty document";
}
