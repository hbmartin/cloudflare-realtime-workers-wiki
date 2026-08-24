import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DOCUMENT_FRAGMENT } from "./blocks.mjs";
import { settledProjectionHash } from "./document-push.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("settledProjectionHash", () => {
  it("waits for a quiet period and removes its listener exactly once", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const off = vi.spyOn(doc, "off");
    let resolved = false;
    const hash = settledProjectionHash(doc, { quietMs: 10, maxWaitMs: 50 }).then((value) => {
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
