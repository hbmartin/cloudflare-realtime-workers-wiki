/**
 * Writes a converted page into the server as a headless collaborative client.
 *
 * No HTTP route accepts document body content: the only ingress is the Yjs WebSocket at
 * /parties/document/{pageId}~{epoch}. Connecting as an ordinary client is therefore not
 * a workaround but the supported path, and it means the import inherits chunking, the
 * update log, R2 snapshots, size limits, versioning, search indexing, and the backlink
 * projection without a line of new server code.
 */
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { projectDocument } from "../../src/shared/document-projection.ts";
import { documentProjectionHash } from "../../src/shared/import-integrity.ts";
import { DOCUMENT_FRAGMENT, DocumentStateChangedError, writeBlocksToFragment } from "./blocks.mjs";

const SYNC_TIMEOUT_MS = 30_000;

// Close codes the server uses, mapped to the text reported for a failed page.
const CLOSE_REASONS = new Map([
  [4401, "the connection grant expired"],
  [4410, "a restored version replaced this document"],
  [4411, "the page was deleted"],
  [4412, "the page was archived"],
  [4429, "the document already has the maximum number of connections"],
]);

/**
 * y-partyserver builds its socket as `new provider._WS(url)` with no second argument,
 * so a subclass closing over the credentials is the only seam for the session cookie.
 * The empty subprotocol list is required: `ws` reads a plain object in that position as
 * its options bag.
 */
function authenticatedSocket(cookie, origin) {
  return class extends WebSocket {
    constructor(url) {
      super(url, [], { headers: { cookie, origin } });
    }
  };
}

function settleOnce(provider, timeoutMs, message, subscribe) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(message)), timeoutMs);
    const listeners = [];
    function finish(error) {
      clearTimeout(timer);
      for (const [event, handler] of listeners) provider.off(event, handler);
      if (error) reject(error);
      else resolve();
    }
    function on(event, handler) {
      listeners.push([event, handler]);
      provider.on(event, handler);
    }
    on("connection-close", (event) => {
      const code = event?.code;
      const reason = CLOSE_REASONS.get(code);
      finish(
        new Error(
          reason
            ? `The document connection closed: ${reason} (${code}).`
            : `The document connection closed (${code ?? "no code"}).`,
        ),
      );
    });
    on("connection-error", () => finish(new Error("The document connection failed.")));
    subscribe(on, finish);
  });
}

function waitForSync(provider) {
  if (provider.synced) return Promise.resolve();
  return settleOnce(provider, SYNC_TIMEOUT_MS, "Timed out waiting for the document to sync.", (on, finish) => {
    on("sync", (synced) => {
      if (synced) finish();
    });
  });
}

function createProvider(client, pageId, epoch, doc) {
  const url = new URL(client.baseURL);
  return new YProvider(url.host, `${pageId}~${epoch}`, doc, {
    party: "document",
    connect: false,
    protocol: url.protocol === "https:" ? "wss" : "ws",
    disableBc: true,
    WebSocketPolyfill: authenticatedSocket(client.cookie, client.origin),
  });
}

function closeProvider(provider, doc, pageId) {
  try {
    provider.awareness?.setLocalState(null);
    provider.disconnect();
    provider.destroy();
    doc.destroy();
  } catch (error) {
    console.warn(`Failed to close the connection for ${pageId} cleanly: ${error.message}`);
  }
}

function fragmentJson(doc) {
  return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(DOCUMENT_FRAGMENT));
}

/**
 * Projection hash of a ProseMirror document JSON. This hash is the importer's
 * conflict-detection currency: every comparison assumes each side was computed through
 * this exact pipeline, so it lives here rather than being recomposed at each call site.
 */
export function documentJsonProjectionHash(document) {
  return documentProjectionHash(projectDocument(document));
}

export async function documentJsonForBlocks(editor, blocks) {
  const doc = new Y.Doc();
  try {
    await writeBlocksToFragment(editor, blocks, doc);
    return fragmentJson(doc);
  } finally {
    doc.destroy();
  }
}

function currentProjectionHash(doc) {
  return documentJsonProjectionHash(fragmentJson(doc));
}

