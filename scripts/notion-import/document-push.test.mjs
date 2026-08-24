import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DOCUMENT_FRAGMENT } from "./blocks.mjs";
import { connectedProjectionHash, settledProjectionHash } from "./document-push.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("settledProjectionHash", () => {
  it("waits for a quiet period and removes its listener exactly once", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const provider = new EventEmitter();
    provider.wsconnected = true;
    const off = vi.spyOn(doc, "off");
    let resolved = false;
    const hash = settledProjectionHash(doc, { quietMs: 10, maxWaitMs: 50, provider }).then((value) => {
      resolved = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(9);
    expect(resolved).toBe(false);
    doc.getMap("metadata").set("updated", true);
    await vi.advanceTimersByTimeAsync(9);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(hash).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(off).toHaveBeenCalledTimes(1);
    expect(provider.listenerCount("connection-close")).toBe(0);
    expect(provider.listenerCount("connection-error")).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(off).toHaveBeenCalledTimes(1);
    doc.destroy();
  });

  it("uses the maximum deadline while updates keep resetting the quiet timer", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const off = vi.spyOn(doc, "off");
    let resolved = false;
    const hash = settledProjectionHash(doc, { quietMs: 10, maxWaitMs: 25 }).then((value) => {
      resolved = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(9);
    doc.getMap("metadata").set("update-1", true);
    await vi.advanceTimersByTimeAsync(9);
    doc.getMap("metadata").set("update-2", true);
    await vi.advanceTimersByTimeAsync(6);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(hash).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(off).toHaveBeenCalledTimes(1);
    doc.destroy();
  });

  it.each([
    ["connection-close", { code: 4411 }, /page was deleted/],
    ["connection-error", undefined, /connection failed/],
  ])("rejects when the provider emits %s before settlement", async (event, detail, message) => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const provider = new EventEmitter();
    const off = vi.spyOn(doc, "off");
    const hash = settledProjectionHash(doc, { quietMs: 10, maxWaitMs: 50, provider });

    provider.emit(event, detail);

    await expect(hash).rejects.toThrow(message);
    expect(off).toHaveBeenCalledTimes(1);
    expect(provider.listenerCount("connection-close")).toBe(0);
    expect(provider.listenerCount("connection-error")).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(off).toHaveBeenCalledTimes(1);
    doc.destroy();
  });

  it.each([
    ["map", () => new Y.Map()],
    ["array", () => new Y.Array()],
  ])("rejects a projection failure for an unexpected Yjs %s", async (_name, unexpectedType) => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getXmlFragment(DOCUMENT_FRAGMENT).insert(0, [unexpectedType()]);
    const off = vi.spyOn(doc, "off");
    const hash = settledProjectionHash(doc, { quietMs: 10, maxWaitMs: 50 });
    const outcome = hash.then(
      () => null,
      (error) => error,
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBeInstanceOf(Error);
    expect(off).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(off).toHaveBeenCalledTimes(1);
    doc.destroy();
  });
});

describe("connectedProjectionHash", () => {
  it("returns the synchronized hash without waiting for a quiet-period timer", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const provider = new EventEmitter();
    provider.wsconnected = true;

    await expect(connectedProjectionHash(provider, doc)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(vi.getTimerCount()).toBe(0);
    expect(provider.listenerCount("connection-close")).toBe(0);
    expect(provider.listenerCount("connection-error")).toBe(0);
    doc.destroy();
  });

  it.each([
    ["connection-close", { code: 4411 }, /page was deleted/],
    ["connection-error", undefined, /connection failed/],
  ])("rejects when the provider emits %s while hashing", async (event, detail, message) => {
    const doc = new Y.Doc();
    const provider = new EventEmitter();
    provider.wsconnected = true;
    const hash = connectedProjectionHash(provider, doc);

    provider.emit(event, detail);

    await expect(hash).rejects.toThrow(message);
    expect(provider.listenerCount("connection-close")).toBe(0);
    expect(provider.listenerCount("connection-error")).toBe(0);
    doc.destroy();
  });
});
