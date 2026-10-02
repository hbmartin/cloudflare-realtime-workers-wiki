import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { docxDocument, docxImages, docxPng } from "../../tests/helpers/docx";
import { projectDocument } from "../shared/document-projection";
import { createZip, readZip } from "../shared/zip";
import { docxHtmlToDocument } from "./docx-html";
import type { ProseMirrorJson } from "../shared/types";
import { readDocx, writeDocx } from "./docx";

const noImage = async () => null;

describe("DOCX conversion", () => {
  it("reads a fixture produced independently with python-docx", async () => {
    const bytes = await readFile(new URL("../../tests/fixtures/docx/rich-text.docx", import.meta.url));
    const imported = await readDocx(bytes);
    const json = JSON.stringify(imported.document);
    for (const label of ["Independent Word fixture", "Résumé 日本語", "First cell", "Second cell", "List item"])
      expect(json).toContain(label);
    for (const type of ["heading", "bold", "italic", "underline", "strike", "table", "bulletListItem", "image"])
      expect(json).toContain(`"type":"${type}"`);
    expect(imported.entries.size).toBe(1);
  });

  it.each(docxImages)("embeds and imports $mime images", async (asset) => {
    const output = await writeDocx(
      { type: "doc", content: [{ type: "image", attrs: { url: "/api/attachments/image", name: "Picture" } }] },
      "Images",
      "https://notes.test",
      async () => asset,
    );
    expect(output.warnings).toEqual([]);
    const imported = await readDocx(output.bytes);
    expect([...imported.entries.values()][0]?.bytes).toEqual(asset.bytes);
  });

  it("round-trips rich text, Unicode, nested lists, tables, breaks, and embedded images", async () => {
    const resolve = vi.fn(async () => ({ bytes: docxPng, mime: "image/png" }));
    const output = await writeDocx(docxDocument(), "Word fixture", "https://notes.test", resolve);
    expect(output.warnings).toEqual([]);
    expect(resolve).toHaveBeenCalledWith("/api/attachments/docx-image");
    const parts = await readZip(output.bytes);
    const xml = new TextDecoder().decode(parts.find((part) => part.path === "word/document.xml")!.bytes);
    expect(xml.match(/Word fixture/g)).toHaveLength(1);
    expect(parts.some((part) => part.path.startsWith("word/media/"))).toBe(true);
    const imported = await readDocx(output.bytes);
    const json = JSON.stringify(imported.document);
    for (const expected of [
      '"type":"heading"',
      '"type":"bold"',
      '"type":"italic"',
      '"type":"underline"',
      '"type":"strike"',
      '"type":"hardBreak"',
      '"type":"bulletListItem"',
      '"type":"numberedListItem"',
      '"type":"table"',
      '"type":"tableCell"',
      '"type":"image"',
      "Résumé 日本語",
      "https://example.com/",
    ])
      expect(json).toContain(expected);
    expect(imported.entries.size).toBe(1);
    expect([...imported.entries.values()][0]!.bytes).toEqual(docxPng);
    const text = projectDocument(imported.document).plainText;
    for (const label of ["Parent bullet", "Nested number", "Second number", "Cell A", "Cell B"])
      expect(text).toContain(label);
  });

  it("supports a blank document", async () => {
    const output = await writeDocx({ type: "doc", content: [] }, "Blank", "https://notes.test", noImage);
    expect(projectDocument((await readDocx(output.bytes)).document).plainText).toBe("");
  });

  it("preserves linked Word images as links without fetching them", async () => {
    const source = await writeDocx(docxDocument(), "Linked", "https://notes.test", async () => ({
      bytes: docxPng,
      mime: "image/png",
    }));
    const entries = await readZip(source.bytes);
    const relationships = entries.find((part) => part.path === "word/_rels/document.xml.rels")!;
    relationships.bytes = new TextEncoder().encode(
      new TextDecoder()
        .decode(relationships.bytes)
        .replace(/Target="media\/[^"]+"/g, 'Target="https://example.com/linked.png" TargetMode="External"'),
    );
    const imported = await readDocx(createZip(entries));
    expect(imported.entries.size).toBe(0);
    expect(JSON.stringify(imported.document)).toContain("https://example.com/linked.png");
    expect(imported.issues.some((issue) => issue.code === "docx_external_image_link")).toBe(true);
  });

  it("retains text in legacy table cells", async () => {
    const output = await writeDocx(
      {
        type: "doc",
        content: [
          {
            type: "blockContainer",
            content: [
              { type: "table" },
              {
                type: "blockGroup",
                content: [
                  {
                    type: "blockContainer",
                    content: [
                      {
                        type: "tableRow",
                        content: [{ type: "tableCell", content: [{ type: "text", text: "Legacy cell" }] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      "Legacy",
      "https://notes.test",
      noImage,
    );
    expect(JSON.stringify((await readDocx(output.bytes)).document)).toContain("Legacy cell");
  });

  it("preserves fallback source and links and reports unsupported images and custom blocks", async () => {
    const output = await writeDocx(
      {
        type: "doc",
        content: [
          { type: "image", attrs: { url: "https://example.com/picture.webp", name: "External picture" } },
          { type: "mermaid", attrs: { source: "flowchart LR; A --> B" } },
          { type: "linkedDiagram", attrs: { pageId: "map-id", title: "Architecture" } },
        ],
      },
      "Fallbacks",
      "https://notes.test",
      noImage,
    );
    expect(output.warnings).toHaveLength(3);
    const imported = await readDocx(output.bytes);
    const json = JSON.stringify(imported.document);
    expect(json).toContain("https://example.com/picture.webp");
    expect(json).toContain("flowchart LR; A --");
    expect(json).toContain("https://notes.test/?page=map-id");
  });

  it("does not embed unsupported or invalid image bytes", async () => {
    for (const mime of ["image/webp", "image/png"]) {
      const output = await writeDocx(docxDocument(), "Fallback", "https://notes.test", async () => ({
        bytes: new Uint8Array([1, 2]),
        mime,
      }));
      expect(output.warnings).toContain("Some images could not be embedded and were exported as labels or links.");
      expect((await readZip(output.bytes)).some((part) => part.path.startsWith("word/media/"))).toBe(false);
    }
  });

  it("rejects non-Word and corrupted archives", async () => {
    await expect(readDocx(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "invalid_docx" });
    await expect(readDocx(createZip([{ path: "notes.txt", bytes: new Uint8Array([1]) }]))).rejects.toMatchObject({
      code: "invalid_docx",
    });
    const output = await writeDocx({ type: "doc" }, "Corrupt", "https://notes.test", noImage);
    const entries = await readZip(output.bytes);
    const main = entries.find((entry) => entry.path === "word/document.xml")!;
    main.bytes = new TextEncoder().encode("<invalid/>");
    await expect(readDocx(createZip(entries))).rejects.toMatchObject({ code: "invalid_docx" });
  });

  it("rejects entity declarations and macro documents", async () => {
    const output = await writeDocx({ type: "doc" }, "Invalid", "https://notes.test", noImage);
    const entries = await readZip(output.bytes);
    const types = entries.find((entry) => entry.path === "[Content_Types].xml")!;
    const original = types.bytes;
    types.bytes = new TextEncoder().encode(
      `<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]>${new TextDecoder().decode(original)}`,
    );
    await expect(readDocx(createZip(entries))).rejects.toMatchObject({ code: "invalid_docx" });
    types.bytes = original;
    entries.push({ path: "word/vbaProject.bin", bytes: new Uint8Array([1]) });
    await expect(readDocx(createZip(entries))).rejects.toMatchObject({ code: "invalid_docx" });
  });

  it("rejects encrypted and excessive expanded archives before conversion", async () => {
    for (const scenario of ["encrypted", "oversized"]) {
      const bytes = createZip([{ path: "word/document.xml", bytes: new Uint8Array([1]) }]);
      const view = new DataView(bytes.buffer);
      const central = view.getUint32(bytes.byteLength - 6, true);
      if (scenario === "encrypted") view.setUint16(central + 8, 1, true);
      else {
        view.setUint16(central + 10, 8, true);
        view.setUint32(central + 24, 65 * 1024 * 1024, true);
      }
      await expect(readDocx(bytes)).rejects.toMatchObject({
        code: "invalid_docx",
        status: scenario === "encrypted" ? 422 : 413,
      });
    }
  });
});

const descendants = (node: ProseMirrorJson, type: string): ProseMirrorJson[] => [
  ...(node.type === type ? [node] : []),
  ...(node.content ?? []).flatMap((child) => descendants(child, type)),
];
describe("DOCX review regressions", () => {
  it("emits Word breaks and tabs, strips invalid XML text, and omits empty layout placeholders", async () => {
    const source = {
      type: "doc",
      content: [
        {
          type: "columnList",
          content: [
            {
              type: "column",
              content: [{ type: "codeBlock", content: [{ type: "text", text: "one\n\ttwo\u0001\ufffe" }] }],
            },
          ],
        },
        { type: "tableOfContents" },
        { type: "breadcrumb" },
        { type: "mermaid", attrs: { source: "a\nb\tc" } },
      ],
    };
    const output = await writeDocx(source, "Title\u0000", "https://notes.test", noImage);
    const xml = new TextDecoder().decode(
      (await readZip(output.bytes)).find((e) => e.path === "word/document.xml")!.bytes,
    );
    expect(xml).toContain("<w:br/>");
    expect(xml).toContain("<w:tab/>");
    expect(
      Array.from(xml).some(
        (character) =>
          character.charCodeAt(0) < 9 ||
          character === String.fromCharCode(0xfffe) ||
          character === String.fromCharCode(0xffff),
      ),
    ).toBe(false);
    expect(xml).not.toContain("[column");
    expect(xml).not.toContain("[tableOfContents]");
    const imported = await readDocx(output.bytes);
    expect(JSON.stringify(imported.document)).toContain('"type":"codeBlock"');
    expect(imported.issues.filter((i) => i.code === "docx_conversion_warning")).toEqual([]);
  });
  it("removes our generated title and retains an external Title paragraph and single-column layout", async () => {
    const output = await writeDocx(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] },
      "Export title",
      "https://notes.test",
      noImage,
    );
    const ours = await readDocx(output.bytes);
    expect(projectDocument(ours.document).plainText).toBe("Body");
    expect(ours.issues.some((i) => i.code === "docx_word_layout_simplified")).toBe(false);
    const parts = await readZip(output.bytes);
    const external = await readDocx(createZip(parts.filter((p) => p.path !== "docProps/custom.xml")));
    expect(projectDocument(external.document).plainText).toContain("Export title");
    expect(external.issues.some((i) => i.code === "docx_conversion_warning")).toBe(false);
  });
  it("resolves an alternate main part for conversion, content validation, and review warnings", async () => {
    const output = await writeDocx(docxDocument(), "Alternate", "https://notes.test", async () => ({
      bytes: docxPng,
      mime: "image/png",
    }));
    const parts = await readZip(output.bytes);
    for (const part of parts) {
      if (part.path === "word/document.xml") part.path = "word/main.xml";
      if (part.path === "word/_rels/document.xml.rels") part.path = "word/_rels/main.xml.rels";
      if (part.path === "_rels/.rels" || part.path === "[Content_Types].xml")
        part.bytes = new TextEncoder().encode(
          new TextDecoder().decode(part.bytes).replaceAll("word/document.xml", "word/main.xml"),
        );
    }
    const main = parts.find((p) => p.path === "word/main.xml")!;
    main.bytes = new TextEncoder().encode(
      new TextDecoder().decode(main.bytes).replace("<w:sectPr>", '<w:sectPr><w:cols w:num="2"/>'),
    );
    const result = await readDocx(createZip(parts));
    expect(projectDocument(result.document).plainText).toContain("Résumé 日本語");
    expect(result.entries.size).toBe(1);
    expect(result.issues.some((i) => i.code === "docx_word_layout_simplified")).toBe(true);
  });
  it("deduplicates repeated image assets", async () => {
    const output = await writeDocx(
      {
        type: "doc",
        content: Array.from({ length: 12 }, () => ({ type: "image", attrs: { url: "/api/attachments/image" } })),
      },
      "Repeated",
      "https://notes.test",
      async () => ({ bytes: docxPng, mime: "image/png" }),
    );
    const result = await readDocx(output.bytes);
    expect(descendants(result.document, "image")).toHaveLength(12);
    expect(result.entries.size).toBe(1);
  });
  it("preserves Word spans and expands imports into aligned continuation cells", async () => {
    const cell = (text: string, attrs = {}) => ({
      type: "tableCell",
      attrs,
      content: [{ type: "tableParagraph", content: [{ type: "text", text }] }],
    });
    const output = await writeDocx(
      {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              { type: "tableRow", content: [cell("A", { rowspan: 2, colspan: 2 }), cell("B")] },
              { type: "tableRow", content: [cell("C")] },
            ],
          },
        ],
      },
      "Merged",
      "https://notes.test",
      noImage,
    );
    const xml = new TextDecoder().decode(
      (await readZip(output.bytes)).find((e) => e.path === "word/document.xml")!.bytes,
    );
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    const table = descendants((await readDocx(output.bytes)).document, "table")[0]!;
    expect(table.content!.map((row) => row.content!.map((part) => projectDocument(part).plainText))).toEqual([
      ["A", "", "B"],
      ["", "", "C"],
    ]);
  });
  it("keeps list images, continuation text, and nested lists under their original bullet in reading order", () => {
    const result = docxHtmlToDocument(
      '<ul><li>Before<img src="asset"/>After<ul><li>Nested</li></ul>Tail</li><li>Second</li></ul>',
      new Set(["asset"]),
    );
    const roots = result.document.content![0]!.content!;
    expect(roots).toHaveLength(2);
    expect(roots[0]!.content![0]!.type).toBe("bulletListItem");
    const children = roots[0]!.content![1]!.content!;
    expect(children.map((child) => child.content![0]!.type)).toEqual([
      "image",
      "paragraph",
      "bulletListItem",
      "paragraph",
    ]);
    expect(projectDocument(roots[0]!).plainText).toMatch(/Before[\s\S]*After[\s\S]*Nested[\s\S]*Tail/);
  });
  it.each([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), new TextEncoder().encode("old .doc")])(
    "explains unsupported Word containers",
    async (bytes) => {
      await expect(readDocx(bytes)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("unencrypted .docx"),
      });
    },
  );
});
