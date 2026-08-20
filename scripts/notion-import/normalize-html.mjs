/**
 * Rewrites Notion's exported HTML into markup BlockNote can parse.
 *
 * Notion's HTML is its own dialect and in places is not valid HTML at all, so this
 * runs before `tryParseHTMLToBlocks` rather than trying to teach BlockNote the dialect.
 * Every rule is guarded by a selector, so markup no rule recognises falls through to
 * BlockNote's generic parse instead of throwing.
 *
 * What BlockNote already handles, and this therefore leaves alone: headings, lists,
 * `<details>/<summary>` toggles (exactly what Notion emits), blockquote, `<pre><code>`,
 * `<hr>`, `<table>`, `<figure><img>+<figcaption>`, and inline `<strong> <em> <del> <u>
 * <code> <a>`. BlockNote's default colour names are Notion's, so colours map by name.
 *
 * Anything that cannot survive is reported through `onIssue` rather than dropped
 * quietly: an import that silently loses content is worse than one that says so.
 */
import { JSDOM } from "jsdom";

const NOTION_COLORS = new Set(["gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"]);

function replaceWith(node, replacement) {
  node.parentNode?.replaceChild(replacement, node);
}

/** Lifts an element's children into its place and removes the element. */
function unwrap(node) {
  const parent = node.parentNode;
  if (!parent) return;
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
}

export function normalizeNotionHtml(html, options = {}) {
  const { resolveHref = () => null, onIssue = () => {} } = options;
  const dom = new JSDOM(html);
  const { document } = dom.window;

  // The exported header holds the cover, icon, title, and the database property table.
  // The title is taken from the page's own metadata, so the whole header goes.
  const body = document.querySelector("article > div.page-body") ?? document.querySelector("div.page-body");
  if (!body) throw new Error("The exported page has no Notion page-body element; refusing to import it as blank.");

  for (const nav of body.querySelectorAll("nav.table_of_contents, nav.breadcrumb")) {
    onIssue("unsupported_block", nav.className.includes("breadcrumb") ? "breadcrumb" : "table_of_contents");
    nav.remove();
  }

  // Notion writes `@import url(katex.css)` immediately before every inline equation.
  for (const style of body.querySelectorAll("style")) style.remove();

  // Notion nests `<div class="indented">` inside `<p>`, which is invalid, so any parser
  // splits it and synthesises empty `<p>` elements with no id. Real Notion blocks always
  // carry an id, which is what distinguishes them from the phantoms.
  for (const paragraph of body.querySelectorAll("p")) {
    if (!paragraph.id && !paragraph.textContent.trim() && !paragraph.querySelector("img, a, code")) {
      paragraph.remove();
    }
  }

  // Column layouts have no BlockNote equivalent, so the columns are concatenated in
  // document order rather than dropped.
  for (const columnList of body.querySelectorAll("div.column-list")) {
    onIssue("unsupported_block", "column_list");
    for (const column of columnList.querySelectorAll("div.column")) unwrap(column);
    unwrap(columnList);
  }

  // Inside a list item this restores the nesting BlockNote expects; at the top level it
  // flattens an indent that has nowhere to go.
  for (const indented of body.querySelectorAll("div.indented")) {
    const insideListItem = indented.closest("li") !== null;
    if (!insideListItem && indented.textContent.trim()) onIssue("nesting_flattened", "indented");
    unwrap(indented);
  }

  // Notion writes underline as inline CSS, never as <u>.
  for (const span of body.querySelectorAll('span[style*="border-bottom"]')) {
    if (!span.getAttribute("style")?.includes("border-bottom:0.05em solid")) continue;
    const underline = document.createElement("u");
    while (span.firstChild) underline.append(span.firstChild);
    replaceWith(span, underline);
  }

  // A to-do item is a div, not an input, so BlockNote cannot recognise it as a checklist.
  for (const item of body.querySelectorAll("li")) {
    const checkbox = item.querySelector("div.checkbox");
    if (!checkbox) continue;
    const input = document.createElement("input");
    input.setAttribute("type", "checkbox");
    if (checkbox.className.includes("checkbox-on")) input.setAttribute("checked", "");
    replaceWith(checkbox, input);
  }

  // A callout becomes a quote carrying its icon as leading text. The icon is the first
  // child div and the body the second; nested blocks inside it are flattened.
  for (const callout of body.querySelectorAll("figure.callout")) {
    const children = [...callout.children];
    const icon = children[0]?.textContent?.trim() ?? "";
    const content = children[1];
    const quote = document.createElement("blockquote");
    if (icon) quote.append(document.createTextNode(`${icon} `));
    if (content) while (content.firstChild) quote.append(content.firstChild);
    onIssue("nesting_flattened", "callout");
    replaceWith(callout, quote);
  }

  // There is no maths block, so the TeX is preserved as a latex code block rather than
  // rendered. The source is the KaTeX annotation, which holds the original expression.
  for (const equation of body.querySelectorAll("figure.equation")) {
    const tex = equation.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? "";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-latex";
    code.textContent = tex;
    pre.append(code);
    onIssue("unsupported_block", "equation");
    replaceWith(equation, pre);
  }

  for (const token of body.querySelectorAll("span.notion-text-equation-token")) {
    const tex = token.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? "";
    const code = document.createElement("code");
    code.textContent = tex;
    onIssue("unsupported_block", "inline_equation");
    replaceWith(token, code);
  }

  // Notion wraps exported images in an anchor to the same file, which BlockNote reads as
  // a link rather than an image.
  for (const anchor of body.querySelectorAll("figure.image a")) {
    if (anchor.querySelector("img")) unwrap(anchor);
  }

  // BlockNote reads the width attribute, not the inline style Notion writes.
  for (const image of body.querySelectorAll("img")) {
    const width = /width:\s*(\d+)px/.exec(image.getAttribute("style") ?? "")?.[1];
    if (width) image.setAttribute("width", width);
    image.removeAttribute("style");
  }

  // A bookmark is a rich link card with no equivalent, so it degrades to a titled link.
  for (const bookmark of body.querySelectorAll("a.bookmark")) {
    const href = bookmark.getAttribute("href") ?? "";
    const title = bookmark.querySelector(".bookmark-title")?.textContent?.trim() || href;
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.setAttribute("href", href);
    link.textContent = title;
    paragraph.append(link);
    onIssue("unsupported_block", "bookmark");
    const figure = bookmark.closest("figure") ?? bookmark;
    replaceWith(figure, paragraph);
  }

  // A file attachment is a figure wrapping a link; BlockNote reads an embed with a caption.
  for (const source of body.querySelectorAll("figure div.source")) {
    const anchor = source.querySelector("a");
    const figure = source.closest("figure");
    if (!anchor || !figure) continue;
    const embed = document.createElement("embed");
    embed.setAttribute("src", anchor.getAttribute("href") ?? "");
    const caption = document.createElement("figcaption");
    caption.textContent = anchor.textContent?.trim() ?? "";
    figure.replaceChildren(embed, caption);
  }

  // Colour is carried on class names; BlockNote reads inline styles and its palette
  // shares Notion's names, so the mapping is by name rather than by hex value.
  for (const element of body.querySelectorAll('[class*="block-color-"], [class*="highlight-"]')) {
    const match = /(?:block-color|highlight)-(\w+?)(_background)?(?:\s|$)/.exec(element.className);
    if (!match) continue;
    const [, color, background] = match;
    if (!NOTION_COLORS.has(color)) continue;
    const existing = element.getAttribute("style") ?? "";
    element.setAttribute("style", `${existing};${background ? "background-color" : "color"}:${color}`);
  }

  // Notion pads blocks apart with stray line breaks, which would become empty paragraphs.
  for (const lineBreak of body.querySelectorAll("br")) {
    if (lineBreak.parentElement === body) lineBreak.remove();
  }

  // A simple table has no header row and its cell ids repeat per row; both confuse the
  // parser, and ragged rows have to be padded or the table is rejected outright.
  for (const table of body.querySelectorAll("table.simple-table")) {
    const rows = [...table.querySelectorAll("tr")];
    const widest = Math.max(0, ...rows.map((row) => row.children.length));
    for (const row of rows) {
      while (row.children.length < widest) row.append(document.createElement("td"));
    }
  }

  rewriteLinks(body, document, resolveHref, onIssue);

  // Block ids are Notion's, and BlockNote assigns its own.
  for (const element of body.querySelectorAll("[id]")) element.removeAttribute("id");
  for (const element of body.querySelectorAll("table, td, th, tr")) element.removeAttribute("class");

  return body.innerHTML;
}

