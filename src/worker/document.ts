import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { collectTransclusions, projectDocument, type ProseMirrorJson } from "../shared/document-projection";
import { diagramFromYDoc, projectDiagram, renderDiagramSvg } from "../shared/diagram";
import { flattenDocumentBlocks } from "../shared/notion-blocks";
import type { DocumentContentEnvelope } from "../shared/types";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import { joinBytes, splitBytes } from "../shared/bytes";
import { jitteredBackoff } from "../shared/retry";
import type { Env } from "./env";
import { sweepOutbox } from "./jobs";
import { notificationFanoutStatements } from "./notifications";
import { refreshPageSearchV2Statements } from "./search-index";
import { broadcastWorkspaceEvent } from "./workspace-events";
import { webhookEventStatements } from "./webhooks";

const COMPACTION_DELAY_MS = 30_000;
const ALARM_RETRY_DELAY_MS = 5_000;
// Ceiling for the restore-reconciliation backoff. The room is read-only while a
// restore is pending, so this also bounds how long a resident room can lag
// behind a recovered dependency; a cold wake still reconciles in onStart.
const RESTORE_RECONCILIATION_MAX_DELAY_MS = 5 * 60_000;
const VERSION_INTERVAL_MS = 15 * 60_000;
const VERSION_RETENTION_MS = 30 * 24 * 60 * 60_000;
const WARN_BYTES = 16 * 1024 * 1024;
const READ_ONLY_BYTES = 24 * 1024 * 1024;

