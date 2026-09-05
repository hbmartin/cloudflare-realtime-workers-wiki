import { describe, expect, it } from "vitest";
import { createZip, readZip } from "./zip";

describe("ZIP utilities", () => {
  it("round-trips portable stored archives", async () => {
    const zip = createZip([
      { path: "Page.md", bytes: new TextEncoder().encode("# Page") },
      { path: "assets/image.png", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    await expect(readZip(zip)).resolves.toEqual([
      { path: "Page.md", bytes: new TextEncoder().encode("# Page") },
      { path: "assets/image.png", bytes: new Uint8Array([1, 2, 3]) },
    ]);
  });

  it("reads deflated entries and rejects traversal paths and expansion bombs", async () => {
    const name = new TextEncoder().encode("safe.txt");
    const plain = new TextEncoder().encode("compressed text");
    const compressed = new Uint8Array([75, 206, 207, 45, 40, 74, 45, 46, 78, 77, 81, 40, 73, 173, 40, 1, 0]);
    const stored = createZip([{ path: "safe.txt", bytes: plain }]);
    const centralOffset = 30 + name.byteLength + plain.byteLength;
    const endOffset = centralOffset + 46 + name.byteLength;
    const resized = new Uint8Array(stored.byteLength - plain.byteLength + compressed.byteLength);
    resized.set(stored.subarray(0, 30 + name.byteLength));
    resized.set(compressed, 30 + name.byteLength);
    resized.set(stored.subarray(centralOffset, endOffset), 30 + name.byteLength + compressed.byteLength);
    resized.set(stored.subarray(endOffset), 30 + name.byteLength + compressed.byteLength + 46 + name.byteLength);
    const output = new DataView(resized.buffer);
    output.setUint16(8, 8, true);
    output.setUint32(18, compressed.byteLength, true);
    const nextCentral = 30 + name.byteLength + compressed.byteLength;
    output.setUint16(nextCentral + 10, 8, true);
    output.setUint32(nextCentral + 20, compressed.byteLength, true);
    const nextEnd = nextCentral + 46 + name.byteLength;
    output.setUint32(nextEnd + 16, nextCentral, true);
    await expect(readZip(resized)).resolves.toEqual([{ path: "safe.txt", bytes: plain }]);

    expect(() => createZip([{ path: "../secret", bytes: plain }])).toThrow(/unsafe path/);
    const bomb = resized.slice();
    new DataView(bomb.buffer).setUint32(nextCentral + 24, compressed.byteLength * 201, true);
    await expect(readZip(bomb)).rejects.toThrow(/expands beyond/);
  });
});
