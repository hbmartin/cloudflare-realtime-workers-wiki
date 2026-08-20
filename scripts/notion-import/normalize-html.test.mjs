/**
 * The markup samples here are Notion's real exported shapes, not invented ones. Where a
 * rule exists because Notion does something unusual, the test says so.
 */
import { describe, expect, it } from "vitest";
import { createImportEditor, htmlToBlocks } from "./blocks.mjs";
import { normalizeNotionHtml } from "./normalize-html.mjs";

function page(inner) {
  return `<html><head><title>T</title></head><body><article id="a1" class="page sans">
    <header><img class="page-cover-image" src="cover.png"/><div class="page-header-icon"><span class="icon">💡</span></div>
    <h1 class="page-title">A Page</h1><table class="properties"><tr><td>Prop</td></tr></table></header>
    <div class="page-body">${inner}</div></article></body></html>`;
}

function normalize(inner, options) {
  const issues = [];
  const html = normalizeNotionHtml(page(inner), {
    onIssue: (code, detail) => issues.push(`${code}:${detail}`),
    ...options,
  });
  return { html, issues };
}

describe("scoping", () => {
  it("keeps only the page body, dropping the cover, icon, title, and property table", () => {
    const { html } = normalize('<p id="p1">Body text</p>');
    expect(html).toContain("Body text");
    expect(html).not.toContain("page-title");
    expect(html).not.toContain("properties");
    expect(html).not.toContain("page-cover-image");
  });

  it("drops the table of contents and reports it", () => {
    const { html, issues } = normalize('<nav id="n" class="table_of_contents"><div>Heading</div></nav><p id="p">x</p>');
    expect(html).not.toContain("table_of_contents");
    expect(issues).toContain("unsupported_block:table_of_contents");
  });
});

describe("inline formatting", () => {
  it("reads underline from inline CSS, which is the only way Notion writes it", () => {
    const { html } = normalize('<p id="p"><span style="border-bottom:0.05em solid">under</span></p>');
    expect(html).toContain("<u>under</u>");
  });

  it("converts an inline equation and removes the stylesheet Notion injects before it", () => {
    const { html, issues } = normalize(
      `<p id="p">E is <style>@import url('https://cdn.test/katex.min.css')</style>` +
        `<span data-token-index="0" class="notion-text-equation-token">` +
        `<annotation encoding="application/x-tex">E = mc^2</annotation></span></p>`,
    );
    expect(html).toContain("<code>E = mc^2</code>");
    expect(html).not.toContain("@import");
    expect(issues).toContain("unsupported_block:inline_equation");
  });
});

