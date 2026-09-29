// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaboration, createNetworkCollaboration, createWorkspaceEvents } from "./collaboration";
import { LOCAL_SIGNOUT_KEY } from "./offline-catalog";

const mocks = vi.hoisted(() => ({
  whenSynced: new Promise<void>(() => undefined),
  persistenceNames: [] as string[],
  providers: [] as Array<{
    synced: boolean;
    wsconnected: boolean;
    wsconnecting: boolean;
    shouldConnect: boolean;
    sendMessage: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    connectBc: ReturnType<typeof vi.fn>;
    reconnect: ReturnType<typeof vi.fn>;
    _reconnectWS: () => Promise<void>;
    disconnect: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    emit(event: string, value: unknown): void;
  }>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    constructor(name: string) {
      mocks.persistenceNames.push(name);
    }
    whenSynced = mocks.whenSynced;
    destroy = vi.fn(async () => undefined);
  },
}));

vi.mock("y-partyserver/provider", () => ({
  default: class {
    synced = false;
    wsconnected = false;
    wsconnecting = false;
    shouldConnect = false;
    sendMessage = vi.fn();
    connect = vi.fn(async () => {
      this.shouldConnect = true;
    });
    connectBc = vi.fn();
    reconnect = vi.fn(async () => undefined);
    _reconnectWS = async () => {
      await this.reconnect();
    };
    disconnect = vi.fn(() => {
      this.shouldConnect = false;
    });
    destroy = vi.fn();
    awareness = { setLocalState: vi.fn() };
    private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

    constructor() {
      mocks.providers.push(this);
    }

    on(event: string, handler: (value: unknown) => void) {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
    }

    off(event: string, handler: (value: unknown) => void) {
      this.handlers.get(event)?.delete(handler);
    }

    emit(event: string, value: unknown) {
      for (const handler of this.handlers.get(event) ?? []) handler(value);
    }
  },
}));

vi.mock("yjs", () => ({
  Doc: class {
    private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
    }

    off(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.get(event)?.delete(handler);
    }

    emitUpdate(origin: unknown) {
      for (const handler of this.handlers.get("update") ?? []) handler(new Uint8Array([1]), origin);
    }

    destroy() {}
  },
  encodeStateVector: () => new Uint8Array(),
}));

