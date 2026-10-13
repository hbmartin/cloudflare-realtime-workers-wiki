import { Node, Schema, type NodeSpec } from "prosemirror-model";
import type { ProseMirrorJson } from "./types";

export class DocumentValidationError extends Error {
  readonly code = "invalid_document";
}

const INLINE_BLOCKS = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
  "codeBlock",
  "callout",
  "columns",
  "footnoteDefinition",
]);
const ATOM_BLOCKS = new Set([
  "divider",
  "image",
  "audio",
  "video",
  "file",
  "pdf",
  "math",
  "mermaid",
  "embed",
  "bookmark",
  "tableOfContents",
  "columnList",
  "column",
  "syncedBlockSource",
  "syncedBlockReference",
  "breadcrumb",
  "linkToPage",
  "linkedDiagram",
  "linkedTableView",
  "tabs",
  "tabPanel",
  "footnotes",
]);
const INLINE_ATOMS = new Set(["mention", "dateMention", "inlineMath", "statusBadge", "footnoteReference"]);
const STYLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "link", "textColor", "backgroundColor"]);
const MAX_NODES = 250_000;

function fail(message: string): never {
  throw new DocumentValidationError(message);
}

/** Validate the headless BlockNote wire tree without loading React or browser node views. */
export function validateDocumentTree(value: unknown): asserts value is ProseMirrorJson {
  if (!value || typeof value !== "object" || (value as ProseMirrorJson).type !== "doc")
    fail("Document root must be a doc.");
  const ids = new Set<string>();
  const marks = new Set(STYLE_MARKS);
  let count = 0;
  const visit = (raw: unknown, depth: number, inTabs = false): void => {
    if (++count > MAX_NODES || depth > 64) fail("Document tree exceeds its structural limits.");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Document nodes must be objects.");
    const node = raw as ProseMirrorJson;
    if (typeof node.type !== "string") fail("Document node type is required.");
    if (node.content !== undefined && !Array.isArray(node.content)) fail("Document node content must be an array.");
    if (node.attrs !== undefined && (!node.attrs || typeof node.attrs !== "object" || Array.isArray(node.attrs)))
      fail("Document attributes must be an object.");
    for (const [key, attribute] of Object.entries(node.attrs ?? {})) {
      if (key === "ychange") continue;
      if (
        key === "colwidth" &&
        (attribute === null ||
          (Array.isArray(attribute) && attribute.every((width) => Number.isFinite(width) && width >= 0)))
      )
        continue;
      if (attribute !== null && !["string", "number", "boolean"].includes(typeof attribute))
        fail("Document attribute value is invalid.");
      if (typeof attribute === "number" && !Number.isFinite(attribute)) fail("Document numeric attribute is invalid.");
      if (
        [
          "backgroundColor",
          "textColor",
          "textAlignment",
          "url",
          "caption",
          "name",
          "formula",
          "pageId",
          "tablePageId",
          "viewId",
          "sourcePageId",
          "blockId",
          "language",
          "label",
          "payload",
        ].includes(key) &&
        typeof attribute !== "string"
      )
        fail("Document text attribute is invalid.");
    }
    if (node.type === "blockContainer") {
      const id = node.attrs?.id;
      if (typeof id !== "string" || !id || id.length > 200 || ids.has(id)) fail("Document block IDs must be unique.");
      ids.add(id);
    }
    if (node.type === "tableRow" && node.attrs?.apiRowId) {
      const id = node.attrs.apiRowId;
      if (typeof id !== "string" || id.length > 200 || ids.has(id)) fail("Table row IDs must be unique.");
      ids.add(id);
    }
    if (node.type === "text" && (typeof node.text !== "string" || !node.text)) fail("Text nodes must contain text.");
    if (node.marks !== undefined && !Array.isArray(node.marks)) fail("Document marks must be an array.");
    for (const mark of node.marks ?? []) {
      if (!mark || typeof mark.type !== "string") fail("Document mark type is required.");
      if (!STYLE_MARKS.has(mark.type) && !/^comment--[A-Za-z0-9:_-]{1,200}$/.test(mark.type))
        fail("Document contains an unknown mark.");
      if (mark.attrs !== undefined && (!mark.attrs || typeof mark.attrs !== "object" || Array.isArray(mark.attrs)))
        fail("Document mark attributes must be an object.");
      for (const attribute of Object.values(mark.attrs ?? {}))
        if (
          attribute !== null &&
          typeof attribute !== "string" &&
          typeof attribute !== "boolean" &&
          !(typeof attribute === "number" && Number.isFinite(attribute))
        )
          fail("Document mark attribute is invalid.");
      if (mark.type === "link" && mark.attrs?.href !== undefined && typeof mark.attrs.href !== "string")
        fail("Link destination is invalid.");
      marks.add(mark.type);
    }
    if (
      node.attrs?.textAlignment !== undefined &&
      !["left", "center", "right", "justify"].includes(String(node.attrs.textAlignment))
    )
      fail("Text alignment is invalid.");
    if (
      node.type === "heading" &&
      node.attrs?.level !== undefined &&
      ![1, 2, 3, 4, 5, 6].includes(Number(node.attrs.level))
    )
      fail("Heading level is invalid.");
    if (node.type === "checkListItem" && node.attrs?.checked !== undefined && typeof node.attrs.checked !== "boolean")
      fail("Checklist state is invalid.");
    if (node.type === "blockContainer") {
      const block = node.content?.[0];
      const children = node.content?.[1]?.content ?? [];
      if (block?.type === "tabs" && inTabs) fail("Tabs cannot be nested.");
      if (
        block?.type === "tabs" &&
        (children.length < 1 ||
          children.length > 20 ||
          children.some((child) => child.content?.[0]?.type !== "tabPanel"))
      )
        fail("Tabs must contain between 1 and 20 tab panels.");
      if (
        block?.type === "footnotes" &&
        (children.length > 1000 || children.some((child) => child.content?.[0]?.type !== "footnoteDefinition"))
      )
        fail("Footnotes may contain only footnote definitions.");
      inTabs ||= block?.type === "tabs";
    }
    if (node.type === "tabPanel" && (typeof node.attrs?.label !== "string" || node.attrs.label.length > 200))
      fail("Tab label is invalid.");
    if (
      node.type === "statusBadge" &&
      (typeof node.attrs?.label !== "string" ||
        node.attrs.label.length > 200 ||
        !["gray", "blue", "green", "yellow", "red", "purple"].includes(String(node.attrs?.color)))
    )
      fail("Status badge is invalid.");
    if (
      ["footnoteDefinition", "footnoteReference"].includes(node.type) &&
      (typeof node.attrs?.definitionId !== "string" || !node.attrs.definitionId || node.attrs.definitionId.length > 200)
    )
      fail("Footnote ID is invalid.");
    if (node.type === "table") validateTable(node);
    for (const child of node.content ?? []) visit(child, depth + 1, inTabs);
  };
  visit(value, 0);
  const nodes: Record<string, NodeSpec> = {
    doc: { content: "blockGroup?" },
    blockGroup: { content: "blockContainer*" },
    blockContainer: { content: "blockContent blockGroup?" },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true },
    table: { group: "blockContent", content: "tableRow+" },
    tableRow: { content: "(tableCell | tableHeader)+" },
    tableCell: { content: "tableParagraph+" },
    tableHeader: { content: "tableParagraph+" },
    tableParagraph: { content: "inline*" },
  };
  for (const type of INLINE_BLOCKS) nodes[type] = { group: "blockContent", content: "inline*" };
  for (const type of ATOM_BLOCKS) nodes[type] = { group: "blockContent", atom: true };
  for (const type of INLINE_ATOMS) nodes[type] = { group: "inline", inline: true, atom: true };
  try {
    const schema = new Schema({ nodes, marks: Object.fromEntries([...marks].map((type) => [type, {}])) });
    Node.fromJSON(schema, value).check();
  } catch {
    fail("Document node structure is incompatible with the editor.");
  }
  if (ids.size > 10_000) fail("Document block limit exceeded.");
}

