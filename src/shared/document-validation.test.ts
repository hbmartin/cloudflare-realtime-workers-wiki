import { describe, expect, it } from "vitest";
import { normalizeDocumentTables, requiredDocumentCapabilities, validateDocumentTree } from "./document-validation";
import { documentBlocks, notionInputToBlockContainer, notionPayloadForBlock } from "./notion-blocks";
import type { ProseMirrorJson } from "./types";

function page(...blocks: ProseMirrorJson[]) {
  return { type: "doc", content: [{ type: "blockGroup", content: blocks }] };
}
function block(id: string, node: ProseMirrorJson, children?: ProseMirrorJson[]) {
  return {
    type: "blockContainer",
    attrs: { id },
    content: [node, ...(children ? [{ type: "blockGroup", content: children }] : [])],
  };
}
const text = { type: "text", text: "Hello" };

describe("document validation", () => {
  it("fails capability negotiation closed for deeply nested and unknown stored structures", () => {
    let nested: ProseMirrorJson = { type: "paragraph" };
    for (let depth = 0; depth < 100; depth++) nested = { type: "blockGroup", content: [nested] };
    expect(requiredDocumentCapabilities(nested)).toContain("unsupported:document-structure");
    expect(requiredDocumentCapabilities(page(block("unknown", { type: "futureBlock" })))).toContain(
      "unsupported:futureBlock",
    );
    expect(requiredDocumentCapabilities(page(block("table", { type: "table" })))).toEqual(["native-tables-v1"]);
  });

  it("counts structural elements for capabilities while retaining complete write limits and rejecting text children", () => {
    const manyTextRuns = page(
      block("runs", { type: "paragraph", content: Array.from({ length: 250_000 }, () => ({ ...text })) }),
    );
    expect(requiredDocumentCapabilities(manyTextRuns)).toEqual([]);
    expect(() => validateDocumentTree(manyTextRuns)).toThrow(/structural limits/);
    expect(
      requiredDocumentCapabilities({
        type: "doc",
        content: Array.from({ length: 250_000 }, () => ({ type: "paragraph" })),
      }),
    ).toContain("unsupported:document-structure");
    const malformedText = page(
      block("malformed", { type: "paragraph", content: [{ ...text, content: [{ type: "footnoteReference" }] }] }),
    );
    expect(requiredDocumentCapabilities(malformedText)).toEqual(["footnotes-v1", "unsupported:document-structure"]);
    expect(
      requiredDocumentCapabilities(page(block("missing-text", { type: "paragraph", content: [{ type: "text" }] }))),
    ).toContain("unsupported:document-structure");
  });

  it("accepts supported block and inline structure including empty documents", () => {
    expect(() => validateDocumentTree(page())).not.toThrow();
    expect(() =>
      validateDocumentTree(
        page(
          block("paragraph", {
            type: "paragraph",
            content: [text, { type: "mention", attrs: { entityId: "target", entityType: "page", label: "Target" } }],
          }),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      validateDocumentTree(page(block("legacy-columns", { type: "columns", attrs: { count: 2 }, content: [text] }))),
    ).not.toThrow();
  });
  it("limits code blocks to plain text while retaining comment annotations", () => {
    expect(() => validateDocumentTree(page(block("code", { type: "codeBlock", content: [text] })))).not.toThrow();
    expect(() =>
      validateDocumentTree(
        page(block("code", { type: "codeBlock", content: [{ ...text, marks: [{ type: "comment--thread_1" }] }] })),
      ),
    ).not.toThrow();
    const annotation = { type: "comment", attrs: { threadId: "thread", orphan: false } };
    for (const type of ["paragraph", "codeBlock"]) {
      expect(() =>
        validateDocumentTree(page(block(type, { type, content: [{ ...text, marks: [annotation] }] }))),
      ).not.toThrow();
    }
    for (const mark of [
      { ...annotation, attrs: { threadId: 1 } },
      { ...annotation, attrs: { orphan: "false" } },
      { type: "commentary" },
    ])
      expect(() =>
        validateDocumentTree(page(block("invalid", { type: "paragraph", content: [{ ...text, marks: [mark] }] }))),
      ).toThrow(/annotation|unknown mark/);
    for (const node of [
      { type: "footnoteReference", attrs: { definitionId: "note" } },
      { type: "hardBreak" },
      { ...text, marks: [{ type: "bold" }] },
      { ...text, marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    ]) {
      expect(() => validateDocumentTree(page(block("code", { type: "codeBlock", content: [node] })))).toThrow(
        /incompatible/,
      );
    }
  });

  it.each([
    page(block("duplicate", { type: "paragraph" }), block("duplicate", { type: "paragraph" })),
    page(block("unknown", { type: "not-a-block" })),
    page(block("extra", { type: "paragraph", content: [{ type: "tableRow" }] })),
    page(block("attrs", { type: "image", attrs: { url: { invalid: true } } })),
    page(block("wrong-content", { type: "tabs" })),
    page({ type: "blockContainer", attrs: { id: "missing-content" } }),
    { type: "paragraph" },
  ])("rejects malformed or unreadable candidate trees", (document) => {
    expect(() => validateDocumentTree(document)).toThrow(/invalid|Document|Tab/i);
  });

  it("converts legacy table rows to native rows and keeps API identity and cell marks", () => {
    const legacy = page(
      block("table", { type: "table" }, [
        block("first-row", {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [{ ...text, marks: [{ type: "bold" }] }] }],
        }),
        block("second-row", { type: "tableRow", content: [{ type: "tableCell" }] }),
      ]),
    );
    const native = normalizeDocumentTables(legacy);
    expect(() => validateDocumentTree(native)).not.toThrow();
    const table = documentBlocks(native)[0]!;
    expect(table.children.map((row) => row.internalId)).toEqual(["first-row", "second-row"]);
    expect(table.node.content?.[0]?.content?.[0]?.content?.[0]?.type).toBe("tableParagraph");
    expect(notionPayloadForBlock(table.children[0]!).payload.cells).toMatchObject([[{ annotations: { bold: true } }]]);
    expect(legacy.content[0]!.content[0]!.content).toHaveLength(2);
  });

  it("produces native tables from Notion input and rejects uneven row geometry", () => {
    const table = notionInputToBlockContainer({
      table: {
        table_width: 2,
        children: [
          { id: "row-a", table_row: { cells: [[{ text: { content: "A" } }], []] } },
          { id: "row-b", table_row: { cells: [[], []] } },
        ],
      },
    });
    expect(() => validateDocumentTree(page(table))).not.toThrow();
    expect(table.content).toHaveLength(1);
    table.content![0]!.content![1]!.content!.pop();
    expect(() => validateDocumentTree(page(table))).toThrow(/consistent width/);
  });

  it("validates spans against the whole table instead of requiring equal cell counts", () => {
    const cell = { type: "tableCell", attrs: { colwidth: [0] }, content: [{ type: "tableParagraph" }] };
    expect(() =>
      validateDocumentTree(
        page(
          block("table", {
            type: "table",
            content: [
              { type: "tableRow", content: [{ ...cell, attrs: { rowspan: 2 } }, cell] },
              { type: "tableRow", content: [cell] },
            ],
          }),
        ),
      ),
    ).not.toThrow();
  });

  it("accepts tabs and readable dangling footnote references, rejects nested tabs", () => {
    const panel = block("panel", { type: "tabPanel", attrs: { label: "One" } }, [
      block("body", {
        type: "paragraph",
        content: [{ type: "footnoteReference", attrs: { definitionId: "missing" } }],
      }),
    ]);
    const tabs = block("tabs", { type: "tabs" }, [panel]);
    expect(() => validateDocumentTree(page(tabs))).not.toThrow();
    panel.content.push({
      type: "blockGroup",
      content: [
        block("nested", { type: "tabs" }, [block("nested-panel", { type: "tabPanel", attrs: { label: "Two" } })]),
      ],
    });
    expect(() => validateDocumentTree(page(tabs))).toThrow(/invalid|Document|Tab/i);
  });
});
