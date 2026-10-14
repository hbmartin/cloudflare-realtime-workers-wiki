import { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { observeUnsupportedCodeContent, UnsupportedCodeContentError, ySyncPluginKey } from "y-prosemirror";
import { notesCommentSchema, notesSchema } from "../../../src/client/mentions";
import { ServerThreadStore } from "../../../src/client/server-thread-store";
import { normalizeYCodeBlocks } from "../../../src/shared/code-content";
import { documentToYjsUpdate } from "../../../src/shared/import-content";

const annotationKey = "comment--0123abcd";
const codeElement = (doc) => doc.getXmlFragment("document-store").get(0).get(0).get(0);

/** Count code inspections through the browser's mounted binding. */
export function inspectChangedCodeScopes() {
  const doc = new Y.Doc(),
    group = new Y.XmlElement("blockGroup"),
    paragraph = new Y.XmlElement("blockContainer"),
    plain = new Y.XmlElement("paragraph"),
    plainText = new Y.XmlText();
  paragraph.setAttribute("id", "plain");
  plain.insert(0, [plainText]);
  paragraph.insert(0, [plain]);
  group.insert(0, [paragraph]);
  const texts = Array.from({ length: 100 }, (_, index) => {
    const container = new Y.XmlElement("blockContainer"),
      code = new Y.XmlElement("codeBlock"),
      text = new Y.XmlText();
    container.setAttribute("id", `code-${index}`);
    code.setAttribute("language", "javascript");
    text.insert(0, "safe code");
    code.insert(0, [text]);
    container.insert(0, [code]);
    group.insert(index + 1, [container]);
    return text;
  });
  doc.getXmlFragment("document-store").insert(0, [group]);
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: notesSchema,
      collaboration: {
        fragment: doc.getXmlFragment("document-store"),
        user: { name: "Scope fixture", color: "#123456" },
      },
    }),
  );
  const host = document.createElement("section");
  document.body.appendChild(host);
  editor.mount(host);
  const counts = Array(texts.length).fill(0),
    deltaReaders = texts.map((text) => Reflect.get(text, "toDelta"));
  texts.forEach((text, index) => {
    text.toDelta = (...args) => {
      counts[index]++;
      return deltaReaders[index].apply(text, args);
    };
  });
  const inspect = () => [Math.min(...counts), Math.max(...counts)],
    reset = () => counts.fill(0);
  const listenerCount = Reflect.get(doc, "_observers").get("beforeObserverCalls")?.size ?? 0;
  try {
    plainText.insert(0, "paragraph only");
    doc.getMap("presence").set("cursor", 1);
    const unrelated = inspect();
    reset();
    texts[0].insert(1, "!");
    const affected = counts[0],
      untouched = Math.max(...counts.slice(1));
    reset();
    const added = new Y.XmlElement("blockContainer");
    added.setAttribute("id", "structural");
    added.insert(0, [new Y.XmlElement("paragraph")]);
    group.insert(1, [added]);
    const structural = inspect();
    reset();
    const binding = ySyncPluginKey.getState(editor.prosemirrorState).binding;
    Reflect.get(binding, "_forceRerender").call(binding);
    const forced = inspect();
    editor.unmount();
    return {
      unrelated,
      affected,
      untouched,
      structural,
      forced,
      listenerRemoved: (Reflect.get(doc, "_observers").get("beforeObserverCalls")?.size ?? 0) < listenerCount,
    };
  } finally {
    texts.forEach((text, index) => (text.toDelta = deltaReaders[index]));
    editor.unmount();
    host.remove();
    doc.destroy();
  }
}

