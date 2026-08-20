/**
 * These cover the assumptions the whole importer rests on. Each one was verified by
 * hand before the design was committed to; they live here so a BlockNote, Yjs, or
 * y-prosemirror upgrade that breaks one fails CI instead of silently producing pages
 * with no searchable text and no backlinks.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { projectDocument } from "../../src/shared/document-projection.ts";
import { mentionInlineConfig } from "../../src/shared/mention-spec.ts";
import {
  assignStableIds,
  createImportEditor,
  DOCUMENT_FRAGMENT,
  escapeHtml,
  htmlToBlocks,
  mentionHtml,
  writeBlocksToFragment,
} from "./blocks.mjs";

/** Mirrors what the Durable Object does in `compactOnce` before writing the D1 projection. */
function projectFragment(doc) {
  return projectDocument(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(DOCUMENT_FRAGMENT)));
}

describe("headless BlockNote conversion", () => {
  it("builds an editor and parses HTML with no browser", async () => {
    const editor = await createImportEditor();
    const blocks = await htmlToBlocks(
      editor,
      "<h1>Title</h1><p>Hello <strong>bold</strong></p><ul><li>a</li><li>b</li></ul><table><tr><td>x</td></tr></table>",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "bulletListItem",
      "bulletListItem",
      "table",
    ]);
  });

  it("round-trips a mention written as plain HTML into a page reference", async () => {
    const editor = await createImportEditor();
    const targetId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const html = `<p>See ${mentionHtml({ entityId: targetId, label: "Roadmap" })} for details.</p>`;
    const blocks = await htmlToBlocks(editor, html);
    const doc = new Y.Doc();
    await writeBlocksToFragment(editor, blocks, doc);

    const projection = projectFragment(doc);
    expect(projection.plainText).toContain("See Roadmap for details.");
    expect(projection.pageReferences).toEqual([{ targetId, excerpt: expect.stringContaining("Roadmap") }]);
  });

  it("treats a re-converted identical page as a no-op so a resumed import is free", async () => {
    // Converting again, not reusing the blocks: BlockNote mints a random id per block,
    // and those ids live in the Yjs document, so without stable ids a re-import would be
    // a real edit on every run even though the text never changed.
    const editor = await createImportEditor();
    const html = "<h1>Doc</h1><p>Hello <strong>world</strong></p><ul><li>one</li></ul>";
    const convert = async () => assignStableIds(await htmlToBlocks(editor, html), "source/page.html");
    const doc = new Y.Doc();

    const first = await writeBlocksToFragment(editor, await convert(), doc);
    expect(first.updates).toBeGreaterThan(0);

    const second = await writeBlocksToFragment(editor, await convert(), doc);
    expect(second.updates).toBe(0);
    expect(second.byteLength).toBe(first.byteLength);
  });

  it("derives block ids from the page, so two pages never collide", async () => {
    const editor = await createImportEditor();
    const html = "<p>Same text on both pages</p>";
    const left = assignStableIds(await htmlToBlocks(editor, html), "a.html");
    const right = assignStableIds(await htmlToBlocks(editor, html), "b.html");

    expect(left[0].id).not.toBe(right[0].id);
    expect(assignStableIds(await htmlToBlocks(editor, html), "a.html")[0].id).toBe(left[0].id);
  });

  it("keeps a mention projectable when the label is blank", async () => {
    // projectDocument drops any mention with an empty label, which would cost a
    // backlink with no error anywhere, so the helper substitutes a placeholder.
    const editor = await createImportEditor();
    const targetId = "11111111-2222-3333-4444-555555555555";
    const blocks = await htmlToBlocks(editor, `<p>${mentionHtml({ entityId: targetId, label: "   " })}</p>`);
    const doc = new Y.Doc();
    await writeBlocksToFragment(editor, blocks, doc);

    expect(projectFragment(doc).pageReferences).toEqual([{ targetId, excerpt: expect.any(String) }]);
  });
});

describe("mention html", () => {
  it("escapes attributes and text", () => {
    const html = mentionHtml({ entityId: 'a"b', label: "Tom & <Jerry>" });
    expect(html).toContain('data-entity-id="a&quot;b"');
    expect(html).toContain('data-label="Tom &amp; &lt;Jerry&gt;"');
    expect(html).not.toContain("<Jerry>");
  });

  it("uses the prop names the shared config declares", () => {
    // The data-* attribute names are derived from these prop names by BlockNote, so a
    // rename in the shared config has to be mirrored in mentionHtml.
    expect(Object.keys(mentionInlineConfig.propSchema)).toEqual(["entityType", "entityId", "label"]);
  });

  it("escapes only what needs escaping", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});
