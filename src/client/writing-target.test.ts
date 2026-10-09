import { describe, expect, it } from "vitest";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { applyWriting, captureWritingTarget, targetSource, writingTargetState } from "./writing-target";
import { projectDocument } from "../shared/document-projection";

const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+" },
    blockContainer: { content: "paragraph blockGroup?", attrs: { id: { default: null } } },
    paragraph: { content: "inline*" },
    text: { group: "inline" },
    mention: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { label: { default: "Alice" }, entityId: { default: "alice" }, entityType: { default: "user" } },
    },
    dateMention: { inline: true, group: "inline", atom: true, attrs: { value: { default: "2026-10-09" } } },
  },
  marks: { bold: {}, link: { attrs: { href: {} } } },
});
const block = (id: string, text: string) =>
  schema.node("blockContainer", { id }, [schema.node("paragraph", null, text ? schema.text(text) : undefined)]);
const document = () =>
  schema.node(
    "doc",
    null,
    schema.node("blockGroup", null, [block("one", "Before target after"), block("two", "Second paragraph")]),
  );
describe("writing application", () => {
  it("captures mentions and dates with the same text and separators as server projection", () => {
    const doc = schema.node(
      "doc",
      null,
      schema.node(
        "blockGroup",
        null,
        schema.node("blockContainer", { id: "atoms" }, [
          schema.node("paragraph", null, [
            schema.text("A"),
            schema.node("mention"),
            schema.text("about "),
            schema.node("dateMention"),
            schema.text("meeting"),
          ]),
        ]),
      ),
    );
    const selected = captureWritingTarget(doc, 3, 3 + doc.firstChild!.firstChild!.firstChild!.content.size, 1);
    expect(selected.text).toBe("AAlice about 2026-10-09 meeting");
    expect(projectDocument(doc.toJSON()).plainText).toBe(selected.text);
    expect(targetSource(selected, "doc").scope.kind).toBe("selection");
    expect(() =>
      applyWriting(EditorState.create({ doc }).tr, selected, 1, "Replacement", "replace", new Set()),
    ).toThrow(/mention/);
    for (const from of [4, 11]) {
      const atomOnly = captureWritingTarget(doc, from, from + 1, 1);
      expect(atomOnly.text.trim()).not.toBe("");
      expect(targetSource(atomOnly, "doc").scope.kind).toBe("selection");
    }
  });
  it("preserves text outside an inline selection and formats the replacement", () => {
    const doc = document(),
      from = 10,
      to = 16;
    expect(doc.textBetween(from, to)).toBe("target");
    const target = captureWritingTarget(doc, from, to, 1);
    expect(targetSource(target, "doc").scope.kind).toBe("selection");
    const tr = EditorState.create({ doc }).tr;
    applyWriting(tr, target, 1, "**Replacement**", "replace", new Set());
    expect(tr.doc.textContent).toContain("Before ");
    expect(tr.doc.textContent).toContain("Replacement");
    expect(tr.doc.textContent).toContain(" after");
    expect(tr.doc.textContent).toContain("Second paragraph");
    expect(JSON.stringify(tr.doc.toJSON())).toContain('"type":"bold"');
    expect(tr.doc.textContent).not.toContain("target");
  });
  it("re-resolves an unchanged target when collaborators edit an earlier block", () => {
    const doc = document(),
      firstSize = doc.firstChild!.firstChild!.nodeSize;
    const target = captureWritingTarget(doc, firstSize + 3, firstSize + 9, 1);
    const updated = schema.node(
      "doc",
      null,
      schema.node("blockGroup", null, [
        block("one", "Longer content before the target"),
        block("two", "Second paragraph"),
      ]),
    );
    expect(writingTargetState(updated, target, 1).changed).toBe(false);
    const tr = EditorState.create({ doc: updated }).tr;
    applyWriting(tr, target, 1, "New", "replace", new Set());
    expect(tr.doc.textContent).toContain("Longer content before the target");
  });
  it("blocks changed, restored, missing, and protected targets", () => {
    const doc = document(),
      target = captureWritingTarget(doc, 10, 16, 1);
    const changed = schema.node(
      "doc",
      null,
      schema.node("blockGroup", null, [block("one", "Changed target"), block("two", "Second paragraph")]),
    );
    expect(() => applyWriting(EditorState.create({ doc: changed }).tr, target, 1, "New", "replace", new Set())).toThrow(
      /target changed/,
    );
    expect(() => applyWriting(EditorState.create({ doc }).tr, target, 2, "New", "replace", new Set())).toThrow(
      /restored/,
    );
    expect(() => applyWriting(EditorState.create({ doc }).tr, target, 1, "New", "replace", new Set(["one"]))).toThrow(
      /protected/,
    );
    const anchor = captureWritingTarget(doc, 10, 10, 1, "anchor");
    const removed = schema.node("doc", null, schema.node("blockGroup", null, block("two", "Second paragraph")));
    expect(() => applyWriting(EditorState.create({ doc: removed }).tr, anchor, 1, "New", "insert", new Set())).toThrow(
      /anchor/,
    );
  });
  it("appends whole-page output safely while blocking a stale replacement", () => {
    const doc = document(),
      target = captureWritingTarget(doc, 3, 3, 1);
    const updated = schema.node(
      "doc",
      null,
      schema.node("blockGroup", null, [block("one", "Changed"), block("two", "Second paragraph")]),
    );
    const tr = EditorState.create({ doc: updated }).tr;
    applyWriting(tr, target, 1, "Appended", "insert", new Set());
    expect(tr.doc.textContent).toBe("ChangedSecond paragraphAppended");
    expect(() => applyWriting(EditorState.create({ doc: updated }).tr, target, 1, "New", "replace", new Set())).toThrow(
      /target changed/,
    );
  });
});
