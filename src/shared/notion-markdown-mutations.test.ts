import { describe, expect, it } from "vitest";
import { notionInputToBlockContainer } from "./notion-blocks";
import { parseMarkdownCommand } from "./notion-markdown-commands";
import { projectNotionMarkdown } from "./notion-markdown";
import { markdownEditTargets, markdownMutations } from "./notion-markdown-mutations";

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

  it("identifies a selected block across a concurrent projection", () => {
    const { document, projection } = fixture();
    const edit = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] } },
      projection.markdown,
    ).edits;
    const original = markdownEditTargets(projection, edit);
    const unrelated = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Intro" } }] } });
    const shifted = projectNotionMarkdown({
      ...document,
      content: [{ type: "blockGroup", content: [unrelated, ...document.content![0]!.content!] }],
    });
    const shiftedEdit = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Changed" }] } },
      shifted.markdown,
    ).edits;
    expect(markdownEditTargets(shifted, shiftedEdit)).toEqual(original);
    const changed = projectNotionMarkdown({
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
    });
    expect(
      markdownEditTargets(
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
