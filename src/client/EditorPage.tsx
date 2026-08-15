import { CommentsExtension, DefaultThreadStoreAuth, ThreadStoreAuth } from "@blocknote/core/comments";
import { withCollaboration, YjsThreadStore } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { SuggestionMenuController, ThreadsSidebar, useCreateBlockNote } from "@blocknote/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import type { MemberContext } from "../worker/env";
import type { MentionSuggestion, Page } from "../shared/types";
import { projectDocument, type ProseMirrorJson } from "../shared/document-projection";
import { diffBlockIds } from "../shared/block-diff";
import { ApiClientError, api, json } from "./api";
import { BacklinksPanel } from "./BacklinksPanel";
import { createCollaboration, loadOfflineCopy, type CollaborationBundle, userColor } from "./collaboration";
import { notesSchema } from "./mentions";

type Props = {
  page: Page;
  member: MemberContext;
  onPageChanged: (page: Page) => void;
  onPageUnavailable: (pageId: string) => void;
  onSelectPage: (pageId: string) => void;
  backlinksRevision: number;
};

export function EditorPage({ page, member, onPageChanged, onPageUnavailable, onSelectPage, backlinksRevision }: Props) {
  const [bundle, setBundle] = useState<CollaborationBundle | null>(null);
  const [status, setStatus] = useState<"offline" | "connecting" | "connected">("connecting");
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [sizeWarning, setSizeWarning] = useState<{ bytes: number; readOnly: boolean } | null>(null);
  const recoveryKey = `notes:recovery:${member.workspace.id}:${page.id}`;
  const [recovery, setRecovery] = useState<{ key: string; epoch: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem(recoveryKey) ?? "null"); } catch { return null; }
  });
  const [recoveryPreview, setRecoveryPreview] = useState("");
  const [title, setTitle] = useState(page.title);
  const [titleError, setTitleError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const titlePageIdRef = useRef(page.id);
  const titleRevisionRef = useRef(page.revision);
  const titleDirtyRef = useRef(false);
  const editable = member.role !== "viewer" && !sizeWarning?.readOnly;
  const editableRef = useRef(editable);
  editableRef.current = editable;
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
    setSizeWarning(null);
    const next = createCollaboration(member.workspace.id, page.id, page.contentEpoch, setStatus);
    const customMessage = (message: string) => {
      try {
        const value = JSON.parse(message) as { type: string; bytes: number; readOnly: boolean };
        if (value.type === "document-size") setSizeWarning(value);
      } catch {
        // Ignore custom messages from future server versions.
      }
    };
    let active = true;
    next.provider.on("custom-message", customMessage);
    const quarantine = () => {
      const value = { key: `${member.workspace.id}:${page.id}:${page.contentEpoch}:1`, epoch: page.contentEpoch };
      localStorage.setItem(recoveryKey, JSON.stringify(value));
      setRecovery(value);
    };
    const connectionClose = async (event: CloseEvent) => {
      if (event.code === 4410 || event.code === 4411 || event.code === 4412) {
        next.provider.disconnect();
      }
      if (event.code === 4411 || event.code === 4412) {
        onPageUnavailable(page.id);
        return;
      }
      if (event.code !== 4410 && event.code !== 1006) return;
      if (event.code === 4410 && editableRef.current && next.hasUnsyncedChanges) quarantine();
      try {
        const result = await api<{ page: Page }>(`/api/pages/${page.id}`);
        if (!active) return;
        if (result.page.contentEpoch !== page.contentEpoch) {
          if (editableRef.current && next.hasUnsyncedChanges) quarantine();
          onPageChanged(result.page);
        } else if (event.code === 4410) {
          // A restore can fail after taking the transition lock and closing the
          // room. Reconnect when D1 still says this epoch is authoritative.
          next.provider.connect();
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiClientError && error.status === 404) {
          next.provider.disconnect();
          onPageUnavailable(page.id);
        }
      }
    };
    next.provider.on("connection-close", connectionClose);
    setBundle(next);
    return () => {
      active = false;
      next.provider.off("custom-message", customMessage);
      next.provider.off("connection-close", connectionClose);
      next.destroy();
      setBundle(null);
    };
  }, [member.workspace.id, onPageChanged, onPageUnavailable, page.id, page.contentEpoch, recoveryKey]);

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
        titleDirtyRef.current = false;
        titleRevisionRef.current = page.revision;
        setTitle(page.title);
        setTitleError("A collaborator changed this title. Their newer title was kept.");
        return;
      }
      setTitleError(error instanceof Error ? error.message : "The title could not be saved.");
    }
  }

  return (
    <main className="page-canvas">
      <div className="page-tools">
        <span className={`sync-state sync-${status}`}><i />{status}</span>
        {editable && <button className="quiet-button" onClick={async () => {
          const icon = prompt("Page icon (one emoji, or leave blank to remove)", page.icon ?? "")?.trim();
          if (icon === undefined) return;
          const result = await api<{ page: Page }>(`/api/pages/${page.id}`, { method: "PATCH", body: json({ icon: icon || null, revision: page.revision }) });
          onPageChanged(result.page);
        }}>{page.icon ?? "Add icon"}</button>}
        <button className="quiet-button" onClick={() => { setCommentsOpen((open) => !open); setAttachmentsOpen(false); setHistoryOpen(false); setBacklinksOpen(false); }}>Comments</button>
        <button className="quiet-button" onClick={() => { setAttachmentsOpen((open) => !open); setCommentsOpen(false); setHistoryOpen(false); setBacklinksOpen(false); }}>Files</button>
        <button className="quiet-button" onClick={() => { setHistoryOpen((open) => !open); setCommentsOpen(false); setAttachmentsOpen(false); setBacklinksOpen(false); }}>History</button>
        <button className="quiet-button" onClick={() => { setBacklinksOpen((open) => !open); setCommentsOpen(false); setAttachmentsOpen(false); setHistoryOpen(false); }}>Backlinks</button>
      </div>
      {sizeWarning && (
        <div className={`notice ${sizeWarning.readOnly ? "notice-danger" : ""}`}>
          This document is {(sizeWarning.bytes / 1024 / 1024).toFixed(1)} MiB.
          {sizeWarning.readOnly ? " It is read-only at the 24 MiB safety limit." : " Consider splitting it before it reaches 24 MiB."}
        </div>
      )}
      {recovery && recovery.epoch !== page.contentEpoch && (
        <div className="notice recovery-notice">
          <div><strong>Offline copy quarantined</strong><span>Edits from epoch {recovery.epoch} were not merged after this page was restored.</span></div>
          <button className="quiet-button" onClick={async () => {
            const doc = await loadOfflineCopy(recovery.key);
            setRecoveryPreview(plainYDoc(doc));
            doc.destroy();
          }}>Preview</button>
          <button className="quiet-button" onClick={async () => {
            const doc = await loadOfflineCopy(recovery.key);
            const bytes = Y.encodeStateAsUpdate(doc);
            const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/vnd.yjs" });
            const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
            anchor.href = url; anchor.download = `${page.title}-offline-epoch-${recovery.epoch}.yjs`; anchor.click();
            URL.revokeObjectURL(url); doc.destroy();
          }}>Export</button>
          <button className="quiet-button" onClick={() => { localStorage.removeItem(recoveryKey); setRecovery(null); setRecoveryPreview(""); }}>Dismiss</button>
          {recoveryPreview && <p>{recoveryPreview}</p>}
        </div>
      )}
      <div className={`document-layout ${commentsVisible || historyOpen || attachmentsOpen || backlinksOpen ? "with-panel" : ""}`}>
        <article className="document-paper">
          <input
            ref={titleRef}
            className="page-title"
            value={title}
            onChange={(event) => {
              if (!titleDirtyRef.current) titleRevisionRef.current = page.revision;
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
            <CollaborativeEditor bundle={bundle} member={member} editable={editable} commentsOpen={commentsVisible} />
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
  const load = () => api<{ attachments: Attachment[] }>(`/api/pages/${page.id}/attachments`).then((data) => setAttachments(data.attachments));
  useEffect(() => { void load(); }, [page.id]);

  async function upload(file: File) {
    setBusy(true);
    const body = new FormData(); body.set("file", file);
    try {
      await api(`/api/pages/${page.id}/attachments`, { method: "POST", body });
      await load();
    } finally { setBusy(false); }
  }

  return (
    <aside className="side-panel attachments-panel">
      <h2>Files</h2>
      <p className="muted">Private workspace files, up to 10 MiB each.</p>
      {editable && <>
        <input ref={input} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
        <button className="quiet-button" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : "Upload file"}</button>
      </>}
      <div className="attachment-list">
        {attachments.map((attachment) => <div key={attachment.id}><a href={`/api/attachments/${attachment.id}`} target="_blank" rel="noreferrer">{attachment.name}</a><span>{(attachment.size / 1024).toFixed(1)} KiB</span>{editable && <button onClick={async () => { await api(`/api/attachments/${attachment.id}`, { method: "DELETE" }); await load(); }}>×</button>}</div>)}
        {!attachments.length && <p className="empty-copy">No files on this page.</p>}
      </div>
    </aside>
  );
}

class ReadOnlyThreadStoreAuth extends ThreadStoreAuth {
  canCreateThread() { return false; }
  canAddComment() { return false; }
  canUpdateComment() { return false; }
  canDeleteComment() { return false; }
  canDeleteThread() { return false; }
  canResolveThread() { return false; }
  canUnresolveThread() { return false; }
  canAddReaction() { return false; }
  canDeleteReaction() { return false; }
}

function editorOptions(bundle: CollaborationBundle, member: MemberContext, editable: boolean) {
  const threadStore = new YjsThreadStore(
    member.user.id,
    bundle.doc.getMap("comments"),
    editable ? new DefaultThreadStoreAuth(member.user.id, "editor") : new ReadOnlyThreadStoreAuth(),
  );
  return withCollaboration({
    schema: notesSchema,
    collaboration: {
      fragment: bundle.doc.getXmlFragment("document-store"),
      provider: bundle.provider,
      user: { name: member.user.name, color: userColor(member.user.id) },
      showCursorLabels: "activity" as const,
    },
    extensions: [CommentsExtension({
      threadStore,
      resolveUsers: async (ids: string[]) => ids.map((id) => ({
        id,
        username: id === member.user.id ? member.user.name : "Collaborator",
        avatarUrl: "",
        color: userColor(id),
      })),
    })],
  });
}

function CollaborativeEditor({ bundle, member, editable, commentsOpen }: {
  bundle: CollaborationBundle;
  member: MemberContext;
  editable: boolean;
  commentsOpen: boolean;
}) {
  const options = useMemo(() => editorOptions(bundle, member, editable), [bundle, editable, member]);
  const editor = useCreateBlockNote(options, [bundle, editable]);
  const getMentionItems = async (query: string) => {
    const data = await api<{ suggestions: MentionSuggestion[] }>(`/api/mentions/suggestions?q=${encodeURIComponent(query)}`);
    return data.suggestions.map((suggestion) => ({
      title: suggestion.label,
      subtext: suggestion.detail,
      group: suggestion.entityType === "page" ? "Pages" : "People",
      icon: <span>{suggestion.icon ?? (suggestion.entityType === "page" ? "□" : "@")}</span>,
      onItemClick: () => editor.insertInlineContent([
        {
          type: "mention",
          props: {
            entityType: suggestion.entityType,
            entityId: suggestion.entityId,
            label: suggestion.label,
          },
        },
        " ",
      ], { updateSelection: true }),
    }));
  };
  return (
    <BlockNoteView editor={editor} editable={editable} className="notes-editor" theme="light">
      {editable && <SuggestionMenuController triggerCharacter="@" getItems={getMentionItems} />}
      {commentsOpen && (
        <aside className="side-panel comments-panel">
          <h2>Comments</h2>
          <p className="muted">{editable
            ? "Select text and use the formatting toolbar to start a thread."
            : "Comments are read-only while this document is not editable."}</p>
          <ThreadsSidebar filter="all" sort="position" />
        </aside>
      )}
    </BlockNoteView>
  );
}

type Version = { id: string; title: string; epoch: number; sequence: number; byteSize: number; createdAt: number };

function HistoryPanel({ page, member, current, onRestored }: {
  page: Page;
  member: MemberContext;
  current: Y.Doc | null;
  onRestored: (epoch: number) => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<Version | null>(null);
  const [snapshot, setSnapshot] = useState<Y.Doc | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ versions: Version[] }>(`/api/pages/${page.id}/versions`).then((data) => setVersions(data.versions));
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
    if (!selected || !confirm(`Restore “${selected.title}” from ${new Date(selected.createdAt).toLocaleString()}?`)) return;
    setBusy(true);
    try {
      const result = await api<{ contentEpoch: number }>(`/api/pages/${page.id}/restore-version`, {
        method: "POST", body: json({ versionId: selected.id }),
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
          <button key={version.id} className={selected?.id === version.id ? "selected" : ""} onClick={() => void choose(version)}>
            <strong>{new Date(version.createdAt).toLocaleString()}</strong>
            <span>{(version.byteSize / 1024).toFixed(1)} KiB · epoch {version.epoch}</span>
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
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("document-store")) as ProseMirrorJson;
  return projectDocument(json).plainText || "Empty document";
}