function uuidFromHash(hash: string) {
  const value = `${hash.slice(0, 12)}5${hash.slice(13, 16)}a${hash.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export interface ConnectionAuth {
  userId: string;
  role: "owner" | "editor" | "viewer";
  expiresAt: number;
  __ypsAwarenessIds?: number[];
}

interface MetaRow extends Record<string, SqlStorageValue> {
  content_kind: "document" | "diagram";
  snapshot_seq: number;
  snapshot_bytes: number;
  dirty: number;
  retired: number;
  restore_pending: number;
  restore_attempts: number;
  restore_retry_at: number;
  read_only: number;
  last_version_at: number;
  last_editor_id: string | null;
  notify_edit: number;
}

interface PageProjectionRow {
  workspace_id: string;
  space_id: string;
  title: string;
  archived_at: number | null;
}

interface RestoreRecoveryRow extends Record<string, SqlStorageValue> {
  old_epoch: number;
  new_epoch: number;
  new_key: string;
  pre_key: string | null;
}

type RelativePositionJson = ReturnType<typeof Y.relativePositionToJSON>;

function documentTextNodes(document: Y.Doc) {
  const nodes: Y.XmlText[] = [];
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) nodes.push(child);
      else if (child instanceof Y.XmlElement) visit(child);
    }
  };
  visit(document.getXmlFragment("document-store"));
  return nodes;
}

function commentMarkThreadId(markName: string, value: unknown) {
  const baseName = markName.replace(/--[a-zA-Z0-9+/=]{8}$/, "");
  if (baseName !== "comment" || !value || typeof value !== "object") return null;
  const threadId = (value as Record<string, unknown>).threadId;
  return typeof threadId === "string" ? threadId : null;
}

function anchoredCommentThreadIds(document: Y.Doc) {
  const ids = new Set<string>();
  for (const text of documentTextNodes(document)) {
    for (const delta of text.toDelta()) {
      for (const [markName, value] of Object.entries(delta.attributes ?? {})) {
        const threadId = commentMarkThreadId(markName, value);
        if (threadId) ids.add(threadId);
      }
    }
  }
  return ids;
}

function legacyComments(document: Y.Doc) {
  const anchored = anchoredCommentThreadIds(document);
  const threads: Array<Record<string, unknown>> = [];
  document.getMap<Y.Map<unknown>>("comments").forEach((thread, id) => {
    if (!(thread instanceof Y.Map)) return;
    const rawComments = thread.get("comments");
    const comments =
      rawComments instanceof Y.Array
        ? rawComments
            .toArray()
            .filter((comment): comment is Y.Map<unknown> => comment instanceof Y.Map)
            .map((comment) => ({
              id: comment.get("id"),
              userId: comment.get("userId"),
              body: comment.get("body") ?? null,
              deletedAt: comment.get("deletedAt"),
              createdAt: comment.get("createdAt"),
              updatedAt: comment.get("updatedAt"),
            }))
        : [];
    threads.push({
      id: typeof thread.get("id") === "string" ? thread.get("id") : id,
      createdAt: thread.get("createdAt"),
      updatedAt: thread.get("updatedAt"),
      resolved: Boolean(thread.get("resolved")),
      resolvedUpdatedAt: thread.get("resolvedUpdatedAt"),
      resolvedBy: thread.get("resolvedBy"),
      anchored: anchored.has(id),
      comments,
    });
  });
  return threads;
}

function removeCommentMark(document: Y.Doc, threadId: string) {
  let changed = false;
  document.transact(() => {
    for (const text of documentTextNodes(document)) {
      let offset = 0;
      for (const delta of text.toDelta()) {
        const length = typeof delta.insert === "string" ? delta.insert.length : 1;
        for (const [markName, value] of Object.entries(delta.attributes ?? {})) {
          if (commentMarkThreadId(markName, value) === threadId) {
            text.format(offset, length, { [markName]: null });
            changed = true;
          }
        }
        offset += length;
      }
    }
  }, "comment-anchor");
  return changed;
}

type ApiBlockMutation =
  | {
      type: "append_children";
      parentInternalId?: string;
      children: ProseMirrorJson[];
      position?: { type: "start" | "end" | "after_block"; afterInternalId?: string };
    }
  | { type: "update_block"; internalId: string; node: ProseMirrorJson }
  | { type: "delete_block"; internalId: string };

function yNode(node: ProseMirrorJson): Y.XmlElement | Y.XmlText {
  if (node.type === "text") {
    const text = new Y.XmlText();
    text.applyDelta([
      {
        insert: node.text ?? "",
        ...(node.marks?.length
          ? {
              attributes: Object.fromEntries(node.marks.map((mark) => [mark.type, mark.attrs ?? {}])),
            }
          : {}),
      },
    ]);
    return text;
  }
  const element = new Y.XmlElement(node.type ?? "paragraph");
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined && key !== "ychange") element.setAttribute(key, value as string);
  }
  element.insert(0, (node.content ?? []).map(yNode));
  return element;
}

type YBlockParent = Y.XmlFragment | Y.XmlElement;

function blockGroup(parent: YBlockParent, create: boolean) {
  const existing = parent
    .toArray()
    .find((child): child is Y.XmlElement => child instanceof Y.XmlElement && child.nodeName === "blockGroup");
  if (existing || !create) return existing ?? null;
  const group = new Y.XmlElement("blockGroup");
  parent.insert(parent.length, [group]);
  return group;
}

function findYContainer(
  document: Y.Doc,
  id: string,
): { container: Y.XmlElement; group: Y.XmlElement; index: number } | null {
  const root = blockGroup(document.getXmlFragment("document-store"), false);
  if (!root) return null;
  const visit = (group: Y.XmlElement): { container: Y.XmlElement; group: Y.XmlElement; index: number } | null => {
    for (const [index, child] of group.toArray().entries()) {
      if (!(child instanceof Y.XmlElement) || child.nodeName !== "blockContainer") continue;
      if (child.getAttribute("id") === id) return { container: child, group, index };
      const nested = blockGroup(child, false);
      if (nested) {
        const found = visit(nested);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root);
}

function applyApiMutation(document: Y.Doc, operation: ApiBlockMutation) {
  if (operation.type === "append_children") {
    const parent = operation.parentInternalId ? findYContainer(document, operation.parentInternalId)?.container : null;
    if (operation.parentInternalId && !parent) throw new Error("block_not_found");
    const group = blockGroup(parent ?? document.getXmlFragment("document-store"), true)!;
    const position = operation.position ?? { type: "end" as const };
    let index = group.length;
    if (position.type === "start") index = 0;
    if (position.type === "after_block") {
      if (!position.afterInternalId) throw new Error("invalid_position");
      index =
        group
          .toArray()
          .findIndex(
            (child) => child instanceof Y.XmlElement && child.getAttribute("id") === position.afterInternalId,
          ) + 1;
      if (!index) throw new Error("invalid_position");
    }
    group.insert(index, operation.children.map(yNode));
    return;
  }
  const found = findYContainer(document, operation.internalId);
  if (!found) throw new Error("block_not_found");
  if (operation.type === "delete_block") {
    found.group.delete(found.index, 1);
    return;
  }
  const children = found.container.toArray();
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (!(child instanceof Y.XmlElement) || child.nodeName !== "blockGroup") found.container.delete(index, 1);
  }
  found.container.insert(0, [yNode(operation.node)]);
}

function collectLegacyColumns(document: ProseMirrorJson) {
  const legacy: ProseMirrorJson[] = [];
  const visit = (node: ProseMirrorJson) => {
    if (
      node.type === "blockContainer" &&
      node.content?.some((child) => child.type !== "blockGroup" && child.type === "columns")
    ) {
      legacy.push(node);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(document);
  return legacy;
}

function paragraphContainer(content: ProseMirrorJson[] = []) {
  return {
    type: "blockContainer",
    attrs: { id: crypto.randomUUID() },
    content: [
      {
        type: "paragraph",
        attrs: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
        ...(content.length ? { content: structuredClone(content) } : {}),
      },
    ],
  } satisfies ProseMirrorJson;
}

function legacyColumnsReplacement(container: ProseMirrorJson) {
  const legacy = container.content?.find((child) => child.type === "columns");
  if (!legacy) throw new Error("Legacy columns block is missing.");
  const nested = container.content?.find((child) => child.type === "blockGroup")?.content ?? [];
  const count = Number(legacy.attrs?.count ?? 2) === 3 ? 3 : 2;
  const columns = Array.from({ length: count }, (_, index) => ({
    type: "blockContainer",
    attrs: { id: crypto.randomUUID() },
    content: [
      { type: "column" },
      {
        type: "blockGroup",
        content:
          index === 0 ? [paragraphContainer(legacy.content), ...structuredClone(nested)] : [paragraphContainer()],
      },
    ],
  }));
  return {
    type: "blockContainer",
    attrs: structuredClone(container.attrs ?? {}),
    content: [{ type: "columnList" }, { type: "blockGroup", content: columns }],
  } satisfies ProseMirrorJson;
}

export function migrateLegacyColumns(document: Y.Doc) {
  const json = yXmlFragmentToProsemirrorJSON(document.getXmlFragment("document-store")) as ProseMirrorJson;
  const legacy = collectLegacyColumns(json);
  if (!legacy.length) return false;
  document.transact(() => {
    for (const container of legacy) {
      const id = container.attrs?.id;
      if (typeof id !== "string") continue;
      const found = findYContainer(document, id);
      if (!found) continue;
      found.group.delete(found.index, 1);
      found.group.insert(found.index, [yNode(legacyColumnsReplacement(container))]);
    }
  }, "legacy-columns-migration");
  return true;
}

async function addCommentMark(
  document: Y.Doc,
  threadId: string,
  selection: { head: RelativePositionJson; anchor: RelativePositionJson },
) {
  let head: Y.AbsolutePosition | null;
  let anchor: Y.AbsolutePosition | null;
  try {
    head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.head), document);
    anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.anchor), document);
  } catch {
    return false;
  }
  if (!head || !anchor || !(head.type instanceof Y.XmlText) || !(anchor.type instanceof Y.XmlText)) return false;
  const nodes = documentTextNodes(document);
  let headNode = nodes.indexOf(head.type);
  let anchorNode = nodes.indexOf(anchor.type);
  if (headNode < 0 || anchorNode < 0) return false;
  let headOffset = head.index;
  let anchorOffset = anchor.index;
  if (headNode > anchorNode || (headNode === anchorNode && headOffset > anchorOffset)) {
    [headNode, anchorNode] = [anchorNode, headNode];
    [headOffset, anchorOffset] = [anchorOffset, headOffset];
  }
  const ranges = nodes.slice(headNode, anchorNode + 1).map((text, index, selected) => {
    const from = index === 0 ? headOffset : 0;
    const to = index === selected.length - 1 ? anchorOffset : text.length;
    return { text, from, length: Math.max(0, to - from) };
  });
  const selectedLength = ranges.reduce((total, range) => total + range.length, 0);
  if (!selectedLength || selectedLength > 100_000) return false;
  const markName = `comment--${(await sha256Hex(threadId)).slice(0, 8)}`;
  document.transact(() => {
    removeCommentMark(document, threadId);
    for (const range of ranges) {
      if (range.length) range.text.format(range.from, range.length, { [markName]: { threadId, orphan: false } });
    }
  }, "comment-anchor");
  return true;
}

export class Document extends YServer {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1_000, debounceMaxWait: 5_000 };

  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private metadata!: MetaRow;
  private pendingUpdates: Uint8Array[] = [];
  private pendingAuthorId: string | null = null;
  private pendingNotifyEdit = false;
  private purged = false;
  private transition: "archive" | "restore" | null = null;
  private transitionAlarmDeferred = false;
  private transitionAlarmRearm: Promise<void> | null = null;
  private transitionRetryAt: number | null = null;
  private validatingTransition = false;
  private loadedSnapshot = false;
  // Set when onStart reconciled a pending restore, consumed by the alarm that
  // initialization was running for. Per instance, so a later alarm delivered to
  // a resident room still reconciles on its own schedule.
  private reconciledOnStart = false;
  private compaction: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.bindings = env;
  }

  private get ids() {
    const separator = this.name.lastIndexOf("~");
    if (separator < 1) throw new Error("Invalid document room name");
    return {
      pageId: this.name.slice(0, separator),
      epoch: Number(this.name.slice(separator + 1)),
    };
  }

  async onStart() {
    const sql = this.state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS document_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot_seq INTEGER NOT NULL DEFAULT 0,
      snapshot_bytes INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 0,
      retired INTEGER NOT NULL DEFAULT 0,
      restore_pending INTEGER NOT NULL DEFAULT 0,
      restore_attempts INTEGER NOT NULL DEFAULT 0,
      restore_retry_at INTEGER NOT NULL DEFAULT 0,
      read_only INTEGER NOT NULL DEFAULT 0,
      last_version_at INTEGER NOT NULL DEFAULT 0,
      last_editor_id TEXT,
      notify_edit INTEGER NOT NULL DEFAULT 0
      , content_kind TEXT NOT NULL DEFAULT 'document'
    )`);
    const metaColumns = sql.exec<{ name: string }>(`PRAGMA table_info(document_meta)`).toArray();
    if (!metaColumns.some((column) => column.name === "snapshot_bytes")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN snapshot_bytes INTEGER NOT NULL DEFAULT 0`);
    }
    if (!metaColumns.some((column) => column.name === "restore_pending")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN restore_pending INTEGER NOT NULL DEFAULT 0`);
    }
    if (!metaColumns.some((column) => column.name === "restore_attempts")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN restore_attempts INTEGER NOT NULL DEFAULT 0`);
    }
    if (!metaColumns.some((column) => column.name === "restore_retry_at")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN restore_retry_at INTEGER NOT NULL DEFAULT 0`);
    }
    if (!metaColumns.some((column) => column.name === "notify_edit")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN notify_edit INTEGER NOT NULL DEFAULT 0`);
    }
    if (!metaColumns.some((column) => column.name === "content_kind")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'document'`);
    }
    const hadMetadata = Boolean(
      sql.exec<{ present: number }>(`SELECT EXISTS(SELECT 1 FROM document_meta WHERE id = 1) present`).one().present,
    );
    sql.exec(`INSERT OR IGNORE INTO document_meta (id) VALUES (1)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS update_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS update_chunks (
      seq INTEGER NOT NULL REFERENCES update_events(seq) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (seq, chunk_index)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS restore_recovery (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      old_epoch INTEGER NOT NULL,
      new_epoch INTEGER NOT NULL,
      new_key TEXT NOT NULL,
      pre_key TEXT
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_update_chunks_seq ON update_chunks(seq, chunk_index)`);
    this.metadata = sql.exec<MetaRow>(`SELECT * FROM document_meta WHERE id = 1`).one();

    // Normal hibernation wakes stay independent of D1. New state still needs
    // an authoritative check so a purged room cannot restart without its tombstone.
    if (!hadMetadata) {
      const { pageId, epoch } = this.ids;
      const current = await this.bindings.DB.prepare(`SELECT content_epoch, kind FROM pages WHERE id = ?`)
        .bind(pageId)
        .first<{ content_epoch: number; kind: string }>();
      this.metadata.retired = !current || current.content_epoch !== epoch ? 1 : 0;
      this.metadata.restore_pending = 0;
      this.metadata.content_kind = current?.kind === "diagram" ? "diagram" : "document";
      sql.exec(
        `UPDATE document_meta
            SET retired = ?, restore_pending = 0, content_kind = ?
          WHERE id = 1`,
        this.metadata.retired,
        this.metadata.content_kind,
      );
    } else if (this.metadata.restore_pending) {
      this.reconciledOnStart = true;
      await this.reconcilePendingRestore();
    }

    await super.onStart();
    this.document.on("update", (update: Uint8Array, origin: unknown) => {
      this.bufferUpdate(update, origin as Connection<ConnectionAuth> | null);
    });
    // A restored epoch starts with an R2 snapshot but no local update log. Seed
    // one idempotent Yjs update so the new room regenerates search projections,
    // references, thumbnails, and the epoch-scoped current projection.
    if (!hadMetadata && !this.metadata.retired && this.loadedSnapshot) {
      this.bufferUpdate(Y.encodeStateAsUpdate(this.document), null);
      this.flushPendingUpdates();
    }
    if (!this.metadata.retired && this.metadata.content_kind === "document" && migrateLegacyColumns(this.document)) {
      this.flushPendingUpdates();
    }
    const pendingLog = sql
      .exec<{ pending: number }>(
        `SELECT EXISTS(SELECT 1 FROM update_events WHERE seq > ?) pending`,
        this.metadata.snapshot_seq,
      )
      .one().pending;
    if (pendingLog) {
      if (!this.metadata.dirty) {
        this.metadata.dirty = 1;
        sql.exec(`UPDATE document_meta SET dirty = 1 WHERE id = 1`);
      }
      await this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS);
    }
  }

  async onLoad() {
    const { pageId, epoch } = this.ids;
    const doc = new Y.Doc();
    const snapshot = await this.bindings.BUCKET.get(this.snapshotKey(pageId, epoch));
    this.loadedSnapshot = Boolean(snapshot);
    if (snapshot) Y.applyUpdate(doc, new Uint8Array(await snapshot.arrayBuffer()));

    const events = this.state.storage.sql
      .exec<{ seq: number }>(`SELECT seq FROM update_events WHERE seq > ? ORDER BY seq`, this.metadata.snapshot_seq)
      .toArray();
    for (const event of events) {
      const chunks = this.state.storage.sql
        .exec<{ data: ArrayBuffer }>(`SELECT data FROM update_chunks WHERE seq = ? ORDER BY chunk_index`, event.seq)
        .toArray();
      Y.applyUpdate(doc, joinBytes(chunks.map((chunk) => new Uint8Array(chunk.data))));
    }
    return doc;
  }

  async onConnect(connection: Connection<ConnectionAuth>, context: ConnectionContext) {
    const connections = Array.from(this.getConnections());
    if (connections.length > 30) {
      connection.close(4429, "This page already has 30 collaborators.");
      return;
    }

    const userId = context.request.headers.get("x-notes-user-id");
    const role = context.request.headers.get("x-notes-role") as ConnectionAuth["role"] | null;
    const expiresAt = Number(context.request.headers.get("x-notes-expires-at"));
    if (!userId || !role || !expiresAt) {
      connection.close(4401, "Authorization missing.");
      return;
    }
    connection.setState({ userId, role, expiresAt });
    await this.scheduleAlarm(expiresAt);
    await super.onConnect(connection, context);
    if (this.metadata.read_only || this.metadata.snapshot_bytes >= WARN_BYTES) {
      this.sendCustomMessage(
        connection,
        JSON.stringify({
          type: "document-size",
          bytes: this.metadata.snapshot_bytes || READ_ONLY_BYTES,
          readOnly: Boolean(this.metadata.read_only),
        }),
      );
    }
  }

  isReadOnly(connection: Connection<ConnectionAuth>) {
    return Boolean(
      this.metadata.retired ||
      this.metadata.restore_pending ||
      this.transition ||
      this.metadata.read_only ||
      connection.state?.role === "viewer" ||
      !connection.state ||
      connection.state.expiresAt <= Date.now(),
    );
  }

  onMessage(connection: Connection<ConnectionAuth>, message: WSMessage) {
    const state = connection.state;
    if (!state || state.expiresAt <= Date.now()) {
      connection.close(4401, "Authorization expired. Reconnect to continue.");
      return;
    }
    if (this.metadata.retired || this.metadata.restore_pending || this.purged || this.transition === "restore") {
      connection.close(4410, "This document version has been retired.");
      return;
    }
    if (this.transition === "archive") {
      connection.close(4412, "This page was archived.");
      return;
    }
    return super.onMessage(connection, message);
  }

  onCustomMessage(connection: Connection<ConnectionAuth>, message: string) {
    let value: { type?: unknown; generation?: unknown };
    try {
      value = JSON.parse(message);
    } catch {
      return;
    }
    if (
      value.type !== "document-update-barrier" ||
      !Number.isInteger(value.generation) ||
      Number(value.generation) < 1 ||
      this.isReadOnly(connection)
    )
      return;
    // Client custom messages share the WebSocket's ordering with Yjs updates.
    // Reaching this barrier means every preceding update from that client has
    // been applied; flushing before the reply turns the reply into a durable ack.
    this.flushPendingUpdates();
    this.sendCustomMessage(
      connection,
      JSON.stringify({
        type: "document-update-ack",
        generation: value.generation,
      }),
    );
  }

  async onSave() {
    if (this.purged) return;
    this.flushPendingUpdates();
    if (this.metadata.dirty) await this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS);
  }

  async onAlarm() {
    if (this.purged) return;
    if (this.transition) {
      this.transitionAlarmDeferred = true;
      const rearm = this.scheduleAlarm(Date.now() + ALARM_RETRY_DELAY_MS);
      this.transitionAlarmRearm = rearm;
      try {
        await rearm;
      } finally {
        if (this.transitionAlarmRearm === rearm) this.transitionAlarmRearm = null;
      }
      return;
    }
    if (this.metadata.restore_pending) {
      // partyserver initializes before it delivers an alarm, so onStart has
      // already reconciled this wake, and that attempt armed the next retry.
      // Tracked as state rather than inferred from restore_retry_at, because
      // super.onStart() loads a snapshot and replays the log between the two:
      // a large document can outrun the 2.5-5 s first backoff and reconcile
      // twice on one delivery.
      if (this.reconciledOnStart) {
        // The latch outlives the wake that set it: onStart reconciles on any
        // start, not only an alarm delivery, and nothing else clears it. A
        // start driven by a normal request therefore holds it on a live
        // instance, and the retry that attempt armed lands here instead of the
        // cold wake this branch was written for. Re-arm for the same reason the
        // quiet-period branch does: the delivery consumed the stored alarm
        // either way.
        this.reconciledOnStart = false;
        await this.armRestoreRetry(this.metadata.restore_retry_at);
      } else if (Date.now() >= this.metadata.restore_retry_at) {
        await this.reconcilePendingRestore();
      } else {
        // Inside the persisted quiet period the alarm has nothing left to do
        // but hold the schedule that attempt set: the delivery consumed the
        // stored alarm, so skipping without re-arming would strand the room
        // read-only.
        await this.armRestoreRetry(this.metadata.restore_retry_at);
      }
    }
    if (this.purged || this.metadata.retired || this.metadata.restore_pending) return;
    this.flushPendingUpdates();
    const time = Date.now();
    for (const connection of this.getConnections<ConnectionAuth>()) {
      if (!connection.state || connection.state.expiresAt <= time) {
        connection.close(4401, "Authorization expired. Reconnect to continue.");
      }
    }
    if (this.metadata.dirty) await this.compact();

    const nextExpiry = Array.from(this.getConnections<ConnectionAuth>())
      .map((connection) => connection.state?.expiresAt ?? 0)
      .filter((expiry) => expiry > Date.now())
      .sort((left, right) => left - right)[0];
    if (nextExpiry) await this.scheduleAlarm(nextExpiry);
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);
    if (request.headers.get("x-notes-internal") !== this.bindings.BETTER_AUTH_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/content")) {
      this.flushPendingUpdates();
      if (this.metadata.dirty) await this.compact();
      const { pageId, epoch } = this.ids;
      if (this.metadata.content_kind === "diagram") {
        const envelope = diagramFromYDoc(this.document, {
          pageId,
          contentEpoch: epoch,
          sequence: this.metadata.snapshot_seq,
        });
        return Response.json(envelope, {
          headers: { etag: `"${await sha256Hex(canonicalJson(envelope))}"` },
        });
      }
      const document = yXmlFragmentToProsemirrorJSON(this.document.getXmlFragment("document-store")) as ProseMirrorJson;
      const envelope: DocumentContentEnvelope = {
        schemaVersion: 1,
        pageId,
        contentEpoch: epoch,
        sequence: this.metadata.snapshot_seq,
        document,
      };
      return Response.json(envelope, {
        headers: { etag: `"${await sha256Hex(canonicalJson(envelope))}"` },
      });
    }
    if (request.method === "POST" && url.pathname.endsWith("/api-mutate")) {
      if (this.metadata.content_kind !== "document") {
        return Response.json({ error: "Block mutations are only available for document pages." }, { status: 422 });
      }
      let body: { actorId?: unknown; operations?: unknown };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid mutation request." }, { status: 400 });
      }
      if (
        typeof body.actorId !== "string" ||
        !Array.isArray(body.operations) ||
        body.operations.length < 1 ||
        body.operations.length > 100
      ) {
        return Response.json({ error: "Invalid mutation request." }, { status: 400 });
      }
      if (this.purged || this.metadata.retired || this.metadata.restore_pending || this.transition) {
        return Response.json({ error: "This document version has been retired." }, { status: 410 });
      }
      if (this.metadata.read_only) return Response.json({ error: "This document is read-only." }, { status: 409 });
      const clone = new Y.Doc();
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(this.document));
      try {
        clone.transact(() => {
          for (const operation of body.operations as ApiBlockMutation[]) applyApiMutation(clone, operation);
        }, "api-validation");
      } catch (error) {
        const code = error instanceof Error ? error.message : "invalid_mutation";
        clone.destroy();
        return Response.json({ error: code }, { status: code === "block_not_found" ? 404 : 422 });
      }
      const document = yXmlFragmentToProsemirrorJSON(clone.getXmlFragment("document-store")) as ProseMirrorJson;
      const blockCount = flattenDocumentBlocks(document).length;
      if (blockCount > 10_000) {
        clone.destroy();
        return Response.json({ error: "Document block limit exceeded." }, { status: 413 });
      }
      const snapshot = Y.encodeStateAsUpdate(clone);
      if (snapshot.byteLength >= READ_ONLY_BYTES) {
        clone.destroy();
        return Response.json({ error: "Document size limit exceeded." }, { status: 413 });
      }
      clone.destroy();
      this.pendingAuthorId = body.actorId;
      this.pendingNotifyEdit = false;
      this.document.transact(() => {
        for (const operation of body.operations as ApiBlockMutation[]) applyApiMutation(this.document, operation);
      }, "api-mutation");
      this.flushPendingUpdates();
      if (this.metadata.dirty) await this.compact(true);
      return Response.json({ document, sequence: this.metadata.snapshot_seq });
    }
    if (request.method === "GET" && url.pathname.endsWith("/legacy-comments")) {
      if (this.metadata.content_kind !== "document") return Response.json({ threads: [] });
      return Response.json({ threads: legacyComments(this.document) });
    }
    if (request.method === "POST" && url.pathname.endsWith("/legacy-comments/clear")) {
      if (this.metadata.content_kind !== "document") return Response.json({ cleared: true });
      const legacy = this.document.getMap("comments");
      if (legacy.size) {
        this.document.transact(() => legacy.clear(), "comment-migration");
        this.flushPendingUpdates();
        if (this.metadata.dirty) await this.compact();
      }
      return Response.json({ cleared: true });
    }
    if (request.method === "POST" && url.pathname.endsWith("/comment-anchor")) {
      if (this.metadata.content_kind !== "document") {
        return Response.json({ error: "Text anchors are only available for document pages." }, { status: 422 });
      }
      let body: {
        threadId?: unknown;
        userId?: unknown;
        operation?: unknown;
        selection?: { head?: unknown; anchor?: unknown };
      };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid comment anchor request." }, { status: 400 });
      }
      if (
        typeof body.threadId !== "string" ||
        typeof body.userId !== "string" ||
        (body.operation !== "add" && body.operation !== "remove")
      ) {
        return Response.json({ error: "Invalid comment anchor request." }, { status: 400 });
      }
      if (this.purged || this.metadata.retired || this.metadata.restore_pending || this.transition) {
        return Response.json({ error: "This document version has been retired." }, { status: 410 });
      }
      if (this.metadata.read_only && body.operation === "add") {
        return Response.json({ error: "This document is read-only." }, { status: 409 });
      }
      const { pageId } = this.ids;
      const thread = await this.bindings.DB.prepare(`SELECT id FROM comment_threads WHERE id = ? AND page_id = ?`)
        .bind(body.threadId, pageId)
        .first<{ id: string }>();
      if (!thread) return Response.json({ error: "Comment thread not found." }, { status: 404 });
      this.pendingAuthorId = body.userId;
      if (body.operation === "remove") removeCommentMark(this.document, body.threadId);
      const anchored =
        body.operation === "remove"
          ? false
          : body.selection?.head && body.selection.anchor
            ? await addCommentMark(this.document, body.threadId, {
                head: body.selection.head as RelativePositionJson,
                anchor: body.selection.anchor as RelativePositionJson,
              })
            : false;
      this.flushPendingUpdates();
      if (this.metadata.dirty) await this.compact();
      return Response.json({ anchored });
    }
    if (request.method === "POST" && url.pathname.endsWith("/initialize")) {
      let body: { jobId?: unknown; inputKey?: unknown };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid initialization request." }, { status: 400 });
      }
      const jobId = typeof body.jobId === "string" ? body.jobId : "";
      const inputKey = typeof body.inputKey === "string" ? body.inputKey : "";
      if (!jobId || !inputKey.startsWith(`jobs/${jobId}/`)) {
        return Response.json({ error: "Invalid initialization request." }, { status: 400 });
      }
      if (this.purged || this.metadata.retired) {
        return Response.json({ error: "This document version has been retired." }, { status: 410 });
      }
      const { pageId, epoch } = this.ids;
      const staged = await this.bindings.DB.prepare(
        `SELECT j.requested_by FROM pages p JOIN jobs j ON j.id = p.import_job_id
          WHERE p.id = ? AND p.content_epoch = ? AND p.import_job_id = ?
            AND j.type IN ('import', 'template_clone') AND j.status IN ('queued', 'running')`,
      )
        .bind(pageId, epoch, jobId)
        .first<{ requested_by: string }>();
      if (!staged) {
        return Response.json(
          { error: "Only a staged import or template clone may initialize content." },
          { status: 409 },
        );
      }
      const projectionTable = this.metadata.content_kind === "diagram" ? "diagram_projections" : "document_projections";
      const existingProjection = await this.bindings.DB.prepare(
        `SELECT sequence FROM ${projectionTable} WHERE page_id = ? AND content_epoch = ?`,
      )
        .bind(pageId, epoch)
        .first<{ sequence: number }>();
      if (existingProjection) return Response.json({ initialized: true, sequence: existingProjection.sequence });
      const alreadyStarted =
        this.metadata.snapshot_seq !== 0 ||
        this.pendingUpdates.length > 0 ||
        this.state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM update_events`).one().count > 0 ||
        Array.from(this.getConnections()).length > 0;
      if (alreadyStarted) {
        return Response.json({ error: "The staged document has already been initialized." }, { status: 409 });
      }
      const input = await this.bindings.BUCKET.get(inputKey);
      if (!input) return Response.json({ error: "Initialization content is missing." }, { status: 404 });
      if (input.size > READ_ONLY_BYTES) {
        return Response.json({ error: "Initialization content is too large." }, { status: 413 });
      }
      const update = new Uint8Array(await input.arrayBuffer());
      this.pendingAuthorId = staged.requested_by;
      Y.applyUpdate(this.document, update);
      if (this.metadata.content_kind === "document") migrateLegacyColumns(this.document);
      this.flushPendingUpdates();
      // An empty update produces no Yjs event, but still needs a sequence so
      // compaction persists the canonical empty projection for the staged page.
      if (!this.metadata.dirty) {
        this.state.storage.transactionSync(() => {
          const row = this.state.storage.sql
            .exec<{ seq: number }>(
              `INSERT INTO update_events (author_id, created_at) VALUES (?, ?) RETURNING seq`,
              staged.requested_by,
              Date.now(),
            )
            .one();
          for (const [index, bytes] of splitBytes(update).entries()) {
            this.state.storage.sql.exec(
              `INSERT INTO update_chunks (seq, chunk_index, data) VALUES (?, ?, ?)`,
              row.seq,
              index,
              bytes.buffer,
            );
          }
          this.state.storage.sql.exec(
            `UPDATE document_meta SET dirty = 1, last_editor_id = ? WHERE id = 1`,
            staged.requested_by,
          );
        });
        this.metadata.dirty = 1;
        this.metadata.last_editor_id = staged.requested_by;
        this.pendingAuthorId = null;
      }
      await this.compact();
      return Response.json({ initialized: true, sequence: this.metadata.snapshot_seq });
    }
    if (request.method === "POST" && url.pathname.endsWith("/archive")) {
      if (this.validatingTransition || this.transition || this.metadata.restore_pending) {
        return Response.json({ error: "Document transition already in progress." }, { status: 409 });
      }
      this.validatingTransition = true;
      try {
        const { pageId, epoch } = this.ids;
        const page = await this.bindings.DB.prepare(`SELECT content_epoch, archived_at FROM pages WHERE id = ?`)
          .bind(pageId)
          .first<{ content_epoch: number; archived_at: number | null }>();
        if (!page || page.content_epoch !== epoch || page.archived_at === null) {
          return Response.json(
            { error: "The page is no longer archived.", code: "archive_no_longer_applicable" },
            { status: 410 },
          );
        }
        if (this.transition || this.metadata.restore_pending || this.metadata.retired || this.purged) {
          return Response.json({ error: "Document transition already in progress." }, { status: 409 });
        }
        this.transition = "archive";
        this.validatingTransition = false;
        try {
          for (const connection of this.getConnections()) {
            connection.close(4412, "This page was archived.");
          }
          this.flushPendingUpdates();
          if (this.metadata.dirty) await this.compact(true);
          return Response.json({ archived: true });
        } finally {
          await this.finishTransition();
        }
      } finally {
        this.validatingTransition = false;
      }
    }
    if (request.method === "POST" && url.pathname.endsWith("/restore-version")) {
      let body: { versionId?: unknown; userId?: unknown };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid restore request." }, { status: 400 });
      }
      if (typeof body.versionId !== "string" || typeof body.userId !== "string") {
        return Response.json({ error: "Invalid restore request." }, { status: 400 });
      }
      return this.restoreVersion(body.versionId, body.userId);
    }
    if (request.method === "POST" && url.pathname.endsWith("/purge")) {
      this.purged = true;
      this.metadata.retired = 1;
      this.pendingUpdates = [];
      this.pendingAuthorId = null;
      this.pendingNotifyEdit = false;
      for (const connection of this.getConnections()) {
        connection.close(4411, "This page was permanently deleted.");
      }
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return Response.json({ purged: true });
    }
    return new Response("Not found", { status: 404 });
  }

  private bufferUpdate(update: Uint8Array, origin: Connection<ConnectionAuth> | null) {
    if (this.metadata.retired || this.metadata.restore_pending || this.purged || this.transition) return;
    this.pendingUpdates.push(update);
    this.pendingAuthorId = origin?.state?.userId ?? this.pendingAuthorId;
    this.pendingNotifyEdit ||= Boolean(origin?.state?.userId);
  }

  private flushPendingUpdates() {
    if (!this.pendingUpdates.length || this.purged) return;
    const updates = this.pendingUpdates;
    const authorId = this.pendingAuthorId;
    const notifyEdit = this.pendingNotifyEdit;
    const merged = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
    this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql
        .exec<{ seq: number }>(
          `INSERT INTO update_events (author_id, created_at) VALUES (?, ?) RETURNING seq`,
          authorId,
          Date.now(),
        )
        .one();
      for (const [index, bytes] of splitBytes(merged).entries()) {
        this.state.storage.sql.exec(
          `INSERT INTO update_chunks (seq, chunk_index, data) VALUES (?, ?, ?)`,
          row.seq,
          index,
          bytes.buffer,
        );
      }
      this.state.storage.sql.exec(
        `UPDATE document_meta SET dirty = 1, last_editor_id = COALESCE(?, last_editor_id),
          notify_edit = CASE WHEN ? THEN 1 ELSE notify_edit END WHERE id = 1`,
        authorId,
        notifyEdit ? 1 : 0,
      );
    });
    this.pendingUpdates = [];
    this.pendingAuthorId = null;
    this.pendingNotifyEdit = false;
    this.metadata.dirty = 1;
    if (authorId) this.metadata.last_editor_id = authorId;
    if (notifyEdit) this.metadata.notify_edit = 1;
  }

  private compact(forceVersion = false): Promise<void> {
    const active = this.compaction;
    if (active) return active.catch(() => undefined).then(() => this.compact(forceVersion));
    const compacting = this.compactOnce(forceVersion);
    const tracked = compacting.finally(() => {
      if (this.compaction === tracked) this.compaction = null;
    });
    this.compaction = tracked;
    return tracked;
  }

  private async compactOnce(forceVersion = false) {
    if (this.metadata.content_kind === "document") migrateLegacyColumns(this.document);
    this.flushPendingUpdates();
    const { pageId, epoch } = this.ids;
    const maximum = this.state.storage.sql
      .exec<{ seq: number | null }>(`SELECT MAX(seq) seq FROM update_events`)
      .one().seq;
    if (maximum === null) {
      this.metadata.dirty = 0;
      this.state.storage.sql.exec(`UPDATE document_meta SET dirty = 0 WHERE id = 1`);
      return;
    }

    if (this.metadata.content_kind === "diagram") {
      await this.compactDiagram(maximum, forceVersion);
      return;
    }

    const metadataAtStart = { ...this.metadata };
    const snapshot = Y.encodeStateAsUpdate(this.document);
    const json = yXmlFragmentToProsemirrorJSON(this.document.getXmlFragment("document-store")) as ProseMirrorJson;
    const projection = projectDocument(json);
    const transclusions = collectTransclusions(json);
    const envelope: DocumentContentEnvelope = {
      schemaVersion: 1,
      pageId,
      contentEpoch: epoch,
      sequence: maximum,
      document: json,
    };
    const structuredJson = canonicalJson(envelope);
    const structuredBytes = new TextEncoder().encode(structuredJson);
    const structuredKey = this.projectionKey(pageId, epoch, maximum);
    const readOnly = snapshot.byteLength >= READ_ONLY_BYTES;
    if (snapshot.byteLength >= WARN_BYTES) {
      this.broadcastCustomMessage(
        JSON.stringify({
          type: "document-size",
          bytes: snapshot.byteLength,
          readOnly,
        }),
      );
    }

    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE document_meta
            SET dirty = 0, notify_edit = 0, snapshot_bytes = ?, read_only = CASE WHEN ? THEN 1 ELSE read_only END
          WHERE id = 1`,
        snapshot.byteLength,
        readOnly ? 1 : 0,
      );
    });
    this.metadata.dirty = 0;
    this.metadata.notify_edit = 0;
    this.metadata.snapshot_bytes = snapshot.byteLength;
    if (readOnly) this.metadata.read_only = 1;

    try {
      // Keep the dirty-state handoff synchronous with capturing `maximum`.
      // Updates received while hashing or writing R2 must remain dirty for the
      // next compaction instead of being cleared by this one.
      const structuredHash = await sha256Hex(structuredJson);
      const existingBlockIds = new Map(
        (
          await this.bindings.DB.prepare(`SELECT id, internal_id FROM api_blocks WHERE page_id = ?`)
            .bind(pageId)
            .all<{ id: string; internal_id: string }>()
        ).results.map((row) => [row.internal_id, row.id]),
      );
      const blockMetadata = await Promise.all(
        flattenDocumentBlocks(json).map(async (block) => ({
          id: existingBlockIds.get(block.id) ?? uuidFromHash(await sha256Hex(`${pageId}:${block.id}`)),
          internalId: block.id,
          contentHash: await sha256Hex(canonicalJson(block)),
        })),
      );
      await this.bindings.BUCKET.put(this.snapshotKey(pageId, epoch), snapshot, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
      });
      await this.bindings.BUCKET.put(structuredKey, structuredBytes, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          pageId,
          epoch: String(epoch),
          sequence: String(maximum),
          contentHash: structuredHash,
        },
      });

      const page = await this.bindings.DB.prepare(
        `SELECT workspace_id, space_id, title, archived_at FROM pages WHERE id = ? AND content_epoch = ?`,
      )
        .bind(pageId, epoch)
        .first<PageProjectionRow>();
      // Every compaction writes a new projection object; without this the superseded
      // ones accumulate in R2 for the life of the page.
      const supersededProjection = await this.bindings.DB.prepare(
        `SELECT r2_key FROM document_projections WHERE page_id = ?`,
      )
        .bind(pageId)
        .first<{ r2_key: string }>();
      let versionAt = metadataAtStart.last_version_at;
      let versionKey: string | null = null;
      let versionStatementIndex = -1;
      let pageProjected = false;

      if (page) {
        const [oldPageTargets, oldUserTargets, watcherRows] = await Promise.all([
          this.bindings.DB.prepare(`SELECT target_page_id id FROM page_references WHERE source_page_id = ?`)
            .bind(pageId)
            .all<{ id: string }>(),
          this.bindings.DB.prepare(`SELECT target_user_id id FROM member_mentions WHERE source_page_id = ?`)
            .bind(pageId)
            .all<{ id: string }>(),
          metadataAtStart.notify_edit && metadataAtStart.last_editor_id
            ? this.bindings.DB.prepare(
                `SELECT user_id id FROM subscriptions
                  WHERE resource_type = 'page' AND resource_id = ? AND muted_at IS NULL
                 UNION
                SELECT space_watch.user_id id FROM subscriptions space_watch
                  WHERE space_watch.resource_type = 'space' AND space_watch.resource_id = ?
                    AND space_watch.muted_at IS NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM subscriptions page_override
                       WHERE page_override.user_id = space_watch.user_id
                         AND page_override.resource_type = 'page' AND page_override.resource_id = ?
                    )`,
              )
                .bind(pageId, page.space_id, pageId)
                .all<{ id: string }>()
            : Promise.resolve({ results: [] as Array<{ id: string }> }),
        ]);
        const timestamp = Date.now();
        const oldMentionIds = new Set(oldUserTargets.results.map((row) => row.id));
        const newMentionIds = projection.memberMentions
          .map((mention) => mention.targetId)
          .filter((id) => !oldMentionIds.has(id));
        const watcherIds = watcherRows.results.map((row) => row.id).filter((id) => !newMentionIds.includes(id));
        const makeVersion = Boolean(
          forceVersion ||
          !metadataAtStart.last_version_at ||
          timestamp - metadataAtStart.last_version_at >= VERSION_INTERVAL_MS,
        );
        const statements = [
          this.bindings.DB.prepare(
            `UPDATE pages SET plain_text = ?, indexed_seq = ?, oversized = ?, updated_at = ?
                 , updated_by = COALESCE(?, updated_by)
              WHERE id = ? AND content_epoch = ?`,
          ).bind(
            projection.plainText,
            maximum,
            readOnly ? 1 : 0,
            timestamp,
            metadataAtStart.last_editor_id,
            pageId,
            epoch,
          ),
          this.bindings.DB.prepare(
            `INSERT INTO document_projections
              (page_id, content_epoch, sequence, schema_version, r2_key, content_hash, byte_size, updated_at)
             SELECT id, ?, ?, 1, ?, ?, ?, ? FROM pages
              WHERE id = ? AND content_epoch = ?
             ON CONFLICT(page_id) DO UPDATE SET
              content_epoch = excluded.content_epoch,
              sequence = excluded.sequence,
              schema_version = excluded.schema_version,
              r2_key = excluded.r2_key,
              content_hash = excluded.content_hash,
              byte_size = excluded.byte_size,
              updated_at = excluded.updated_at`,
          ).bind(epoch, maximum, structuredKey, structuredHash, structuredBytes.byteLength, timestamp, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM page_search WHERE page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO page_search (page_id, workspace_id, title, body)
              SELECT id, workspace_id, title, ? FROM pages
               WHERE id = ? AND content_epoch = ? AND archived_at IS NULL AND import_job_id IS NULL`,
          ).bind(projection.plainText, pageId, epoch),
          ...refreshPageSearchV2Statements(this.bindings.DB, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE page_references SET projection_seq = -1 WHERE source_page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO page_references (source_page_id, target_page_id, excerpt, projection_seq)
              SELECT ?, target.id, json_extract(item.value, '$.excerpt'), ?
                FROM json_each(?) item
                JOIN pages target ON target.id = json_extract(item.value, '$.targetId')
               WHERE target.workspace_id = ? AND target.archived_at IS NULL AND target.id <> ?
                 AND EXISTS (SELECT 1 FROM pages source WHERE source.id = ? AND source.content_epoch = ?)
              ON CONFLICT(source_page_id, target_page_id) DO UPDATE SET
                excerpt = excluded.excerpt, projection_seq = excluded.projection_seq`,
          ).bind(pageId, maximum, JSON.stringify(projection.pageReferences), page.workspace_id, pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM page_references WHERE source_page_id = ? AND projection_seq <> ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, maximum, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE member_mentions SET projection_seq = -1 WHERE source_page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO member_mentions
              (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
              SELECT ?, ?, member.user_id, json_extract(item.value, '$.excerpt'), ?, ?
                FROM json_each(?) item
                JOIN workspace_members member
                  ON member.workspace_id = ? AND member.user_id = json_extract(item.value, '$.targetId')
               WHERE EXISTS (SELECT 1 FROM pages source WHERE source.id = ? AND source.content_epoch = ?)
              ON CONFLICT(source_page_id, target_user_id) DO UPDATE SET
                excerpt = excluded.excerpt, projection_seq = excluded.projection_seq`,
          ).bind(
            page.workspace_id,
            pageId,
            timestamp,
            maximum,
            JSON.stringify(projection.memberMentions),
            page.workspace_id,
            pageId,
            epoch,
          ),
          this.bindings.DB.prepare(
            `DELETE FROM member_mentions WHERE source_page_id = ? AND projection_seq <> ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, maximum, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE transclusion_sources SET projection_seq = -1 WHERE page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO transclusion_sources (page_id, block_id, content_json, projection_seq, updated_at)
             SELECT ?, json_extract(item.value, '$.blockId'), json_extract(item.value, '$.content'), ?, ?
               FROM json_each(?) item
              WHERE EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)
             ON CONFLICT(page_id, block_id) DO UPDATE SET
               content_json = excluded.content_json, projection_seq = excluded.projection_seq,
               updated_at = excluded.updated_at`,
          ).bind(
            pageId,
            maximum,
            timestamp,
            JSON.stringify(
              transclusions.sources.map((source) => ({
                blockId: source.blockId,
                content: JSON.stringify(source.content),
              })),
            ),
            pageId,
            epoch,
          ),
          this.bindings.DB.prepare(
            `DELETE FROM transclusion_sources WHERE page_id = ? AND projection_seq <> ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, maximum, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE transclusion_references SET projection_seq = -1 WHERE reference_page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO transclusion_references
              (reference_page_id, source_page_id, block_id, projection_seq)
             SELECT ?, source_page.id, json_extract(item.value, '$.blockId'), ?
               FROM json_each(?) item
               JOIN pages source_page ON source_page.id = json_extract(item.value, '$.sourcePageId')
              WHERE source_page.workspace_id = ?
                AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)
             ON CONFLICT(reference_page_id, source_page_id, block_id) DO UPDATE SET
               projection_seq = excluded.projection_seq`,
          ).bind(pageId, maximum, JSON.stringify(transclusions.references), page.workspace_id, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM transclusion_references WHERE reference_page_id = ? AND projection_seq <> ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, maximum, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE api_blocks SET deleted_at = ? WHERE page_id = ? AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(timestamp, pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO api_blocks
              (id, page_id, internal_id, content_hash, created_by, updated_by, created_at, updated_at, deleted_at)
             SELECT json_extract(item.value, '$.id'), ?, json_extract(item.value, '$.internalId'),
                    json_extract(item.value, '$.contentHash'), ?, ?, ?, ?, NULL
               FROM json_each(?) item
              WHERE EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)
             ON CONFLICT(page_id, internal_id) DO UPDATE SET
               content_hash = excluded.content_hash,
               updated_by = CASE WHEN api_blocks.content_hash <> excluded.content_hash
                                 THEN excluded.updated_by ELSE api_blocks.updated_by END,
               updated_at = CASE WHEN api_blocks.content_hash <> excluded.content_hash
                                 THEN excluded.updated_at ELSE api_blocks.updated_at END,
               deleted_at = NULL`,
          ).bind(
            pageId,
            metadataAtStart.last_editor_id,
            metadataAtStart.last_editor_id,
            timestamp,
            timestamp,
            JSON.stringify(blockMetadata),
            pageId,
            epoch,
          ),
          ...webhookEventStatements(this.bindings.DB, {
            workspaceId: page.workspace_id,
            type: "page.content_updated",
            entityType: "page",
            entityId: pageId,
            pageId,
            actorId: metadataAtStart.last_editor_id,
            sourceKey: `page.content_updated:${pageId}:${epoch}:${maximum}`,
            data: { sequence: maximum },
            createdAt: timestamp,
          }),
          ...notificationFanoutStatements(this.bindings.DB, {
            workspaceId: page.workspace_id,
            spaceId: page.space_id,
            pageId,
            threadId: null,
            actorId: metadataAtStart.last_editor_id ?? "",
            eventType: "mention",
            sourceId: `${pageId}:${epoch}:${maximum}`,
            recipientIds: metadataAtStart.notify_edit && metadataAtStart.last_editor_id ? newMentionIds : [],
            emitSlackChannel: Boolean(
              metadataAtStart.notify_edit && metadataAtStart.last_editor_id && newMentionIds.length,
            ),
            data: { sequence: maximum },
            createdAt: timestamp,
          }),
          ...notificationFanoutStatements(this.bindings.DB, {
            workspaceId: page.workspace_id,
            spaceId: page.space_id,
            pageId,
            threadId: null,
            actorId: metadataAtStart.last_editor_id ?? "",
            eventType: "page_edit",
            sourceId: `${pageId}:${epoch}:${maximum}`,
            recipientIds: metadataAtStart.notify_edit ? watcherIds : [],
            emitSlackChannel: Boolean(metadataAtStart.notify_edit && metadataAtStart.last_editor_id),
            data: { sequence: maximum },
            createdAt: timestamp,
          }),
        ];
        const currentPageTargetsIndex = statements.length;
        statements.push(
          this.bindings.DB.prepare(
            `SELECT target_page_id id FROM page_references
            WHERE source_page_id = ? AND projection_seq = ?`,
          ).bind(pageId, maximum),
        );
        const currentUserTargetsIndex = statements.length;
        statements.push(
          this.bindings.DB.prepare(
            `SELECT target_user_id id FROM member_mentions
            WHERE source_page_id = ? AND projection_seq = ?`,
          ).bind(pageId, maximum),
        );

        if (makeVersion) {
          const versionId = crypto.randomUUID();
          versionKey = this.versionKey(pageId, versionId);
          await this.bindings.BUCKET.put(versionKey, snapshot, {
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
          });
          versionAt = timestamp;
          versionStatementIndex = statements.length;
          statements.push(
            this.bindings.DB.prepare(
              `INSERT INTO page_versions
              (id, page_id, epoch, sequence, title, r2_key, byte_size, last_editor_id, created_at)
              SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM pages WHERE id = ? AND content_epoch = ?`,
            ).bind(
              versionId,
              epoch,
              maximum,
              page.title,
              versionKey,
              snapshot.byteLength,
              metadataAtStart.last_editor_id,
              versionAt,
              pageId,
              epoch,
            ),
          );
        }

        const results = await this.bindings.DB.batch(statements);
        pageProjected = Boolean(results[0]?.meta.changes);
        const superseded = supersededProjection?.r2_key;
        if (pageProjected && superseded && superseded !== structuredKey) {
          this.state.waitUntil(
            this.bindings.BUCKET.delete(superseded).catch((error: unknown) => {
              console.error("Failed to delete superseded document projection", { pageId, epoch, error });
            }),
          );
        }
        if (versionStatementIndex >= 0 && !results[versionStatementIndex]?.meta.changes && versionKey) {
          await this.bindings.BUCKET.delete(versionKey);
          versionKey = null;
          versionAt = metadataAtStart.last_version_at;
        }

        if (pageProjected) {
          this.state.waitUntil(
            sweepOutbox(this.bindings).catch((error) => console.error("Failed to enqueue webhook events", error)),
          );
          const currentPageTargets = (results[currentPageTargetsIndex]?.results as Array<{ id: string }>) ?? [];
          const currentUserTargets = (results[currentUserTargetsIndex]?.results as Array<{ id: string }>) ?? [];
          const backlinkTargetIds = [
            ...new Set([...oldPageTargets.results.map((row) => row.id), ...currentPageTargets.map((row) => row.id)]),
          ];
          const mentionTargetUserIds = [
            ...new Set([...oldUserTargets.results.map((row) => row.id), ...currentUserTargets.map((row) => row.id)]),
          ];
          this.state.waitUntil(
            broadcastWorkspaceEvent(this.bindings, page.workspace_id, {
              type: "projection-updated",
              pageId,
              backlinkTargetIds,
              mentionTargetUserIds,
            }).catch((error) => console.error("Failed to broadcast projection update", error)),
          );
          if (
            metadataAtStart.notify_edit &&
            metadataAtStart.last_editor_id &&
            (newMentionIds.length || watcherIds.length)
          ) {
            this.state.waitUntil(
              Promise.all([
                broadcastWorkspaceEvent(this.bindings, page.workspace_id, { type: "notifications-invalidated" }),
                sweepOutbox(this.bindings),
              ]).catch((error) => console.error("Failed to enqueue document notifications", error)),
            );
          }
        }
      }

      // R2 was durable before the log is acknowledged. Replaying duplicate Yjs
      // updates after a crash between these two steps is safe.
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(`DELETE FROM update_chunks WHERE seq <= ?`, maximum);
        this.state.storage.sql.exec(`DELETE FROM update_events WHERE seq <= ?`, maximum);
        this.state.storage.sql.exec(
          `UPDATE document_meta SET snapshot_seq = ?, last_version_at = ? WHERE id = 1`,
          maximum,
          versionAt,
        );
      });
      this.metadata.snapshot_seq = maximum;
      this.metadata.last_version_at = versionAt;

      if (pageProjected && versionKey) {
        this.state.waitUntil(
          this.pruneVersions(pageId).catch((error) => {
            console.error("Failed to prune document versions", error);
          }),
        );
      }
    } catch (error) {
      this.metadata.dirty = 1;
      if (metadataAtStart.notify_edit) this.metadata.notify_edit = 1;
      this.state.storage.sql.exec(
        `UPDATE document_meta SET dirty = 1, notify_edit = CASE WHEN ? THEN 1 ELSE notify_edit END WHERE id = 1`,
        metadataAtStart.notify_edit ? 1 : 0,
      );
      try {
        await this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS);
      } catch (alarmError) {
        console.error("Failed to schedule compaction retry", alarmError);
      }
      throw error;
    }
  }

  private async compactDiagram(maximum: number, forceVersion: boolean) {
    const { pageId, epoch } = this.ids;
    const metadataAtStart = { ...this.metadata };
    const snapshot = Y.encodeStateAsUpdate(this.document);
    const envelope = diagramFromYDoc(this.document, { pageId, contentEpoch: epoch, sequence: maximum });
    const projection = projectDiagram(envelope);
    const structuredJson = canonicalJson(envelope);
    const structuredBytes = new TextEncoder().encode(structuredJson);
    const structuredKey = this.projectionKey(pageId, epoch, maximum);
    const thumbnailSvg = renderDiagramSvg(envelope, { width: 960, height: 540 });
    const thumbnailBytes = new TextEncoder().encode(thumbnailSvg);
    const thumbnailKey = this.thumbnailKey(pageId, epoch, maximum);
    const readOnly = snapshot.byteLength >= READ_ONLY_BYTES;

    if (snapshot.byteLength >= WARN_BYTES) {
      this.broadcastCustomMessage(JSON.stringify({ type: "document-size", bytes: snapshot.byteLength, readOnly }));
    }

    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE document_meta
            SET dirty = 0, notify_edit = 0, snapshot_bytes = ?, read_only = CASE WHEN ? THEN 1 ELSE read_only END
          WHERE id = 1`,
        snapshot.byteLength,
        readOnly ? 1 : 0,
      );
    });
    this.metadata.dirty = 0;
    this.metadata.notify_edit = 0;
    this.metadata.snapshot_bytes = snapshot.byteLength;
    if (readOnly) this.metadata.read_only = 1;

    try {
      const [structuredHash, thumbnailHash] = await Promise.all([sha256Hex(structuredJson), sha256Hex(thumbnailSvg)]);
      await Promise.all([
        this.bindings.BUCKET.put(this.snapshotKey(pageId, epoch), snapshot, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
        }),
        this.bindings.BUCKET.put(structuredKey, structuredBytes, {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
          customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum), contentHash: structuredHash },
        }),
        this.bindings.BUCKET.put(thumbnailKey, thumbnailBytes, {
          httpMetadata: { contentType: "image/svg+xml; charset=utf-8" },
          customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum), contentHash: thumbnailHash },
        }),
      ]);

      const page = await this.bindings.DB.prepare(
        `SELECT workspace_id, space_id, title, archived_at FROM pages WHERE id = ? AND content_epoch = ?`,
      )
        .bind(pageId, epoch)
        .first<PageProjectionRow>();
      const supersededProjection = await this.bindings.DB.prepare(
        `SELECT r2_key, thumbnail_r2_key FROM diagram_projections WHERE page_id = ?`,
      )
        .bind(pageId)
        .first<{ r2_key: string; thumbnail_r2_key: string }>();
      let versionAt = metadataAtStart.last_version_at;
      let versionKey: string | null = null;
      let versionStatementIndex = -1;
      let pageProjected = false;

      if (page) {
        const [oldPageTargets, oldUserTargets, watcherRows] = await Promise.all([
          this.bindings.DB.prepare(`SELECT target_page_id id FROM page_references WHERE source_page_id = ?`)
            .bind(pageId)
            .all<{ id: string }>(),
          this.bindings.DB.prepare(`SELECT target_user_id id FROM member_mentions WHERE source_page_id = ?`)
            .bind(pageId)
            .all<{ id: string }>(),
          metadataAtStart.notify_edit && metadataAtStart.last_editor_id
            ? this.bindings.DB.prepare(
                `SELECT user_id id FROM subscriptions
                  WHERE resource_type = 'page' AND resource_id = ? AND muted_at IS NULL
                 UNION
                SELECT space_watch.user_id id FROM subscriptions space_watch
                  WHERE space_watch.resource_type = 'space' AND space_watch.resource_id = ?
                    AND space_watch.muted_at IS NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM subscriptions page_override
                       WHERE page_override.user_id = space_watch.user_id
                         AND page_override.resource_type = 'page' AND page_override.resource_id = ?
                    )`,
              )
                .bind(pageId, page.space_id, pageId)
                .all<{ id: string }>()
            : Promise.resolve({ results: [] as Array<{ id: string }> }),
        ]);
        const timestamp = Date.now();
        const oldMentionIds = new Set(oldUserTargets.results.map((row) => row.id));
        const newMentionIds = projection.memberMentions
          .map((mention) => mention.targetId)
          .filter((id) => !oldMentionIds.has(id));
        const watcherIds = watcherRows.results.map((row) => row.id).filter((id) => !newMentionIds.includes(id));
        const makeVersion = Boolean(
          forceVersion ||
          !metadataAtStart.last_version_at ||
          timestamp - metadataAtStart.last_version_at >= VERSION_INTERVAL_MS,
        );
        const statements = [
          this.bindings.DB.prepare(
            `UPDATE pages SET plain_text = ?, indexed_seq = ?, oversized = ?, updated_at = ?,
                 updated_by = COALESCE(?, updated_by)
              WHERE id = ? AND content_epoch = ?`,
          ).bind(
            projection.plainText,
            maximum,
            readOnly ? 1 : 0,
            timestamp,
            metadataAtStart.last_editor_id,
            pageId,
            epoch,
          ),
          this.bindings.DB.prepare(
            `INSERT INTO diagram_projections
              (page_id, content_epoch, sequence, schema_version, r2_key, content_hash, byte_size,
               thumbnail_r2_key, thumbnail_hash, thumbnail_byte_size, updated_at)
             SELECT id, ?, ?, 1, ?, ?, ?, ?, ?, ?, ? FROM pages
              WHERE id = ? AND content_epoch = ? AND kind = 'diagram'
             ON CONFLICT(page_id) DO UPDATE SET
              content_epoch = excluded.content_epoch,
              sequence = excluded.sequence,
              schema_version = excluded.schema_version,
              r2_key = excluded.r2_key,
              content_hash = excluded.content_hash,
              byte_size = excluded.byte_size,
              thumbnail_r2_key = excluded.thumbnail_r2_key,
              thumbnail_hash = excluded.thumbnail_hash,
              thumbnail_byte_size = excluded.thumbnail_byte_size,
              updated_at = excluded.updated_at`,
          ).bind(
            epoch,
            maximum,
            structuredKey,
            structuredHash,
            structuredBytes.byteLength,
            thumbnailKey,
            thumbnailHash,
            thumbnailBytes.byteLength,
            timestamp,
            pageId,
            epoch,
          ),
          this.bindings.DB.prepare(
            `DELETE FROM page_search WHERE page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO page_search (page_id, workspace_id, title, body)
              SELECT id, workspace_id, title, ? FROM pages
               WHERE id = ? AND content_epoch = ? AND archived_at IS NULL AND import_job_id IS NULL`,
          ).bind(projection.plainText, pageId, epoch),
          ...refreshPageSearchV2Statements(this.bindings.DB, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE page_references SET projection_seq = -1 WHERE source_page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO page_references (source_page_id, target_page_id, excerpt, projection_seq)
              SELECT ?, target.id, json_extract(item.value, '$.excerpt'), ?
                FROM json_each(?) item
                JOIN pages target ON target.id = json_extract(item.value, '$.targetId')
               WHERE target.workspace_id = ? AND target.archived_at IS NULL AND target.id <> ?
                 AND EXISTS (SELECT 1 FROM pages source WHERE source.id = ? AND source.content_epoch = ?)
              ON CONFLICT(source_page_id, target_page_id) DO UPDATE SET
                excerpt = excluded.excerpt, projection_seq = excluded.projection_seq`,
          ).bind(pageId, maximum, JSON.stringify(projection.pageReferences), page.workspace_id, pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM page_references WHERE source_page_id = ? AND projection_seq <> ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, maximum, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE member_mentions SET projection_seq = -1 WHERE source_page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO member_mentions
              (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
              SELECT ?, ?, member.user_id, json_extract(item.value, '$.excerpt'), ?, ?
                FROM json_each(?) item
                JOIN workspace_members member
                  ON member.workspace_id = ? AND member.user_id = json_extract(item.value, '$.targetId')
               WHERE EXISTS (SELECT 1 FROM pages source WHERE source.id = ? AND source.content_epoch = ?)
              ON CONFLICT(source_page_id, target_user_id) DO UPDATE SET
                excerpt = excluded.excerpt, projection_seq = excluded.projection_seq`,
          ).bind(
            page.workspace_id,
            pageId,
            timestamp,
            maximum,
            JSON.stringify(projection.memberMentions),
            page.workspace_id,
            pageId,
            epoch,
          ),
          this.bindings.DB.prepare(
            `DELETE FROM member_mentions WHERE source_page_id = ? AND projection_seq <> ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, maximum, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM transclusion_sources WHERE page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM transclusion_references WHERE reference_page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `UPDATE api_blocks SET deleted_at = ? WHERE page_id = ? AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(timestamp, pageId, pageId, epoch),
          ...webhookEventStatements(this.bindings.DB, {
            workspaceId: page.workspace_id,
            type: "page.content_updated",
            entityType: "page",
            entityId: pageId,
            pageId,
            actorId: metadataAtStart.last_editor_id,
            sourceKey: `page.content_updated:${pageId}:${epoch}:${maximum}`,
            data: { sequence: maximum },
            createdAt: timestamp,
          }),
          ...notificationFanoutStatements(this.bindings.DB, {
            workspaceId: page.workspace_id,
            spaceId: page.space_id,
            pageId,
            threadId: null,
            actorId: metadataAtStart.last_editor_id ?? "",
            eventType: "mention",
            sourceId: `${pageId}:${epoch}:${maximum}`,
            recipientIds: metadataAtStart.notify_edit && metadataAtStart.last_editor_id ? newMentionIds : [],
            emitSlackChannel: Boolean(
              metadataAtStart.notify_edit && metadataAtStart.last_editor_id && newMentionIds.length,
            ),
            data: { sequence: maximum },
            createdAt: timestamp,
          }),
          ...notificationFanoutStatements(this.bindings.DB, {
            workspaceId: page.workspace_id,
            spaceId: page.space_id,
            pageId,
            threadId: null,
            actorId: metadataAtStart.last_editor_id ?? "",
            eventType: "page_edit",
            sourceId: `${pageId}:${epoch}:${maximum}`,
            recipientIds: metadataAtStart.notify_edit ? watcherIds : [],
            emitSlackChannel: Boolean(metadataAtStart.notify_edit && metadataAtStart.last_editor_id),
            data: { sequence: maximum },
            createdAt: timestamp,
          }),
        ];
        const currentPageTargetsIndex = statements.length;
        statements.push(
          this.bindings.DB.prepare(
            `SELECT target_page_id id FROM page_references WHERE source_page_id = ? AND projection_seq = ?`,
          ).bind(pageId, maximum),
        );
        const currentUserTargetsIndex = statements.length;
        statements.push(
          this.bindings.DB.prepare(
            `SELECT target_user_id id FROM member_mentions WHERE source_page_id = ? AND projection_seq = ?`,
          ).bind(pageId, maximum),
        );

        if (makeVersion) {
          const versionId = crypto.randomUUID();
          versionKey = this.versionKey(pageId, versionId);
          await this.bindings.BUCKET.put(versionKey, snapshot, {
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
          });
          versionAt = timestamp;
          versionStatementIndex = statements.length;
          statements.push(
            this.bindings.DB.prepare(
              `INSERT INTO page_versions
                (id, page_id, epoch, sequence, title, r2_key, byte_size, last_editor_id, created_at)
               SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM pages WHERE id = ? AND content_epoch = ?`,
            ).bind(
              versionId,
              epoch,
              maximum,
              page.title,
              versionKey,
              snapshot.byteLength,
              metadataAtStart.last_editor_id,
              versionAt,
              pageId,
              epoch,
            ),
          );
        }

        const results = await this.bindings.DB.batch(statements);
        pageProjected = Boolean(results[0]?.meta.changes);
        if (pageProjected) {
          const oldObjects = [supersededProjection?.r2_key, supersededProjection?.thumbnail_r2_key].filter(
            (key): key is string => Boolean(key && key !== structuredKey && key !== thumbnailKey),
          );
          if (oldObjects.length) {
            this.state.waitUntil(
              this.bindings.BUCKET.delete(oldObjects).catch((error: unknown) => {
                console.error("Failed to delete superseded diagram projection", { pageId, epoch, error });
              }),
            );
          }
        }
        if (versionStatementIndex >= 0 && !results[versionStatementIndex]?.meta.changes && versionKey) {
          await this.bindings.BUCKET.delete(versionKey);
          versionKey = null;
          versionAt = metadataAtStart.last_version_at;
        }

        if (pageProjected) {
          this.state.waitUntil(
            sweepOutbox(this.bindings).catch((error) => console.error("Failed to enqueue webhook events", error)),
          );
          const currentPageTargets = (results[currentPageTargetsIndex]?.results as Array<{ id: string }>) ?? [];
          const currentUserTargets = (results[currentUserTargetsIndex]?.results as Array<{ id: string }>) ?? [];
          const backlinkTargetIds = [
            ...new Set([...oldPageTargets.results.map((row) => row.id), ...currentPageTargets.map((row) => row.id)]),
          ];
          const mentionTargetUserIds = [
            ...new Set([...oldUserTargets.results.map((row) => row.id), ...currentUserTargets.map((row) => row.id)]),
          ];
          this.state.waitUntil(
            broadcastWorkspaceEvent(this.bindings, page.workspace_id, {
              type: "projection-updated",
              pageId,
              backlinkTargetIds,
              mentionTargetUserIds,
            }).catch((error) => console.error("Failed to broadcast diagram projection update", error)),
          );
          if (
            metadataAtStart.notify_edit &&
            metadataAtStart.last_editor_id &&
            (newMentionIds.length || watcherIds.length)
          ) {
            this.state.waitUntil(
              Promise.all([
                broadcastWorkspaceEvent(this.bindings, page.workspace_id, { type: "notifications-invalidated" }),
                sweepOutbox(this.bindings),
              ]).catch((error) => console.error("Failed to enqueue diagram notifications", error)),
            );
          }
        }
      }

      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(`DELETE FROM update_chunks WHERE seq <= ?`, maximum);
        this.state.storage.sql.exec(`DELETE FROM update_events WHERE seq <= ?`, maximum);
        this.state.storage.sql.exec(
          `UPDATE document_meta SET snapshot_seq = ?, last_version_at = ? WHERE id = 1`,
          maximum,
          versionAt,
        );
      });
      this.metadata.snapshot_seq = maximum;
      this.metadata.last_version_at = versionAt;
      if (pageProjected && versionKey) {
        this.state.waitUntil(
          this.pruneVersions(pageId).catch((error) => console.error("Failed to prune diagram versions", error)),
        );
      }
    } catch (error) {
      this.metadata.dirty = 1;
      if (metadataAtStart.notify_edit) this.metadata.notify_edit = 1;
      this.state.storage.sql.exec(
        `UPDATE document_meta SET dirty = 1, notify_edit = CASE WHEN ? THEN 1 ELSE notify_edit END WHERE id = 1`,
        metadataAtStart.notify_edit ? 1 : 0,
      );
      try {
        await this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS);
      } catch (alarmError) {
        console.error("Failed to schedule diagram compaction retry", alarmError);
      }
      throw error;
    }
  }

  private async pruneVersions(pageId: string) {
    const cutoff = Date.now() - VERSION_RETENTION_MS;
    const versions = await this.bindings.DB.prepare(
      `SELECT id, r2_key, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC`,
    )
      .bind(pageId)
      .all<{ id: string; r2_key: string; created_at: number }>();
    const expired = versions.results.filter((version, index) => index >= 200 || version.created_at < cutoff);
    for (const version of expired) {
      await this.bindings.DB.prepare(`DELETE FROM page_versions WHERE id = ?`).bind(version.id).run();
      await this.bindings.BUCKET.delete(version.r2_key);
    }
  }

  private restoreRecovery() {
    return (
      this.state.storage.sql
        .exec<RestoreRecoveryRow>(`SELECT old_epoch, new_epoch, new_key, pre_key FROM restore_recovery WHERE id = 1`)
        .toArray()[0] ?? null
    );
  }

  private recordRestoreRecovery(recovery: RestoreRecoveryRow) {
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO restore_recovery
          (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, ?, ?, ?, ?)`,
        recovery.old_epoch,
        recovery.new_epoch,
        recovery.new_key,
        recovery.pre_key,
      );
      this.state.storage.sql.exec(
        `UPDATE document_meta SET restore_pending = 1, restore_attempts = 0, restore_retry_at = 0 WHERE id = 1`,
      );
      this.metadata.restore_pending = 1;
      this.metadata.restore_attempts = 0;
      this.metadata.restore_retry_at = 0;
    });
  }

  private clearRestoreRecovery(retired: boolean) {
    if (this.purged) return;
    const retiredFlag = retired ? 1 : 0;
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE document_meta SET retired = ?, restore_pending = 0, restore_attempts = 0, restore_retry_at = 0 WHERE id = 1`,
        retiredFlag,
      );
      this.state.storage.sql.exec(`DELETE FROM restore_recovery WHERE id = 1`);
      this.metadata.retired = retiredFlag;
      this.metadata.restore_pending = 0;
      this.metadata.restore_attempts = 0;
      this.metadata.restore_retry_at = 0;
    });
  }

  private async deleteRestoreObjects(recovery: Pick<RestoreRecoveryRow, "new_key" | "pre_key">) {
    const results = await Promise.allSettled([
      this.bindings.BUCKET.delete(recovery.new_key),
      ...(recovery.pre_key ? [this.bindings.BUCKET.delete(recovery.pre_key)] : []),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async deferRestoreReconciliation(error: unknown) {
    console.error("Failed to reconcile pending document restore", error);
    // A purge can land during the dependency call that just failed; its
    // storage is gone, so there is nothing left to record or arm.
    if (this.purged) return;
    // The attempt count and the time the next one is due live in SQLite because
    // this object hibernates: in-memory state would reset to the fast first
    // retry on every eviction, which is exactly when a long outage keeps
    // evicting it. The due time is also what stops one alarm delivery from
    // reconciling twice; see onAlarm.
    const attempt = this.metadata.restore_attempts;
    const retryAt = Date.now() + jitteredBackoff(attempt, ALARM_RETRY_DELAY_MS, RESTORE_RECONCILIATION_MAX_DELAY_MS);
    try {
      this.state.storage.sql.exec(
        `UPDATE document_meta SET restore_attempts = ?, restore_retry_at = ? WHERE id = 1`,
        attempt + 1,
        retryAt,
      );
      this.metadata.restore_attempts = attempt + 1;
      this.metadata.restore_retry_at = retryAt;
    } catch (storageError) {
      console.error("Failed to record restore reconciliation attempt", storageError);
    }
    // Remember the backoff so finishTransition does not pull the alarm forward
    // and retry immediately against the dependency that just failed.
    if (this.transition) this.transitionRetryAt = Math.max(this.transitionRetryAt ?? 0, retryAt);
    await this.armRestoreRetry(retryAt);
  }

  // While a restore is pending the alarm only ever reconciles, so the retry
  // replaces whatever alarm is stored: an earlier one would fire before the
  // backoff, a later one (connection expiry, compaction) would delay it.
  private async armRestoreRetry(retryAt: number) {
    try {
      await this.state.storage.setAlarm(retryAt);
    } catch (alarmError) {
      console.error("Failed to schedule restore reconciliation", alarmError);
    }
  }

  private async reconcilePendingRestore() {
    const recovery = this.restoreRecovery();
    const { pageId, epoch } = this.ids;
    let current: { content_epoch: number } | null;
    try {
      current = await this.bindings.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
        .bind(pageId)
        .first<{ content_epoch: number }>();
    } catch (error) {
      await this.deferRestoreReconciliation(error);
      return false;
    }
    if (this.purged) return false;

    if (!recovery) {
      this.clearRestoreRecovery(!current || current.content_epoch !== epoch);
      return true;
    }

    if (current?.content_epoch === recovery.old_epoch) {
      try {
        await this.deleteRestoreObjects(recovery);
      } catch (error) {
        await this.deferRestoreReconciliation(error);
        return false;
      }
      if (this.purged) return false;
      this.clearRestoreRecovery(false);
      return true;
    }

    try {
      if (!current) {
        await this.deleteRestoreObjects(recovery);
      } else if (current.content_epoch > recovery.new_epoch) {
        // The pre-restore version may still be referenced by page_versions, but
        // a superseded epoch snapshot is no longer reachable from D1.
        await this.deleteRestoreObjects({ new_key: recovery.new_key, pre_key: null });
      }
    } catch (error) {
      await this.deferRestoreReconciliation(error);
      return false;
    }
    if (this.purged) return false;

    // At the committed new epoch, the epoch snapshot is current and the
    // pre-restore version may be referenced by page_versions.
    this.clearRestoreRecovery(true);
    return true;
  }

  private async restoreVersion(versionId: string, userId: string) {
    if (
      this.validatingTransition ||
      this.transition ||
      this.metadata.restore_pending ||
      this.metadata.retired ||
      this.purged
    ) {
      return Response.json({ error: "Document transition already in progress." }, { status: 409 });
    }
    this.validatingTransition = true;
    try {
      const { pageId, epoch } = this.ids;
      let selectedBytes: Uint8Array;
      try {
        const version = await this.bindings.DB.prepare(`SELECT r2_key FROM page_versions WHERE id = ? AND page_id = ?`)
          .bind(versionId, pageId)
          .first<{ r2_key: string }>();
        if (!version) return Response.json({ error: "Version not found." }, { status: 404 });
        const selected = await this.bindings.BUCKET.get(version.r2_key);
        if (!selected) return Response.json({ error: "Version snapshot is missing." }, { status: 404 });
        selectedBytes = new Uint8Array(await selected.arrayBuffer());
      } catch (error) {
        console.error("Document restore validation failed", error);
        return Response.json({ error: "The version could not be restored." }, { status: 503 });
      }

      if (this.transition || this.metadata.restore_pending || this.metadata.retired || this.purged) {
        return Response.json({ error: "Document transition already in progress." }, { status: 409 });
      }
      this.transition = "restore";
      this.validatingTransition = false;
      const newEpoch = epoch + 1;
      const newKey = this.snapshotKey(pageId, newEpoch);
      let preKey: string | null = null;
      let commitState: "committed" | "not-committed" | "unknown" = "unknown";
      const markRestoreCommitted = () => {
        try {
          this.clearRestoreRecovery(true);
        } catch (error) {
          // D1 is authoritative for routing. A restarted old room also reconciles
          // its retired state from the committed epoch before accepting clients.
          console.error("Failed to persist retired document state", error);
        }
      };
      const cleanupUncommittedRestore = async () => {
        try {
          await this.deleteRestoreObjects({ new_key: newKey, pre_key: preKey });
          this.clearRestoreRecovery(false);
        } catch (error) {
          await this.deferRestoreReconciliation(error);
        }
      };
      try {
        for (const connection of this.getConnections()) {
          connection.close(4410, "A restored version replaced this document.");
        }
        this.flushPendingUpdates();

        const hadPendingLog = Boolean(this.metadata.dirty);
        if (hadPendingLog) await this.compact(true);

        const statements: D1PreparedStatement[] = [];
        let preVersion: { id: string; snapshot: Uint8Array } | null = null;
        if (!hadPendingLog) {
          const currentSnapshot = Y.encodeStateAsUpdate(this.document);
          const preId = crypto.randomUUID();
          preKey = this.versionKey(pageId, preId);
          preVersion = { id: preId, snapshot: currentSnapshot };
        }

        this.recordRestoreRecovery({
          old_epoch: epoch,
          new_epoch: newEpoch,
          new_key: newKey,
          pre_key: preKey,
        });
        if (preVersion && preKey) {
          await this.bindings.BUCKET.put(preKey, preVersion.snapshot, {
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: { pageId, epoch: String(epoch), sequence: String(this.metadata.snapshot_seq) },
          });
          statements.push(
            this.bindings.DB.prepare(
              `INSERT INTO page_versions
              (id, page_id, epoch, sequence, title, r2_key, byte_size, last_editor_id, created_at)
             SELECT ?, id, ?, ?, title, ?, ?, ?, ? FROM pages
              WHERE id = ? AND content_epoch = ? AND archived_at IS NULL`,
            ).bind(
              preVersion.id,
              epoch,
              this.metadata.snapshot_seq,
              preKey,
              preVersion.snapshot.byteLength,
              userId,
              Date.now(),
              pageId,
              epoch,
            ),
          );
        }

        await this.bindings.BUCKET.put(newKey, selectedBytes, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { pageId, epoch: String(newEpoch), restoredFrom: versionId },
        });
        statements.push(
          this.bindings.DB.prepare(
            `UPDATE pages
              SET content_epoch = ?, revision = revision + 1, indexed_seq = 0, updated_at = ?
            WHERE id = ? AND content_epoch = ? AND archived_at IS NULL`,
          ).bind(newEpoch, Date.now(), pageId, epoch),
        );
        const results = await this.bindings.DB.batch(statements);
        if (!results.at(-1)?.meta.changes) {
          commitState = "not-committed";
          await cleanupUncommittedRestore();
          return Response.json({ error: "The page epoch changed during restore." }, { status: 409 });
        }
        commitState = "committed";
        markRestoreCommitted();
        return Response.json({ pageId, contentEpoch: newEpoch });
      } catch (error) {
        if (commitState === "unknown") {
          try {
            const current = await this.bindings.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
              .bind(pageId)
              .first<{ content_epoch: number }>();
            if (current?.content_epoch === newEpoch) commitState = "committed";
            else if (current?.content_epoch === epoch) commitState = "not-committed";
          } catch (lookupError) {
            console.error("Failed to confirm restore commit state", lookupError);
          }
        }
        if (commitState === "not-committed") {
          await cleanupUncommittedRestore();
        } else if (commitState === "committed") {
          markRestoreCommitted();
        } else {
          await this.deferRestoreReconciliation(error);
        }
        console.error("Document restore failed", error);
        return Response.json({ error: "The version could not be restored." }, { status: 503 });
      } finally {
        await this.finishTransition();
      }
    } finally {
      this.validatingTransition = false;
    }
  }

  private snapshotKey(pageId: string, epoch: number) {
    return `${this.metadata.content_kind === "diagram" ? "diagrams" : "documents"}/${pageId}/epochs/${epoch}/current.bin`;
  }

  private projectionKey(pageId: string, epoch: number, sequence: number) {
    return `${this.metadata.content_kind === "diagram" ? "diagrams" : "documents"}/${pageId}/epochs/${epoch}/projections/${sequence}.json`;
  }

  private thumbnailKey(pageId: string, epoch: number, sequence: number) {
    return `diagrams/${pageId}/epochs/${epoch}/thumbnails/${sequence}.svg`;
  }

  private versionKey(pageId: string, versionId: string) {
    return `${this.metadata.content_kind === "diagram" ? "diagrams" : "documents"}/${pageId}/versions/${versionId}.bin`;
  }

  private async finishTransition() {
    this.transition = null;
    const retryAt = this.transitionRetryAt;
    this.transitionRetryAt = null;
    const alarmWasDeferred = this.transitionAlarmDeferred;
    this.transitionAlarmDeferred = false;
    if (this.purged) return;
    if (alarmWasDeferred) await this.transitionAlarmRearm?.catch(() => undefined);
    try {
      // A transition retry must move any existing alarm out to its backoff even
      // when that earlier alarm never fired during the transition. Otherwise a
      // pre-existing alarm can immediately retry the dependency that just failed.
      if (retryAt !== null) await this.deferAlarm(retryAt);
      else if (alarmWasDeferred) await this.scheduleAlarm(Date.now());
    } catch (error) {
      console.error("Failed to resume document alarm after transition", error);
    }
  }

  private async scheduleAlarm(when: number) {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || when < existing) await this.state.storage.setAlarm(when);
  }

  // The mirror of scheduleAlarm: a backoff has to hold even when an earlier
  // alarm is already pending or overdue, so this only ever moves the alarm out.
  private async deferAlarm(when: number) {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing < when) await this.state.storage.setAlarm(when);
  }
}
