import { describe, expect, it } from "vitest";
import { notionInputToBlockContainer } from "./notion-blocks";
import { parseMarkdownCommand } from "./notion-markdown-commands";
import { projectNotionMarkdown } from "./notion-markdown";
import { markdownEditTargets, markdownMutations } from "./notion-markdown-mutations";
import { parseWritableMarkdown } from "./notion-markdown-write";

function fixture() {
  const first = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "First paragraph" } }] } });
  const second = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Second paragraph" } }] } });
  const document = { type: "doc", content: [{ type: "blockGroup", content: [first, second] }] };
  const projection = projectNotionMarkdown(document);
  return { first, second, document, projection };
}

describe("Notion Markdown block mutations", () => {
  it("replaces only the selected block and keeps its ID", () => {
    const { first, second, document, projection } = fixture();
    const command = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] } },
      projection.markdown,
    );
    const operations = markdownMutations(document, projection, command.edits, false);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      type: "replace_block",
      internalId: first.attrs?.id,
      container: {
        attrs: { id: first.attrs?.id },
        content: [{ type: "paragraph", content: [{ text: "Changed paragraph" }] }],
      },
    });
    expect(JSON.stringify(operations)).not.toContain(second.attrs?.id);
  });

  it("inserts at the start without changing existing IDs", () => {
    const { document, projection } = fixture();
    const command = parseMarkdownCommand(
      { type: "insert_content", insert_content: { content: "Intro\n\n", position: { type: "start" } } },
      projection.markdown,
    );
    expect(markdownMutations(document, projection, command.edits, false)).toMatchObject([
      { type: "append_children", position: { type: "start" } },
    ]);
  });

  it("replaces an empty page body", () => {
    const document = { type: "doc", content: [{ type: "blockGroup", content: [] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      { type: "replace_content", replace_content: { new_str: "First paragraph\n" } },
      projection.markdown,
    );
    expect(markdownMutations(document, projection, command.edits, false)).toMatchObject([
      { type: "append_children", position: { type: "start" } },
    ]);
  });

  it("appends body content before a child-page marker", () => {
    const { document } = fixture();
    const projection = projectNotionMarkdown(document, new Map(), {}, [
      {
        id: "child",
        internalId: "child",
        type: "linkToPage",
        node: { type: "linkToPage", attrs: { pageId: "child", title: "Child" } },
        children: [],
      },
    ]);
    const command = parseMarkdownCommand(
      { type: "insert_content", insert_content: { content: "Last paragraph\n", position: { type: "end" } } },
      projection.markdown,
    );
    expect(markdownMutations(document, projection, command.edits, false)).toMatchObject([
      { type: "append_children", position: { type: "after_block" } },
    ]);
  });

  it("keeps existing IDs and formatting when a range inserts between unchanged blocks", () => {
    const { first, second, document, projection } = fixture();
    first.content![0]!.attrs = { ...first.content![0]!.attrs, textColor: "red" };
    const updated = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      {
        type: "replace_content_range",
        replace_content_range: {
          content_range: "First paragraph...Second paragraph",
          content: "First paragraph\n\nMiddle\n\nSecond paragraph",
        },
      },
      updated.markdown,
    );
    const operations = markdownMutations(document, updated, command.edits, false);
    expect(operations).toMatchObject([{ type: "append_children" }]);
    expect(operations[0]).toMatchObject({ position: { afterInternalId: first.attrs?.id } });
    expect(operations.some((operation) => "internalId" in operation && operation.internalId === second.attrs?.id)).toBe(
      false,
    );
    expect(projection.markdown).toContain("First paragraph");
  });

  it("keeps list items when only their Markdown numbering changes", () => {
    const blocks = parseWritableMarkdown("1. a\n1. b\n1. c\n\nAfter\n");
    const document = { type: "doc", content: [{ type: "blockGroup", content: blocks }] };
    const projection = projectNotionMarkdown(document);
    const protectedId = String(blocks[2]!.attrs?.id);
    const changed = projection.markdown.replace("1. b", "2. b").replace("1. c", "3. c").replace("After", "Updated");
    const command = parseMarkdownCommand(
      { type: "replace_content", replace_content: { new_str: changed } },
      projection.markdown,
    );
    const operations = markdownMutations(document, projection, command.edits, false, new Set([protectedId]));
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ type: "replace_block", internalId: blocks[3]!.attrs?.id });
  });

  it("preserves nested and parent color while editing a list label", () => {
    const [parent] = parseWritableMarkdown("- Parent\n  - **_Styled_**\n");
    parent!.content![0]!.attrs = { ...parent!.content![0]!.attrs, textColor: "blue" };
    const child = parent!.content![1]!.content![0]!;
    child.content![0]!.attrs = { ...child.content![0]!.attrs, textColor: "red" };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [parent!] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "Parent", new_str: "Updated" }] } },
      projection.markdown,
    );
    const operations = markdownMutations(document, projection, command.edits, false);
    expect(operations[0]).toMatchObject({
      type: "replace_block",
      container: {
        content: [{ attrs: { textColor: "blue" } }, { content: [{ content: [{ attrs: { textColor: "red" } }] }] }],
      },
    });
  });

  it("keeps multiline math untouched when surrounding paragraphs change", () => {
    const { first, second } = fixture();
    const math = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [{ type: "math", attrs: { formula: "a\n\nb" } }],
    };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [first, math, second] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      {
        type: "replace_content",
        replace_content: {
          new_str: projection.markdown.replace("First", "Updated first").replace("Second", "Updated second"),
        },
      },
      projection.markdown,
    );
    const operations = markdownMutations(document, projection, command.edits, false);
    expect(operations.filter((operation) => operation.type === "replace_block")).toHaveLength(2);
    expect(JSON.stringify(operations)).not.toContain(math.attrs.id);
  });

  it("keeps zero-length spacer blocks while replacing surrounding text", () => {
    const { first, second } = fixture();
    const spacer = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [{ type: "paragraph", attrs: { textColor: "red" } }],
    };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [first, spacer, second] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      {
        type: "replace_content",
        replace_content: {
          new_str: projection.markdown.replace("First", "Updated first").replace("Second", "Updated second"),
        },
      },
      projection.markdown,
    );
    const operations = markdownMutations(document, projection, command.edits, false);
    expect(operations.filter((operation) => operation.type === "replace_block")).toHaveLength(2);
    expect(JSON.stringify(operations)).not.toContain(spacer.attrs.id);
  });

  it("rejects a full replacement that would silently leave an invisible spacer", () => {
    const { first, second } = fixture();
    const spacer = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [{ type: "paragraph" }],
    };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [first, spacer, second] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      { type: "replace_content", replace_content: { new_str: "Only one block", allow_deleting_content: true } },
      projection.markdown,
    );
    expect(() => markdownMutations(document, projection, command.edits, true)).toThrow("invisible block");
  });

  it("keeps untouched styled and table-of-contents blocks within a replaced range", () => {
    const { first, second } = fixture();
    const styled = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [
        {
          type: "paragraph",
          attrs: { textColor: "red" },
          content: [{ type: "text", text: "Styled", marks: [{ type: "italic" }, { type: "bold" }] }],
        },
      ],
    };
    const toc = { type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "tableOfContents" }] };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [first, styled, toc, second] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      {
        type: "replace_content",
        replace_content: {
          new_str: projection.markdown.replace("First", "Updated first").replace("Second", "Updated second"),
        },
      },
      projection.markdown,
    );
    const operations = markdownMutations(document, projection, command.edits, false);
    expect(operations.filter((operation) => operation.type === "replace_block")).toHaveLength(2);
    expect(JSON.stringify(operations)).not.toContain(styled.attrs.id);
    expect(JSON.stringify(operations)).not.toContain(toc.attrs.id);
  });

  it("does not confuse literal unknown text in code with an unknown block", () => {
    const code = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [
        { type: "codeBlock", attrs: { language: "txt" }, content: [{ type: "text", text: "<unknown literal" }] },
      ],
    };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [code] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "literal", new_str: "text" }] } },
      projection.markdown,
    );
    expect(markdownMutations(document, projection, command.edits, false)).toHaveLength(1);
  });

  it("rejects a changed audio link while preserving the same audio inside a range", () => {
    const audio = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [{ type: "audio", attrs: { url: "https://example.com/audio.mp3", caption: "Recording" } }],
    };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [audio] }] };
    const projection = projectNotionMarkdown(document);
    const command = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "Recording", new_str: "Edited" }] } },
      projection.markdown,
    );
    expect(() => markdownMutations(document, projection, command.edits, true)).toThrow(/block API/);
  });

  it("identifies a selected block across a concurrent projection", () => {
    const { document, projection } = fixture();
    const edit = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] } },
      projection.markdown,
    ).edits;
    const original = markdownEditTargets(document, projection, edit);
    const unrelated = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Intro" } }] } });
    const shiftedDocument = {
      ...document,
      content: [{ type: "blockGroup", content: [unrelated, ...document.content![0]!.content!] }],
    };
    const shifted = projectNotionMarkdown(shiftedDocument);
    const shiftedEdit = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] } },
      shifted.markdown,
    ).edits;
    expect(markdownEditTargets(shiftedDocument, shifted, shiftedEdit)).toEqual(original);
    const changedDocument = {
      ...document,
      content: [
        {
          type: "blockGroup",
          content: [
            {
              ...document.content![0]!.content![0]!,
              content: [{ type: "paragraph", content: [{ type: "text", text: "First changed" }] }],
            },
            document.content![0]!.content![1]!,
          ],
        },
      ],
    };
    const changed = projectNotionMarkdown(changedDocument);
    expect(
      markdownEditTargets(
        changedDocument,
        changed,
        parseMarkdownCommand(
          { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] } },
          changed.markdown,
        ).edits,
      ),
    ).not.toEqual(original);
  });

  it("rejects edits to unknown content and preserves unrelated child pages", () => {
    const { document } = fixture();
    const withChild = projectNotionMarkdown(
      document,
      new Map(),
      { pageHref: () => "https://example.test/?page=child" },
      [
        {
          id: "child",
          internalId: "child",
          type: "linkToPage",
          node: { type: "linkToPage", attrs: { pageId: "child", title: "Child" } },
          children: [],
        },
      ],
    );
    const update = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Edited" }] } },
      withChild.markdown,
    );
    expect(markdownMutations(document, withChild, update.edits, false)).toHaveLength(1);
    const replace = parseMarkdownCommand(
      { type: "replace_content", replace_content: { new_str: "New page" } },
      withChild.markdown,
    );
    expect(() => markdownMutations(document, withChild, replace.edits, false)).toThrow(/child page/);
  });

  it("refuses to replace a list whose nested item owns a comment anchor", () => {
    const child = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [
        { type: "bulletListItem", content: [{ type: "text", text: "Child", marks: [{ type: "comment--thread" }] }] },
      ],
    };
    const parent = {
      type: "blockContainer",
      attrs: { id: crypto.randomUUID() },
      content: [
        { type: "bulletListItem", content: [{ type: "text", text: "Parent" }] },
        { type: "blockGroup", content: [child] },
      ],
    };
    const document = { type: "doc", content: [{ type: "blockGroup", content: [parent] }] };
    const projection = projectNotionMarkdown(document);
    const edit = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "Parent", new_str: "Changed" }] } },
      projection.markdown,
    );
    expect(() => markdownMutations(document, projection, edit.edits, false)).toThrow(/comment anchors/);
  });
});
