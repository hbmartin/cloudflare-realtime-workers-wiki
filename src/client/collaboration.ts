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

export type NetworkCollaborationBundle = {
  doc: Y.Doc;
  provider: YProvider;
  ready: Promise<void>;
  readonly synced: boolean;
  readonly hasUnsyncedChanges: boolean;
  destroy: () => void;
};

function createDurabilityBarrier(
  provider: Pick<YProvider, "synced" | "sendMessage">,
  durability: CollaborationDurability,
  timerClampMs: number,
) {
  let timer: number | undefined;
  let deadline: number | undefined;
  const send = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    const generation = durability.barrierGeneration();
    if (generation === null) {
      deadline = undefined;
      return;
    }
    if (!provider.synced) {
      if (deadline !== undefined && deadline <= Date.now()) deadline = undefined;
      return;
    }
    deadline = undefined;
    provider.sendMessage(JSON.stringify({ type: "document-update-barrier", generation }));
  };
  return {
    send,
    schedule() {
      const now = Date.now();
      if (deadline !== undefined && deadline <= now && !provider.synced) deadline = undefined;
      deadline ??= now + 5_000;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(send, Math.max(0, Math.min(timerClampMs, deadline - now)));
    },
    destroy() {
      if (timer !== undefined) window.clearTimeout(timer);
    },
  };
}

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
  let connectionTimer: number | undefined;
  let connectionAttempt = 0;
  let destroyed = false;
  let indexeddbSynced = false;
  const durability = new CollaborationDurability();
  const barrier = createDurabilityBarrier(provider, durability, 1_000);
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

  const handleStatus = ({ status }: { status: "connecting" | "connected" | "disconnected" }) => {
    onStatus(status === "disconnected" ? "offline" : status);
  };
  provider.on("status", handleStatus);
  const handleSync = (synced: boolean) => {
    if (synced) barrier.send();
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
    barrier.schedule();
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
      barrier.send();
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
      barrier.destroy();
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

/** A reconnecting Yjs room with no browser persistence. Used by diagrams, which
 * deliberately become read-only whenever the authoritative server is absent. */
export function createNetworkCollaboration(
  pageId: string,
  epoch: number,
  onStatus: (status: "offline" | "connecting" | "connected") => void,
): NetworkCollaborationBundle {
  const doc = new Y.Doc();
  const provider = new YProvider(window.location.host, `${pageId}~${epoch}`, doc, {
    party: "document",
    connect: false,
  });
  const durability = new CollaborationDurability();
  let destroyed = false;
  let synced = false;
  let readyResolved = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let hiddenTimer: number | undefined;
  let retryTimer: number | undefined;
  let retryAttempt = 0;
  const barrier = createDurabilityBarrier(provider, durability, 500);

  const connect = () => {
    if (destroyed) return;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    retryTimer = undefined;
    onStatus("connecting");
    void provider.connect().then(
      () => {
        retryAttempt = 0;
      },
      (error) => {
        if (destroyed) return;
        onStatus("offline");
        console.error("Failed to connect diagram collaboration", error);
        if (document.visibilityState !== "hidden") {
          retryTimer = window.setTimeout(connect, connectionRetryDelay(retryAttempt++));
        }
      },
    );
  };

  const handleStatus = ({ status }: { status: "connecting" | "connected" | "disconnected" }) => {
    if (status === "disconnected") {
      synced = false;
      if (!destroyed && document.visibilityState !== "hidden" && retryTimer === undefined) {
        retryTimer = window.setTimeout(connect, connectionRetryDelay(retryAttempt++));
      }
    } else if (retryTimer !== undefined) {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    onStatus(status === "disconnected" ? "offline" : status === "connected" && !synced ? "connecting" : status);
  };
  const handleSync = (next: boolean) => {
    synced = next;
    if (next) {
      onStatus("connected");
      barrier.send();
      if (!readyResolved) {
        readyResolved = true;
        resolveReady();
      }
    } else onStatus("connecting");
  };
  const handleCustomMessage = (message: string) => {
    try {
      const value = JSON.parse(message) as { type?: unknown; generation?: unknown };
      if (value.type === "document-update-ack" && Number.isInteger(value.generation)) {
        durability.acknowledge(Number(value.generation));
      }
    } catch {
      // Ignore custom messages from future server versions.
    }
  };
  const handleUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === provider) return;
    durability.markChanged();
    barrier.schedule();
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") {
      barrier.send();
      hiddenTimer = window.setTimeout(() => {
        hiddenTimer = undefined;
        synced = false;
        provider.disconnect();
      }, 30_000);
    } else {
      if (hiddenTimer !== undefined) window.clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      connect();
    }
  };

  provider.on("status", handleStatus);
  provider.on("sync", handleSync);
  provider.on("custom-message", handleCustomMessage);
  doc.on("update", handleUpdate);
  document.addEventListener("visibilitychange", visibility);
  connect();

  return {
    doc,
    provider,
    ready,
    get synced() {
      return synced;
    },
    get hasUnsyncedChanges() {
      return durability.hasUnsyncedChanges;
    },
    destroy() {
      destroyed = true;
      if (hiddenTimer !== undefined) window.clearTimeout(hiddenTimer);
      barrier.destroy();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", visibility);
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      provider.off("custom-message", handleCustomMessage);
      doc.off("update", handleUpdate);
      provider.awareness.setLocalState(null);
      provider.destroy();
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
