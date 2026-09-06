import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { csvToTable, documentToYjsUpdate, htmlToDocument, markdownToDocument, parseCsv } from "./import-content";

describe("import content", () => {
  it("maps Markdown blocks and round-trips them through Yjs", () => {
    const parsed = markdownToDocument(
      "# Hello\n\n**Bold** [safe](https://example.com)\n\n- [x] Done\n\n```mermaid\ngraph TD; A-->B\n```\n",
    );
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, documentToYjsUpdate(parsed.document));
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment("document-store"));
    expect(json.content?.[0]).toMatchObject({ type: "blockGroup" });
    expect(json.content?.[0]?.content?.[0]?.content?.[0]).toMatchObject({ type: "heading" });
    expect(JSON.stringify(json)).toContain("checkListItem");
    expect(JSON.stringify(json)).toContain("mermaid");
  });

  it("drops executable HTML and unsafe links while retaining readable content", () => {
    const parsed = htmlToDocument(
      '<html><head><title>Safe</title><script>alert(1)</script></head><body><h1>Heading</h1><p>Hello <strong>world</strong> <a href="javascript:alert(1)">bad</a></p></body></html>',
    );
    expect(parsed.title).toBe("Safe");
    expect(JSON.stringify(parsed.document)).not.toContain("alert(1)");
    expect(JSON.stringify(parsed.document)).toContain("world");
    expect(parsed.issues).toEqual([{ code: "unsafe_url", detail: "javascript:alert(1)" }]);
  });

  it("keeps NUL and lone-surrogate entities literal so imports round-trip through Yjs", () => {
    const parsed = htmlToDocument("<p>a&#xD800;b&#0;c&#x1F600;d&#65;</p>");
    const text = JSON.stringify(parsed.document);
    expect(text).toContain("a&#xD800;b&#0;c😀dA");
    expect(text).not.toContain("\\ud800");
    expect(text).not.toContain("\\u0000");
  });

  it("resets block and inline state at HTML block boundaries", () => {
    const parsed = htmlToDocument("<h1></h1><p><strong>Bold</p><p>Plain</p>");
    const containers = parsed.document.content?.[0]?.content ?? [];
    const blocks = containers.map((container) => container.content?.[0]);

    expect(blocks.map((block) => block?.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks[0]?.content?.[0]).toMatchObject({ text: "Bold", marks: [{ type: "bold" }] });
    expect(blocks[1]?.content?.[0]).toMatchObject({ text: "Plain" });
    expect(blocks[1]?.content?.[0]?.marks).toBeUndefined();
  });

  it("leaves unknown named HTML entities intact", () => {
    const parsed = htmlToDocument("<p>&constructor;</p>");
    expect(JSON.stringify(parsed.document)).toContain("&constructor;");
    expect(JSON.stringify(parsed.document)).not.toContain("function Object");
  });

  it("parses quoted CSV and conservatively infers table types", () => {
    expect(parseCsv('Name,Active,Score\n"A, one",yes,2\nB,no,3\n')).toEqual([
      ["Name", "Active", "Score"],
      ["A, one", "yes", "2"],
      ["B", "no", "3"],
    ]);
    expect(csvToTable("Name,Active,Score\nA,yes,2\nB,no,3\n")).toMatchObject({
      columns: [{ type: "text" }, { type: "checkbox" }, { type: "number" }],
      rows: [
        ["A", true, 2],
        ["B", false, 3],
      ],
    });
  });
});
