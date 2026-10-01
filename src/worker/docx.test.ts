import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { docxDocument, docxImages, docxPng } from "../../tests/helpers/docx";
import { projectDocument } from "../shared/document-projection";
import { createZip, readZip } from "../shared/zip";
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
    expect(projectDocument((await readDocx(output.bytes)).document).plainText).toContain("Blank");
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
