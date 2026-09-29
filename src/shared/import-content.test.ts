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

  it.each(["*foo\\*", "_bar\\_"])("does not turn an escaped closing delimiter into formatting: %s", (source) => {
    const parsed = markdownToDocument(source);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([{ type: "text", text: source.replaceAll("\\", "") }]);
  });

  it.each(["**baz\\**", "__qux\\__"])("retains the visible text of ambiguous escaped runs: %s", (source) => {
    const content = markdownToDocument(source).document.content![0]!.content![0]!.content![0]!.content!;
    expect(content.map((node) => node.text).join("")).toBe(source.replaceAll("\\", "").slice(1, -1));
  });

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

  it("keeps nested bold inside an outer italic delimiter", () => {
    const content = markdownToDocument("*read the **important** part*").document.content![0]!.content![0]!.content![0]!
      .content!;
    expect(content).toEqual([
      { type: "text", text: "read the ", marks: [{ type: "italic" }] },
      { type: "text", text: "important", marks: [{ type: "italic" }, { type: "bold" }] },
      { type: "text", text: " part", marks: [{ type: "italic" }] },
    ]);
  });

  it.each([
    ["**bold *italic***", "italic"],
    ["*foo**bar*", "foo**bar"],
    ["*a***b**", "a"],
    ["*foo** bar", "foo"],
    ["*foo**\n", "foo"],
  ])("keeps italics at delimiter runs: %s", (source, italic) => {
    const content = markdownToDocument(source).document.content![0]!.content![0]!.content![0]!.content!;
    expect(content.some((node) => node.text === italic && node.marks?.[0]?.type === "italic")).toBe(true);
  });

  it("keeps ambiguous delimiter runs readable without duplicate marks", () => {
    const content = markdownToDocument("*a**b**").document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "a*", marks: [{ type: "italic" }] },
      { type: "text", text: "b", marks: [{ type: "italic" }] },
    ]);
  });

  it("keeps a strong span inside a matched italic span", () => {
    const content = markdownToDocument("*foo**bar**baz*").document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "foo", marks: [{ type: "italic" }] },
      { type: "text", text: "bar", marks: [{ type: "italic" }, { type: "bold" }] },
      { type: "text", text: "baz", marks: [{ type: "italic" }] },
    ]);
  });

  it("keeps two strong spans and the surrounding italic text", () => {
    const content = markdownToDocument("*Note: **foo** and **bar** are required*").document.content![0]!.content![0]!
      .content![0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "Note: ", marks: [{ type: "italic" }] },
      { type: "text", text: "foo", marks: [{ type: "italic" }, { type: "bold" }] },
      { type: "text", text: " and ", marks: [{ type: "italic" }] },
      { type: "text", text: "bar", marks: [{ type: "italic" }, { type: "bold" }] },
      { type: "text", text: " are required", marks: [{ type: "italic" }] },
    ]);
  });

  it("keeps links and code inside nested emphasis", () => {
    const linked = markdownToDocument("*see [docs](https://example.com) and **this** too*");
    const content = linked.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toContainEqual({
      type: "text",
      text: "docs",
      marks: [{ type: "italic" }, { type: "link", attrs: { href: "https://example.com" } }],
    });
    expect(linked.references).toEqual(["https://example.com"]);
    const code = markdownToDocument("*run `npm i` then **now** ok*").document.content![0]!.content![0]!.content![0]!
      .content!;
    expect(code).toContainEqual({ type: "text", text: "npm i", marks: [{ type: "italic" }, { type: "code" }] });
    expect(code).toContainEqual({ type: "text", text: "now", marks: [{ type: "italic" }, { type: "bold" }] });
  });

  it("rejects unsafe links inside emphasis and leaves spaced asterisks literal", () => {
    const unsafe = markdownToDocument("*see [bad](javascript:alert(1)) and **this** too*");
    expect(unsafe.issues).toEqual([{ code: "unsafe_url", detail: "javascript:alert(1)" }]);
    expect(unsafe.references).toEqual([]);
    const spaced = markdownToDocument("a * b **c** d * e").document.content![0]!.content![0]!.content![0]!.content!;
    expect(spaced).toEqual([
      { type: "text", text: "a * b " },
      { type: "text", text: "c", marks: [{ type: "bold" }] },
      { type: "text", text: " d * e" },
    ]);
  });

  it("recognizes a real opener after an escaped backslash", () => {
    const content = markdownToDocument("\\\\*a**b**c*").document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "\\" },
      { type: "text", text: "a", marks: [{ type: "italic" }] },
      { type: "text", text: "b", marks: [{ type: "italic" }, { type: "bold" }] },
      { type: "text", text: "c", marks: [{ type: "italic" }] },
    ]);
  });

  it("scans long unclosed emphasis with backslashes without backtracking", () => {
    const source = `**Path ${"\\alpha ".repeat(90)}`;
    const parsed = markdownToDocument(source);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([{ type: "text", text: source.trim() }]);
  });

  it("preserves literal backslashes inside HTML and autolinks", () => {
    const html = markdownToDocument('<div class="foo\\-bar">');
    expect(html.document.content![0]!.content![0]!.content![0]!.content).toEqual([
      { type: "text", text: '<div class="foo\\-bar">' },
    ]);
    const link = markdownToDocument("<https://example.com/a\\.b>");
    expect(link.references).toEqual(["https://example.com/a%5C.b"]);
    expect(link.document.content![0]!.content![0]!.content![0]!.content).toEqual([
      {
        type: "text",
        text: "https://example.com/a\\.b",
        marks: [{ type: "link", attrs: { href: "https://example.com/a%5C.b" } }],
      },
    ]);
  });

  it("bounds formatting work for an exceptionally long paragraph without dropping text", () => {
    const source = `**${"\\.".repeat(40_000)}`;
    const parsed = markdownToDocument(source);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toEqual([{ type: "text", text: `**${".".repeat(40_000)}` }]);
    expect(parsed.issues).toEqual([
      { code: "inline_markup_simplified", detail: "Long inline content was parsed in bounded sections." },
    ]);
    const plain = markdownToDocument("\\.".repeat(40_000));
    expect(plain.issues).toEqual([]);
    expect(plain.document.content![0]!.content![0]!.content![0]!.content).toEqual([
      { type: "text", text: ".".repeat(40_000) },
    ]);
  });

  it("keeps references and bounded work in heavily escaped content", () => {
    const source = `[child](Folder/child.md) ${"\\.".repeat(20_000)} <`;
    const parsed = markdownToDocument(source);
    expect(parsed.references).toEqual(["Folder/child.md"]);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content[0]).toEqual({
      type: "text",
      text: "child",
      marks: [{ type: "link", attrs: { href: "Folder/child.md" } }],
    });
    expect(content.map((node) => node.text).join("")).toContain(".".repeat(20_000));
    expect(parsed.issues).toContainEqual({
      code: "inline_markup_simplified",
      detail: "Long inline content was parsed in bounded sections.",
    });
  });

  it("keeps escaped backslashes in link and block image destinations", () => {
    const link = markdownToDocument(String.raw`[doc](folder\\_name/file.md)`);
    expect(link.references).toEqual(["folder%5C_name/file.md"]);
    const image = markdownToDocument(String.raw`![diagram](folder\\_name/file.png)`);
    expect(image.references).toEqual(["folder%5C_name/file.png"]);
  });

  it("preserves Slack and nested-path links when a long paragraph is simplified", () => {
    const suffix = "\\.".repeat(5_000);
    const parsed = markdownToDocument(
      `wow\\![Slack](<https://x.slack.com/a.b>) [child](Folder_(one)/Child.md) ${suffix}`,
    );
    expect(parsed.references).toEqual(["https://x.slack.com/a.b", "Folder_(one)/Child.md"]);
    expect(parsed.issues.some((issue) => issue.code === "image_not_imported")).toBe(false);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.content!.map((node) => node.text).join("")).toContain(
      "wow!Slack child",
    );
  });

  it("does not make escaped brackets or code-span examples into links in long content", () => {
    const parsed = markdownToDocument(
      "\\[example\\](wrong.md) `[code](also-wrong.md)` [real](right.md) " + "\\.".repeat(5_000),
    );
    expect(parsed.references).toEqual(["right.md"]);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toContainEqual({ type: "text", text: "[code](also-wrong.md)", marks: [{ type: "code" }] });
  });

  it("unescapes a block image label once", () => {
    const parsed = markdownToDocument(String.raw`![my\_diagram \*v2\*](x.png)`);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.attrs).toMatchObject({
      caption: "my_diagram *v2*",
      name: "my_diagram *v2*",
    });
  });

  it("keeps ordinary rich text above four kilobytes and long link destinations", () => {
    const ordinary = markdownToDocument(`${"word ".repeat(900)}**Important** <https://example.com>`);
    expect(ordinary.references).toEqual(["https://example.com"]);
    expect(ordinary.document.content![0]!.content![0]!.content![0]!.content).toContainEqual({
      type: "text",
      text: "Important",
      marks: [{ type: "bold" }],
    });
    const url = `https://example.com/${"a".repeat(4090)}`;
    expect(markdownToDocument(`[long](<${url}>) ${"word ".repeat(1800)}`).references).toContain(url);
  });

  it("keeps a large embedded block image as an image", () => {
    const data = `data:image/png;base64,${"A".repeat(8192)}`;
    const parsed = markdownToDocument(`![logo](${data})`);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.type).toBe("image");
    expect(parsed.references).toEqual([data]);
  });

  it("keeps a long inline data image from spilling its payload into text", () => {
    const data = `data:image/png;base64,${"A".repeat(50_000)}`;
    const parsed = markdownToDocument(`See ![chart](${data}) below`);
    expect(parsed.references).toContain(data);
    expect(parsed.issues).toContainEqual({ code: "image_not_imported", detail: data.slice(0, 120) });
    expect(JSON.stringify(parsed.document)).not.toContain("A".repeat(10_000));
  });

  it("keeps later and larger data images out of paragraph text", () => {
    const data = `data:image/png;base64,${"A".repeat(100_000)}`;
    const parsed = markdownToDocument(`See ![small](small.png) then ![large](${data}) below`);
    expect(parsed.references).toEqual(["small.png", data]);
    expect(JSON.stringify(parsed.document)).not.toContain("A".repeat(10_000));
  });

  it("recognizes an image after unmatched code punctuation and an escaped backslash", () => {
    const data = `data:image/png;base64,${"A".repeat(12_000)}`;
    const unmatched = markdownToDocument(`Press the \` key. See ![chart](${data}) below`);
    const escapedBackslash = markdownToDocument(String.raw`See \\![chart](${data}) below`);
    expect(unmatched.references).toContain(data);
    expect(escapedBackslash.references).toContain(data);
    expect(JSON.stringify(unmatched.document)).not.toContain("A".repeat(10_000));
  });

  it("keeps a long data-image example inside code as code", () => {
    const data = `data:image/png;base64,${"A".repeat(10_000)}`;
    const parsed = markdownToDocument(`\`example ![chart](${data})\``);
    expect(parsed.references).toEqual([]);
    expect(parsed.issues.some((issue) => issue.code === "image_not_imported")).toBe(false);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.content).toContainEqual({
      type: "text",
      text: `example ![chart](${data})`,
      marks: [{ type: "code" }],
    });
  });

  it("bounds a hostile image label before asking Marked to tokenize it", () => {
    const parsed = markdownToDocument(`![\\](${"<? ".repeat(20_000)}](img.png)`);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.type).toBe("paragraph");
  });

  it("keeps links that follow earlier link destinations near a long-content boundary", () => {
    const parsed = markdownToDocument(
      `[first](first.md) ${"word ".repeat(1634)}[second](https://example.com/second) ${"word ".repeat(1000)}`,
    );
    expect(parsed.references).toEqual(["first.md", "https://example.com/second"]);
    expect(JSON.stringify(parsed.document)).toContain("https://example.com/second");
  });

  it("keeps formatting after ordinary punctuation in a long paragraph", () => {
    const parsed = markdownToDocument(
      `2 * 3 = 6 and x < y in file_name ${"word ".repeat(1630)}**important** [source](source.md)`,
    );
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(content).toContainEqual({ type: "text", text: "important", marks: [{ type: "bold" }] });
    expect(parsed.references).toEqual(["source.md"]);
  });

  it.each(["2*3", "a<b", "arr](x", "2 ** 3", "<https://example.com/_next>"])(
    "keeps references after unmatched long-line punctuation: %s",
    (prefix) => {
      const parsed = markdownToDocument(`${prefix} ${"word ".repeat(1700)}[Spec](spec.md)`);
      expect(parsed.references).toContain("spec.md");
    },
  );

  it("keeps references in dense long paragraphs", () => {
    const links = Array.from({ length: 1_000 }, (_, index) => `[L${index}](file${index}.md)`).join(" ");
    const parsed = markdownToDocument(links);
    expect(parsed.references).toHaveLength(1_000);
    expect(parsed.references.at(-1)).toBe("file999.md");
  });

  it("bounds long paragraphs at whitespace without retrying the same section", () => {
    const parsed = markdownToDocument(`*${"a ".repeat(5_000)}[end](end.md)`);
    expect(parsed.references).toContain("end.md");
    expect(parsed.document.content![0]!.content![0]!.content![0]!.content!.map((node) => node.text).join("")).toContain(
      "end",
    );
  });

  it("keeps rich links and code when a long paragraph crosses a section boundary", () => {
    const parsed = markdownToDocument(`${"word ".repeat(1_700)}**[Title](page.md)** and \`code\``);
    const content = parsed.document.content![0]!.content![0]!.content![0]!.content!;
    expect(parsed.references).toContain("page.md");
    expect(content).toContainEqual({
      type: "text",
      text: "Title",
      marks: [{ type: "bold" }, { type: "link", attrs: { href: "page.md" } }],
    });
    expect(content).toContainEqual({ type: "text", text: "code", marks: [{ type: "code" }] });
  });

  it("keeps a link whose label crosses the long-content cut", () => {
    const parsed = markdownToDocument(`${"a".repeat(8170)} [see the full design doc](design.md) ${"b ".repeat(100)}*`);
    expect(parsed.references).toContain("design.md");
    expect(parsed.document.content![0]!.content![0]!.content![0]!.content).toContainEqual({
      type: "text",
      text: "see the full design doc",
      marks: [{ type: "link", attrs: { href: "design.md" } }],
    });
  });

  it("keeps a link after an unmatched bracket and a long title-bearing link", () => {
    const ordinary = markdownToDocument(
      `[0, 1) ${"word ".repeat(1630)}[link text here](https://example.com/x) ${"tail ".repeat(400)}*`,
    );
    expect(ordinary.references).toContain("https://example.com/x");
    const dense = markdownToDocument(`[${"<? ".repeat(1_000)}](doc.md "Design") ${"\\.".repeat(5_000)}`);
    expect(dense.references).toContain("doc.md");
  });

  it("keeps an escaped destination after dense markup", () => {
    const parsed = markdownToDocument(`[${"<? ".repeat(1_000)}](a\\)b) ${"\\.".repeat(5_000)}`);
    expect(parsed.references).toContain("a)b");
  });

  it("keeps a link when a dense-section boundary falls inside its destination", () => {
    const parsed = markdownToDocument(
      `${"\\.".repeat(100)} [doc](https://x.com/${"\\-".repeat(40)}) tail ${"x ".repeat(4200)}`,
    );
    expect(parsed.references).toContain(`https://x.com/${"-".repeat(40)}`);
  });

  it("keeps a link after dense escaped content without lexing the whole paragraph", () => {
    const parsed = markdownToDocument(`${"\\.".repeat(10_000)} [late](late.md)`);
    expect(parsed.references).toContain("late.md");
  });

  it("keeps links after unmatched backticks and backslashes in dense content", () => {
    const unmatched = markdownToDocument(`${"\\.".repeat(200)} it's [late](late.md) ${"x ".repeat(4200)}`);
    expect(unmatched.references).toContain("late.md");
    const code = markdownToDocument(`${"\\.".repeat(200)} \`C:\\ a\` [after](after.md) ${"x ".repeat(4200)}`);
    expect(code.references).toContain("after.md");
  });

  it("keeps a dense long link label without invoking recursive Marked label parsing", () => {
    const parsed = markdownToDocument(`[${"<? ".repeat(2_000)}](dense.md) ${"\\.".repeat(5_000)}`);
    expect(parsed.references).toContain("dense.md");
  });

  it("finishes malformed tags and escapes in a long paragraph", () => {
    const parsed = markdownToDocument(`${"<? ".repeat(30_000)} ${"\\.".repeat(30_000)}`);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.type).toBe("paragraph");
  });

  it("bounds memory for a paragraph of backtick delimiters", () => {
    const parsed = markdownToDocument("` ".repeat(100_001));
    expect(parsed.document.content![0]!.content![0]!.content![0]!.type).toBe("paragraph");
    expect(parsed.issues.some((issue) => issue.code === "inline_markup_simplified")).toBe(true);
  });

  it("finishes a long paragraph without spaces", () => {
    const parsed = markdownToDocument(`*${"a".repeat(1_000_000)}`);
    expect(
      parsed.document.content![0]!.content![0]!.content![0]!.content!.map((node) => node.text).join(""),
    ).toHaveLength(1_000_001);
  });

  it("keeps code-span brackets in a block image caption", () => {
    const parsed = markdownToDocument("![a `]` b](image.png)");
    expect(parsed.document.content![0]!.content![0]!.content![0]).toMatchObject({
      type: "image",
      attrs: { caption: "a `]` b", name: "a `]` b" },
    });
  });

  it("unescapes a literal backslash in a block image caption only once", () => {
    const parsed = markdownToDocument(String.raw`![a\\[b]](image.png)`);
    expect(parsed.document.content![0]!.content![0]!.content![0]).toMatchObject({
      type: "image",
      attrs: { caption: String.raw`a\[b]` },
    });
  });

  it("does not scan a trailing long paragraph as one block image", () => {
    const parsed = markdownToDocument(`![a](image.png) ${"*x ".repeat(3_000)})`);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.type).toBe("paragraph");
    expect(parsed.references).toContain("image.png");
  });

  it("rejects a malformed image destination with dense emphasis", () => {
    const parsed = markdownToDocument(`![a](x ${"*x ".repeat(20_000)})`);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.type).toBe("paragraph");
  });

  it.each([`![a](image.png "Smile :)")`, `![a](<image).png>)`, "![`C:\\`](image.png)"])(
    "keeps a block image with a valid quoted or escaped label: %s",
    (source) => {
      const parsed = markdownToDocument(source);
      expect(parsed.document.content![0]!.content![0]!.content![0]!.type).toBe("image");
    },
  );

  it("uses Marked link and code rules in long content", () => {
    const suffix = " word".repeat(1800);
    const parsed = markdownToDocument(`[Bob's notes](Bob's%20notes%20abc123.md) \`a\`\`b\` [Spec](spec.md)${suffix}`);
    expect(parsed.references).toEqual(["Bob's%20notes%20abc123.md", "spec.md"]);
    expect(parsed.document.content![0]!.content![0]!.content![0]!.content).toContainEqual({
      type: "text",
      text: "a``b",
      marks: [{ type: "code" }],
    });
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