/**
 * Turns links into mentions, asset references, or plain external links.
 *
 * A mention is emitted as plain HTML because BlockNote registers a parse rule for
 * `[data-inline-content-type="mention"]` and maps each prop from its `data-*`
 * attribute, so the whole rewrite stays a DOM edit rather than a walk over parsed blocks.
 */
function rewriteLinks(body, document, resolveHref, onIssue) {
  for (const anchor of body.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    const resolved = resolveHref(href);
    if (!resolved) {
      // Only a relative link that resolved to nothing is a problem; an external link is
      // simply left as a link.
      if (!/^https?:|^mailto:|^#/i.test(href)) onIssue("link_unresolved", href);
      continue;
    }
    if (resolved.type === "asset") {
      anchor.setAttribute("href", resolved.url);
      continue;
    }
    if (resolved.type === "skipped-unsafe-asset") {
      onIssue("attachment_skipped_unsafe", href);
      replaceWith(anchor, document.createTextNode(anchor.textContent ?? ""));
      continue;
    }
    const mention = document.createElement("span");
    mention.setAttribute("data-inline-content-type", "mention");
    mention.setAttribute("data-entity-type", "page");
    mention.setAttribute("data-entity-id", resolved.entityId);
    mention.setAttribute("data-label", resolved.label);
    mention.textContent = `@${resolved.label}`;
    // A page link rendered as its own block becomes a paragraph holding the mention.
    const figure = anchor.closest("figure.link-to-page");
    replaceWith(figure ?? anchor, figure ? wrapInParagraph(document, mention) : mention);
  }

  for (const element of body.querySelectorAll("img[src], embed[src], video[src], audio[src], source[src]")) {
    const resolved = resolveHref(element.getAttribute("src") ?? "");
    if (resolved?.type === "asset") element.setAttribute("src", resolved.url);
    else if (resolved?.type === "skipped-unsafe-asset") {
      onIssue("attachment_skipped_unsafe", element.getAttribute("src") ?? "");
      element.remove();
    } else if (!resolved) onIssue("attachment_missing", element.getAttribute("src") ?? "");
  }
}

function wrapInParagraph(document, node) {
  const paragraph = document.createElement("p");
  paragraph.append(node);
  return paragraph;
}
