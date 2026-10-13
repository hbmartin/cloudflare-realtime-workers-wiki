// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { Fragment, Schema, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { notesSchema } from "./mentions";
import { footnoteCatalog } from "../shared/editor-features";
import { documentToYjsUpdate, htmlToDocument, markdownToDocument } from "../shared/import-content";
import { serializeDocument } from "../shared/document-projection";
import { findTextMatches, replaceSearchRanges } from "./find-replace";
import { footnotesExtension, tabsExtension, tabsPluginKey } from "./editor-feature-blocks";
import { remapFeatureSlice } from "./editor-copy";
import { moveTabPanel, duplicateTabPanel } from "./tab-operations";
import { paginateBlocks } from "./presentation-layout";
import { updateHeadingIndex } from "./heading-index";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";

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
