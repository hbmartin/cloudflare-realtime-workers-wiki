import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DIAGRAM_NODES_ROOT } from "../shared/diagram";
import { MentionTargetTracker } from "./mention-targets";

describe("incremental mention targets", () => {
  it("tracks duplicates, atomic replacement, and separate removal and reinsertion", () => {
    const document = new Y.Doc();
    const root = document.getXmlFragment("document-store");
    const tracker = new MentionTargetTracker(document, "document");
    const changes: string[][] = [];
    root.observeDeep((events, transaction) => {
      const targets = tracker.update(transaction, events);
      if (targets) changes.push([...targets]);
    });
    const paragraph = () => {
      const block = new Y.XmlElement("paragraph");
      const mention = new Y.XmlElement("mention");
      mention.setAttribute("entityType", "user");
      mention.setAttribute("entityId", "target");
      mention.setAttribute("label", "Target");
      block.insert(0, [mention]);
      return block;
    };
    document.transact(() => root.insert(0, [paragraph()]));
    document.transact(() => root.insert(1, [paragraph()]));
    document.transact(() => root.delete(0, 1));
    document.transact(() => root.delete(0, 1));
    document.transact(() => root.insert(0, [paragraph()]));
    expect(changes).toEqual([["target"], ["target"], ["target"], [], ["target"]]);
  });

  it("tracks a changed diagram node without scanning its siblings", () => {
    const document = new Y.Doc();
    const nodes = document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT);
    const tracker = new MentionTargetTracker(document, "diagram");
    const changes: string[][] = [];
    nodes.observeDeep((events, transaction) => {
      const targets = tracker.update(transaction, events);
      if (targets) changes.push([...targets]);
    });
    const node = new Y.Map<unknown>();
    const mentions = new Y.Map<string>();
    mentions.set("target", "Target");
    node.set("mentions", mentions);
    nodes.set("first", node);
    node.set("label", "A changed label");
    mentions.delete("target");
    mentions.set("second", "Second");
    nodes.delete("first");
    expect(changes).toEqual([["target"], [], ["second"], []]);
  });
});
