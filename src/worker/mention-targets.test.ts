import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DIAGRAM_NODES_ROOT } from "../shared/diagram";
import { MentionTargetTracker } from "./mention-targets";

describe("incremental mention targets", () => {
  it("ignores mention elements embedded in text outside the XML child tree", () => {
    const document = new Y.Doc();
    const root = document.getXmlFragment("document-store");
    const text = new Y.XmlText();
    root.insert(0, [text]);
    const tracker = new MentionTargetTracker(document, "document");
    root.observeDeep((events, transaction) => tracker.update(transaction, events));
    const embedded = new Y.XmlElement("mention");
    embedded.setAttribute("entityType", "user");
    embedded.setAttribute("entityId", "phantom");
    embedded.setAttribute("label", "Phantom");
    text.insertEmbed(0, embedded);
    embedded.setAttribute("label", "Changed");
    expect([...tracker.targets]).toEqual([]);
  });
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

  it("tracks structural edits beneath a BlockNote blockGroup", () => {
    const document = new Y.Doc();
    const root = document.getXmlFragment("document-store");
    const group = new Y.XmlElement("blockGroup");
    root.insert(0, [group]);
    const tracker = new MentionTargetTracker(document, "document");
    const changes: string[][] = [];
    root.observeDeep((events, transaction) => {
      const targets = tracker.update(transaction, events);
      if (targets) changes.push([...targets].sort());
    });
    const container = (id: string) => {
      const block = new Y.XmlElement("blockContainer");
      const paragraph = new Y.XmlElement("paragraph");
      const mention = new Y.XmlElement("mention");
      mention.setAttribute("entityType", "user");
      mention.setAttribute("entityId", id);
      mention.setAttribute("label", id);
      paragraph.insert(0, [mention]);
      block.insert(0, [paragraph]);
      return { block, paragraph, mention };
    };
    const first = container("first");
    const second = container("second");
    group.insert(0, [first.block]);
    group.insert(1, [second.block]);
    first.mention.setAttribute("entityId", "third");
    group.delete(1, 1);
    const nested = new Y.XmlElement("blockGroup");
    first.block.insert(1, [nested]);
    nested.insert(0, [container("fourth").block]);
    expect(changes).toEqual([
      ["first"],
      ["first", "second"],
      ["second", "third"],
      ["third"],
      ["third"],
      ["fourth", "third"],
    ]);
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
