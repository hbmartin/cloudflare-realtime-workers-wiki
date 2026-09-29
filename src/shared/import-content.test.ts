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

  it("renders escaped Slack punctuation as literal text and keeps link labels intact", () => {
    const parsed = markdownToDocument(
      "Ship v1\\.2 \\- today\\! \\(see plan\\) and snake\\_case\\_x [Plan\\] draft](<https://example.com/plan>)",
    );
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "Ship v1.2 - today! (see plan) and snake_case_x " },
      { type: "text", text: "Plan] draft", marks: [{ type: "link", attrs: { href: "https://example.com/plan" } }] },
    ]);
  });

  it("keeps backslashes literal inside code spans while unescaping surrounding text", () => {
    const parsed = markdownToDocument("Before `\\d+\\.\\d+` then `a\\\\b` and `C:\\` after \\`literal\\`");
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "Before " },
      { type: "text", text: "\\d+\\.\\d+", marks: [{ type: "code" }] },
      { type: "text", text: " then " },
      { type: "text", text: "a\\\\b", marks: [{ type: "code" }] },
      { type: "text", text: " and " },
      { type: "text", text: "C:\\", marks: [{ type: "code" }] },
      { type: "text", text: " after `literal`" },
    ]);
  });

  it.each(["*foo\\*", "_bar\\_", "**baz\\**", "__qux\\__"])(
    "does not turn an escaped closing delimiter into formatting: %s",
    (source) => {
      const parsed = markdownToDocument(source);
      const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
      expect(content).toEqual([{ type: "text", text: source.replaceAll("\\", "") }]);
    },
  );

  it.each([
    ["\\**foo*", "*", "foo", ""],
    ["**a***b*", "a", "b", ""],
    ["*foo**", "", "foo", "*"],
    ["\\__foo_", "_", "foo", ""],
  ])("keeps italic spans adjacent to consumed delimiters: %s", (source, prefix, italic, suffix) => {
    const content = markdownToDocument(source).document.content![0]!.content![0]!.content![0]!.content!;
    expect(content.some((node) => node.text === italic && node.marks?.[0]?.type === "italic")).toBe(true);
    expect(content.map((node) => node.text).join("")).toBe(`${prefix}${italic}${suffix}`);
  });

  it("scans long unclosed emphasis with backslashes without backtracking", () => {
    const source = `**Path ${"\\alpha ".repeat(90)}`;
    const parsed = markdownToDocument(source);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([{ type: "text", text: source.trim() }]);
  });

  it.each([
    ["Folder_(one)/Child.md", "Folder_(one)/Child.md"],
    ["Folder_\\(one\\)/Child.md", "Folder_(one)/Child.md"],
    ["Folder%20(one)/Child.md", "Folder%20(one)/Child.md"],
    ['<Folder (one)/Child.md> "Child title"', "Folder (one)/Child.md"],
    ["Folder_(one)/Child.md 'Child title'", "Folder_(one)/Child.md"],
  ])("keeps the complete Markdown link destination: %s", (destination, expected) => {
    const parsed = markdownToDocument(`Read [child](${destination}) now.`);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "Read " },
      { type: "text", text: "child", marks: [{ type: "link", attrs: { href: expected } }] },
      { type: "text", text: " now." },
    ]);
  });

  it.each([
    ["Folder_(one)/Image.png", "Folder_(one)/Image.png"],
    ["Folder_\\(one\\)/Image.png", "Folder_(one)/Image.png"],
    ['<Folder (one)/Image.png> "Image title"', "Folder (one)/Image.png"],
  ])("keeps the complete block image destination: %s", (destination, expected) => {
    const parsed = markdownToDocument(`![diagram](${destination})`);
    const block = parsed.document.content![0]!.content![0]!.content![0]!;
    expect(block).toMatchObject({
      type: "image",
      attrs: { url: expected, caption: "diagram", name: "diagram" },
    });
    expect(parsed.references).toEqual([expected]);
    expect(parsed.issues).toEqual([]);
  });

  it("retains degraded inline images as ownership references", () => {
    const parsed = markdownToDocument("Before ![diagram](Folder_(one)/Image.png) after.");
    expect(parsed.references).toEqual(["Folder_(one)/Image.png"]);
    expect(parsed.issues).toEqual([{ code: "image_not_imported", detail: "Folder_(one)/Image.png" }]);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content.map((node) => node.text).join("")).toBe("Before diagram after.");
  });

  it("does not retain unsafe block image destinations as ownership evidence", () => {
    const parsed = markdownToDocument("![diagram](javascript:alert(1))");
    expect(parsed.references).toEqual([]);
    expect(parsed.issues).toEqual([{ code: "unsafe_url", detail: "javascript:alert(1)" }]);
  });

  it("drops executable HTML and unsafe links while retaining readable content", () => {
    const parsed = htmlToDocument(
      '<html><head><title>Safe</title><script>alert(1)</script></head><body><h1>Heading</h1><p>Hello <strong>world</strong> <a href="javascript:alert(1)">bad</a></p></body></html>',
    );
    expect(parsed.title).toBe("Safe");
    expect(JSON.stringify(parsed.document)).not.toContain("alert(1)");
    expect(JSON.stringify(parsed.document)).toContain("world");
    expect(parsed.issues).toEqual([{ code: "unsafe_url", detail: "javascript:alert(1)" }]);
    expect(parsed.references).toEqual([]);
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
  it("keeps line breaks and the blocks that hold them", () => {
    const inline = htmlToDocument("<p>alpha<br>beta</p>");
    const blocks = inline.document.content[0]!.content!.map((container) => container.content![0]!);
    expect(blocks[0]!.content!.map((node) => node.type ?? "text")).toEqual(["text", "hardBreak", "text"]);

    const breakOnly = htmlToDocument("<p><br></p>");
    expect(breakOnly.document.content[0]!.content).toHaveLength(1);
  });
});