/** Exercise rejection with the browser's actual editor binding, preserving the received bytes. */
export function rejectUnsupportedCode() {
  const results = [];
  for (const received of [false, true]) {
    const doc = new Y.Doc(),
      remote = new Y.Doc(),
      expected = new Y.Doc();
    const group = new Y.XmlElement("blockGroup"),
      container = new Y.XmlElement("blockContainer"),
      code = new Y.XmlElement("codeBlock"),
      text = new Y.XmlText();
    container.setAttribute("id", "code");
    code.setAttribute("language", "javascript");
    text.insert(0, "safe code");
    code.insert(0, [text]);
    container.insert(0, [code]);
    group.insert(0, [container]);
    doc.getXmlFragment("document-store").insert(0, [group]);
    const anchor = Y.createRelativePositionFromTypeIndex(text, 2);
    const host = document.createElement("section");
    document.body.appendChild(host);
    const errors = [];
    const unsubscribe = observeUnsupportedCodeContent(doc, (error) => errors.push(error));
    let editor;
    const mount = () => {
      const instance = BlockNoteEditor.create(
        withCollaboration({
          schema: notesSchema,
          collaboration: {
            fragment: doc.getXmlFragment("document-store"),
            user: { name: "Code fixture", color: "#123456" },
          },
        }),
      );
      instance.mount(host);
      return instance;
    };
    const unchanged = (before) => {
      const after = Y.encodeStateAsUpdate(doc);
      return before.length === after.length && before.every((value, index) => value === after[index]);
    };
    try {
      if (!received) {
        text.insertEmbed(4, { unsupported: "image" });
        const before = Y.encodeStateAsUpdate(doc);
        let controlledError = false;
        try {
          editor = mount();
        } catch (error) {
          controlledError = error instanceof UnsupportedCodeContentError;
        }
        results.push({
          received,
          controlledError,
          bytesRetained: unchanged(before),
          identityRetained: code.get(0) === text,
        });
      } else {
        editor = mount();
        Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(expected, Y.encodeStateAsUpdate(doc));
        const remoteText = codeElement(remote).get(0);
        remoteText.insertEmbed(4, { unsupported: "image" });
        const update = Y.encodeStateAsUpdate(remote);
        Y.applyUpdate(expected, update);
        Y.applyUpdate(doc, update);
        const before = Y.encodeStateAsUpdate(doc);
        const bytesRetained = unchanged(Y.encodeStateAsUpdate(expected));
        editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.insertText("blocked", 3));
        const writesBlocked = unchanged(before);
        const controlledError = errors.length === 1 && errors[0] instanceof UnsupportedCodeContentError;
        const identityRetained = code.get(0) === text;
        const anchorRetained = Y.createAbsolutePositionFromRelativePosition(anchor, doc)?.type === text;
        remoteText.delete(4, 1);
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
        editor.unmount();
        editor = mount();
        const repaired = editor.prosemirrorState.doc.textContent === "safe code";
        results.push({
          received,
          controlledError,
          bytesRetained,
          writesBlocked,
          identityRetained,
          anchorRetained,
          repaired,
        });
      }
    } finally {
      unsubscribe();
      editor?.unmount();
      host.remove();
      doc.destroy();
      remote.destroy();
      expected.destroy();
    }
  }
  return results;
}

