import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DIAGRAM_NODES_ROOT } from "../shared/diagram";
import { MentionTargetTracker } from "./mention-targets";

function median(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)]!;
}

function wholeTreeScan(document: Y.Doc, kind: "document" | "diagram") {
  let count = 0;
  if (kind === "diagram") {
    for (const node of document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT).values())
      if (node instanceof Y.Map)
        for (const [id, label] of (node.get("mentions") as Y.Map<string> | undefined)?.entries() ?? [])
          if (/^[\w-]{1,100}$/.test(id) && typeof label === "string") count++;
  } else {
    const visit = (element: Y.XmlFragment | Y.XmlElement) => {
      for (const child of element.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "mention" && child.getAttribute("entityType") === "user") count++;
        visit(child);
      }
    };
    visit(document.getXmlFragment("document-store"));
  }
  return count;
}

describe("mention target scan measurement", () => {
  it.skipIf(process.env.MENTION_BENCH !== "1")("measures 10,000-node document and diagram edits", () => {
    for (const kind of ["document", "diagram"] as const) {
      const document = new Y.Doc();
      let editable: Y.XmlText | Y.Map<unknown>;
      if (kind === "document") {
        const root = document.getXmlFragment("document-store");
        const group = new Y.XmlElement("blockGroup");
        const blocks: Y.XmlElement[] = [];
        for (let index = 0; index < 10_000; index++) {
          const block = new Y.XmlElement("blockContainer");
          const paragraph = new Y.XmlElement("paragraph");
          const text = new Y.XmlText();
          text.insert(0, "text");
          paragraph.insert(0, [text]);
          block.insert(0, [paragraph]);
          blocks.push(block);
          if (index === 0) editable = text;
        }
        group.insert(0, blocks);
        root.insert(0, [group]);
      } else {
        const nodes = document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT);
        document.transact(() => {
          for (let index = 0; index < 10_000; index++) {
            const node = new Y.Map<unknown>();
            node.set("label", "text");
            nodes.set(String(index), node);
            if (index === 0) editable = node;
          }
        });
      }
      const tracker = new MentionTargetTracker(document, kind);
      const tracking: number[] = [];
      const root =
        kind === "document"
          ? document.getXmlFragment("document-store")
          : document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT);
      root.observeDeep((events, transaction) => {
        const start = performance.now();
        tracker.update(transaction, events);
        tracking.push(performance.now() - start);
      });
      const typing: number[] = [];
      const structural: number[] = [];
      const wholeTree: number[] = [];
      for (let index = 0; index < 25; index++) {
        let start = performance.now();
        const target = editable!;
        if (target instanceof Y.XmlText) document.transact(() => target.insert(0, "x"));
        else document.transact(() => target.set("label", String(index)));
        typing.push(performance.now() - start);
        start = performance.now();
        if (kind === "document") {
          const block = new Y.XmlElement("blockContainer");
          block.insert(0, [new Y.XmlElement("paragraph")]);
          (document.getXmlFragment("document-store").get(0) as Y.XmlElement).insert(10_000 + index, [block]);
        } else {
          document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT).set(`new-${index}`, new Y.Map());
        }
        structural.push(performance.now() - start);
        start = performance.now();
        const count = wholeTreeScan(document, kind);
        wholeTree.push(performance.now() - start);
        expect(count).toBe(0);
      }
      expect(tracker.targets.size).toBe(0);
      const structuralTracking = tracking.filter((_, index) => index % 2 === 1);
      const result = {
        kind,
        nodes: 10_000,
        typingMedianMs: Number(median(typing).toFixed(3)),
        structuralMedianMs: Number(median(structural).toFixed(3)),
        trackingMedianMs: Number(median(structuralTracking).toFixed(3)),
        formerWholeTreeMedianMs: Number(median(wholeTree).toFixed(3)),
        trackingSharePercent: Number(((100 * median(structuralTracking)) / median(structural)).toFixed(1)),
      };
      console.log("mention-targets-benchmark", JSON.stringify(result));
    }
  });
});