/**
 * Hashes the document once the edit that interrupted a guarded write stops streaming.
 *
 * A multi-message edit may still be arriving when the write is refused; a hash taken at
 * that instant names a state the destination never kept, and it would be persisted as
 * the accepted destination hash that verify compares against. Bounded: an editor still
 * typing at the deadline yields a transient hash, which the next run's guarded compare
 * corrects.
 */
function settledProjectionHash(doc, { quietMs = 1_000, maxWaitMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let quiet = setTimeout(finish, quietMs);
    const deadline = setTimeout(finish, maxWaitMs);
    function onUpdate() {
      clearTimeout(quiet);
      quiet = setTimeout(finish, quietMs);
    }
    function finish() {
      clearTimeout(quiet);
      clearTimeout(deadline);
      doc.off("update", onUpdate);
      resolve(currentProjectionHash(doc));
    }
    doc.on("update", onUpdate);
  });
}

/**
 * Waits for the server to confirm the update reached its storage.
 *
 * `onCustomMessage` flushes the pending update log before replying, so the ack means the
 * write is durable rather than merely delivered. This is the same handshake the browser
 * editor uses.
 */
function waitForDurability(provider, timeoutMs) {
  const generation = 1;
  return settleOnce(provider, timeoutMs, "Timed out waiting for the durability acknowledgement.", (on, finish) => {
    on("custom-message", (raw) => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (parsed?.type === "document-update-ack" && parsed.generation >= generation) finish();
    });
    provider.sendMessage(JSON.stringify({ type: "document-update-barrier", generation }));
  });
}

export async function pushDocument({
  client,
  editor,
  blocks,
  pageId,
  epoch,
  lingerMs = 1_200,
  barrierTimeoutMs = 30_000,
  expectedProjectionHashes = null,
  beforeWrite = async () => {},
}) {
  if (expectedProjectionHashes && expectedProjectionHashes.length === 0) {
    // A truthy empty list would silently conflict with every possible live hash.
    throw new Error("expectedProjectionHashes must be null or contain at least one hash.");
  }
  const doc = new Y.Doc();
  const provider = createProvider(client, pageId, epoch, doc);

  try {
    await provider.connect();
    await waitForSync(provider);
    // Compare and replace through one synchronized Y.Doc. The update flag closes the
    // remaining async window: if another client writes while the hash is calculated or
    // its baseline is persisted, writeBlocksToFragment refuses the transaction. A flag
    // rather than a state-vector comparison, because a delete-only edit advances no
    // insertion clock but still fires the update event.
    let remoteUpdateSeen = false;
    const markRemoteUpdate = () => {
      remoteUpdateSeen = true;
    };
    doc.on("update", markRemoteUpdate);
    // The doc is read synchronously when the call is evaluated, so the listener above
    // and this baseline describe the same state.
    const liveProjectionHash = await currentProjectionHash(doc);
    if (expectedProjectionHashes && !expectedProjectionHashes.includes(liveProjectionHash)) {
      return { conflict: true, liveProjectionHash };
    }
    await beforeWrite(liveProjectionHash);
    let written;
    try {
      written = await writeBlocksToFragment(editor, blocks, doc, DOCUMENT_FRAGMENT, () => remoteUpdateSeen);
    } catch (error) {
      if (!(error instanceof DocumentStateChangedError)) throw error;
      return { conflict: true, liveProjectionHash: await settledProjectionHash(doc) };
    } finally {
      doc.off("update", markRemoteUpdate);
    }
    // Zero updates means the page already held exactly this content, which is what makes
    // a resumed import free rather than a rewrite.
    if (written.updates > 0) {
      await waitForDurability(provider, barrierTimeoutMs);
      // onSave is debounced, and it is onSave that arms the 30-second compaction alarm.
      // Disconnecting immediately leaves the projection to the connection grant instead,
      // so search and backlinks would lag by minutes rather than seconds.
      await delay(lingerMs);
    }
    return written;
  } finally {
    // destroy() removes the process exit listener installed by the provider.
    closeProvider(provider, doc, pageId);
  }
}