describe("collaboration durability barriers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(1);
    mocks.whenSynced = new Promise<void>(() => undefined);
    mocks.providers.length = 0;
    mocks.persistenceNames.length = 0;
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        clear: () => stored.clear(),
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the original deadline when a barrier cannot yet be sent", async () => {
    const bundle = createCollaboration("workspace", "page", 1, vi.fn(), "user");
    const doc = bundle.doc as typeof bundle.doc & { emitUpdate: (origin: unknown) => void };
    const provider = mocks.providers[0]!;

    doc.emitUpdate(null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_500);
    doc.emitUpdate(null);
    provider.synced = true;
    await vi.advanceTimersByTimeAsync(500);

    expect(provider.sendMessage).toHaveBeenCalledOnce();
    bundle.destroy();
  });

  it("separates local Yjs stores by account", () => {
    const first = createCollaboration("workspace", "page", 1, vi.fn(), "user-a");
    const second = createCollaboration("workspace", "page", 1, vi.fn(), "user-b");
    expect(mocks.persistenceNames).toEqual(["account:user-a:workspace:page:1:2", "account:user-b:workspace:page:1:2"]);
    first.destroy();
    second.destroy();
  });

  it("registers each store and blocks new stores while the account is signing out", () => {
    localStorage.clear();
    const first = createCollaboration("workspace", "page", 1, vi.fn(), "user");
    const key = "account:user:workspace:page:1:2";
    expect(localStorage.getItem(`noteflare-document-keys:user\u0000workspace\u0000${key}`)).toBe("1");
    localStorage.setItem(LOCAL_SIGNOUT_KEY, "user\u0000workspace");
    expect(() => createCollaboration("workspace", "other", 1, vi.fn(), "user")).toThrow(
      "Local sign-out is removing offline documents.",
    );
    expect(mocks.persistenceNames).toEqual([key]);
    first.destroy();
    localStorage.clear();
  });

  it("bounds diagram durability latency while retaining the quiet-period debounce", async () => {
    const bundle = createNetworkCollaboration("page", 1, vi.fn());
    const doc = bundle.doc as typeof bundle.doc & { emitUpdate: (origin: unknown) => void };
    const provider = mocks.providers[0]!;
    provider.synced = true;
    provider.emit("sync", true);

    for (let elapsed = 0; elapsed < 4_800; elapsed += 400) {
      doc.emitUpdate(null);
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(provider.sendMessage).not.toHaveBeenCalled();

    doc.emitUpdate(null);
    await vi.advanceTimersByTimeAsync(200);
    expect(provider.sendMessage).toHaveBeenCalledOnce();
    expect(provider.sendMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: "document-update-barrier", generation: 13 }),
    );
    bundle.destroy();
  });

  it("starts a fresh diagram quiet period after an offline deadline expires", async () => {
    const bundle = createNetworkCollaboration("page", 1, vi.fn());
    const doc = bundle.doc as typeof bundle.doc & { emitUpdate: (origin: unknown) => void };
    const provider = mocks.providers[0]!;

    doc.emitUpdate(null);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(4_600);

    doc.emitUpdate(null);
    provider.synced = true;
    await vi.advanceTimersByTimeAsync(499);
    expect(provider.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(provider.sendMessage).toHaveBeenCalledOnce();
    bundle.destroy();
  });

  it("handles collaboration connection failures after IndexedDB sync", async () => {
    mocks.whenSynced = Promise.resolve();
    const onStatus = vi.fn();
    const error = new Error("token refresh failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bundle = createCollaboration("workspace", "page", 1, onStatus, "user");
    const provider = mocks.providers[0]!;
    provider.connect.mockRejectedValueOnce(error);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onStatus).toHaveBeenCalledWith("offline");
    expect(logged).toHaveBeenCalledWith("Failed to connect document collaboration", error);
    expect(provider.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.connect).toHaveBeenCalledTimes(2);
    bundle.destroy();
  });

  it("checks access again before the provider's automatic reconnect", async () => {
    mocks.whenSynced = Promise.resolve();
    const beforeConnect = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const bundle = createCollaboration("workspace", "page", 1, vi.fn(), "user", beforeConnect);
    const provider = mocks.providers[0]!;
    await bundle.ready;
    expect(provider.connect).toHaveBeenCalledOnce();

    await provider["_reconnectWS"]();
    await Promise.resolve();
    await Promise.resolve();
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(provider.connect).toHaveBeenCalledOnce();
    expect(provider.disconnect).toHaveBeenCalledOnce();
    bundle.destroy();
  });

  it("uses the provider's socket-only reconnect after checking access", async () => {
    mocks.whenSynced = Promise.resolve();
    const beforeConnect = vi.fn().mockResolvedValue(true);
    const bundle = createCollaboration("workspace", "page", 1, vi.fn(), "user", beforeConnect);
    const provider = mocks.providers[0]!;
    await bundle.ready;
    await provider["_reconnectWS"]();
    await Promise.resolve();
    await Promise.resolve();
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(provider.connect).toHaveBeenCalledOnce();
    expect(provider.reconnect).toHaveBeenCalledOnce();
    bundle.destroy();
  });

  it("re-enables a connection when a hidden tab returns before its socket closes", async () => {
    mocks.whenSynced = Promise.resolve();
    const bundle = createCollaboration("workspace", "page", 1, vi.fn(), "user");
    const provider = mocks.providers[0]!;
    await bundle.ready;
    provider.wsconnected = true;
    (provider.disconnect as () => void)();
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.connect).toHaveBeenCalledTimes(2);
    expect(provider.shouldConnect).toBe(true);
    bundle.destroy();
  });

  it("keeps a connected status when the tab becomes visible", async () => {
    mocks.whenSynced = Promise.resolve();
    const onStatus = vi.fn();
    const bundle = createCollaboration("workspace", "page", 1, onStatus, "user");
    const provider = mocks.providers[0]!;
    await bundle.ready;
    provider.wsconnected = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onStatus).toHaveBeenLastCalledWith("connected");
    expect(provider.connect).toHaveBeenCalledOnce();
    bundle.destroy();
  });

  it("fails closed when offline storage fails to open", async () => {
    const error = new Error("IndexedDB unavailable");
    mocks.whenSynced = Promise.reject(error);
    const onStatus = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bundle = createCollaboration("workspace", "page", 1, onStatus, "user");
    const provider = mocks.providers[0]!;

    await expect(bundle.ready).rejects.toBe(error);

    expect(logged).toHaveBeenCalledWith("Failed to load offline document state", error);
    expect(onStatus).toHaveBeenCalledWith("offline");
    expect(provider.connect).not.toHaveBeenCalled();
    bundle.destroy();
  });

  it("disconnects a collaboration connection that completes after destroy", async () => {
    const connection = deferred<void>();
    mocks.whenSynced = Promise.resolve();
    const bundle = createCollaboration("workspace", "page", 1, vi.fn(), "user");
    const provider = mocks.providers[0]!;
    provider.connect.mockReturnValue(connection.promise);

    await Promise.resolve();
    await Promise.resolve();
    expect(provider.connect).toHaveBeenCalledOnce();

    bundle.destroy();
    connection.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(provider.disconnect).toHaveBeenCalledOnce();
  });

  it("delivers recognized workspace invalidation events", () => {
    const onEvent = vi.fn();
    const bundle = createWorkspaceEvents("workspace", onEvent, vi.fn());

    mocks.providers[0]!.emit("custom-message", JSON.stringify({ type: "workspace-invalidated" }));

    expect(onEvent).toHaveBeenCalledWith({ type: "workspace-invalidated" });
    bundle.destroy();
  });

  it("ignores malformed and unknown workspace events", () => {
    const onEvent = vi.fn();
    const bundle = createWorkspaceEvents("workspace", onEvent, vi.fn());
    const provider = mocks.providers[0]!;

    provider.emit("custom-message", "not JSON");
    provider.emit("custom-message", JSON.stringify({ type: "future-event" }));
    provider.emit("custom-message", JSON.stringify({ type: "projection-updated", pageId: "page" }));

    expect(onEvent).not.toHaveBeenCalled();
    bundle.destroy();
  });
});
