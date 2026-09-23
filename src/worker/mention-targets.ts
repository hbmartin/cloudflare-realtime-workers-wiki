import * as Y from "yjs";
import { DIAGRAM_NODES_ROOT } from "../shared/diagram";

type Counts = Map<string, number>;
export type MentionTargetKind = "document" | "diagram";

function directEvent(events: Y.YEvent<any>[], root: Y.XmlFragment | Y.Map<Y.Map<unknown>>) {
  return events.find((event) => Object.is(event.target, root));
}

function addCounts(target: Counts, source: Counts, sign: 1 | -1) {
  for (const [id, count] of source) {
    const next = (target.get(id) ?? 0) + sign * count;
    if (next > 0) target.set(id, next);
    else target.delete(id);
  }
}

function xmlCounts(node: Y.XmlElement): Counts {
  const counts: Counts = new Map();
  const visit = (element: Y.XmlElement) => {
    if (element.nodeName === "mention" && element.getAttribute("entityType") === "user") {
      const id = element.getAttribute("entityId");
      const label = element.getAttribute("label");
      if (typeof id === "string" && id && typeof label === "string" && label) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const child of element.toArray()) if (child instanceof Y.XmlElement) visit(child);
  };
  visit(node);
  return counts;
}

function diagramCounts(node: Y.Map<unknown>): Counts {
  const counts: Counts = new Map();
  const mentions = node.get("mentions");
  if (mentions instanceof Y.Map)
    for (const [id, label] of mentions.entries())
      if (/^[\w-]{1,100}$/.test(id) && typeof label === "string") counts.set(id, 1);
  return counts;
}

// Keep counts because a target can occur more than once. Removed Yjs XML
// elements have already lost their children by afterTransaction, so their
// previous counts must come from the cache.
export class MentionTargetTracker {
  private readonly counts: Counts = new Map();
  private readonly xml = new WeakMap<Y.XmlElement, Counts>();
  private readonly diagram = new WeakMap<Y.Map<unknown>, Counts>();
  private readonly diagramKeys = new WeakMap<Y.Map<unknown>, string>();

  constructor(
    private readonly document: Y.Doc,
    private readonly kind: MentionTargetKind,
  ) {
    this.rebuild();
  }

  get targets() {
    return new Set(this.counts.keys());
  }

  private replace(previous: Counts, next: Counts) {
    addCounts(this.counts, previous, -1);
    addCounts(this.counts, next, 1);
  }

  private rebuild() {
    this.counts.clear();
    if (this.kind === "diagram") {
      for (const [key, value] of this.document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT).entries()) {
        if (!(value instanceof Y.Map)) continue;
        const found = diagramCounts(value);
        this.diagram.set(value, found);
        this.diagramKeys.set(value, key);
        addCounts(this.counts, found, 1);
      }
    } else {
      for (const child of this.document.getXmlFragment("document-store").toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        const found = xmlCounts(child);
        this.xml.set(child, found);
        addCounts(this.counts, found, 1);
      }
    }
  }

  update(transaction: Y.Transaction, events: Y.YEvent<any>[]): Set<string> | null {
    return this.kind === "diagram" ? this.updateDiagram(transaction, events) : this.updateXml(transaction, events);
  }

  private updateXml(transaction: Y.Transaction, events: Y.YEvent<any>[]): Set<string> | null {
    const root = this.document.getXmlFragment("document-store");
    const relevant = [...transaction.changed].some(
      ([type, keys]) =>
        Object.is(type, root) ||
        (type instanceof Y.XmlElement &&
          (keys.has(null) ||
            (type.nodeName === "mention" && ["entityType", "entityId", "label"].some((key) => keys.has(key))))),
    );
    if (!relevant) return null;
    const rootChanged = [...transaction.changed].some(([type]) => Object.is(type, root));
    const rootEvent = directEvent(events, root);
    if (rootChanged && !rootEvent) {
      this.rebuild();
      return this.targets;
    }
    const replaced = new Set<Y.XmlElement>();
    if (rootEvent) {
      for (const item of rootEvent.changes.deleted)
        for (const child of item.content.getContent())
          if (child instanceof Y.XmlElement) {
            addCounts(this.counts, this.xml.get(child) ?? new Map(), -1);
            this.xml.delete(child);
            replaced.add(child);
          }
      for (const item of rootEvent.changes.added)
        for (const child of item.content.getContent())
          if (child instanceof Y.XmlElement) {
            const found = xmlCounts(child);
            this.xml.set(child, found);
            addCounts(this.counts, found, 1);
            replaced.add(child);
          }
    }
    const touched = new Set<Y.XmlElement>();
    for (const [type] of transaction.changed) {
      if (!(type instanceof Y.XmlElement)) continue;
      let top = type;
      while (top.parent instanceof Y.XmlElement && top.parent !== root) top = top.parent;
      if (top.parent === root && !replaced.has(top)) touched.add(top);
    }
    for (const top of touched) {
      const found = xmlCounts(top);
      this.replace(this.xml.get(top) ?? new Map(), found);
      this.xml.set(top, found);
    }
    return this.targets;
  }

  private updateDiagram(transaction: Y.Transaction, events: Y.YEvent<any>[]): Set<string> | null {
    const root = this.document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT);
    const affected = new Set<Y.Map<unknown>>();
    let relevant = false;
    if ([...transaction.changed].some(([type]) => Object.is(type, root))) {
      relevant = true;
      const event = directEvent(events, root);
      if (!event) {
        this.rebuild();
        return this.targets;
      }
      for (const [key, change] of event.changes.keys) {
        if (change.oldValue instanceof Y.Map) affected.add(change.oldValue);
        const current = root.get(key);
        if (current instanceof Y.Map) {
          this.diagramKeys.set(current, key);
          affected.add(current);
        }
      }
    }
    for (const [type, keys] of transaction.changed) {
      if (!(type instanceof Y.Map) || Object.is(type, root)) continue;
      if (type.parent === root && keys.has("mentions")) {
        relevant = true;
        affected.add(type);
      } else if (type.parent instanceof Y.Map && type.parent.parent === root && type.parent.get("mentions") === type) {
        relevant = true;
        affected.add(type.parent);
      }
    }
    if (!relevant) return null;
    for (const node of affected) {
      const key = this.diagramKeys.get(node);
      const live = key !== undefined && root.get(key) === node;
      const found = live ? diagramCounts(node) : new Map<string, number>();
      this.replace(this.diagram.get(node) ?? new Map(), found);
      if (live) this.diagram.set(node, found);
      else this.diagram.delete(node);
    }
    return this.targets;
  }
}
