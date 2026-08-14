import { describe, expect, it } from "vitest";
import { joinBytes, splitBytes, UPDATE_CHUNK_BYTES } from "./bytes";

describe("Yjs update chunking", () => {
  it("round-trips an update larger than D1's two MiB row limit", () => {
    const update = new Uint8Array(UPDATE_CHUNK_BYTES * 2 + 417);
    for (let index = 0; index < update.length; index++) update[index] = index % 251;
    const chunks = splitBytes(update);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([UPDATE_CHUNK_BYTES, UPDATE_CHUNK_BYTES, 417]);
    expect(joinBytes(chunks)).toEqual(update);
  });

  it("rejects invalid chunk sizes", () => {
    expect(() => splitBytes(new Uint8Array([1]), 0)).toThrow("positive");
  });
});
