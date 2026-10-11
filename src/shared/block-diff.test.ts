import { describe, expect, it } from "vitest";
import { diffDocuments, digestExcerpts } from "./block-diff";
import type { ProseMirrorJson } from "./types";
function block(id: string, text: string, children: ProseMirrorJson[] = [], attrs: Record<string, unknown> = {}) {
  return {
    type: "blockContainer",
    attrs: { id },
    content: [
      { type: "paragraph", attrs, content: [{ type: "text", text }] },
      ...(children.length ? [{ type: "blockGroup", content: children }] : []),
    ],
  };
}
const doc = (...content: ProseMirrorJson[]): ProseMirrorJson => ({
  type: "doc",
  content: [{ type: "blockGroup", content }],
});
describe("structured document comparison", () => {
  it("compares own block content without duplicating child changes", () => {
    const before = doc(block("parent", "Heading", [block("child", "Old")]));
    const after = doc(block("parent", "Heading", [block("child", "New")]));
    expect(diffDocuments(before, after).changes).toEqual([
      { id: "child", kind: "modified", blockType: "paragraph", before: "Old", after: "New" },
    ]);
  });
  it("ignores cosmetic changes but detects destinations and custom properties", () => {
    expect(
      diffDocuments(
        doc(block("a", "Text", [], { textColor: "red" })),
        doc(block("a", "Text", [], { textColor: "blue" })),
      ).identical,
    ).toBe(true);
    expect(
      diffDocuments(
        doc(block("a", "Text", [], { url: "https://a.test" })),
        doc(block("a", "Text", [], { url: "https://b.test" })),
      ).counts.modified,
    ).toBe(1);
  });
  it("does not report sibling moves after additions or removals", () => {
    expect(
      diffDocuments(doc(block("a", "A"), block("b", "B")), doc(block("c", "C"), block("a", "A"), block("b", "B")))
        .counts,
    ).toEqual({ added: 1, removed: 0, modified: 0, moved: 0 });
  });
  it("reports reordering, reparenting and removed blocks", () => {
    const result = diffDocuments(
      doc(block("a", "A"), block("b", "B"), block("c", "C")),
      doc(block("b", "B", [block("a", "A")])),
    );
    expect(result.counts).toEqual({ added: 0, removed: 1, modified: 0, moved: 1 });
    expect(
      diffDocuments(doc(block("a", "A"), block("b", "B")), doc(block("b", "B"), block("a", "A"))).counts.moved,
    ).toBe(1);
  });
  it("bounds Unicode excerpts and reports an edit then revert as unchanged", () => {
    const before = doc(block("a", "Same"));
    expect(diffDocuments(before, before).identical).toBe(true);
    const changed = diffDocuments(doc(), doc(...["a", "b", "c", "d"].map((id) => block(id, "😀".repeat(300)))));
    expect(digestExcerpts(changed)).toHaveLength(3);
    expect(Array.from(digestExcerpts(changed)[0]!.after)).toHaveLength(240);
  });
});

it("ignores split bold text runs but preserves whitespace and link destinations", () => {
  const before = doc(block("a", "Hello world"));
  const after = doc({
    type: "blockContainer",
    attrs: { id: "a" },
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world", marks: [{ type: "bold" }] },
        ],
      },
    ],
  });
  expect(diffDocuments(before, after).identical).toBe(true);
  const linked = structuredClone(after);
  linked.content![0]!.content![0]!.content![0]!.content![1]!.marks = [
    { type: "link", attrs: { href: "https://new.test" } },
  ];
  expect(diffDocuments(before, linked).changes[0]?.after).toContain("Hello world");
  expect(diffDocuments(before, linked).changes[0]?.after).toContain("https://new.test");
});
it.each(["formula", "source", "pageId", "url", "name"])("detects meaningful %s changes", (property) => {
  expect(
    diffDocuments(doc(block("a", "", [], { [property]: "old" })), doc(block("a", "", [], { [property]: "new" }))).counts
      .modified,
  ).toBe(1);
});
