import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { normalizeCodeBlockContent, normalizeYCodeBlocks } from "./code-content";
import { documentToYjsUpdate } from "./import-content";
import { validateDocumentTree } from "./document-validation";
import type { ProseMirrorJson } from "./types";

const annotation = { threadId: "thread", orphan: false };
function codeDocument(content: ProseMirrorJson[]) {
  return {
    type: "doc",
    content: [
      {
        type: "blockGroup",
        content: [
          {
            type: "blockContainer",
            attrs: { id: "code" },
            content: [{ type: "codeBlock", attrs: { language: "js" }, content }],
          },
        ],
      },
    ],
  };
}
function legacyDocument(content: ProseMirrorJson[]) {
  const document = new Y.Doc();
  Y.applyUpdate(document, documentToYjsUpdate(codeDocument(content)));
  const group = document.getXmlFragment("document-store").get(0) as Y.XmlElement;
  const code = (group.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  return { document, code };
}

describe("legacy code content normalization", () => {
  it("uses the persisted CJS patch to preserve same-thread aliases within one text and across texts", () => {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const Y = require("yjs"), { Schema } = require("prosemirror-model"), p = require("y-prosemirror");
      const schema = new Schema({ nodes: { doc: { content: "codeBlock+" }, codeBlock: { content: "text*" }, text: {} }, marks: { comment: { attrs: { threadId: { default: "" }, orphan: { default: false } }, excludes: "" } } });
      const results = [];
      for (const single of [false, true]) {
        const doc = new Y.Doc(), code = new Y.XmlElement("codeBlock"), attrs = { threadId: "same-thread", orphan: false };
        const runs = [{ insert: "left", attributes: { comment: attrs } }, { insert: "right", attributes: { "comment--0123abcd": attrs } }];
        const texts = single ? [new Y.XmlText()] : [new Y.XmlText(), new Y.XmlText()];
        if (single) texts[0].applyDelta(runs); else runs.forEach((run, index) => texts[index].applyDelta([run]));
        code.insert(0, texts); doc.getXmlFragment("document-store").insert(0, [code]);
        const { doc: pm, meta } = p.initProseMirrorDoc(doc.getXmlFragment("document-store"), schema);
        p.updateYFragment(doc, doc.getXmlFragment("document-store"), schema.node("doc", null, [schema.node("codeBlock", null, [schema.text("leXftright", pm.firstChild.firstChild.marks)])]), meta);
        results.push({ text: texts.map(text => text.toDelta().map(delta => delta.insert).join("")).join(""), keys: texts.flatMap(text => text.toDelta().flatMap(delta => Array.from({ length: delta.insert.length }, () => Object.keys(delta.attributes || {}).sort()))), identity: code.toArray().every((text, index) => text === texts[index]) });
      }
      console.log(JSON.stringify(results));
    `,
      ],
      { encoding: "utf8" },
    );
    for (const result of JSON.parse(output)) {
      expect(result.text).toBe("leXftright");
      expect(result.keys).toEqual([
        ...Array.from({ length: 5 }, () => ["comment"]),
        ...Array.from({ length: 5 }, () => ["comment--0123abcd"]),
      ]);
      expect(result.identity).toBe(true);
    }
  });
  it("uses the persisted CJS reader/writer patch when reconciling concurrent segmented code", () => {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const Y = require("yjs"), { Schema } = require("prosemirror-model"), p = require("y-prosemirror");
      const schema = new Schema({ nodes: { doc: { content: "codeBlock+" }, codeBlock: { content: "text*" }, text: {} } });
      const seed = new Y.Doc(), code = new Y.XmlElement("codeBlock");
      const texts = ["left", "\\n", "right"].map(value => { const text = new Y.XmlText(); text.insert(0, value); return text; });
      code.insert(0, texts); seed.getXmlFragment("document-store").insert(0, [code]);
      p.initProseMirrorDoc(seed.getXmlFragment("document-store"), schema);
      if (code.length !== 3) throw Error("Reader moved text identity");
      const bytes = Y.encodeStateAsUpdate(seed), docs = [new Y.Doc(), new Y.Doc()];
      for (const [index, doc] of docs.entries()) {
        Y.applyUpdate(doc, bytes);
        const fragment = doc.getXmlFragment("document-store"), { doc: pm, meta } = p.initProseMirrorDoc(fragment, schema);
        p.updateYFragment(doc, fragment, schema.node("doc", null, [schema.node("codeBlock", null, [schema.text(pm.textContent + (index ? " B" : " A"))])]), meta);
      }
      Y.applyUpdate(docs[0], Y.encodeStateAsUpdate(docs[1]));
      console.log(JSON.stringify({ text: p.yXmlFragmentToProseMirrorRootNode(docs[0].getXmlFragment("document-store"), schema).textContent, types: docs[0].getXmlFragment("document-store").get(0).length }));
    `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    expect(result.text).toMatch(/^left\nright (A B|B A)$/);
    expect(result.types).toBe(3);
  });
  it("preserves whitespace and both comment forms while stripping only known formatting and converting breaks", () => {
    const content = [
      {
        type: "text",
        text: "  const 😀 = 1;",
        marks: [
          { type: "bold" },
          { type: "link", attrs: { href: "https://example.test" } },
          { type: "comment", attrs: annotation },
          { type: "comment--legacy_thread", attrs: { ...annotation, threadId: "legacy" } },
        ],
      },
      { type: "hardBreak", marks: [{ type: "comment", attrs: annotation }] },
      { type: "text", text: "\tend\n" },
    ];
    const normalized = normalizeCodeBlockContent(content);
    expect(normalized).toEqual([
      {
        type: "text",
        text: "  const 😀 = 1;",
        marks: [
          { type: "comment", attrs: annotation },
          { type: "comment--legacy_thread", attrs: { ...annotation, threadId: "legacy" } },
        ],
      },
      { type: "text", text: "\n", marks: [{ type: "comment", attrs: annotation }] },
      { type: "text", text: "\tend\n" },
    ]);
    expect(content[0]!.marks).toHaveLength(4);
    validateDocumentTree(codeDocument(normalized));
    expect(normalizeCodeBlockContent(normalized)).toEqual(normalized);
  });

  it.each([
    { type: "mention", attrs: { label: "Do not guess my text" } },
    { type: "hardBreak", content: [{ type: "text", text: "hidden" }] },
    { type: "hardBreak", text: "hidden" },
    { type: "hardBreak", attrs: { label: "Do not discard me" } },
    { type: "text", text: "" },
    { type: "text", text: "text", attrs: { invalid: {} } },
    { type: "text", text: "text", marks: [{ type: "bold", attrs: { invalid: {} } }] },
    { type: "text", text: "text", marks: [{ type: "comment", attrs: { threadId: 1 } }] },
    { type: "text", text: "text", marks: [{ type: "unknown" }] },
  ])("rejects unsupported or malformed code content: %j", (node) => {
    expect(() => normalizeCodeBlockContent([node])).toThrow(/unsupported|invalid|unknown/);
  });

  it("keeps XmlText identity, relative anchors and raw annotations, and emits no update after the repair", () => {
    const { document, code } = legacyDocument([
      {
        type: "text",
        text: "  😀first",
        marks: [
          { type: "bold" },
          { type: "comment--0123abcd", attrs: annotation },
          { type: "comment--legacy_thread", attrs: annotation },
        ],
      },
      { type: "hardBreak" },
      { type: "text", text: "\tsecond\n", marks: [{ type: "textColor", attrs: { stringValue: "red" } }] },
    ]);
    const first = code.get(0) as Y.XmlText,
      last = code.get(2) as Y.XmlText;
    const outside = new Y.XmlElement("paragraph"),
      outsideText = new Y.XmlText();
    outsideText.insert(0, "Styled outside code");
    outsideText.format(0, 19, { bold: {} });
    outside.insert(0, [outsideText]);
    const outsideContainer = new Y.XmlElement("blockContainer");
    outsideContainer.setAttribute("id", "outside");
    outsideContainer.insert(0, [outside]);
    (document.getXmlFragment("document-store").get(0) as Y.XmlElement).insert(1, [outsideContainer]);
    const anchor = Y.createRelativePositionFromTypeIndex(first, 4),
      end = Y.createRelativePositionFromTypeIndex(last, 7);
    const updates: Uint8Array[] = [];
    document.on("update", (update) => updates.push(update));
    expect(normalizeYCodeBlocks(document)).toBe(true);
    expect(code.get(0)).toBe(first);
    expect(code.get(2)).toBe(last);
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, document)).toMatchObject({ type: first, index: 4 });
    expect(Y.createAbsolutePositionFromRelativePosition(end, document)).toMatchObject({ type: last, index: 7 });
    expect(first.toDelta()).toEqual([
      { insert: "  😀first", attributes: { "comment--0123abcd": annotation, "comment--legacy_thread": annotation } },
    ]);
    expect(last.toDelta()).toEqual([{ insert: "\tsecond\n" }]);
    expect(outsideText.toDelta()).toEqual([{ insert: "Styled outside code", attributes: { bold: {} } }]);
    const normalized = yXmlFragmentToProsemirrorJSON(document.getXmlFragment("document-store"));
    validateDocumentTree(normalized);
    expect(normalized.content![0]!.content![0]!.content![0]!.content!.map((node) => node.text).join("")).toBe(
      "  😀first\n\tsecond\n",
    );
    expect(updates).toHaveLength(1);
    expect(normalizeYCodeBlocks(document)).toBe(false);
    expect(updates).toHaveLength(1);
    document.destroy();
  });

  it("preflights all code before repair so unknown atoms cannot cause a partial rewrite", () => {
    const { document, code } = legacyDocument([{ type: "text", text: "known", marks: [{ type: "bold" }] }]);
    const other = new Y.XmlElement("codeBlock"),
      unknown = new Y.XmlElement("footnoteReference");
    other.insert(0, [unknown]);
    (document.getXmlFragment("document-store").get(0) as Y.XmlElement).insert(0, [other]);
    const before = Y.encodeStateAsUpdate(document);
    expect(() => normalizeYCodeBlocks(document)).toThrow(/unsupported/);
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
    expect((code.get(0) as Y.XmlText).toDelta()[0]!.attributes).toEqual({ bold: {} });
    document.destroy();
  });
});
