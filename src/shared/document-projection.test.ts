import { describe, expect, it } from "vitest";
import { projectDocument, serializeDocument, type ProseMirrorJson } from "./document-projection";

function document(...content: ProseMirrorJson[]): ProseMirrorJson {
  return { type: "doc", content };
}

describe("structured document projection", () => {
  it("extracts nested rich text, links, and literal angle brackets", () => {
    const projection = projectDocument(
      document(
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Math says 1 < 2", marks: [{ type: "bold" }] },
            {
              type: "text",
              text: " and links stay readable",
              marks: [{ type: "link", attrs: { href: "https://example.test" } }],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Nested item" }] }] },
          ],
        },
      ),
    );

    expect(projection.plainText).toBe("Math says 1 < 2 and links stay readable Nested item");
  });

  it("collects and deduplicates page and member mentions with nearby excerpts", () => {
    const projection = projectDocument(
      document({
        type: "paragraph",
        content: [
          { type: "text", text: "Review " },
          { type: "mention", attrs: { entityType: "page", entityId: "page-1", label: "Roadmap" } },
          { type: "text", text: " with " },
          { type: "mention", attrs: { entityType: "user", entityId: "user-1", label: "Ada" } },
          { type: "text", text: " before launch. See " },
          { type: "mention", attrs: { entityType: "page", entityId: "page-1", label: "Roadmap" } },
        ],
      }),
    );

    expect(projection.plainText).toBe("Review Roadmap with Ada before launch. See Roadmap");
    expect(projection.pageReferences).toHaveLength(1);
    expect(projection.pageReferences[0]).toMatchObject({ targetId: "page-1" });
    expect(projection.pageReferences[0]!.excerpt).toContain("Review Roadmap with Ada");
    expect(projection.memberMentions).toHaveLength(1);
    expect(projection.memberMentions[0]!.excerpt).toContain("Roadmap with Ada before launch");
  });

  it("normalizes whitespace without joining separate blocks", () => {
    const projection = projectDocument(
      document(
        { type: "paragraph", content: [{ type: "text", text: "  first\n\tline " }] },
        { type: "paragraph", content: [{ type: "text", text: " second   line " }] },
      ),
    );
    expect(projection.plainText).toBe("first line second line");
  });

  it("preserves text around literal null characters", () => {
    const projection = projectDocument(
      document({
        type: "paragraph",
        content: [{ type: "text", text: "before\u0000keep this searchable\u0000after" }],
      }),
    );
    expect(projection.plainText).toContain("before\u0000keep this searchable\u0000after");
  });

  it("ignores incomplete mention nodes", () => {
    const projection = projectDocument(
      document({
        type: "paragraph",
        content: [
          { type: "mention", attrs: { entityType: "page", label: "Missing id" } },
          { type: "mention", attrs: { entityType: "page", entityId: "missing-label" } },
        ],
      }),
    );
    expect(projection.pageReferences).toEqual([]);
    expect(projection.memberMentions).toEqual([]);
  });

  it("retains the text limit while still discovering later references", () => {
    const projection = projectDocument(
      document({
        type: "paragraph",
        content: [
          { type: "text", text: "x".repeat(500_100) },
          { type: "mention", attrs: { entityType: "page", entityId: "late-page", label: "Late" } },
        ],
      }),
    );
    expect(projection.plainText).toHaveLength(500_000);
    expect(projection.pageReferences.map((item) => item.targetId)).toEqual(["late-page"]);
    expect(projection.pageReferences[0]!.excerpt).toContain("Late");
  });

  it("serializes custom nodes and neutralizes unsafe links and unknown nodes", () => {
    const serialized = serializeDocument(
      document(
        {
          type: "callout",
          attrs: { icon: "!", tone: "warning" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Heads up" }] }],
        },
        { type: "math", attrs: { formula: "x < y" } },
        { type: "mermaid", attrs: { source: "graph TD; A-->B" } },
        { type: "bookmark", attrs: { title: "Unsafe", url: "javascript:alert(1)" } },
        { type: "futureWidget", content: [{ type: "text", text: "<still readable>" }] },
      ),
    );

    expect(serialized.markdown).toContain("> ! Heads up");
    expect(serialized.markdown).toContain("```mermaid");
    expect(serialized.html).toContain('class="callout callout-warning"');
    expect(serialized.html).toContain("x &lt; y");
    expect(serialized.html).not.toContain("javascript:");
    expect(serialized.html).toContain('data-unsupported-node="futureWidget"');
    expect(serialized.html).toContain("&lt;still readable&gt;");
  });
});