/** Exercise the shipped browser binding on migrated code without a connected provider. */
export async function reconcileCodeReplicas() {
  const results = [];
  for (const reversed of [false, true]) {
    const seed = new Y.Doc();
    Y.applyUpdate(
      seed,
      documentToYjsUpdate({
        type: "doc",
        content: [
          {
            type: "blockGroup",
            content: [
              {
                type: "blockContainer",
                attrs: { id: "code" },
                content: [
                  {
                    type: "codeBlock",
                    attrs: { language: "javascript" },
                    content: [
                      {
                        type: "text",
                        text: "left",
                        marks: [{ type: "bold" }, { type: "comment", attrs: { threadId: "thread", orphan: true } }],
                      },
                      { type: "hardBreak" },
                      {
                        type: "text",
                        text: "right",
                        marks: [{ type: "comment", attrs: { threadId: "thread", orphan: true } }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const originalTail = codeElement(seed).get(2);
    originalTail.format(0, originalTail.length, {
      comment: null,
      [annotationKey]: { threadId: "thread", orphan: true },
    });
    normalizeYCodeBlocks(seed);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const docs = [new Y.Doc(), new Y.Doc()];
    docs[0].clientID = reversed ? 10402 : 10401;
    docs[1].clientID = reversed ? 10401 : 10402;
    const editors = [],
      hosts = [],
      tails = [],
      anchors = [],
      managers = [];
    try {
      for (const [index, doc] of docs.entries()) {
        Y.applyUpdate(doc, snapshot);
        const tail = codeElement(doc).get(2);
        tails.push(tail);
        anchors.push(Y.createRelativePositionFromTypeIndex(tail, 2));
        const fragment = doc.getXmlFragment("document-store");
        managers.push(new Y.UndoManager(fragment, { trackedOrigins: new Set([ySyncPluginKey]), captureTimeout: 0 }));
        const editor = BlockNoteEditor.create(
          withCollaboration({
            schema: notesSchema,
            extensions: [
              CommentsExtension({
                threadStore: new ServerThreadStore("fixture", `owner-${index}`, () => {}),
                schema: notesCommentSchema,
                resolveUsers: async () => [],
              }),
            ],
            collaboration: { fragment, user: { name: `Editor ${index}`, color: "#123456" } },
          }),
        );
        const host = document.createElement("section");
        document.body.appendChild(host);
        hosts.push(host);
        editors.push(editor);
        editor.mount(host);
      }
      for (const [index, editor] of editors.entries()) {
        let end;
        editor.prosemirrorState.doc.descendants((node, position) => {
          if (node.type.name === "codeBlock") end = position + 1 + node.content.size;
        });
        editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.insertText(index ? " B" : " A", end));
      }
      const disconnected = editors.map((editor) => editor.prosemirrorState.doc.textContent);
      const updates = docs.map((doc) => Y.encodeStateAsUpdate(doc));
      const order = reversed ? [1, 0] : [0, 1];
      for (const index of order) Y.applyUpdate(docs[index], updates[1 - index]);
      const merged = editors.map((editor) => editor.prosemirrorState.doc.textContent);
      const identitiesRetained = docs.every((doc, index) => codeElement(doc).toArray().includes(tails[index]));
      const anchorsRetained = docs.every((doc, index) => {
        const absolute = Y.createAbsolutePositionFromRelativePosition(anchors[index], doc);
        return absolute?.type === tails[index] && absolute.index === 2;
      });
      const annotationsRetained = tails.every((tail) =>
        tail.toDelta().some((delta) => delta.attributes?.[annotationKey]?.threadId === "thread"),
      );
      const annotationAliasesRetained = docs.every(
        (doc, index) =>
          codeElement(doc)
            .get(0)
            .toDelta()
            .every((delta) => delta.attributes?.comment?.threadId === "thread" && !delta.attributes?.[annotationKey]) &&
          tails[index].toDelta().every((delta) => !delta.attributes?.comment),
      );
      managers[0].undo();
      Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
      const undone = editors.map((editor) => editor.prosemirrorState.doc.textContent);
      managers[0].redo();
      Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
      const redone = editors.map((editor) => editor.prosemirrorState.doc.textContent);
      for (const editor of editors) editor.prosemirrorState.doc.check();
      results.push({
        disconnected,
        merged,
        identitiesRetained,
        anchorsRetained,
        annotationsRetained,
        annotationAliasesRetained,
        annotationDeltas: tails.map((tail) => tail.toDelta()),
        undone,
        redone,
      });
    } finally {
      for (const editor of editors) editor.unmount();
      for (const manager of managers) manager.destroy();
      for (const host of hosts) host.remove();
      for (const doc of docs) doc.destroy();
      seed.destroy();
    }
  }
  return results;
}
