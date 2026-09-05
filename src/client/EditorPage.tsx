import { CommentsExtension } from "@blocknote/core/comments";
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
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
import type { ClientMemberContext } from "../shared/types";
import type { MentionSuggestion, Page } from "../shared/types";
import { projectDocument, type ProseMirrorJson } from "../shared/document-projection";
import { diffBlockIds } from "../shared/block-diff";
import { ApiClientError, api, apiErrorMessage, json } from "./api";
import { BacklinksPanel } from "./BacklinksPanel";
import { createCollaboration, loadOfflineCopy, type CollaborationBundle, userColor } from "./collaboration";
import { createDocumentCloseReconciler } from "./document-connection";
import { editorBlockFactories } from "./editor-blocks";
import { notesSchema } from "./mentions";
import { ServerThreadStore } from "./server-thread-store";
import { resolveAttachmentUrl, uploadAttachment } from "./uploads";

export type EditorPageProps = {
  page: Page;
  member: ClientMemberContext;
  onPageChanged: (page: Page) => void;
  onPageUnavailable: (pageId: string) => void;
  onAccessDenied: (pageId: string, error: ApiClientError) => void;
  onSelectPage: (pageId: string) => void;
  backlinksRevision: number;
  commentsRevision?: number;
};

export function EditorPage({
  page,
  member,
  onPageChanged,
  onPageUnavailable,
  onAccessDenied,
  onSelectPage,
  backlinksRevision,
  commentsRevision = 0,
}: EditorPageProps) {
  const [bundle, setBundle] = useState<CollaborationBundle | null>(null);
  const [status, setStatus] = useState<"offline" | "connecting" | "connected">("connecting");
  const [storageError, setStorageError] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [sizeWarning, setSizeWarning] = useState<{ bytes: number; readOnly: boolean } | null>(null);
  const recoveryKey = `notes:recovery:${member.workspace.id}:${page.id}`;
  const [recovery, setRecovery] = useState<{ key: string; epoch: number } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(recoveryKey) ?? "null");
    } catch {
      return null;
    }
  });
  const [recoveryPreview, setRecoveryPreview] = useState("");
  const [title, setTitle] = useState(page.title);
  const [titleError, setTitleError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const titlePageIdRef = useRef(page.id);
  const titleRevisionRef = useRef(page.revision);
  const titleDirtyRef = useRef(false);
  const editable = member.role !== "viewer" && !sizeWarning?.readOnly && !storageError;
  const commentsVisible = commentsOpen;

  useEffect(() => {
    if (titlePageIdRef.current !== page.id) {
      titlePageIdRef.current = page.id;
      titleDirtyRef.current = false;
      titleRevisionRef.current = page.revision;
      setTitle(page.title);
      setTitleError("");
      return;
    }
    if (!titleDirtyRef.current && document.activeElement !== titleRef.current) {
      titleRevisionRef.current = page.revision;
      setTitle(page.title);
    }
  }, [page.id, page.revision, page.title]);

  useEffect(() => {
    const next = createCollaboration(member.workspace.id, page.id, page.contentEpoch, setStatus);
    let active = true;
    const customMessage = (message: string) => {
      try {
        const value = JSON.parse(message) as { type: string; bytes: number; readOnly: boolean };
        if (value.type === "document-size") setSizeWarning(value);
      } catch {
        // Ignore custom messages from future server versions.
      }
    };
    next.provider.on("custom-message", customMessage);
    const quarantine = () => {
      const value = { key: `${member.workspace.id}:${page.id}:${page.contentEpoch}:1`, epoch: page.contentEpoch };
      const serialized = JSON.stringify(value);
      if (localStorage.getItem(recoveryKey) !== serialized) localStorage.setItem(recoveryKey, serialized);
      setRecovery((current) => (current?.key === value.key && current.epoch === value.epoch ? current : value));
    };
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
    const connectionSync = (synced: boolean) => closeReconciler.handleSync(synced);
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
      next.destroy();
      setBundle(null);
    };
  }, [
    member.role,
    member.workspace.id,
    onAccessDenied,
    onPageChanged,
    onPageUnavailable,
    page.id,
    page.contentEpoch,
    recoveryKey,
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
    <main className="page-canvas">
      <div className="page-tools">
        <span className={`sync-state sync-${status}`}>
          <i />
          {status}
        </span>
        {editable && (
          <button
            className="quiet-button"
            onClick={async () => {
              const icon = prompt("Page icon (one emoji, or leave blank to remove)", page.icon ?? "")?.trim();
              if (icon === undefined) return;
              const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
                method: "PATCH",
                body: json({ icon: icon || null, revision: page.revision }),
              });
              onPageChanged(result.page);
            }}
          >
            {page.icon ?? "Add icon"}
          </button>
        )}
        <button
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
      </div>
      {sizeWarning && (
        <div className={`notice ${sizeWarning.readOnly ? "notice-danger" : ""}`}>
          This document is {(sizeWarning.bytes / 1024 / 1024).toFixed(1)} MiB.
          {sizeWarning.readOnly
            ? " It is read-only at the 24 MiB safety limit."
            : " Consider splitting it before it reaches 24 MiB."}
        </div>
      )}
      {storageError && <div className="notice notice-danger">{storageError}</div>}
      {recovery && recovery.epoch !== page.contentEpoch && !storageError && (
        <div className="notice recovery-notice">
          <div>
            <strong>Offline copy quarantined</strong>
            <span>Edits from epoch {recovery.epoch} were not merged after this page was restored.</span>
          </div>
          <button
            className="quiet-button"
            onClick={async () => {
              const doc = await loadOfflineCopy(recovery.key);
              setRecoveryPreview(plainYDoc(doc));
              doc.destroy();
            }}
          >
            Preview
          </button>
          <button
            className="quiet-button"
            onClick={async () => {
              const doc = await loadOfflineCopy(recovery.key);
              const bytes = Y.encodeStateAsUpdate(doc);
              const blob = new Blob(
                [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
                { type: "application/vnd.yjs" },
              );
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `${page.title}-offline-epoch-${recovery.epoch}.yjs`;
              anchor.click();
              URL.revokeObjectURL(url);
              doc.destroy();
            }}
          >
            Export
          </button>
          <button
            className="quiet-button"
            onClick={() => {
              localStorage.removeItem(recoveryKey);
              setRecovery(null);
              setRecoveryPreview("");
            }}
          >
            Dismiss
          </button>
          {recoveryPreview && <p>{recoveryPreview}</p>}
        </div>
      )}
      <div
        className={`document-layout ${commentsVisible || historyOpen || attachmentsOpen || backlinksOpen ? "with-panel" : ""}`}
      >
        <article className="document-paper">
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
            readOnly={!editable}
            aria-label="Page title"
          />
          {titleError && <p className="form-error">{titleError}</p>}
          {bundle ? (
            <CollaborativeEditor
              bundle={bundle}
              member={member}
              editable={editable}
              commentsOpen={commentsVisible}
              pageId={page.id}
              commentsRevision={commentsRevision}
            />
          ) : storageError ? (
            <div className="editor-loading">
              This document cannot be opened safely until offline storage is available.
            </div>
          ) : (
            <div className="editor-loading">Opening your offline copy…</div>
          )}
        </article>
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
      CommentsExtension({
        threadStore,
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
  pageId,
  commentsRevision,
}: {
  bundle: CollaborationBundle;
  member: ClientMemberContext;
  editable: boolean;
  commentsOpen: boolean;
  pageId: string;
  commentsRevision: number;
}) {
  const [commentError, setCommentError] = useState("");
  const threadStore = useMemo(
    () => new ServerThreadStore(pageId, member.user.id, setCommentError),
    [member.user.id, pageId],
  );
  useEffect(() => {
    void threadStore.refresh(commentsRevision);
  }, [commentsRevision, threadStore]);
  const options = useMemo(
    () => editorOptions(bundle, member, editable, pageId, threadStore),
    [bundle, editable, member, pageId, threadStore],
  );
  const editor = useCreateBlockNote(options, [bundle, editable, pageId]);
  const getSlashItems = async (query: string) =>
    filterSuggestionItems(
      [
        ...getDefaultReactSlashMenuItems(editor),
        ...editorBlockFactories.map((item) => ({
          title: item.label,
          subtext: item.description,
          aliases: [item.type],
          group: "Notes blocks",
          icon: <span>{item.icon}</span>,
          onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: item.type }),
        })),
        {
          title: "Inline math",
          subtext: "Insert a KaTeX formula in this line",
          aliases: ["formula", "latex"],
          group: "Notes blocks",
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
    <BlockNoteView editor={editor} editable={editable} className="notes-editor" theme="light" slashMenu={false}>
      {editable && <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />}
      {editable && <SuggestionMenuController triggerCharacter="@" getItems={getMentionItems} />}
      {commentsOpen && (
        <aside className="side-panel comments-panel">
          <h2>Comments</h2>
          <p className="muted">
            {editable
              ? "Select text and use the formatting toolbar to start a thread."
              : "You can comment and reply even while the document is read-only."}
          </p>
          {commentError && <p className="form-error">{commentError}</p>}
          <ThreadsSidebar filter="all" sort="position" />
        </aside>
      )}
    </BlockNoteView>
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
