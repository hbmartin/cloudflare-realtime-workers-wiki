import { describe, expect, it } from "vitest";
import { normalizedTitle, titleSimilarity, titleTrigramMatch, titleTrigrams } from "./title-search";
describe("title typo candidates", () => {
  it("normalizes Unicode and compares overlapping trigrams", () => {
    expect(normalizedTitle("  Ｈｅｌｌｏ   World ")).toBe("hello world");
    expect(titleSimilarity("architecure", "Architecture")).toBeGreaterThan(0.5);
    expect(titleSimilarity("bananas", "Architecture")).toBe(0);
    expect(titleTrigrams("📝🧠🎉a")).toEqual(["📝🧠🎉", "🧠🎉a"]);
  });
  it("quotes independent trigrams and preserves short-query behavior", () => {
    expect(titleTrigramMatch("ab")).toBeNull();
    expect(titleTrigramMatch('a"bc')).toBe('"a""b" OR """bc"');
  });
});