describe("blocks Notion writes its own way", () => {
  it("turns a to-do list into checkbox inputs BlockNote can read", async () => {
    const { html } = normalize(
      '<ul id="u" class="to-do-list"><li><div class="checkbox checkbox-on"></div>' +
        '<span class="to-do-children-checked">done</span></li>' +
        '<li><div class="checkbox checkbox-off"></div><span class="to-do-children-unchecked">todo</span></li></ul>',
    );
    const editor = await createImportEditor();
    const blocks = await htmlToBlocks(editor, html);
    expect(blocks.map((block) => block.type)).toEqual(["checkListItem", "checkListItem"]);
    expect(blocks[0].props.checked).toBe(true);
    expect(blocks[1].props.checked).toBe(false);
  });

  it("passes a toggle straight through, because Notion already emits details/summary", async () => {
    const { html } = normalize(
      '<ul id="u" class="toggle"><li><details open=""><summary>Summary</summary>' +
        '<p id="p2">Inside</p></details></li></ul>',
    );
    const editor = await createImportEditor();
    const blocks = await htmlToBlocks(editor, html);
    expect(blocks[0].type).toBe("toggleListItem");
  });

  it("degrades a callout to a quote carrying its icon", () => {
    const { html, issues } = normalize(
      '<figure id="f" class="block-color-gray_background callout" style="display:flex">' +
        '<div style="font-size:1.5em"><span class="icon">💡</span></div>' +
        '<div style="width:100%">Watch out</div></figure>',
    );
    expect(html).toContain("<blockquote");
    expect(html).toContain("💡 Watch out");
    expect(issues).toContain("nesting_flattened:callout");
  });

  it("flattens a column layout in document order", () => {
    const { html, issues } = normalize(
      '<div id="cl" class="column-list"><div id="c1" class="column"><p id="p1">Left</p></div>' +
        '<div id="c2" class="column"><p id="p2">Right</p></div></div>',
    );
    expect(html.indexOf("Left")).toBeLessThan(html.indexOf("Right"));
    expect(html).not.toContain("column-list");
    expect(issues).toContain("unsupported_block:column_list");
  });

  it("preserves a block equation as latex source rather than losing it", () => {
    const { html, issues } = normalize(
      '<figure id="f" class="equation"><div class="equation-container">' +
        '<annotation encoding="application/x-tex">E = mc^2</annotation></div></figure>',
    );
    expect(html).toContain('class="language-latex"');
    expect(html).toContain("E = mc^2");
    expect(issues).toContain("unsupported_block:equation");
  });

  it("unwraps the anchor Notion wraps around every exported image and keeps its width", () => {
    const { html } = normalize(
      '<figure id="f" class="image"><a href="page/img.png">' +
        '<img style="width:707px" src="page/img.png"/></a></figure>',
    );
    expect(html).not.toContain("<a href");
    expect(html).toContain('width="707"');
  });

  it("degrades a bookmark card to a titled link", () => {
    const { html, issues } = normalize(
      '<figure id="f"><a href="https://example.test/" class="bookmark source">' +
        '<div class="bookmark-info"><div class="bookmark-text"><div class="bookmark-title">Example Site</div>' +
        "</div></div></a></figure>",
    );
    expect(html).toContain('href="https://example.test/"');
    expect(html).toContain("Example Site");
    expect(issues).toContain("unsupported_block:bookmark");
  });

  it("pads a ragged simple table so the parser accepts it", async () => {
    const { html } = normalize(
      '<table id="t" class="simple-table"><tbody>' +
        '<tr id="r1"><td id="ldE">a</td><td id="KwQz">b</td></tr>' +
        '<tr id="r2"><td id="ldE">c</td></tr></tbody></table>',
    );
    const editor = await createImportEditor();
    const blocks = await htmlToBlocks(editor, html);
    expect(blocks[0].type).toBe("table");
    expect(blocks[0].content.rows).toHaveLength(2);
    expect(blocks[0].content.rows[1].cells).toHaveLength(2);
  });

  it("removes the phantom paragraphs left by Notion nesting a div inside a p", () => {
    // Notion writes `<p>aaa<div class="indented">...</div></p>`, which no parser accepts;
    // splitting it leaves an empty, id-less <p> behind.
    const { html } = normalize('<p id="p1">aaa</p><div class="indented"><p id="p2">bbb</p></div><p></p>');
    expect(html).toContain("aaa");
    expect(html).toContain("bbb");
    expect(html).not.toMatch(/<p><\/p>/);
  });
});

const resolveHref = (href) => {
  if (href.includes("Target")) return { type: "page", entityId: "page-uuid", label: "Target Page" };
  if (href.endsWith(".png")) return { type: "asset", url: "/api/attachments/att-1" };
  return null;
};

describe("link rewriting", () => {
  it("emits a mention that survives all the way to a page reference", async () => {
    const { html } = normalize('<p id="p">See <a href="Target%20abc.html">Target</a> now</p>', { resolveHref });
    const editor = await createImportEditor();
    const blocks = await htmlToBlocks(editor, html);
    const mention = blocks[0].content.find((item) => item.type === "mention");
    expect(mention.props).toEqual({ entityType: "page", entityId: "page-uuid", label: "Target Page" });
  });

  it("turns a child-page block into a paragraph holding the mention", () => {
    const { html } = normalize('<figure id="f" class="link-to-page"><a href="Target%20abc.html">Target</a></figure>', {
      resolveHref,
    });
    expect(html).toContain('data-entity-id="page-uuid"');
    expect(html).toMatch(/<p>\s*<span data-inline-content-type="mention"/);
  });

  it("points an image at the uploaded attachment", () => {
    const { html } = normalize('<figure id="f" class="image"><img src="page/img.png"/></figure>', { resolveHref });
    expect(html).toContain('src="/api/attachments/att-1"');
  });

  it("leaves an external link alone but reports a relative one that went nowhere", () => {
    const { issues, html } = normalize(
      '<p id="p"><a href="https://example.test/x">out</a><a href="Missing%20page.html">gone</a></p>',
      { resolveHref },
    );
    expect(html).toContain('href="https://example.test/x"');
    expect(issues.some((issue) => issue.startsWith("link_unresolved:"))).toBe(true);
    expect(issues.some((issue) => issue.includes("example.test"))).toBe(false);
  });
});
