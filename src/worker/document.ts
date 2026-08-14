import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { joinBytes, splitBytes } from "../shared/bytes";
import type { Env } from "./env";

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
  dirty: number;
  retired: number;
  read_only: number;
  last_version_at: number;
  last_editor_id: string | null;
}

export class Document extends YServer {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1_000, debounceMaxWait: 5_000 };

  private readonly state: DurableObjectState;
  private readonly bindings: Env;

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
      dirty INTEGER NOT NULL DEFAULT 0,
      retired INTEGER NOT NULL DEFAULT 0,
      read_only INTEGER NOT NULL DEFAULT 0,
      last_version_at INTEGER NOT NULL DEFAULT 0,
      last_editor_id TEXT
    )`);
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

    await super.onStart();
    this.document.on("update", (update: Uint8Array, origin: unknown) => {
      this.recordUpdate(update, origin as Connection<ConnectionAuth> | null);
    });
  }

  async onLoad() {
    const { pageId, epoch } = this.ids;
    const doc = new Y.Doc();
    const meta = this.meta();
    const snapshot = await this.bindings.BUCKET.get(this.snapshotKey(pageId, epoch));
    if (snapshot) Y.applyUpdate(doc, new Uint8Array(await snapshot.arrayBuffer()));

    const events = this.state.storage.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM update_events WHERE seq > ? ORDER BY seq`,
        meta.snapshot_seq,
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

  onConnect(connection: Connection<ConnectionAuth>, context: ConnectionContext) {
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
    this.scheduleAlarm(expiresAt);
    return super.onConnect(connection, context);
  }

  isReadOnly(connection: Connection<ConnectionAuth>) {
    const meta = this.meta();
    return Boolean(
      meta.retired ||
        meta.read_only ||
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
    if (this.meta().retired) {
      connection.close(4410, "This document version has been retired.");
      return;
    }
    return super.onMessage(connection, message);
  }

  async onSave() {
    await this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS);
  }

  async onAlarm() {
    const time = Date.now();
    for (const connection of this.getConnections<ConnectionAuth>()) {
      if (!connection.state || connection.state.expiresAt <= time) {
        connection.close(4401, "Authorization expired. Reconnect to continue.");
      }
    }
    if (this.meta().dirty) await this.compact();

    const nextExpiry = Array.from(this.getConnections<ConnectionAuth>())
      .map((connection) => connection.state?.expiresAt ?? 0)
      .filter((expiry) => expiry > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextExpiry) await this.state.storage.setAlarm(nextExpiry);
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);
    if (request.headers.get("x-notes-internal") !== this.bindings.BETTER_AUTH_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/retire")) {
      this.state.storage.sql.exec(`UPDATE document_meta SET retired = 1 WHERE id = 1`);
      if (this.meta().dirty) await this.compact(true);
      for (const connection of this.getConnections()) {
        connection.close(4410, "A restored version replaced this document.");
      }
      return Response.json({ retired: true });
    }
    return new Response("Not found", { status: 404 });
  }

  private meta() {
    return this.state.storage.sql.exec<MetaRow>(`SELECT * FROM document_meta WHERE id = 1`).one();
  }

  private recordUpdate(update: Uint8Array, origin: Connection<ConnectionAuth> | null) {
    if (this.meta().retired) return;
    const authorId = origin?.state?.userId ?? null;
    this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql
        .exec<{ seq: number }>(
          `INSERT INTO update_events (author_id, created_at) VALUES (?, ?) RETURNING seq`,
          authorId,
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
        `UPDATE document_meta SET dirty = 1, last_editor_id = COALESCE(?, last_editor_id) WHERE id = 1`,
        authorId,
      );
    });
    this.state.waitUntil(this.scheduleAlarm(Date.now() + COMPACTION_DELAY_MS));
  }

  private async compact(forceVersion = false) {
    const { pageId, epoch } = this.ids;
    const meta = this.meta();
    const maximum = this.state.storage.sql
      .exec<{ seq: number | null }>(`SELECT MAX(seq) seq FROM update_events`)
      .one().seq;
    if (!maximum) return;

    const snapshot = Y.encodeStateAsUpdate(this.document);
    if (snapshot.byteLength >= WARN_BYTES) {
      this.broadcastCustomMessage(JSON.stringify({
        type: "document-size",
        bytes: snapshot.byteLength,
        readOnly: snapshot.byteLength >= READ_ONLY_BYTES,
      }));
    }
    if (snapshot.byteLength >= READ_ONLY_BYTES) {
      this.state.storage.sql.exec(`UPDATE document_meta SET read_only = 1 WHERE id = 1`);
    }

    await this.bindings.BUCKET.put(this.snapshotKey(pageId, epoch), snapshot, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
    });

    const page = await this.bindings.DB.prepare(
      `SELECT workspace_id, title FROM pages WHERE id = ? AND content_epoch = ?`,
    ).bind(pageId, epoch).first<{ workspace_id: string; title: string }>();
    const body = this.plainText();
    const makeVersion = Boolean(page && (forceVersion || !meta.last_version_at || Date.now() - meta.last_version_at >= VERSION_INTERVAL_MS));
    let versionAt = meta.last_version_at;

    if (page) {
      const statements = [
        this.bindings.DB.prepare(
          `UPDATE pages SET plain_text = ?, indexed_seq = ?, oversized = ?, updated_at = ?
            WHERE id = ? AND content_epoch = ?`,
        ).bind(body, maximum, snapshot.byteLength >= READ_ONLY_BYTES ? 1 : 0, Date.now(), pageId, epoch),
        this.bindings.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(pageId),
        this.bindings.DB.prepare(
          `INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, ?)`,
        ).bind(pageId, page.workspace_id, page.title, body),
      ];
      if (makeVersion) {
        const id = crypto.randomUUID();
        const key = `documents/${pageId}/versions/${id}.bin`;
        await this.bindings.BUCKET.put(key, snapshot, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { pageId, epoch: String(epoch), sequence: String(maximum) },
        });
        versionAt = Date.now();
        statements.push(this.bindings.DB.prepare(
          `INSERT INTO page_versions
            (id, page_id, epoch, sequence, title, r2_key, byte_size, last_editor_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, pageId, epoch, maximum, page.title, key, snapshot.byteLength, meta.last_editor_id, versionAt));
      }
      await this.bindings.DB.batch(statements);
      if (makeVersion) await this.pruneVersions(pageId);
    }

    // R2 was durable before the log is acknowledged. Replaying duplicate Yjs
    // updates after a crash between these two steps is safe.
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(`DELETE FROM update_chunks WHERE seq <= ?`, maximum);
      this.state.storage.sql.exec(`DELETE FROM update_events WHERE seq <= ?`, maximum);
      this.state.storage.sql.exec(
        `UPDATE document_meta
            SET snapshot_seq = ?, dirty = 0, last_version_at = ?
          WHERE id = 1`,
        maximum,
        versionAt,
      );
    });
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

  private plainText() {
    return this.document
      .getXmlFragment("document-store")
      .toString()
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500_000);
  }

  private snapshotKey(pageId: string, epoch: number) {
    return `documents/${pageId}/epochs/${epoch}/current.bin`;
  }

  private async scheduleAlarm(when: number) {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || when < existing) await this.state.storage.setAlarm(when);
  }
}
