// @vitest-environment jsdom
import { BlockNoteEditor, mapTableCell, contentNodeToTableContent, tableContentToNodes } from "@blocknote/core";
import { TableHandlesExtension, TableHandlesView, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { CommentsExtension } from "@blocknote/core/comments";
import { Fragment, Schema, Slice } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
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
import { prosemirrorToYXmlFragment, ySyncPluginKey, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { validateDocumentTree } from "../shared/document-validation";

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
describe("document editor features", () => {
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
    const editor = BlockNoteEditor.create({
      schema: notesSchema,
      extensions: [tabsExtension, footnotesExtension],
      collaboration: {
        fragment: doc.getXmlFragment("document-store"),
        user: { name: "Test", color: "#123456" },
      },
    });
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
      editor.nestBlock();
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
