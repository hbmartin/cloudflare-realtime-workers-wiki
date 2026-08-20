import { describe, expect, it } from "vitest";
import { canonicalJson, documentProjectionHash, tableContentHash } from "./import-integrity";

describe("import integrity", () => {
  it("canonicalizes object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, rows: ["second", "first"] })).toBe(
      '{"nested":{"a":1,"b":2},"rows":["second","first"],"z":1}',
    );
  });

  it("sorts and deduplicates projection targets before hashing", async () => {
    const left = await documentProjectionHash({
      plainText: "same",
      pageReferences: [
        { targetId: "b", excerpt: "ignored" },
        { targetId: "a", excerpt: "first" },
        { targetId: "a", excerpt: "duplicate" },
      ],
      memberMentions: [{ targetId: "user", excerpt: "ignored" }],
    });
    const right = await documentProjectionHash({
      plainText: "same",
      pageReferences: [
        { targetId: "a", excerpt: "" },
        { targetId: "b", excerpt: "" },
      ],
      memberMentions: [{ targetId: "user", excerpt: "" }],
    });
    expect(left).toBe(right);
  });

  it("distinguishes valid empty tables from one empty row", async () => {
    const columns = [{ name: "Name", type: "text", options: [] }];
    expect(await tableContentHash(columns, [])).not.toBe(await tableContentHash(columns, [[null]]));
  });
});
