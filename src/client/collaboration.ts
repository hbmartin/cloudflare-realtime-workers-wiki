import { IndexeddbPersistence } from "y-indexeddb";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import type { WorkspaceEvent } from "../shared/types";

export type CollaborationBundle = {
  doc: Y.Doc;
  indexeddb: IndexeddbPersistence;
  provider: YProvider;
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
  let destroyed = false;
  let indexeddbSynced = false;
  let hasUnsyncedChanges = false;
  let localGeneration = 0;
  let acknowledgedGeneration = 0;

  const handleStatus = ({ status }: { status: "connecting" | "connected" | "disconnected" }) => {
    onStatus(status === "disconnected" ? "offline" : status);
  };
  provider.on("status", handleStatus);
  const handleSync = (synced: boolean) => {
    if (synced) {
      acknowledgedGeneration = localGeneration;
      hasUnsyncedChanges = false;
    }
  };
  const handleCustomMessage = (message: string) => {
    try {
      const value = JSON.parse(message) as { type?: unknown; generation?: unknown };
      if (value.type !== "document-update-ack" || !Number.isInteger(value.generation)) return;
      acknowledgedGeneration = Math.max(acknowledgedGeneration, Number(value.generation));
      hasUnsyncedChanges = acknowledgedGeneration < localGeneration;
    } catch {
      // Ignore custom messages from future server versions.
    }
  };
  provider.on("sync", handleSync);
  provider.on("custom-message", handleCustomMessage);
  doc.on("update", (_update: Uint8Array, origin: unknown) => {
    if (origin === provider || origin === indexeddb) return;
    localGeneration += 1;
    hasUnsyncedChanges = true;
    if (provider.wsconnected) {
      provider.sendMessage(JSON.stringify({ type: "document-update-barrier", generation: localGeneration }));
    }
  });
  indexeddb.whenSynced.then(() => {
    if (!destroyed) {
      // Until the server sync completes, conservatively treat a persisted copy
      // as recoverable offline work. An epoch rejection happens before sync.
      hasUnsyncedChanges = Y.encodeStateVector(doc).byteLength > 1;
      indexeddbSynced = true;
      provider.connect();
    }
  });

  const visibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenTimer = window.setTimeout(() => provider.disconnect(), 30_000);
    } else {
      if (hiddenTimer) window.clearTimeout(hiddenTimer);
      if (indexeddbSynced) provider.connect();
    }
  };
  document.addEventListener("visibilitychange", visibility);

  return {
    doc,
    indexeddb,
    provider,
    get hasUnsyncedChanges() { return hasUnsyncedChanges; },
    destroy() {
      destroyed = true;
      if (hiddenTimer) window.clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", visibility);
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      provider.off("custom-message", handleCustomMessage);
      provider.awareness.setLocalState(null);
      provider.destroy();
      indexeddb.destroy();
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
      onEvent(JSON.parse(message) as WorkspaceEvent);
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

export function userColor(id: string) {
  const palette = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#d97706", "#059669", "#0891b2"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}
