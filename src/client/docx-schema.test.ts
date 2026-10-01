// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";
import { notesSchema } from "./mentions";
import { docxHtmlToDocument, safeDocxHref } from "../worker/docx-html";

describe("DOCX HTML adapter", () => {
  it("creates valid blocks for the actual document editor schema", () => {
    const result = docxHtmlToDocument(
      `<h2>Heading</h2><p><strong><em><u><s>Rich</s></u></em></strong><br>text</p>
      <ul><li>Bullet<ol><li>Number</li><li>Next</li></ol></li></ul>
      <table><tr><th>Header</th><td><p>Cell</p><p>Second paragraph</p></td></tr></table>
      <p>Before<img src="docx-images/image.png" alt="Diagram">After</p>`,
      new Set(["docx-images/image.png"]),
    );
    const editor = BlockNoteEditor.create({ schema: notesSchema });
    const parsed = editor.pmSchema.nodeFromJSON(result.document);
    expect(() => parsed.check()).not.toThrow();
    editor.transact((transaction) => transaction.replaceWith(0, transaction.doc.content.size, parsed.content));
    expect(editor.document.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "bulletListItem",
      "table",
      "paragraph",
      "image",
      "paragraph",
    ]);
    expect(editor.document[2]?.children.map((block) => block.type)).toEqual(["numberedListItem", "numberedListItem"]);
    editor.unmount();
  });

  it("preserves empty paragraphs and basic tables and reports layout simplification", () => {
    const result = docxHtmlToDocument(
      '<p></p><table><tr><td colspan="2">Wide</td></tr><tr><td>A</td><td>B</td></tr></table>',
    );
    expect(result.document.content?.[0]?.content?.[0]?.content?.[0]?.type).toBe("paragraph");
    expect(result.issues).toContainEqual({ code: "docx_table_simplified", detail: "Merged or nested table cell" });
    const rows = result.document.content?.[0]?.content?.[1]?.content?.[0]?.content;
    expect(rows?.map((row) => row.content?.length)).toEqual([2, 2]);
  });

  it("preserves explicit trailing line breaks", () => {
    const result = docxHtmlToDocument("<p>Before<br></p>");
    const paragraph = result.document.content?.[0]?.content?.[0]?.content?.[0];
    expect(paragraph?.content?.at(-1)?.type).toBe("hardBreak");
  });

  it("retains list text inside a simplified table cell", () => {
    const result = docxHtmlToDocument("<table><tr><td><ul><li>First</li><li>Second</li></ul></td></tr></table>");
    expect(JSON.stringify(result.document)).toContain("First");
    expect(JSON.stringify(result.document)).toContain("Second");
    expect(result.issues.some((issue) => issue.code === "docx_table_simplified")).toBe(true);
  });

  it("keeps external images as links and removes unsafe links and script content", () => {
    const result = docxHtmlToDocument(
      '<p><a href="javascript:alert(1)">Label</a><img src="https://example.com/image.png" alt="Outside"></p><script>bad()</script>',
    );
    const json = JSON.stringify(result.document);
    expect(json).not.toContain("javascript:");
    expect(json).not.toContain("bad()");
    expect(json).toContain("https://example.com/image.png");
    expect(result.issues.map((issue) => issue.code)).toEqual(["unsafe_url", "docx_image_not_embedded"]);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "https://example.com\nunsafe",
    "https:\\evil.test",
  ])("rejects unsafe URL %s", (href) => {
    expect(safeDocxHref(href)).toBeNull();
  });
});
