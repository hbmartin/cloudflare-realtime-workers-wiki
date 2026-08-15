// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaboration } from "./collaboration";

const mocks = vi.hoisted(() => ({
  whenSynced: new Promise<void>(() => undefined),
  providers: [] as Array<{
    synced: boolean;
    sendMessage: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced = mocks.whenSynced;
    destroy = vi.fn(async () => undefined);
  },
}));

vi.mock("y-partyserver/provider", () => ({
  default: class {
    synced = false;
    sendMessage = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
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
    mocks.whenSynced = new Promise<void>(() => undefined);
    mocks.providers.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the original deadline when a barrier cannot yet be sent", async () => {
    const bundle = createCollaboration("workspace", "page", 1, vi.fn());
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

  it("handles collaboration connection failures after IndexedDB sync", async () => {
    mocks.whenSynced = Promise.resolve();
    const onStatus = vi.fn();
    const error = new Error("token refresh failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bundle = createCollaboration("workspace", "page", 1, onStatus);
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
});
