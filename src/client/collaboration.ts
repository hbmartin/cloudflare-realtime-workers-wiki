import { IndexeddbPersistence } from "y-indexeddb";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import type { WorkspaceEvent } from "../shared/types";
import { parseWorkspaceEvent } from "../shared/validation";
import { CollaborationDurability } from "./collaboration-durability";
import { connectionRetryDelay } from "./retry";

export type CollaborationBundle = {
  doc: Y.Doc;
  indexeddb: IndexeddbPersistence;
  provider: YProvider;
  /**
   * Resolves after offline state loads and, unless destroyed, connection
   * startup begins. Rejects if offline storage fails while the bundle is
   * active; failures after destroy are suppressed.
   */
  ready: Promise<void>;
  readonly hasUnsyncedChanges: boolean;
  destroy: () => void;
};

export type WorkspaceEventsBundle = {
  provider: YProvider;
  destroy: () => void;
};

export function createCollaboration(
  workspaceId: string,
  pageId: string,
  epoch: number,
  onStatus: (status: "offline" | "connecting" | "connected") => void,
): CollaborationBundle {
  const doc = new Y.Doc();
  const key = `${workspaceId}:${pageId}:${epoch}:1`;
  const indexeddb = new IndexeddbPersistence(key, doc);
  const provider = new YProvider(window.location.host, `${pageId}~${epoch}`, doc, {
    party: "document",
    connect: false,
  });
  let hiddenTimer: number | undefined;
  let barrierTimer: number | undefined;
  let barrierDeadline: number | undefined;
  let connectionTimer: number | undefined;
  let connectionAttempt = 0;
  let destroyed = false;
  let indexeddbSynced = false;
  const durability = new CollaborationDurability();
  const connect = () => {
    if (destroyed) return;
    if (connectionTimer !== undefined) window.clearTimeout(connectionTimer);
    connectionTimer = undefined;
    void provider.connect().then(
      () => {
        if (destroyed) {
          provider.disconnect();
          return;
        }
        connectionAttempt = 0;
      },
      (error) => {
        if (destroyed) return;
        onStatus("offline");
        console.error("Failed to connect document collaboration", error);
        if (document.visibilityState !== "hidden") {
          connectionTimer = window.setTimeout(connect, connectionRetryDelay(connectionAttempt++));
        }
      },
    );
  };

  const sendDurabilityBarrier = () => {
    if (barrierTimer !== undefined) window.clearTimeout(barrierTimer);
    barrierTimer = undefined;
    const generation = durability.barrierGeneration();
    if (generation === null) {
      barrierDeadline = undefined;
      return;
    }
    if (!provider.synced) return;
    barrierDeadline = undefined;
    provider.sendMessage(JSON.stringify({ type: "document-update-barrier", generation }));
  };
  const scheduleDurabilityBarrier = () => {
    const now = Date.now();
    barrierDeadline ??= now + 5_000;
    if (barrierTimer !== undefined) window.clearTimeout(barrierTimer);
    barrierTimer = window.setTimeout(sendDurabilityBarrier, Math.max(0, Math.min(1_000, barrierDeadline - now)));
  };

  const handleStatus = ({ status }: { status: "connecting" | "connected" | "disconnected" }) => {
    onStatus(status === "disconnected" ? "offline" : status);
  };
  provider.on("status", handleStatus);
  const handleSync = (synced: boolean) => {
    if (synced) sendDurabilityBarrier();
  };
  const handleCustomMessage = (message: string) => {
    try {
      const value = JSON.parse(message) as { type?: unknown; generation?: unknown };
      if (value.type !== "document-update-ack" || !Number.isInteger(value.generation)) return;
      durability.acknowledge(Number(value.generation));
    } catch {
      // Ignore custom messages from future server versions.
    }
  };
  provider.on("sync", handleSync);
  provider.on("custom-message", handleCustomMessage);
  doc.on("update", (_update: Uint8Array, origin: unknown) => {
    if (origin === provider || origin === indexeddb) return;
    durability.markChanged();
    scheduleDurabilityBarrier();
  });
  const ready = indexeddb.whenSynced
    .then(() => {
      if (!destroyed) {
        // Until the server sync completes, conservatively treat a persisted copy
        // as recoverable offline work. An epoch rejection happens before sync.
        if (Y.encodeStateVector(doc).byteLength > 1) durability.markChanged();
        indexeddbSynced = true;
        connect();
      }
    })
    .catch((error) => {
      if (destroyed) return;
      console.error("Failed to load offline document state", error);
      onStatus("offline");
      throw error;
    });

  const visibility = () => {
    if (document.visibilityState === "hidden") {
      if (connectionTimer !== undefined) window.clearTimeout(connectionTimer);
      connectionTimer = undefined;
      sendDurabilityBarrier();
      hiddenTimer = window.setTimeout(() => {
        hiddenTimer = undefined;
        provider.disconnect();
      }, 30_000);
    } else {
      if (hiddenTimer !== undefined) window.clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      if (indexeddbSynced) connect();
    }
  };
  document.addEventListener("visibilitychange", visibility);

  return {
    doc,
    indexeddb,
    provider,
    ready,
    get hasUnsyncedChanges() {
      return durability.hasUnsyncedChanges;
    },
    destroy() {
      destroyed = true;
      if (hiddenTimer !== undefined) window.clearTimeout(hiddenTimer);
      if (barrierTimer !== undefined) window.clearTimeout(barrierTimer);
      if (connectionTimer !== undefined) window.clearTimeout(connectionTimer);
      document.removeEventListener("visibilitychange", visibility);
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      provider.off("custom-message", handleCustomMessage);
      provider.awareness.setLocalState(null);
      provider.destroy();
      void indexeddb.destroy().catch((error) => console.error("Failed to close offline document storage", error));
      doc.destroy();
    },
  };
}

export async function loadOfflineCopy(key: string) {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(key, doc);
  await persistence.whenSynced;
  await persistence.destroy();
  return doc;
}

export function createWorkspaceEvents(
  workspaceId: string,
  onEvent: (event: WorkspaceEvent) => void,
  onConnected: () => void,
): WorkspaceEventsBundle {
  const doc = new Y.Doc();
  const provider = new YProvider(window.location.host, workspaceId, doc, {
    party: "workspace-events",
  });
  const customMessage = (message: string) => {
    try {
      const event = parseWorkspaceEvent(JSON.parse(message));
      if (event) onEvent(event);
    } catch {
      // Ignore messages from future server versions.
    }
  };
  const status = ({ status: next }: { status: string }) => {
    if (next === "connected") onConnected();
  };
  provider.on("custom-message", customMessage);
  provider.on("status", status);
  return {
    provider,
    destroy() {
      provider.off("custom-message", customMessage);
      provider.off("status", status);
      provider.awareness.setLocalState(null);
      provider.destroy();
      doc.destroy();
    },
  };
}

export function userColor(id: string): string {
  const palette = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#d97706", "#059669", "#0891b2"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}
