// @vitest-environment jsdom
import { BlockNoteEditor, mapTableCell, contentNodeToTableContent, tableContentToNodes } from "@blocknote/core";
import { TableHandlesExtension, TableHandlesView, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { CommentsExtension } from "@blocknote/core/comments";
import { withCollaboration } from "@blocknote/core/yjs";
import { Fragment, Schema, Slice } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import { describe, expect, it, vi } from "vitest";
import { notesCommentSchema, notesSchema } from "./mentions";
import { ServerThreadStore } from "./server-thread-store";
import { footnoteCatalog } from "../shared/editor-features";
import { documentToYjsUpdate, htmlToDocument, markdownToDocument } from "../shared/import-content";
import { serializeDocument } from "../shared/document-projection";
import { findTextMatches, replaceSearchRanges } from "./find-replace";
import { footnotesExtension, tabsExtension, tabsPluginKey, selectionInsideTabs } from "./editor-feature-blocks";
import { remapFeatureSlice } from "./editor-copy";
import { moveTabPanel, duplicateTabPanel } from "./tab-operations";
import { paginateBlocks } from "./presentation-layout";
import { updateHeadingIndex } from "./heading-index";
import * as Y from "yjs";
import {
  prosemirrorToYXmlFragment,
  ySyncPluginKey,
  yUndoPluginKey,
  yXmlFragmentToProsemirrorJSON,
  relativePositionToAbsolutePosition,
  assertSupportedCodeContent,
  observeUnsupportedCodeContent,
  UnsupportedCodeContentError,
  initProseMirrorDoc,
  updateYFragment,
} from "y-prosemirror";
import { validateDocumentTree } from "../shared/document-validation";
import { normalizeYCodeBlocks } from "../shared/code-content";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    atom: { inline: true, group: "inline", atom: true },
    hardBreak: { inline: true, group: "inline" },
  },
  marks: { bold: {}, italic: {} },
});
const search = { query: "cat", caseSensitive: false, wholeWord: false };

function segmentedCodeDocument(clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const group = new Y.XmlElement("blockGroup"),
    container = new Y.XmlElement("blockContainer"),
    code = new Y.XmlElement("codeBlock");
  container.setAttribute("id", "code");
  code.setAttribute("language", "javascript");
  const left = new Y.XmlText(),
    right = new Y.XmlText();
  left.insert(0, "left", { "comment--0123abcd": { threadId: "left-thread", orphan: true } });
  right.insert(0, "right", { comment: { threadId: "right-thread", orphan: true } });
  code.insert(0, [left, new Y.XmlElement("hardBreak"), right]);
  container.insert(0, [code]);
  const trailing = new Y.XmlElement("blockContainer");
  trailing.setAttribute("id", "trailing");
  trailing.insert(0, [new Y.XmlElement("paragraph")]);
  group.insert(0, [container, trailing]);
  doc.getXmlFragment("document-store").insert(0, [group]);
  normalizeYCodeBlocks(doc);
  return doc;
}
function codeElement(doc: Y.Doc) {
  return ((doc.getXmlFragment("document-store").get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
}
function mountSegmentedEditor(doc: Y.Doc) {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: notesSchema,
      extensions: [
        CommentsExtension({
          threadStore: new ServerThreadStore("page", "owner", () => {}),
          schema: notesCommentSchema,
          resolveUsers: async () => [],
        }),
      ],
      collaboration: { fragment: doc.getXmlFragment("document-store"), user: { name: "Test", color: "#123456" } },
    }),
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  editor.mount(host);
  return {
    editor,
    dispose: () => {
      editor.unmount();
      host.remove();
      doc.destroy();
    },
  };
}
function editCode(editor: ReturnType<typeof mountSegmentedEditor>["editor"], text: string, from: number, to = from) {
  editor.transact((tr) => {
    let start = -1;
    tr.doc.descendants((node, pos) => {
      if (node.type.name === "codeBlock") start = pos + 1;
    });
    if (start < 0) throw new Error("Code block missing");
    tr.insertText(text, start + from, start + to);
  });
}
function codeText(editor: ReturnType<typeof mountSegmentedEditor>["editor"]) {
  let text = "";
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === "codeBlock") text = node.textContent;
  });
  return text;
}
function codeMarkKeys(doc: Y.Doc) {
  return codeElement(doc)
    .toArray()
    .flatMap((node) =>
      (node as Y.XmlText)
        .toDelta()
        .flatMap((delta: { insert: string; attributes?: Record<string, unknown> }) =>
          Array.from({ length: delta.insert.length }, () => Object.keys(delta.attributes ?? {}).sort()),
        ),
    );
}

