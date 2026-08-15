import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { projectDocument, type ProseMirrorJson } from "../shared/document-projection";
import { joinBytes, splitBytes } from "../shared/bytes";
import type { Env } from "./env";
import { broadcastWorkspaceEvent } from "./workspace-events";

const COMPACTION_DELAY_MS = 30_000;
const VERSION_INTERVAL_MS = 15 * 60_000;
const VERSION_RETENTION_MS = 30 * 24 * 60 * 60_000;
const WARN_BYTES = 16 * 1024 * 1024;
const READ_ONLY_BYTES = 24 * 1024 * 1024;

interface ConnectionAuth {
  userId: string;
  role: "owner" | "editor" | "viewer";
  expiresAt: number;
  __ypsAwarenessIds?: number[];
}

interface MetaRow extends Record<string, SqlStorageValue> {
  snapshot_seq: number;
  snapshot_bytes: number;
  dirty: number;
  retired: number;
  restore_pending: number;
  read_only: number;
  last_version_at: number;
  last_editor_id: string | null;
}

interface PageProjectionRow {
  workspace_id: string;
  title: string;
  archived_at: number | null;
}

export class Document extends YServer {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1_000, debounceMaxWait: 5_000 };

  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private metadata!: MetaRow;
  private pendingUpdates: Uint8Array[] = [];
  private pendingAuthorId: string | null = null;
  private purged = false;
  private transition: "archive" | "restore" | null = null;
  private restoreValidation = false;
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
      read_only INTEGER NOT NULL DEFAULT 0,
      last_version_at INTEGER NOT NULL DEFAULT 0,
      last_editor_id TEXT
    )`);
    const metaColumns = sql.exec<{ name: string }>(`PRAGMA table_info(document_meta)`).toArray();
    if (!metaColumns.some((column) => column.name === "snapshot_bytes")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN snapshot_bytes INTEGER NOT NULL DEFAULT 0`);
    }
    if (!metaColumns.some((column) => column.name === "restore_pending")) {
      sql.exec(`ALTER TABLE document_meta ADD COLUMN restore_pending INTEGER NOT NULL DEFAULT 0`);
    }
    const hadMetadata = Boolean(sql.exec<{ present: number }>(
      `SELECT EXISTS(SELECT 1 FROM document_meta WHERE id = 1) present`,
    ).one().present);
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
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_update_chunks_seq ON update_chunks(seq, chunk_index)`);
    this.metadata = sql.exec<MetaRow>(`SELECT * FROM document_meta WHERE id = 1`).one();

    // Normal hibernation wakes stay independent of D1. New state still needs
    // an authoritative check so a purged room cannot restart without its tombstone.
    if (!hadMetadata || this.metadata.restore_pending) {
      const { pageId, epoch } = this.ids;
      const current = await this.bindings.DB.prepare(
        `SELECT content_epoch FROM pages WHERE id = ?`,
      ).bind(pageId).first<{ content_epoch: number }>();
      this.metadata.retired = !current || current.content_epoch !== epoch ? 1 : 0;
      this.metadata.restore_pending = 0;
      sql.exec(
        `UPDATE document_meta
            SET retired = ?, restore_pending = 0
          WHERE id = 1`,
        this.metadata.retired,
      );
    }

    await super.onStart();
    this.document.on("update", (update: Uint8Array, origin: unknown) => {
      this.bufferUpdate(update, origin as Connection<ConnectionAuth> | null);
    });
    const pendingLog = sql.exec<{ pending: number }>(
      `SELECT EXISTS(SELECT 1 FROM update_events WHERE seq > ?) pending`,
      this.metadata.snapshot_seq,
    ).one().pending;
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
    if (snapshot) Y.applyUpdate(doc, new Uint8Array(await snapshot.arrayBuffer()));

    const events = this.state.storage.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM update_events WHERE seq > ? ORDER BY seq`,
        this.metadata.snapshot_seq,
      )
      .toArray();
    for (const event of events) {
      const chunks = this.state.storage.sql
        .exec<{ data: ArrayBuffer }>(
          `SELECT data FROM update_chunks WHERE seq = ? ORDER BY chunk_index`,
          event.seq,
        )
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
      this.sendCustomMessage(connection, JSON.stringify({
        type: "document-size",
        bytes: this.metadata.snapshot_bytes || READ_ONLY_BYTES,
        readOnly: Boolean(this.metadata.read_only),
      }));
    }
  }

  isReadOnly(connection: Connection<ConnectionAuth>) {
    return Boolean(
      this.metadata.retired ||
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
    if (this.metadata.retired || this.purged || this.transition === "restore") {
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
    if (value.type !== "document-update-barrier"
      || !Number.isInteger(value.generation)
      || Number(value.generation) < 1
      || this.isReadOnly(connection)) return;
    // Client custom messages share the WebSocket's ordering with Yjs updates.
    // Reaching this barrier means every preceding update from that client has
    // been applied; flushing before the reply turns the reply into a durable ack.
    this.flushPendingUpdates();
    this.sendCustomMessage(connection, JSON.stringify({
      type: "document-update-ack",
      generation: value.generation,
    }));
  }

  async onSave() {
    if (this.purged) return;
    this.flushPendingUpdates();
    if (this.metadata.dirty) await this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS);
  }

  async onAlarm() {
    if (this.purged) return;
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
    if (request.method === "POST" && url.pathname.endsWith("/archive")) {
      if (this.restoreValidation || this.transition) {
        return Response.json({ error: "Document transition already in progress." }, { status: 409 });
      }
      const { pageId, epoch } = this.ids;
      const page = await this.bindings.DB.prepare(
        `SELECT content_epoch, archived_at FROM pages WHERE id = ?`,
      ).bind(pageId).first<{ content_epoch: number; archived_at: number | null }>();
      if (!page || page.content_epoch !== epoch || page.archived_at === null) {
        return Response.json(
          { error: "The page is no longer archived.", code: "archive_no_longer_applicable" },
          { status: 410 },
        );
      }
      if (this.restoreValidation || this.transition || this.metadata.retired || this.purged) {
        return Response.json({ error: "Document transition already in progress." }, { status: 409 });
      }
      this.transition = "archive";
      try {
        for (const connection of this.getConnections()) {
          connection.close(4412, "This page was archived.");
        }
        this.flushPendingUpdates();
        if (this.metadata.dirty) await this.compact(true);
        return Response.json({ archived: true });
      } finally {
        this.transition = null;
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
    if (this.metadata.retired || this.purged || this.transition) return;
    this.pendingUpdates.push(update);
    this.pendingAuthorId = origin?.state?.userId ?? this.pendingAuthorId;
  }

  private flushPendingUpdates() {
    if (!this.pendingUpdates.length || this.purged) return;
    const updates = this.pendingUpdates;
    const authorId = this.pendingAuthorId;
    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
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
        `UPDATE document_meta SET dirty = 1, last_editor_id = COALESCE(?, last_editor_id) WHERE id = 1`,
        authorId,
      );
    });
    this.pendingUpdates = [];
    this.pendingAuthorId = null;
    this.metadata.dirty = 1;
    if (authorId) this.metadata.last_editor_id = authorId;
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

    const metadataAtStart = { ...this.metadata };
    const snapshot = Y.encodeStateAsUpdate(this.document);
    const json = yXmlFragmentToProsemirrorJSON(
      this.document.getXmlFragment("document-store"),
    ) as ProseMirrorJson;
    const projection = projectDocument(json);
    const readOnly = snapshot.byteLength >= READ_ONLY_BYTES;
    if (snapshot.byteLength >= WARN_BYTES) {
      this.broadcastCustomMessage(JSON.stringify({
        type: "document-size",
        bytes: snapshot.byteLength,
        readOnly,
      }));
    }

    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE document_meta
            SET dirty = 0, snapshot_bytes = ?, read_only = CASE WHEN ? THEN 1 ELSE read_only END
          WHERE id = 1`,
        snapshot.byteLength,
        readOnly ? 1 : 0,
      );
    });
    this.metadata.dirty = 0;
    this.metadata.snapshot_bytes = snapshot.byteLength;
    if (readOnly) this.metadata.read_only = 1;

    try {
      await this.bindings.BUCKET.put(this.snapshotKey(pageId, epoch), snapshot, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
      });

      const page = await this.bindings.DB.prepare(
        `SELECT workspace_id, title, archived_at FROM pages WHERE id = ? AND content_epoch = ?`,
      ).bind(pageId, epoch).first<PageProjectionRow>();
      let versionAt = metadataAtStart.last_version_at;
      let versionKey: string | null = null;
      let versionStatementIndex = -1;
      let pageProjected = false;

      if (page) {
        const [oldPageTargets, oldUserTargets] = await Promise.all([
          this.bindings.DB.prepare(
            `SELECT target_page_id id FROM page_references WHERE source_page_id = ?`,
          ).bind(pageId).all<{ id: string }>(),
          this.bindings.DB.prepare(
            `SELECT target_user_id id FROM member_mentions WHERE source_page_id = ?`,
          ).bind(pageId).all<{ id: string }>(),
        ]);
        const timestamp = Date.now();
        const makeVersion = Boolean(
          forceVersion || !metadataAtStart.last_version_at ||
          timestamp - metadataAtStart.last_version_at >= VERSION_INTERVAL_MS,
        );
        const statements = [
          this.bindings.DB.prepare(
            `UPDATE pages SET plain_text = ?, indexed_seq = ?, oversized = ?, updated_at = ?
              WHERE id = ? AND content_epoch = ?`,
          ).bind(projection.plainText, maximum, readOnly ? 1 : 0, timestamp, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM page_search WHERE page_id = ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, pageId, epoch),
          this.bindings.DB.prepare(
            `INSERT INTO page_search (page_id, workspace_id, title, body)
              SELECT id, workspace_id, title, ? FROM pages
               WHERE id = ? AND content_epoch = ? AND archived_at IS NULL`,
          ).bind(projection.plainText, pageId, epoch),
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
          ).bind(page.workspace_id, pageId, timestamp, maximum, JSON.stringify(projection.memberMentions), page.workspace_id, pageId, epoch),
          this.bindings.DB.prepare(
            `DELETE FROM member_mentions WHERE source_page_id = ? AND projection_seq <> ?
              AND EXISTS (SELECT 1 FROM pages WHERE id = ? AND content_epoch = ?)`,
          ).bind(pageId, maximum, pageId, epoch),
        ];
        const currentPageTargetsIndex = statements.length;
        statements.push(this.bindings.DB.prepare(
          `SELECT target_page_id id FROM page_references
            WHERE source_page_id = ? AND projection_seq = ?`,
        ).bind(pageId, maximum));
        const currentUserTargetsIndex = statements.length;
        statements.push(this.bindings.DB.prepare(
          `SELECT target_user_id id FROM member_mentions
            WHERE source_page_id = ? AND projection_seq = ?`,
        ).bind(pageId, maximum));

        if (makeVersion) {
          const versionId = crypto.randomUUID();
          versionKey = `documents/${pageId}/versions/${versionId}.bin`;
          await this.bindings.BUCKET.put(versionKey, snapshot, {
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
          });
          versionAt = timestamp;
          versionStatementIndex = statements.length;
          statements.push(this.bindings.DB.prepare(
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
          ));
        }

        const results = await this.bindings.DB.batch(statements);
        pageProjected = Boolean(results[0]?.meta.changes);
        if (versionStatementIndex >= 0 && !results[versionStatementIndex]?.meta.changes && versionKey) {
          await this.bindings.BUCKET.delete(versionKey);
          versionKey = null;
          versionAt = metadataAtStart.last_version_at;
        }

        if (pageProjected) {
          const currentPageTargets = results[currentPageTargetsIndex]?.results as Array<{ id: string }> ?? [];
          const currentUserTargets = results[currentUserTargetsIndex]?.results as Array<{ id: string }> ?? [];
          const backlinkTargetIds = [...new Set([
            ...oldPageTargets.results.map((row) => row.id),
            ...currentPageTargets.map((row) => row.id),
          ])];
          const mentionTargetUserIds = [...new Set([
            ...oldUserTargets.results.map((row) => row.id),
            ...currentUserTargets.map((row) => row.id),
          ])];
          this.state.waitUntil(broadcastWorkspaceEvent(this.bindings, page.workspace_id, {
            type: "projection-updated",
            pageId,
            backlinkTargetIds,
            mentionTargetUserIds,
          }).catch((error) => console.error("Failed to broadcast projection update", error)));
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
        this.state.waitUntil(this.pruneVersions(pageId).catch((error) => {
          console.error("Failed to prune document versions", error);
        }));
      }
    } catch (error) {
      this.metadata.dirty = 1;
      this.state.storage.sql.exec(`UPDATE document_meta SET dirty = 1 WHERE id = 1`);
      try {
        await this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS);
      } catch (alarmError) {
        console.error("Failed to schedule compaction retry", alarmError);
      }
      throw error;
    }
  }

  private async pruneVersions(pageId: string) {
    const cutoff = Date.now() - VERSION_RETENTION_MS;
    const versions = await this.bindings.DB.prepare(
      `SELECT id, r2_key, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC`,
    ).bind(pageId).all<{ id: string; r2_key: string; created_at: number }>();
    const expired = versions.results.filter((version, index) => index >= 200 || version.created_at < cutoff);
    for (const version of expired) {
      await this.bindings.DB.prepare(`DELETE FROM page_versions WHERE id = ?`).bind(version.id).run();
      await this.bindings.BUCKET.delete(version.r2_key);
    }
  }

  private async restoreVersion(versionId: string, userId: string) {
    if (this.restoreValidation || this.transition || this.metadata.retired || this.purged) {
      return Response.json({ error: "Document transition already in progress." }, { status: 409 });
    }
    this.restoreValidation = true;
    try {
      const { pageId, epoch } = this.ids;
      let selectedBytes: Uint8Array;
      try {
        const version = await this.bindings.DB.prepare(
          `SELECT r2_key FROM page_versions WHERE id = ? AND page_id = ?`,
        ).bind(versionId, pageId).first<{ r2_key: string }>();
        if (!version) return Response.json({ error: "Version not found." }, { status: 404 });
        const selected = await this.bindings.BUCKET.get(version.r2_key);
        if (!selected) return Response.json({ error: "Version snapshot is missing." }, { status: 404 });
        selectedBytes = new Uint8Array(await selected.arrayBuffer());
      } catch (error) {
        console.error("Document restore validation failed", error);
        return Response.json({ error: "The version could not be restored." }, { status: 503 });
      }

      if (this.transition || this.metadata.retired || this.purged) {
        return Response.json({ error: "Document transition already in progress." }, { status: 409 });
      }
      this.transition = "restore";
      this.restoreValidation = false;
      const newEpoch = epoch + 1;
      let newKey: string | null = null;
      let preKey: string | null = null;
      let commitState: "committed" | "not-committed" | "unknown" = "unknown";
      const markRestoreCommitted = () => {
        this.metadata.retired = 1;
        this.metadata.restore_pending = 0;
        try {
          this.state.storage.sql.exec(
            `UPDATE document_meta SET retired = 1, restore_pending = 0 WHERE id = 1`,
          );
        } catch (error) {
          // D1 is authoritative for routing. A restarted old room also reconciles
          // its retired state from the committed epoch before accepting clients.
          console.error("Failed to persist retired document state", error);
        }
      };
      try {
        for (const connection of this.getConnections()) {
          connection.close(4410, "A restored version replaced this document.");
        }
        this.flushPendingUpdates();

        const hadPendingLog = Boolean(this.metadata.dirty);
        newKey = this.snapshotKey(pageId, newEpoch);
        if (hadPendingLog) await this.compact(true);

        const statements: D1PreparedStatement[] = [];
        if (!hadPendingLog) {
          const currentSnapshot = Y.encodeStateAsUpdate(this.document);
          const preId = crypto.randomUUID();
          preKey = `documents/${pageId}/versions/${preId}.bin`;
          await this.bindings.BUCKET.put(preKey, currentSnapshot, {
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: { pageId, epoch: String(epoch), sequence: String(this.metadata.snapshot_seq) },
          });
          statements.push(this.bindings.DB.prepare(
            `INSERT INTO page_versions
              (id, page_id, epoch, sequence, title, r2_key, byte_size, last_editor_id, created_at)
             SELECT ?, id, ?, ?, title, ?, ?, ?, ? FROM pages
              WHERE id = ? AND content_epoch = ? AND archived_at IS NULL`,
          ).bind(
            preId,
            epoch,
            this.metadata.snapshot_seq,
            preKey,
            currentSnapshot.byteLength,
            userId,
            Date.now(),
            pageId,
            epoch,
          ));
        }

        this.metadata.restore_pending = 1;
        this.state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 1 WHERE id = 1`);
        await this.bindings.BUCKET.put(newKey, selectedBytes, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { pageId, epoch: String(newEpoch), restoredFrom: versionId },
        });
        statements.push(this.bindings.DB.prepare(
          `UPDATE pages
              SET content_epoch = ?, revision = revision + 1, indexed_seq = 0, updated_at = ?
            WHERE id = ? AND content_epoch = ? AND archived_at IS NULL`,
        ).bind(newEpoch, Date.now(), pageId, epoch));
        const results = await this.bindings.DB.batch(statements);
        if (!results.at(-1)?.meta.changes) {
          await Promise.all([
            this.bindings.BUCKET.delete(newKey),
            preKey ? this.bindings.BUCKET.delete(preKey) : Promise.resolve(),
          ]);
          newKey = null;
          preKey = null;
          this.metadata.restore_pending = 0;
          this.state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 0 WHERE id = 1`);
          return Response.json({ error: "The page epoch changed during restore." }, { status: 409 });
        }
        commitState = "committed";
        markRestoreCommitted();
        return Response.json({ pageId, contentEpoch: newEpoch });
      } catch (error) {
        if (commitState === "unknown") {
          try {
            const current = await this.bindings.DB.prepare(
              `SELECT content_epoch FROM pages WHERE id = ?`,
            ).bind(pageId).first<{ content_epoch: number }>();
            if (current?.content_epoch === newEpoch) commitState = "committed";
            else if (current?.content_epoch === epoch) commitState = "not-committed";
          } catch (lookupError) {
            console.error("Failed to confirm restore commit state", lookupError);
          }
        }
        if (commitState === "not-committed") {
          await Promise.allSettled([
            ...(newKey ? [this.bindings.BUCKET.delete(newKey)] : []),
            ...(preKey ? [this.bindings.BUCKET.delete(preKey)] : []),
          ]);
          this.metadata.restore_pending = 0;
          try {
            this.state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 0 WHERE id = 1`);
          } catch (storageError) {
            console.error("Failed to clear pending restore state", storageError);
          }
        } else if (commitState === "committed") {
          markRestoreCommitted();
        }
        console.error("Document restore failed", error);
        return Response.json({ error: "The version could not be restored." }, { status: 503 });
      } finally {
        this.transition = null;
      }
    } finally {
      this.restoreValidation = false;
    }
  }

  private snapshotKey(pageId: string, epoch: number) {
    return `documents/${pageId}/epochs/${epoch}/current.bin`;
  }

  private async scheduleAlarm(when: number) {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || when < existing) await this.state.storage.setAlarm(when);
  }
}
