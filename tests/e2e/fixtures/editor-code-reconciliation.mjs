import { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { ySyncPluginKey } from "y-prosemirror";
import { notesCommentSchema, notesSchema } from "../../../src/client/mentions";
import { ServerThreadStore } from "../../../src/client/server-thread-store";
import { normalizeYCodeBlocks } from "../../../src/shared/code-content";
import { documentToYjsUpdate } from "../../../src/shared/import-content";

const annotationKey = "comment--0123abcd";
const codeElement = (doc) => doc.getXmlFragment("document-store").get(0).get(0).get(0);

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