/** Capabilities needed to write a tree without dropping nodes unknown to an older client. */
export function requiredDocumentCapabilities(document: ProseMirrorJson) {
  const required = new Set<string>();
  const capabilities: Record<string, string> = {
    table: "native-tables-v1",
    tabs: "tabs-v1",
    tabPanel: "tabs-v1",
    footnotes: "footnotes-v1",
    footnoteDefinition: "footnotes-v1",
    footnoteReference: "footnotes-v1",
    statusBadge: "status-badges-v1",
    linkedTableView: "linked-table-views-v1",
  };
  const structural = new Set([
    "doc",
    "blockGroup",
    "blockContainer",
    "text",
    "hardBreak",
    "tableRow",
    "tableCell",
    "tableHeader",
    "tableParagraph",
  ]);
  const pending = [{ node: document, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++visited > MAX_NODES || depth > 64) {
      required.add("unsupported:document-structure");
      break;
    }
    const capability = node.type ? capabilities[node.type] : undefined;
    if (capability) required.add(capability);
    else if (
      node.type &&
      !structural.has(node.type) &&
      !INLINE_BLOCKS.has(node.type) &&
      !ATOM_BLOCKS.has(node.type) &&
      !INLINE_ATOMS.has(node.type)
    )
      required.add(`unsupported:${node.type}`);
    for (const child of node.content ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  return [...required].sort();
}

function validateTable(table: ProseMirrorJson) {
  const rows = table.content ?? [];
  if (!rows.length || rows.length > 10_000) fail("Tables must contain rows.");
  const occupied: number[] = [];
  let width = 0;
  for (const [rowIndex, row] of rows.entries()) {
    let column = 0;
    for (const cell of row.content ?? []) {
      while ((occupied[column] ?? 0) > rowIndex) column++;
      const colspan = cell.attrs?.colspan ?? 1;
      const rowspan = cell.attrs?.rowspan ?? 1;
      if (
        !Number.isInteger(colspan) ||
        Number(colspan) < 1 ||
        Number(colspan) > 200 ||
        !Number.isInteger(rowspan) ||
        Number(rowspan) < 1 ||
        rowIndex + Number(rowspan) > rows.length
      )
        fail("Table cell spans are invalid.");
      for (let index = column; index < column + Number(colspan); index++) {
        if ((occupied[index] ?? 0) > rowIndex) fail("Table cells overlap.");
        occupied[index] = rowIndex + Number(rowspan);
      }
      column += Number(colspan);
    }
    const rowWidth = occupied.length;
    if (rowIndex === 0) width = rowWidth;
    if (!width || width > 200 || rowWidth !== width || occupied.some((until) => until <= rowIndex))
      fail("Table rows must have a consistent width.");
  }
}

/** Convert legacy API row containers to native table rows while retaining stable API IDs. */
function normalizeTableNode(node: ProseMirrorJson): ProseMirrorJson {
  const children = node.content?.map(normalizeTableNode);
  if (node.type === "blockContainer" && children?.[0]?.type === "table" && children[1]?.type === "blockGroup") {
    const rows = children[1].content ?? [];
    if (
      rows.some(
        (row) => row.type !== "blockContainer" || row.content?.[0]?.type !== "tableRow" || row.content.length !== 1,
      )
    )
      fail("Legacy table children must be table rows.");
    return {
      ...node,
      content: [
        {
          ...children[0],
          content: rows.map((row) => ({
            ...row.content![0]!,
            attrs: { ...row.content![0]!.attrs, apiRowId: row.attrs?.id },
          })),
        },
      ],
    };
  }
  if (node.type === "tableCell" || node.type === "tableHeader") {
    if (children?.length && children.every((child) => child.type === "paragraph" || child.type === "tableParagraph"))
      return { ...node, content: children.map((child) => ({ ...child, type: "tableParagraph" })) };
    if (children?.some((child) => child.type !== "tableParagraph"))
      return { ...node, content: [{ type: "tableParagraph", content: children }] };
    if (!children?.length) return { ...node, content: [{ type: "tableParagraph" }] };
  }
  return children ? { ...node, content: children } : node;
}

export function normalizeDocumentTables(document: ProseMirrorJson): ProseMirrorJson {
  return normalizeTableNode(document);
}
