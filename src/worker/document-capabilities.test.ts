import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DIAGRAM_NODES_ROOT } from "../shared/diagram";
import { documentCapabilitiesChanged } from "./document-capabilities";

function capture(document: Y.Doc, kind: "document" | "diagram", mutate: () => void) {
  let changed = false;
  document.once("afterTransaction", (transaction: Y.Transaction) => {
    changed = documentCapabilitiesChanged(document, kind, transaction);
  });
  document.transact(mutate);
  return changed;
}

describe("document capability changes", () => {
  it("ignores text, marks, XML attributes and other roots while tracking nested structural edits", () => {
    const document = new Y.Doc();
    const root = document.getXmlFragment("document-store");
    const group = new Y.XmlElement("blockGroup");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Text");
    paragraph.insert(0, [text]);
    group.insert(0, [paragraph]);
    root.insert(0, [group]);
    expect(capture(document, "document", () => text.insert(0, "Changed "))).toBe(false);
    expect(
      capture(document, "document", () => text.format(0, 1, { "comment--0123abcd": { threadId: "thread" } })),
    ).toBe(false);
    expect(capture(document, "document", () => paragraph.setAttribute("textColor", "red"))).toBe(false);
    expect(capture(document, "document", () => document.getMap("api-operation-receipts").set("receipt", "hash"))).toBe(
      false,
    );
    const foreign = document.getXmlFragment("comment-body");
    expect(capture(document, "document", () => foreign.insert(0, [new Y.XmlElement("tabs")]))).toBe(false);
    for (const type of ["statusBadge", "footnoteReference", "linkedTableView", "tabs", "table", "futureBlock"]) {
      expect(capture(document, "document", () => paragraph.insert(0, [new Y.XmlElement(type)]))).toBe(true);
      expect(capture(document, "document", () => paragraph.delete(0, 1))).toBe(true);
    }
    expect(capture(document, "document", () => root.delete(0, 1))).toBe(true);
    expect(documentCapabilitiesChanged(document, "document")).toBe(true);
    document.destroy();
  });

  it("invalidates diagram membership and link keys, ignoring labels, geometry and nested mentions", () => {
    const document = new Y.Doc();
    const nodes = document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT);
    const node = new Y.Map<unknown>();
    expect(capture(document, "diagram", () => nodes.set("node", node))).toBe(true);
    expect(capture(document, "diagram", () => node.set("label", "Changed"))).toBe(false);
    expect(capture(document, "diagram", () => node.set("x", 10))).toBe(false);
    const mentions = new Y.Map<string>();
    expect(capture(document, "diagram", () => node.set("mentions", mentions))).toBe(false);
    expect(capture(document, "diagram", () => mentions.set("user", "User"))).toBe(false);
    for (const key of ["linkedPageId", "linkedViewId"]) {
      expect(capture(document, "diagram", () => node.set(key, "linked"))).toBe(true);
      expect(capture(document, "diagram", () => node.delete(key))).toBe(true);
    }
    expect(capture(document, "diagram", () => nodes.set("node", new Y.Map()))).toBe(true);
    expect(capture(document, "diagram", () => nodes.delete("node"))).toBe(true);
    document.destroy();
  });
});
