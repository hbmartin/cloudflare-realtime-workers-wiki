import * as Y from "yjs";
import { DocumentValidationError, isDocumentFormattingMark, validateDocumentMarks } from "./document-validation";
import type { ProseMirrorJson } from "./types";

/** Canonicalize only the legacy inline content that has an unambiguous plain-text representation. */
export function normalizeCodeBlockContent(content: unknown): ProseMirrorJson[] {
  if (!Array.isArray(content)) throw new DocumentValidationError("Code content must be an array.");
  return content.map((raw: unknown) => {
    const node = raw as ProseMirrorJson;
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      !["text", "hardBreak"].includes(node.type ?? "") ||
      (node.content !== undefined && (!Array.isArray(node.content) || node.content.length > 0)) ||
      (node.type === "text" ? typeof node.text !== "string" || !node.text : node.text !== undefined)
    )
      throw new DocumentValidationError("Code contains unsupported inline content.");
    if (
      node.attrs !== undefined &&
      (!node.attrs ||
        typeof node.attrs !== "object" ||
        Array.isArray(node.attrs) ||
        Object.entries(node.attrs).some(
          ([key, value]) =>
            key !== "ychange" &&
            value !== null &&
            typeof value !== "string" &&
            typeof value !== "boolean" &&
            !(typeof value === "number" && Number.isFinite(value)),
        ))
    )
      throw new DocumentValidationError("Code attributes are invalid.");
    if (node.type === "hardBreak" && Object.keys(node.attrs ?? {}).some((key) => key !== "ychange"))
      throw new DocumentValidationError("Code break attributes are unsupported.");
    const marks = validateDocumentMarks(node.marks).filter((mark) => !isDocumentFormattingMark(mark.type!));
    const { marks: _marks, content: _content, ...plain } = node;
    return {
      ...plain,
      type: "text",
      text: node.type === "hardBreak" ? "\n" : node.text!,
      ...(marks.length ? { marks } : {}),
    };
  });
}

/** Preflight the entire repair before mutating; retain XmlText identity and raw comment mark keys. */
export function normalizeYCodeBlocks(document: Y.Doc): boolean {
  const repairs: Array<() => void> = [];
  const pending = [...document.getXmlFragment("document-store").toArray()];
  while (pending.length) {
    const node = pending.pop()!;
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName !== "codeBlock") {
      for (const child of node.toArray()) pending.push(child);
      continue;
    }
    for (const [index, child] of node.toArray().entries()) {
      if (child instanceof Y.XmlText) {
        let offset = 0;
        for (const delta of child.toDelta()) {
          if (typeof delta.insert !== "string")
            throw new DocumentValidationError("Code contains unsupported embedded content.");
          const attributes = delta.attributes ?? {};
          const marks = Object.entries(attributes).map(([name, attrs]) => ({
            // y-prosemirror hashes mark attributes into the Yjs key and removes this suffix on read.
            type: name.replace(/--[a-zA-Z0-9+/=]{8}$/, ""),
            attrs,
          }));
          normalizeCodeBlockContent([{ type: "text", text: delta.insert, marks }]);
          const remove = Object.fromEntries(
            Object.keys(attributes)
              .filter((name) => isDocumentFormattingMark(name.replace(/--[a-zA-Z0-9+/=]{8}$/, "")))
              .map((name) => [name, null]),
          );
          if (Object.keys(remove).length) {
            const start = offset;
            repairs.push(() => child.format(start, delta.insert.length, remove));
          }
          offset += delta.insert.length;
        }
      } else if (child instanceof Y.XmlElement && child.nodeName === "hardBreak" && child.length === 0) {
        normalizeCodeBlockContent([{ type: "hardBreak", attrs: child.getAttributes() }]);
        repairs.push(() => {
          const newline = new Y.XmlText();
          newline.insert(0, "\n");
          node.delete(index, 1);
          node.insert(index, [newline]);
        });
      } else throw new DocumentValidationError("Code contains unsupported inline content.");
    }
  }
  if (!repairs.length) return false;
  document.transact(() => {
    for (const repair of repairs) repair();
  }, "code-normalize");
  return true;
}
