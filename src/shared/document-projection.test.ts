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

  it("serializes inputs with more delimiter and table entries than a function call can spread", () => {
    const code = "`x".repeat(150_000);
    const rows = Array.from({ length: 150_000 }, () => ({ type: "tableRow", content: [] }));

    const serialized = serializeDocument(
      document(
        { type: "paragraph", content: [{ type: "text", text: code, marks: [{ type: "code" }] }] },
        { type: "table", content: rows },
      ),
    );

    expect(serialized.markdown).toContain(code);
    expect(serialized.markdown.endsWith("|  |\n")).toBe(true);
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

  it("serializes BlockNote wrapper nodes without flattening blocks or emitting unsupported wrappers", () => {
    const serialized = serializeDocument(
      document({
        type: "blockGroup",
        content: [
          {
            type: "blockContainer",
            attrs: { id: "one" },
            content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "First" }] }],
          },
          {
            type: "blockContainer",
            attrs: { id: "two" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }],
          },
        ],
      }),
    );

    expect(serialized.markdown).toBe("## First\n\nSecond\n");
    expect(serialized.html).toContain("<h2>First</h2><p>Second</p>");
    expect(serialized.html).not.toContain("data-unsupported-node");
  });
  it("keeps nested lists and header separators out of flattened text", () => {
    const serialized = serializeDocument({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "bulletListItem",
              content: [
                { type: "text", text: "Parent" },
                {
                  type: "bulletList",
                  content: [{ type: "bulletListItem", content: [{ type: "text", text: "Child" }] }],
                },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "text", text: "Name" }] },
                { type: "tableHeader", content: [{ type: "text", text: "Role" }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "text", text: "Ada" }] },
                { type: "tableCell", content: [{ type: "text", text: "Eng | Lead" }] },
              ],
            },
          ],
        },
      ],
    });

    expect(serialized.markdown).toContain("- Parent\n  - Child\n");
    expect(serialized.html).toContain("<ul><li>Parent<ul><li>Child</li></ul></li></ul>");
    expect(serialized.markdown).toContain("| Name | Role |\n| --- | --- |\n| Ada | Eng \\| Lead |\n");
  });

  it("keeps Markdown literals literal without escaping code spans", () => {
    const serialized = serializeDocument({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "# Not a heading and **not bold** and snake_case" }] },
        { type: "paragraph", content: [{ type: "text", text: "a*b", marks: [{ type: "code" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "really bold", marks: [{ type: "bold" }] }] },
      ],
    });

    expect(serialized.markdown).toContain("\\# Not a heading and \\*\\*not bold\\*\\* and snake_case");
    expect(serialized.markdown).toContain("`a*b`");
    expect(serialized.markdown).toContain("**really bold**");
  });

  it("escapes table delimiters inside code spans without double-escaping existing escapes", () => {
    const serialized = serializeDocument(
      document({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [{ type: "text", text: "Code" }] },
              { type: "tableHeader", content: [{ type: "text", text: "Already escaped" }] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [{ type: "text", text: "a|b", marks: [{ type: "code" }] }] },
              { type: "tableCell", content: [{ type: "text", text: "a\\|b", marks: [{ type: "code" }] }] },
            ],
          },
        ],
      }),
    );

    expect(serialized.markdown).toContain("| Code | Already escaped |\n| --- | --- |\n| `a\\|b` | `a\\|b` |\n");
  });

  it("uses a longer code-span delimiter when inline code contains backticks", () => {
    const serialized = serializeDocument(
      document({
        type: "paragraph",
        content: [{ type: "text", text: "call `nested` here", marks: [{ type: "code" }] }],
      }),
    );

    expect(serialized.markdown).toContain("``call `nested` here``");
  });

  it("synthesizes a header for headerless Markdown tables without dropping data", () => {
    const serialized = serializeDocument(
      document({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [{ type: "text", text: "Ada" }] },
              { type: "tableCell", content: [{ type: "text", text: "Engineer" }] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [{ type: "text", text: "Grace" }] },
              { type: "tableCell", content: [{ type: "text", text: "Admiral" }] },
            ],
          },
        ],
      }),
    );

    expect(serialized.markdown).toContain("|  |  |\n| --- | --- |\n| Ada | Engineer |\n| Grace | Admiral |\n");
  });

  it("rejects control characters in HTML and Markdown link destinations", () => {
    const serialized = serializeDocument(
      document({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "unsafe link",
            marks: [{ type: "link", attrs: { href: "https://example.test/path\n)\n# injected" } }],
          },
        ],
      }),
    );

    expect(serialized.markdown).toBe("unsafe link\n");
    expect(serialized.html).toContain("<p>unsafe link</p>");
    expect(serialized.markdown).not.toContain("# injected");
  });
});