describe("segmented code collaboration", () => {
  it.each([false, true])("preflights queued observer mutations before binding reads (new block=%s)", (newBlock) => {
    const doc = segmentedCodeDocument(225),
      root = doc.getXmlFragment("document-store"),
      group = root.get(0) as Y.XmlElement,
      originalCode = codeElement(doc),
      paragraph = (group.get(1) as Y.XmlElement).get(0) as Y.XmlElement,
      plainText = new Y.XmlText();
    paragraph.insert(0, [plainText]);
    let armed = false,
      injected = false,
      expected: Uint8Array | undefined,
      rejectedText = originalCode.get(2) as Y.XmlText;
    const earlierObserver = () => {
      if (!armed || injected) return;
      injected = true;
      doc.transact(() => {
        if (newBlock) {
          const container = new Y.XmlElement("blockContainer"),
            code = new Y.XmlElement("codeBlock");
          rejectedText = new Y.XmlText();
          container.setAttribute("id", "queued-code");
          rejectedText.insert(0, "safe");
          code.insert(0, [rejectedText]);
          container.insert(0, [code]);
          group.insert(0, [container]);
        }
        // A supported Yjs falsy embed makes upstream schema.text throw. The
        // preflight must catch it before that recovery deletes shared text.
        rejectedText.insertEmbed(2, false);
      });
      expected = Y.encodeStateAsUpdate(doc);
    };
    root.observeDeep(earlierObserver);
    const mounted = mountSegmentedEditor(doc),
      errors: UnsupportedCodeContentError[] = [];
    const unsubscribe = observeUnsupportedCodeContent(doc, (error) => errors.push(error));
    try {
      plainText.insert(0, "prime ");
      armed = true;
      plainText.insert(0, "ordinary paragraph");
      expect(injected).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(UnsupportedCodeContentError);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(expected);
      expect(rejectedText.toDelta().some((delta: { insert: unknown }) => delta.insert === false)).toBe(true);
      expect(rejectedText.parent).toBeInstanceOf(Y.XmlElement);
      expect((rejectedText.parent as Y.XmlElement).toArray()).toContain(rejectedText);
      expect(mounted.editor.prosemirrorState.doc.textContent).not.toContain("ordinary paragraph");
    } finally {
      unsubscribe();
      root.unobserveDeep(earlierObserver);
      mounted.dispose();
    }
  });

  it("validates changed code scopes before observers without scanning unrelated code", () => {
    const doc = segmentedCodeDocument(224),
      root = doc.getXmlFragment("document-store"),
      group = root.get(0) as Y.XmlElement;
    const paragraph = (group.get(1) as Y.XmlElement).get(0) as Y.XmlElement,
      paragraphText = new Y.XmlText();
    paragraph.insert(0, [paragraphText]);
    const other = new Y.XmlElement("blockContainer"),
      otherCode = new Y.XmlElement("codeBlock"),
      otherText = new Y.XmlText();
    other.setAttribute("id", "other-code");
    otherText.insert(0, "untouched");
    otherCode.insert(0, [otherText]);
    other.insert(0, [otherCode]);
    group.insert(1, [other]);
    const mounted = mountSegmentedEditor(doc),
      code = codeElement(doc),
      changedText = code.get(0) as Y.XmlText;
    const originalInspect = vi.spyOn(changedText, "toDelta"),
      otherInspect = vi.spyOn(otherText, "toDelta");
    const observerCount = doc["_observers"].get("beforeObserverCalls")?.size ?? 0;
    try {
      paragraphText.insert(0, "paragraph only");
      doc.getMap("presence").set("cursor", 1);
      expect(originalInspect).not.toHaveBeenCalled();
      expect(otherInspect).not.toHaveBeenCalled();
      changedText.insert(1, "!");
      expect(originalInspect.mock.calls.length).toBeGreaterThan(0);
      expect(otherInspect).not.toHaveBeenCalled();
      originalInspect.mockClear();
      // Replacing a child is structural and must revisit every code scope.
      const added = new Y.XmlElement("blockContainer");
      added.setAttribute("id", "structural");
      added.insert(0, [new Y.XmlElement("paragraph")]);
      group.insert(2, [added]);
      expect(originalInspect.mock.calls.length).toBeGreaterThan(0);
      expect(otherInspect.mock.calls.length).toBeGreaterThan(0);
      originalInspect.mockClear();
      otherInspect.mockClear();
      const binding = ySyncPluginKey.getState(mounted.editor.prosemirrorState).binding;
      Reflect.get(binding, "_forceRerender").call(binding);
      expect(originalInspect.mock.calls.length).toBeGreaterThan(0);
      expect(otherInspect.mock.calls.length).toBeGreaterThan(0);
      mounted.editor.unmount();
      expect(doc["_observers"].get("beforeObserverCalls")?.size ?? 0).toBeLessThan(observerCount);
    } finally {
      originalInspect.mockRestore();
      otherInspect.mockRestore();
      mounted.dispose();
    }
  });

  it("rejects initial embedded code without deleting shared text", () => {
    const doc = segmentedCodeDocument(221),
      code = codeElement(doc);
    const text = code.get(2) as Y.XmlText;
    text.insertEmbed(2, { unsupported: "image" });
    const before = Y.encodeStateAsUpdate(doc),
      delta = text.toDelta();
    try {
      expect(() => mountSegmentedEditor(doc)).toThrow(UnsupportedCodeContentError);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(text.toDelta()).toEqual(delta);
      expect(code.get(2)).toBe(text);
    } finally {
      doc.destroy();
    }
  });

  it("latches an unsupported received update without rewriting it, then supports a repaired remount", () => {
    const doc = segmentedCodeDocument(222),
      mounted = mountSegmentedEditor(doc);
    const remote = new Y.Doc(),
      expected = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(expected, Y.encodeStateAsUpdate(doc));
    const text = codeElement(doc).get(2) as Y.XmlText;
    const anchor = Y.createRelativePositionFromTypeIndex(text, 1);
    const errors: UnsupportedCodeContentError[] = [];
    const unsubscribe = observeUnsupportedCodeContent(doc, (error) => errors.push(error));
    try {
      (codeElement(remote).get(2) as Y.XmlText).insertEmbed(2, { unsupported: "image" });
      const update = Y.encodeStateAsUpdate(remote);
      Y.applyUpdate(expected, update);
      Y.applyUpdate(doc, update);
      const rejectedBytes = Y.encodeStateAsUpdate(doc);
      expect(rejectedBytes).toEqual(Y.encodeStateAsUpdate(expected));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(UnsupportedCodeContentError);
      expect(codeText(mounted.editor)).toBe("left\nright");
      expect(codeElement(doc).get(2)).toBe(text);
      expect(Y.createAbsolutePositionFromRelativePosition(anchor, doc)?.type).toBe(text);
      editCode(mounted.editor, "blocked", 0);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(rejectedBytes);
      // Removing invalid content is an explicit API recovery operation, not a
      // binding rewrite. The old binding stays blocked until it is remounted.
      (codeElement(remote).get(2) as Y.XmlText).delete(2, 1);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
      expect(errors).toHaveLength(1);
      expect(() => assertSupportedCodeContent(doc.getXmlFragment("document-store"))).not.toThrow();
      mounted.editor.unmount();
      const replacement = mountSegmentedEditor(doc);
      try {
        expect(codeText(replacement.editor)).toBe("left\nright");
        editCode(replacement.editor, "!", 10);
        expect(codeText(replacement.editor)).toBe("left\nright!");
      } finally {
        replacement.dispose();
      }
    } finally {
      unsubscribe();
      mounted.dispose();
      remote.destroy();
      expected.destroy();
    }
  });

  it("rejects inconsistent code text length before writer mappings or attributes change", () => {
    const doc = segmentedCodeDocument(223),
      fragment = doc.getXmlFragment("document-store");
    const mounted = mountSegmentedEditor(doc);
    const { doc: pm, meta } = initProseMirrorDoc(fragment, mounted.editor.prosemirrorState.schema);
    const before = Y.encodeStateAsUpdate(doc),
      entries = [...meta.mapping.entries()];
    const text = codeElement(doc).get(2) as Y.XmlText;
    const delta = vi.spyOn(text, "toDelta").mockReturnValue([{ insert: "short!" }]);
    try {
      expect(() => updateYFragment(doc, fragment, pm, meta)).toThrow(UnsupportedCodeContentError);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect([...meta.mapping.entries()]).toEqual(entries);
    } finally {
      delta.mockRestore();
      mounted.dispose();
    }
  });

  it.each([false, true])(
    "preserves range-local aliases of one comment through Unicode edits, crossings and undo (single text %s)",
    (single) => {
      const doc = segmentedCodeDocument(111),
        code = codeElement(doc);
      const attrs = { threadId: "same-thread", orphan: true };
      const runs = [
        { insert: "L😀eft", attributes: { comment: attrs } },
        { insert: "\n" },
        { insert: "right", attributes: { "comment--0123abcd": attrs } },
      ];
      const texts = single ? [new Y.XmlText()] : runs.map(() => new Y.XmlText());
      if (single) texts[0]!.applyDelta(runs);
      else for (const [index, run] of runs.entries()) texts[index]!.applyDelta([run]);
      code.delete(0, code.length);
      code.insert(0, texts);
      const anchor = Y.createRelativePositionFromTypeIndex(texts.at(-1)!, single ? 11 : 4);
      const mounted = mountSegmentedEditor(doc),
        manager = yUndoPluginKey.getState(mounted.editor.prosemirrorState)!.undoManager;
      const originalKeys = codeMarkKeys(doc);
      try {
        manager.clear();
        editCode(mounted.editor, "X", 1);
        expect(codeText(mounted.editor)).toBe("LX😀eft\nright");
        expect(codeMarkKeys(doc)).toEqual([
          ...Array.from({ length: 7 }, () => ["comment"]),
          [],
          ...Array.from({ length: 5 }, () => ["comment--0123abcd"]),
        ]);
        expect(codeElement(doc).toArray()).toEqual(texts);
        expect(Y.createAbsolutePositionFromRelativePosition(anchor, doc)).toMatchObject({
          type: texts.at(-1),
          index: single ? 12 : 4,
        });
        manager.stopCapturing();
        editCode(mounted.editor, "Z", 2, 10);
        expect(codeText(mounted.editor)).toBe("LXZght");
        const keys = codeMarkKeys(doc);
        expect(keys.slice(0, 2)).toEqual([["comment"], ["comment"]]);
        expect(keys[2]).toHaveLength(1);
        expect(["comment", "comment--0123abcd"]).toContain(keys[2]![0]);
        expect(keys.slice(3)).toEqual(Array.from({ length: 3 }, () => ["comment--0123abcd"]));
        expect(codeElement(doc).toArray()).toEqual(texts);
        expect(Y.createAbsolutePositionFromRelativePosition(anchor, doc)).toMatchObject({
          type: texts.at(-1),
          index: single ? 5 : 2,
        });
        expect(mounted.editor.undo()).toBe(true);
        expect(codeText(mounted.editor)).toBe("LX😀eft\nright");
        expect(mounted.editor.undo()).toBe(true);
        expect(codeText(mounted.editor)).toBe("L😀eft\nright");
        expect(codeMarkKeys(doc)).toEqual(originalKeys);
        expect(codeElement(doc).toArray()).toEqual(texts);
        expect(Y.createAbsolutePositionFromRelativePosition(anchor, doc)).toMatchObject({
          type: texts.at(-1),
          index: single ? 11 : 4,
        });
        validateDocumentTree(mounted.editor.prosemirrorState.doc.toJSON());
      } finally {
        mounted.dispose();
      }
    },
  );
  it("preserves matching raw comments in single-text code and creates text in a truly empty code block", () => {
    for (const empty of [false, true]) {
      const doc = segmentedCodeDocument(111),
        code = codeElement(doc);
      code.delete(0, code.length);
      const text = new Y.XmlText();
      if (!empty) {
        text.insert(0, "first", { "comment--0123abcd": { threadId: "left-thread", orphan: true } });
        text.insert(5, "second", { comment: { threadId: "right-thread", orphan: true } });
        code.insert(0, [text]);
      }
      const mounted = mountSegmentedEditor(doc);
      try {
        editCode(mounted.editor, "X", empty ? 0 : 2);
        expect(codeText(mounted.editor)).toBe(empty ? "X" : "fiXrstsecond");
        expect(code.length).toBe(1);
        const actual = code.get(0) as Y.XmlText;
        expect(actual === text).toBe(!empty);
        expect(
          actual
            .toDelta()
            .flatMap((delta: { attributes?: Record<string, unknown> }) => Object.keys(delta.attributes ?? {})),
        ).toEqual(empty ? [] : ["comment--0123abcd", "comment"]);
      } finally {
        mounted.dispose();
      }
    }
  });
  it.each([
    [111, 999, false],
    [999, 111, false],
    [111, 999, true],
    [999, 111, true],
  ] as const)(
    "converges without moving text objects or duplicating tails (IDs %s/%s, reverse %s)",
    (firstID, secondID, reverse) => {
      const firstDoc = segmentedCodeDocument(firstID),
        secondDoc = new Y.Doc();
      secondDoc.clientID = secondID;
      Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(firstDoc));
      const firstTypes = codeElement(firstDoc).toArray(),
        secondTypes = codeElement(secondDoc).toArray();
      const position = Y.createRelativePositionFromTypeIndex(firstTypes[2] as Y.XmlText, 2);
      const first = mountSegmentedEditor(firstDoc),
        second = mountSegmentedEditor(secondDoc);
      try {
        expect(codeElement(firstDoc).toArray()).toEqual(firstTypes);
        expect(codeElement(secondDoc).toArray()).toEqual(secondTypes);
        editCode(first.editor, " A", 10);
        editCode(second.editor, " B", 10);
        const a = Y.encodeStateAsUpdate(firstDoc),
          b = Y.encodeStateAsUpdate(secondDoc);
        for (const [doc, update] of reverse
          ? ([
              [secondDoc, a],
              [firstDoc, b],
            ] as const)
          : ([
              [firstDoc, b],
              [secondDoc, a],
            ] as const))
          Y.applyUpdate(doc, update);
        expect(codeText(first.editor)).toMatch(/^left\nright (A B|B A)$/);
        expect(codeText(second.editor)).toBe(codeText(first.editor));
        expect(codeElement(firstDoc).toArray()).toEqual(firstTypes);
        expect(codeElement(secondDoc).toArray()).toEqual(secondTypes);
        expect(Y.createAbsolutePositionFromRelativePosition(position, firstDoc)).toMatchObject({
          type: firstTypes[2],
          index: 2,
        });
        expect(Y.createAbsolutePositionFromRelativePosition(position, secondDoc)).toMatchObject({
          type: secondTypes[2],
          index: 2,
        });
        expect((firstTypes[0] as Y.XmlText).toDelta()[0]!.attributes).toEqual({
          "comment--0123abcd": { threadId: "left-thread", orphan: true },
        });
        expect((firstTypes[2] as Y.XmlText).toDelta()[0]!.attributes).toEqual({
          comment: { threadId: "right-thread", orphan: true },
        });
        const binding = ySyncPluginKey.getState(first.editor.prosemirrorState)!.binding;
        expect(relativePositionToAbsolutePosition(firstDoc, binding.type, position, binding.mapping)).toBe(10);
        validateDocumentTree(first.editor.prosemirrorState.doc.toJSON());
      } finally {
        first.dispose();
        second.dispose();
      }
    },
  );
  it("keeps empty segments and their positions during crossing deletions, typing and undo", () => {
    const doc = segmentedCodeDocument(111),
      types = codeElement(doc).toArray();
    const tailPosition = Y.createRelativePositionFromTypeIndex(types[2] as Y.XmlText, 4);
    const mounted = mountSegmentedEditor(doc);
    const manager = yUndoPluginKey.getState(mounted.editor.prosemirrorState)!.undoManager;
    try {
      manager.clear();
      editCode(mounted.editor, "X", 2, 7);
      expect(codeText(mounted.editor)).toBe("leXght");
      expect(codeElement(doc).toArray()).toEqual(types);
      expect((types[1] as Y.XmlText).length).toBe(0);
      expect(Y.createAbsolutePositionFromRelativePosition(tailPosition, doc)).toMatchObject({
        type: types[2],
        index: 2,
      });
      expect(mounted.editor.undo()).toBe(true);
      expect(codeText(mounted.editor)).toBe("left\nright");
      expect(codeElement(doc).toArray()).toEqual(types);
      manager.stopCapturing();
      editCode(mounted.editor, "", 0, 10);
      expect(codeText(mounted.editor)).toBe("");
      expect(codeElement(doc).toArray()).toEqual(types);
      expect(types.map((type) => (type as Y.XmlText).length)).toEqual([0, 0, 0]);
      manager.stopCapturing();
      editCode(mounted.editor, "new", 0);
      expect(codeText(mounted.editor)).toBe("new");
      expect(codeElement(doc).toArray()).toEqual(types);
      expect(mounted.editor.undo()).toBe(true);
      expect(codeText(mounted.editor)).toBe("");
      expect(mounted.editor.undo()).toBe(true);
      expect(codeText(mounted.editor)).toBe("left\nright");
      expect(Y.createAbsolutePositionFromRelativePosition(tailPosition, doc)).toMatchObject({
        type: types[2],
        index: 4,
      });
    } finally {
      mounted.dispose();
    }
  });
  it.each([false, true])(
    "retains a remote edit in a segment emptied by a crossing deletion (reverse %s)",
    (reverse) => {
      const firstDoc = segmentedCodeDocument(111),
        secondDoc = new Y.Doc();
      secondDoc.clientID = 999;
      Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(firstDoc));
      const firstTypes = codeElement(firstDoc).toArray(),
        secondTypes = codeElement(secondDoc).toArray();
      const first = mountSegmentedEditor(firstDoc),
        second = mountSegmentedEditor(secondDoc);
      try {
        editCode(first.editor, "X", 2, 7);
        editCode(second.editor, "M", 5);
        const a = Y.encodeStateAsUpdate(firstDoc),
          b = Y.encodeStateAsUpdate(secondDoc);
        for (const [doc, update] of reverse
          ? ([
              [secondDoc, a],
              [firstDoc, b],
            ] as const)
          : ([
              [firstDoc, b],
              [secondDoc, a],
            ] as const))
          Y.applyUpdate(doc, update);
        expect(codeText(first.editor)).toBe("leXMght");
        expect(codeText(second.editor)).toBe(codeText(first.editor));
        expect(codeElement(firstDoc).toArray()).toEqual(firstTypes);
        expect(codeElement(secondDoc).toArray()).toEqual(secondTypes);
        expect((firstTypes[1] as Y.XmlText).toString()).toBe("M");
      } finally {
        first.dispose();
        second.dispose();
      }
    },
  );
  it("merges pending offline edits targeting original code text objects and retains stored comment selections", () => {
    const liveDoc = segmentedCodeDocument(111),
      offlineDoc = new Y.Doc();
    offlineDoc.clientID = 999;
    Y.applyUpdate(offlineDoc, Y.encodeStateAsUpdate(liveDoc));
    const liveTypes = codeElement(liveDoc).toArray(),
      offlineTypes = codeElement(offlineDoc).toArray();
    const selection = {
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(liveTypes[0] as Y.XmlText, 1)),
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(liveTypes[2] as Y.XmlText, 3)),
    };
    const live = mountSegmentedEditor(liveDoc),
      offline = mountSegmentedEditor(offlineDoc);
    try {
      editCode(live.editor, "!", 0);
      editCode(offline.editor, "?", 10);
      const pending = Y.encodeStateAsUpdate(offlineDoc, Y.encodeStateVector(liveDoc));
      Y.applyUpdate(liveDoc, pending);
      Y.applyUpdate(offlineDoc, Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(offlineDoc)));
      expect(codeText(live.editor)).toBe("!left\nright?");
      expect(codeText(offline.editor)).toBe(codeText(live.editor));
      expect(codeElement(liveDoc).toArray()).toEqual(liveTypes);
      expect(codeElement(offlineDoc).toArray()).toEqual(offlineTypes);
      expect(
        Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.head), liveDoc),
      ).toMatchObject({ type: liveTypes[0], index: 2 });
      expect(
        Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.anchor), liveDoc),
      ).toMatchObject({ type: liveTypes[2], index: 3 });
      expect((liveTypes[2] as Y.XmlText).toDelta()[0]!.attributes).toEqual({
        comment: { threadId: "right-thread", orphan: true },
      });
    } finally {
      live.dispose();
      offline.dispose();
    }
  });
});
describe("document editor features", () => {
  it.each([false, true])("loads imported code into the real collaborative editor schema (legacy: %s)", (legacy) => {
    const doc = new Y.Doc();
    const imported = htmlToDocument(
      '<pre><code>\n  <strong>first</strong><br><a href="https://example.test">second</a>\n</code></pre>',
    ).document;
    Y.applyUpdate(doc, documentToYjsUpdate(imported));
    const fragment = doc.getXmlFragment("document-store");
    const code = ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const text = code.get(0) as Y.XmlText;
    if (legacy) {
      text.format(0, text.length, { bold: {}, "comment--0123abcd": { threadId: "thread", orphan: false } });
      code.insert(1, [new Y.XmlElement("hardBreak")]);
    }
    expect(normalizeYCodeBlocks(doc)).toBe(legacy);
    expect(text.toDelta()[0]!.attributes ?? {}).toEqual(
      legacy ? { "comment--0123abcd": { threadId: "thread", orphan: false } } : {},
    );
    validateDocumentTree(yXmlFragmentToProsemirrorJSON(fragment));
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: notesSchema,
        extensions: [
          CommentsExtension({
            threadStore: new ServerThreadStore("page", "owner", () => {}),
            schema: notesCommentSchema,
            resolveUsers: async () => [],
          }),
        ],
        collaboration: { fragment, user: { name: "Test", color: "#123456" } },
      }),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      expect(() => editor.mount(host)).not.toThrow();
      expect(editor.prosemirrorState.doc.textContent).toBe(legacy ? "\n  \nfirst\nsecond\n" : "\n  first\nsecond\n");
      editor.prosemirrorState.doc.check();
      validateDocumentTree(editor.prosemirrorState.doc.toJSON());
      expect(JSON.stringify(editor.prosemirrorState.doc.toJSON()).includes('"threadId":"thread"')).toBe(legacy);
    } finally {
      editor.unmount();
      host.remove();
      doc.destroy();
    }
  });
  it("validates real editor comment annotations after Yjs normalizes their mark names, including code", () => {
    const doc = new Y.Doc();
    const editor = BlockNoteEditor.create({
      schema: notesSchema,
      extensions: [
        CommentsExtension({
          threadStore: new ServerThreadStore("page", "owner", () => {}),
          schema: notesCommentSchema,
          resolveUsers: async () => [],
        }),
      ],
      initialContent: [
        { id: "annotated-paragraph", type: "paragraph", content: "Commented text" },
        { id: "annotated-code", type: "codeBlock", content: "const value = 1;" },
      ],
    });
    try {
      editor.transact((tr) => {
        tr.doc.descendants((node, pos) => {
          if (node.isText)
            tr.addMark(pos, pos + node.nodeSize, editor.pmSchema.mark("comment", { threadId: "thread" }));
        });
      });
      editor.prosemirrorState.doc.check();
      const fragment = doc.getXmlFragment("document-store");
      prosemirrorToYXmlFragment(editor.prosemirrorState.doc, fragment);
      const restored = yXmlFragmentToProsemirrorJSON(fragment);
      const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [];
      const collect = (node: any) => {
        marks.push(...(node.marks ?? []));
        for (const child of node.content ?? []) collect(child);
      };
      collect(restored);
      expect(marks).toEqual([
        { type: "comment", attrs: { threadId: "thread", orphan: false } },
        { type: "comment", attrs: { threadId: "thread", orphan: false } },
      ]);
      expect(() => validateDocumentTree(restored)).not.toThrow();
      editor.pmSchema.nodeFromJSON(restored).check();
    } finally {
      editor.unmount();
      doc.destroy();
    }
  });
  it("mounts an empty collaborative document before its initial blocks receive IDs", () => {
    const doc = new Y.Doc();
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: notesSchema,
        extensions: [tabsExtension, footnotesExtension],
        collaboration: {
          fragment: doc.getXmlFragment("document-store"),
          user: { name: "Test", color: "#123456" },
        },
      }),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      expect(() => editor.mount(host)).not.toThrow();
      const initialDocument = editor.pmSchema.nodeFromJSON({
        type: "doc",
        content: [
          {
            type: "blockGroup",
            content: [{ type: "blockContainer", content: [{ type: "paragraph" }] }],
          },
        ],
      });
      expect(initialDocument.firstChild!.firstChild!.attrs.id).toBeNull();
      expect(() =>
        editor.transact((tr) => tr.replaceWith(0, tr.doc.content.size, initialDocument.content)),
      ).not.toThrow();
      const firstBlock = editor.document[0]!;
      expect(firstBlock.id).toBeTruthy();
      editor.updateBlock(firstBlock, { content: "Ready to edit" });
      expect(editor.prosemirrorState.doc.textContent).toBe("Ready to edit");
      validateDocumentTree(editor.prosemirrorState.doc.toJSON());
    } finally {
      editor.unmount();
      host.remove();
      doc.destroy();
    }
  });
  it("finds across formatting runs but not inline atoms or paragraphs", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("ca", [schema.mark("bold")]),
        schema.text("t cat"),
        schema.node("atom"),
        schema.text("catapult"),
      ]),
      schema.node("paragraph", null, schema.text("CAT café")),
    ]);
    expect(findTextMatches(doc, search)).toHaveLength(4);
    expect(findTextMatches(doc, { ...search, wholeWord: true })).toHaveLength(3);
    expect(findTextMatches(doc, { ...search, query: "tc" })).toEqual([]);
    expect(findTextMatches(doc, { ...search, query: "CAT", caseSensitive: true })).toHaveLength(1);
    expect(findTextMatches(doc, { ...search, query: "café", wholeWord: true })).toHaveLength(1);
  });
  it("replaces all from the end, preserving marks at each match and allowing deletion", () => {
    const doc = schema.node(
      "doc",
      null,
      schema.node("paragraph", null, [
        schema.text("cat ", [schema.mark("bold")]),
        schema.text("cat", [schema.mark("italic")]),
      ]),
    );
    const state = EditorState.create({ schema, doc });
    const tr = replaceSearchRanges(state.tr, findTextMatches(doc, search), "doggo");
    expect(tr.doc.textContent).toBe("doggo doggo");
    expect(tr.doc.firstChild!.firstChild!.marks[0]!.type.name).toBe("bold");
    expect(tr.doc.firstChild!.lastChild!.marks[0]!.type.name).toBe("italic");
    expect(replaceSearchRanges(state.tr, findTextMatches(doc, search), "").doc.textContent).toBe(" ");
  });
  it("round trips status, tabs and footnotes through the real editor schema and Yjs", () => {
    const editor = BlockNoteEditor.create({
      schema: notesSchema,
      extensions: [tabsExtension, footnotesExtension],
      initialContent: [
        {
          id: "tabs",
          type: "tabs",
          children: [
            {
              id: "a",
              type: "tabPanel",
              props: { label: "First" },
              children: [
                {
                  id: "p",
                  type: "paragraph",
                  content: [
                    { type: "statusBadge", props: { label: "Ready", color: "green" } },
                    { type: "footnoteReference", props: { definitionId: "note" } },
                  ],
                },
              ],
            },
            {
              id: "b",
              type: "tabPanel",
              props: { label: "Second" },
              children: [{ id: "q", type: "paragraph", content: "Hidden text" }],
            },
          ],
        },
        {
          id: "notes",
          type: "footnotes",
          children: [{ id: "d", type: "footnoteDefinition", props: { definitionId: "note" }, content: "Definition" }],
        },
      ],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    try {
      const json = editor.prosemirrorState.doc.toJSON();
      editor.pmSchema.nodeFromJSON(json).check();
      const doc = new Y.Doc();
      Y.applyUpdate(doc, documentToYjsUpdate(json));
      const restored = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("document-store"));
      expect(editor.pmSchema.nodeFromJSON(restored).toJSON()).toEqual(json);
      expect(footnoteCatalog(json).numbers.get("note")).toBe(1);
      editor.transact((tr) => tr.setMeta(tabsPluginKey, { tabsId: "tabs", panelId: "b" }));
      expect(tabsPluginKey.getState(editor.prosemirrorState)?.get("tabs")).toBe("b");
      expect(editor.prosemirrorState.doc.toJSON()).toEqual(json); // Active tab is local UI.
      let pos = 0;
      editor.prosemirrorState.doc.descendants((node, at) => {
        if (node.type.name === "paragraph" && node.textContent === "Hidden text") pos = at + 1;
      });
      editor.transact((tr) => tr.setMeta(tabsPluginKey, { tabsId: "tabs", panelId: "a" }));
      editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, pos)));
      expect(tabsPluginKey.getState(editor.prosemirrorState)?.get("tabs")).toBe("b");
      const copied = remapFeatureSlice(new Slice(Fragment.from(editor.prosemirrorState.doc.firstChild!), 0, 0));
      const copiedCatalog = footnoteCatalog(copied.content.firstChild!.toJSON());
      expect([...copiedCatalog.numbers.keys()]).toEqual([...copiedCatalog.definitions.keys()]);
      expect(copiedCatalog.numbers.has("note")).toBe(false);
      const sourceSlice = new Slice(Fragment.from(editor.prosemirrorState.doc.firstChild!), 0, 0);
      const view = editor.prosemirrorView;
      view.dragging = { slice: sourceSlice, move: true };
      try {
        const transform = footnotesExtension({ editor }).prosemirrorPlugins![0]!.props.transformPasted!;
        expect(transform.call(footnotesExtension({ editor }).prosemirrorPlugins![0]!, sourceSlice, view, false)).toBe(
          sourceSlice,
        );
      } finally {
        view.dragging = null;
      }
    } finally {
      editor.unmount();
      host.remove();
    }
  });
  it("keeps native row identities during tab changes and remaps copied native rows", () => {
    const editor = BlockNoteEditor.create({
      schema: notesSchema,
      extensions: [tabsExtension, footnotesExtension],
      initialContent: [
        {
          id: "tabs",
          type: "tabs",
          children: [
            {
              id: "a",
              type: "tabPanel",
              props: { label: "First" },
              children: [
                { id: "table", type: "table", content: { type: "tableContent", rows: [{ cells: ["Cell A"] }] } },
              ],
            },
            {
              id: "b",
              type: "tabPanel",
              props: { label: "Second" },
              children: [
                { type: "paragraph", content: [{ type: "footnoteReference", props: { definitionId: "outside" } }] },
              ],
            },
          ],
        },
      ],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    const rows = () => {
      const output: string[] = [];
      editor.prosemirrorState.doc.descendants((node) => {
        if (node.type.name === "tableRow") output.push(String(node.attrs.apiRowId));
      });
      return output;
    };
    try {
      editor.transact((tr) => {
        tr.doc.descendants((node, pos) => {
          if (node.type.name === "tableRow")
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, apiRowId: "original-row" });
        });
      });
      moveTabPanel(editor, "tabs", "a", 1);
      expect(editor.getBlock("tabs")!.children.map((panel) => panel.id)).toEqual(["b", "a"]);
      expect(rows()).toEqual(["original-row"]);
      editor.insertBlocks([{ id: "c", type: "tabPanel", children: [{ type: "paragraph" }] }], "a", "after");
      expect(rows()).toEqual(["original-row"]);
      const copyId = duplicateTabPanel(editor, "a")!;
      expect(copyId).not.toBe("a");
      expect(rows()).toHaveLength(2);
      expect(rows()[0]).toBe("original-row");
      expect(rows()[1]).not.toBe("original-row");
      editor.removeBlocks([copyId]);
      expect(rows()).toEqual(["original-row"]);
      const copiedRefId = duplicateTabPanel(editor, "b")!;
      const json = editor.prosemirrorState.doc.toJSON();
      expect(footnoteCatalog(json).numbers.has("outside")).toBe(true);
      expect(editor.getBlock(copiedRefId)!.children[0]!.id).not.toBe(editor.getBlock("b")!.children[0]!.id);
    } finally {
      editor.unmount();
      host.remove();
    }
  });
  it("retains native row identities through table controls and gives inserted copies fresh IDs", () => {
    const editor = BlockNoteEditor.create({
      schema: notesSchema,
      extensions: [footnotesExtension],
      initialContent: [
        {
          id: "table",
          type: "table",
          content: {
            type: "tableContent",
            rows: [
              { apiRowId: "row-a", cells: ["A", ""] },
              { apiRowId: "row-b", cells: ["B", ""] },
              { apiRowId: "row-c", cells: ["C", ""] },
            ],
          },
        },
      ],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    const table = () => {
      const block = editor.getBlock("table")!;
      if (block.type !== "table") throw new Error("Expected a table");
      return block;
    };
    const rowIds = () => table().content.rows.map((row) => row.apiRowId);
    const handles = editor.getExtension(TableHandlesExtension)!;
    const elementsFromPoint = vi.fn(() => []);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: elementsFromPoint });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
    const hover = () => host.querySelector("td, th")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    try {
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);
      editor.updateBlock(table(), { content: { ...table().content, headerRows: 1, headerCols: 1 } });
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);
      const colored = table().content.rows.map((row) => ({ ...row, cells: row.cells.map(mapTableCell) }));
      colored[0]!.cells[0]!.props.backgroundColor = "blue";
      editor.updateBlock(table(), { content: { ...table().content, rows: colored } } as never);
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);

      editor.updateBlock(table(), {
        content: { ...table().content, rows: handles.cropEmptyRowsOrColumns(table(), "columns") },
      } as never);
      expect(table().content.rows[0]!.cells).toHaveLength(1);
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);
      editor.updateBlock(table(), {
        content: { ...table().content, rows: handles.addRowsOrColumns(table(), "columns", 1) },
      } as never);
      editor.updateBlock(table(), {
        content: { ...table().content, rows: handles.addRowsOrColumns(table(), "rows", 1) },
      } as never);
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c", ""]);
      editor.updateBlock(table(), {
        content: { ...table().content, rows: handles.cropEmptyRowsOrColumns(table(), "rows") },
      } as never);
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);

      hover();
      handles.addRowOrColumn(0, { orientation: "row", side: "above" });
      expect(rowIds()).toEqual(["", "row-a", "row-b", "row-c"]);
      hover();
      handles.removeRowOrColumn(0, "row");
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);
      hover();
      handles.addRowOrColumn(0, { orientation: "column", side: "left" });
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);
      hover();
      handles.removeRowOrColumn(0, "column");
      hover();
      handles.mergeCells({ relativeStartCell: { row: 0, col: 0 }, relativeEndCell: { row: 1, col: 0 } });
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);
      hover();
      handles.splitCell({ row: 0, col: 0 });
      expect(rowIds()).toEqual(["row-a", "row-b", "row-c"]);

      const dragView = new TableHandlesView(editor as never, editor.prosemirrorView, () => {});
      try {
        dragView.state = {
          show: true,
          showAddOrRemoveRowsButton: false,
          showAddOrRemoveColumnsButton: false,
          referencePosCell: undefined,
          referencePosTable: new DOMRect(),
          widgetContainer: undefined,
          block: table(),
          rowIndex: 2,
          colIndex: 0,
          draggingState: { draggedCellOrientation: "row", originalIndex: 0, mousePos: 0 },
        };
        dragView.dropHandler({ preventDefault() {} } as DragEvent);
        expect(rowIds()).toEqual(["row-b", "row-c", "row-a"]);
        dragView.state = {
          ...dragView.state,
          block: table(),
          rowIndex: 0,
          colIndex: 1,
          draggingState: { draggedCellOrientation: "col", originalIndex: 0, mousePos: 0 },
        };
        dragView.dropHandler({ preventDefault() {} } as DragEvent);
        expect(rowIds()).toEqual(["row-b", "row-c", "row-a"]);
      } finally {
        dragView.destroy();
      }

      const original = table();
      editor.insertBlocks([{ ...original, id: "before-copy" }], "table", "before");
      editor.insertBlocks(
        [
          { ...original, id: "after-copy" },
          { ...original, id: "batch-copy" },
        ],
        "table",
        "after",
      );
      expect(rowIds()).toEqual(["row-b", "row-c", "row-a"]);
      const allIds: string[] = [];
      editor.prosemirrorState.doc.descendants((node) => {
        if (node.type.name === "tableRow") allIds.push(node.attrs.apiRowId);
      });
      expect(new Set(allIds).size).toBe(12);
      for (const id of ["before-copy", "after-copy", "batch-copy"]) {
        const copy = editor.getBlock(id)!;
        if (copy.type !== "table") throw new Error("Expected copied table");
        expect(copy.content.rows.every((row) => !["row-a", "row-b", "row-c"].includes(row.apiRowId!))).toBe(true);
      }
      validateDocumentTree(editor.prosemirrorState.doc.toJSON());
    } finally {
      editor.unmount();
      host.remove();
      Reflect.deleteProperty(document, "elementsFromPoint");
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });
  it("carries native API row IDs through shipped editor conversions", () => {
    const editor = BlockNoteEditor.create({ schema: notesSchema });
    try {
      const rows = tableContentToNodes(
        { type: "tableContent", rows: [{ apiRowId: "api-row", cells: ["Text"] }] },
        editor.pmSchema,
      );
      const content = contentNodeToTableContent(
        editor.pmSchema.nodes.table!.createChecked({}, rows),
        editor.schema.inlineContentSchema,
        editor.schema.styleSchema,
      );
      expect(content.rows[0]!.apiRowId).toBe("api-row");
    } finally {
      editor.unmount();
    }
  });
  it("blocks local nested tabs from helpers, paste and moves while allowing Yjs updates and unrelated edits", () => {
    const tabs = (id: string, content = "Body") => ({
      id,
      type: "tabs" as const,
      children: [
        {
          id: `${id}-panel`,
          type: "tabPanel" as const,
          props: { label: "One" },
          children: [{ id: `${id}-body`, type: "paragraph" as const, content }],
        },
      ],
    });
    const editor = BlockNoteEditor.create({
      schema: notesSchema,
      extensions: [tabsExtension, footnotesExtension],
      initialContent: [tabs("outer", ""), tabs("sibling")],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    const position = (id: string, doc = editor.prosemirrorState.doc) => {
      let found = -1;
      doc.descendants((node, pos) => {
        if (node.type.name === "blockContainer" && node.attrs.id === id) found = pos;
      });
      if (found < 0) throw new Error(`Missing block ${id}`);
      return found;
    };
    try {
      editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, position("outer-body", tr.doc) + 2)));
      expect(selectionInsideTabs(editor.prosemirrorState.selection)).toBe(true);
      const initial = editor.prosemirrorState.doc;
      insertOrUpdateBlockForSlashMenu(editor, tabs("nested"));
      expect(editor.prosemirrorState.doc.eq(initial)).toBe(true);
      editor.insertBlocks([tabs("inserted")], "outer-body", "before");
      expect(editor.prosemirrorState.doc.eq(initial)).toBe(true);

      const sourcePos = position("sibling");
      const source = initial.nodeAt(sourcePos)!;
      editor.transact((tr) => tr.insert(position("outer-body", initial), source).setMeta("paste", true));
      expect(editor.prosemirrorState.doc.eq(initial)).toBe(true);
      editor.transact((tr) => {
        tr.delete(sourcePos, sourcePos + source.nodeSize);
        tr.insert(tr.mapping.map(position("outer-body", initial)), source).setMeta("uiEvent", "drop");
      });
      expect(editor.prosemirrorState.doc.eq(initial)).toBe(true);

      // Native indent moves a gap containing tabs with a wrapper-only ReplaceAroundStep slice.
      editor.transact((tr) => tr.setSelection(NodeSelection.create(tr.doc, sourcePos)));
      expect(editor.canNestBlock()).toBe(true);
      let indent: Transaction | undefined;
      const dispatch = editor.prosemirrorView.dispatch.bind(editor.prosemirrorView);
      const capture = vi.spyOn(editor.prosemirrorView, "dispatch").mockImplementation((tr) => {
        indent = tr;
        dispatch(tr);
      });
      editor.nestBlock();
      capture.mockRestore();
      expect(editor.prosemirrorState.doc.eq(initial)).toBe(true);
      if (!indent) throw new Error("Native indentation did not dispatch a transaction.");
      const indentSteps = indent.steps;
      expect(indentSteps.some((step) => "gapFrom" in step)).toBe(true);
      editor.transact((tr) => {
        // Move all original positions before replaying the native indent steps.
        tr.insert(
          1,
          editor.pmSchema.nodeFromJSON({
            type: "blockContainer",
            attrs: { id: "prefix" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }],
          }),
        );
        tr.doc.check();
        for (const step of indentSteps) {
          const mapped = step.map(tr.mapping);
          if (!mapped) throw new Error("The indent step could not be mapped.");
          tr.step(mapped);
        }
      });
      expect(editor.prosemirrorState.doc.eq(initial)).toBe(true);

      editor.transact((tr) => {
        tr.delete(sourcePos, sourcePos + source.nodeSize);
        tr.insert(tr.mapping.map(position("outer-body", initial)), source).setMeta(ySyncPluginKey, {
          isChangeOrigin: true,
        });
      });
      expect(editor.prosemirrorState.doc.eq(initial)).toBe(false);
      editor.updateBlock("outer-body", { content: "Still editable" });
      expect(editor.getBlock("outer-body")!.content).toEqual([{ type: "text", text: "Still editable", styles: {} }]);
      // Attribute changes use ReplaceAroundStep but do not move or insert tabs.
      editor.updateBlock("outer-body", { props: { textColor: "red" } });
      const body = editor.getBlock("outer-body")!;
      expect(body.type === "paragraph" && body.props.textColor).toBe("red");
      editor.removeBlocks(["sibling"]);
      validateDocumentTree(editor.prosemirrorState.doc.toJSON());
      editor.insertBlocks([tabs("valid")], "outer", "after");
      expect(editor.getBlock("valid")?.type).toBe("tabs");
      editor.updateBlock("outer-panel", { props: { label: "Renamed" } });
      const panel = editor.getBlock("outer-panel")!;
      expect(panel.type === "tabPanel" && panel.props.label).toBe("Renamed");
    } finally {
      editor.unmount();
      host.remove();
    }
  });
  it.each(["markdown", "html"])("preserves footnote-shaped literals inside code blocks: %s", (format) => {
    const code = 'console.log("[^a]"); [^missing]';
    const imported =
      format === "markdown"
        ? markdownToDocument(`Text[^a].\n\n\`\`\`text\n${code}\n\`\`\`\n\n[^a]: Definition`)
        : htmlToDocument(
            `<p>Text<sup><a href="#footnote-a">1</a></sup>.</p><pre><code>${code}</code></pre><p id="footnote-a">Definition</p>`,
          );
    const codeBlock = imported.document.content![0]!.content!.find((block) => block.content?.[0]?.type === "codeBlock")!
      .content![0]!;
    expect(codeBlock.content).toEqual([{ type: "text", text: code }]);
    expect(footnoteCatalog(imported.document).numbers.size).toBe(1);
    validateDocumentTree(imported.document);
    const editor = BlockNoteEditor.create({ schema: notesSchema });
    try {
      editor.pmSchema.nodeFromJSON(imported.document).check();
    } finally {
      editor.unmount();
    }
  });
  it.each(["markdown", "html"])(
    "imports footnotes with request-local identities and exports complete definitions: %s",
    (format) => {
      const source =
        format === "markdown"
          ? "Text[^a] and again[^a].\n\n[^a]: **Important** note"
          : '<p>Text<sup><a href="#footnote-a">1</a></sup></p><p id="footnote-a"><strong>Important</strong> note</p>';
      const imported = format === "markdown" ? markdownToDocument(source) : htmlToDocument(source);
      const catalog = footnoteCatalog(imported.document);
      expect(catalog.numbers.size).toBe(1);
      expect(catalog.definitions.size).toBe(1);
      expect([...catalog.numbers.keys()]).toEqual([...catalog.definitions.keys()]);
      const another = format === "markdown" ? markdownToDocument(source) : htmlToDocument(source);
      expect([...footnoteCatalog(another.document).numbers.keys()]).not.toEqual([...catalog.numbers.keys()]);
      const editor = BlockNoteEditor.create({ schema: notesSchema });
      try {
        editor.pmSchema.nodeFromJSON(imported.document).check();
      } finally {
        editor.unmount();
      }
      expect(serializeDocument(imported.document).markdown).toContain("Important");
      expect(serializeDocument(imported.document).html).toContain('href="#footnote-');
    },
  );
  it("ignores unrelated paragraph edits and detects moved heading subtrees", () => {
    const index = new Map();
    const heading = { id: "h", type: "heading", content: [{ text: "Hello" }], props: { level: 2 } };
    expect(updateHeadingIndex(index, [{ type: "insert", block: heading }])).toBe(true);
    expect(
      updateHeadingIndex(index, [
        { type: "update", block: { id: "p", type: "paragraph", content: [{ text: "typing" }] } },
      ]),
    ).toBe(false);
    expect(
      updateHeadingIndex(index, [{ type: "move", block: { id: "parent", type: "tabs", children: [heading] } }]),
    ).toBe(true);
  });
  it("preserves escaped footnote syntax and keeps unrelated indented content out of definitions", () => {
    const imported = markdownToDocument(
      "Literal \\[^escaped] and `\\[^code]`, actual[^a].\n\n[^a]: Definition\n    Continued\n\nNext paragraph\n\n    Unrelated content",
    );
    const catalog = footnoteCatalog(imported.document);
    expect(catalog.numbers.size).toBe(1);
    expect(catalog.definitions.size).toBe(1);
    const text = serializeDocument(imported.document).markdown;
    expect(text).toContain("escaped");
    expect(text).toContain("code");
    expect(text).toContain("Unrelated content");
    const definition = [...catalog.definitions.values()][0]!;
    expect(JSON.stringify(definition)).toContain("Continued");
    expect(JSON.stringify(definition)).not.toContain("Unrelated");
  });
  it("retains every paragraph of an imported HTML footnote definition", () => {
    const imported = htmlToDocument(
      '<p>Reference<sup><a href="#footnote-a">1</a></sup></p><li id="footnote-a"><p>First paragraph</p><p><strong>Second paragraph</strong></p></li>',
    );
    const catalog = footnoteCatalog(imported.document);
    const definition = [...catalog.definitions.values()][0]!;
    expect(JSON.stringify(definition)).toContain("First paragraph");
    expect(JSON.stringify(definition)).toContain("Second paragraph");
    expect(definition.content?.some((node) => node.type === "hardBreak")).toBe(true);
  });
  it("paginates at headings, dividers and tables, leaving tall blocks scrollable", () => {
    const block = (index: number, type: string, top: number, size: number, headingLevel?: number) => ({
      index,
      type,
      top,
      bottom: top + size,
      headingLevel,
      blank: false,
      marginTop: 0,
      marginBottom: 0,
    });
    expect(
      paginateBlocks(
        [
          block(0, "paragraph", 0, 30),
          block(1, "heading", 30, 20, 1),
          block(2, "paragraph", 50, 20),
          block(3, "divider", 70, 2),
          block(4, "table", 72, 200),
          block(5, "paragraph", 272, 20),
        ],
        100,
      ),
    ).toEqual([
      { nodeIndexes: [0], scrollable: false },
      { nodeIndexes: [1, 2], scrollable: false },
      { nodeIndexes: [4], scrollable: true },
      { nodeIndexes: [5], scrollable: false },
    ]);
  });
});
