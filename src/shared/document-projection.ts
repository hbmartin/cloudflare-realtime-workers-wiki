import type { ProseMirrorJson } from "./types";

export type { ProseMirrorJson } from "./types";

export type ProjectedReference = {
  targetId: string;
  excerpt: string;
};

export type DocumentProjection = {
  plainText: string;
  pageReferences: ProjectedReference[];
  memberMentions: ProjectedReference[];
};

export type SerializedDocument = DocumentProjection & {
  markdown: string;
  html: string;
};

const MAX_PLAIN_TEXT = 500_000;
const EXCERPT_CHARS = 240;

function stringAttr(node: ProseMirrorJson, name: string) {
  const value = node.attrs?.[name];
  return typeof value === "string" ? value : null;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

// CommonMark inline punctuation that would otherwise turn imported literals into
// markup. `_` is deliberately absent: CommonMark does not emphasise intraword `_`,
// so escaping it would mangle every snake_case identifier.
function escapeMarkdownInline(value: string) {
  return value.replaceAll(/[\\`*[\]<>|]/g, (character) => `\\${character}`);
}

// Block-level constructs are only meaningful at the start of a line.
function escapeMarkdownText(value: string) {
  return escapeMarkdownInline(value).replace(
    /(^|\n)([ \t]*)(#{1,6}(?=\s|$)|>|[-+](?=\s|$)|\d{1,9}[.)](?=\s|$)|={2,}$|-{2,}$)/g,
    (_match, lineStart: string, indent: string, token: string) => `${lineStart}${indent}\\${token}`,
  );
}

// Markdown link and image destinations break on whitespace and unbalanced parens.
function markdownDestination(value: string) {
  return /[\s()<>]/.test(value) ? `<${value.replaceAll(/[<>]/g, encodeURIComponent)}>` : value;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, "https://notes.invalid");
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function markedText(node: ProseMirrorJson, format: "markdown" | "html") {
  const text = node.text ?? "";
  // A code span is verbatim in Markdown, so backslash escapes would be literal there.
  const code = (node.marks ?? []).some((mark) => mark.type === "code");
  let value = format === "html" ? escapeHtml(text) : code ? text : escapeMarkdownText(text);
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold" || mark.type === "strong")
      value = format === "html" ? `<strong>${value}</strong>` : `**${value}**`;
    else if (mark.type === "italic" || mark.type === "em")
      value = format === "html" ? `<em>${value}</em>` : `_${value}_`;
    else if (mark.type === "strike") value = format === "html" ? `<s>${value}</s>` : `~~${value}~~`;
    else if (mark.type === "code") value = format === "html" ? `<code>${value}</code>` : `\`${value}\``;
    else if (mark.type === "link") {
      const href = safeUrl(mark.attrs?.href);
      if (href)
        value =
          format === "html"
            ? `<a href="${escapeHtml(href)}" rel="noreferrer">${value}</a>`
            : `[${value}](${markdownDestination(href)})`;
    }
  }
  return value;
}

function nodeText(node: ProseMirrorJson): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "mention") return stringAttr(node, "label") ?? "";
  return (node.content ?? []).map(nodeText).join("");
}

const LIST_ITEM_TYPES = new Set(["bulletListItem", "numberedListItem", "checkListItem", "listItem"]);
// A list item's own line stops here; these carry its nested structure instead.
const NESTED_BLOCK_TYPES = new Set(["bulletList", "numberedList", "blockGroup"]);

function serializeInline(node: ProseMirrorJson, format: "markdown" | "html"): string {
  if (typeof node.text === "string") return markedText(node, format);
  if (node.type === "mention") {
    const label = stringAttr(node, "label") ?? "Mention";
    const id = stringAttr(node, "entityId");
    if (format === "html") return `<span data-mention-id="${escapeHtml(id ?? "")}">${escapeHtml(label)}</span>`;
    return `@${escapeMarkdownInline(label)}`;
  }
  if (node.type === "hardBreak") return format === "html" ? "<br>" : "  \n";
  if (node.type === "inlineMath") {
    const formula = stringAttr(node, "formula") ?? nodeText(node);
    return format === "html"
      ? `<span class="math" data-formula="${escapeHtml(formula)}">${escapeHtml(formula)}</span>`
      : `$${formula.replaceAll("$", "\\$")}$`;
  }
  return (node.content ?? []).map((child) => serializeInline(child, format)).join("");
}

// BlockNote keeps list items as plain siblings with no list node around them, so
// HTML needs the `ul`/`ol` wrapper synthesised from runs of adjacent items.
function listTagFor(node: ProseMirrorJson): "ul" | "ol" | null {
  const type = node.type ?? "";
  if (type === "numberedListItem") return "ol";
  if (LIST_ITEM_TYPES.has(type)) return "ul";
  if (type !== "blockContainer") return null;
  for (const child of node.content ?? []) {
    const childType = child.type ?? "";
    if (childType === "numberedListItem") return "ol";
    if (LIST_ITEM_TYPES.has(childType)) return "ul";
  }
  return null;
}

function serializeSequence(children: ProseMirrorJson[], format: "markdown" | "html", depth: number) {
  if (format !== "html") return children.map((child) => serializeNode(child, format, depth)).join("");
  let output = "";
  for (let index = 0; index < children.length;) {
    const tag = listTagFor(children[index]!);
    if (!tag) {
      output += serializeNode(children[index]!, format, depth);
      index += 1;
      continue;
    }
    let end = index;
    while (end < children.length && listTagFor(children[end]!) === tag) end += 1;
    const items = children.slice(index, end).map((child) => serializeNode(child, format, depth));
    output += `<${tag}>${items.join("")}</${tag}>`;
    index = end;
  }
  return output;
}

// A cell's text is inlined into one pipe-delimited line, so newlines are collapsed
// and every literal pipe is escaped or it would open a new column.
function markdownTableCell(node: ProseMirrorJson) {
  const rendered = (node.content ?? []).map((child) => serializeInline(child, "markdown")).join("");
  return normalizeText(rendered || escapeMarkdownInline(nodeText(node)));
}

function markdownTableRow(row: ProseMirrorJson) {
  return `| ${(row.content ?? []).map((cell) => markdownTableCell(cell)).join(" | ")} |\n`;
}

function serializeNode(node: ProseMirrorJson, format: "markdown" | "html", depth = 0): string {
  const children = node.content ?? [];
  const inline = children.map((child) => serializeInline(child, format)).join("");
  const blockChildren = () => children.map((child) => serializeNode(child, format, depth + 1)).join("");
  const transparentChildren = () => children.map((child) => serializeNode(child, format, depth)).join("");
  const type = node.type ?? "unknown";

  if (type === "blockContainer") {
    // BlockNote stores a list item and its children as siblings; fold the children
    // back into the item so nesting survives in both formats.
    const item = children.find((child) => LIST_ITEM_TYPES.has(child.type ?? ""));
    const groups = children.filter((child) => child.type === "blockGroup");
    if (item && groups.length) {
      return serializeNode({ ...item, content: [...(item.content ?? []), ...groups] }, format, depth);
    }
    return transparentChildren();
  }
  if (type === "doc" || type === "blockGroup") return serializeSequence(children, format, depth);
  if (type === "text" || type === "mention" || type === "inlineMath") return serializeInline(node, format);
  if (type === "paragraph") return format === "html" ? `<p>${inline}</p>` : `${inline}\n\n`;
  if (type === "heading" || /^heading[1-6]$/.test(type)) {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? type.slice(7) ?? 1)));
    return format === "html" ? `<h${level}>${inline}</h${level}>` : `${"#".repeat(level)} ${inline}\n\n`;
  }
  if (type === "blockquote" || type === "quote") {
    const text = escapeMarkdownText(nodeText(node).trim());
    return format === "html"
      ? `<blockquote>${blockChildren() || escapeHtml(text)}</blockquote>`
      : `${text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
  }
  if (type === "bulletList" || type === "numberedList" || LIST_ITEM_TYPES.has(type)) {
    if (type.endsWith("List")) {
      const tag = type === "bulletList" ? "ul" : "ol";
      // Items own their own indentation, so the container keeps the current depth.
      return format === "html" ? `<${tag}>${transparentChildren()}</${tag}>` : transparentChildren();
    }
    // Paragraph content belongs on the item's own line; child lists nest below it.
    const nested = children.filter((child) => NESTED_BLOCK_TYPES.has(child.type ?? ""));
    const own = children.filter((child) => !NESTED_BLOCK_TYPES.has(child.type ?? ""));
    const label = own.map((child) => serializeInline(child, format)).join("");
    const nestedOutput = nested.map((child) => serializeNode(child, format, depth + 1)).join("");
    if (format === "html") return `<li>${label}${nestedOutput}</li>`;
    const marker =
      type === "numberedListItem" ? "1." : type === "checkListItem" ? `- [${node.attrs?.checked ? "x" : " "}]` : "-";
    return `${"  ".repeat(depth)}${marker} ${label.trim()}\n${nestedOutput}`;
  }
  if (type === "codeBlock" || type === "code") {
    const language = stringAttr(node, "language") ?? "";
    const code = nodeText(node);
    return format === "html"
      ? `<pre><code data-language="${escapeHtml(language)}">${escapeHtml(code)}</code></pre>`
      : `\`\`\`${language}\n${code}\n\`\`\`\n\n`;
  }
  if (type === "divider" || type === "horizontalRule") return format === "html" ? "<hr>" : "---\n\n";
  if (["image", "audio", "video", "file"].includes(type)) {
    const url = safeUrl(node.attrs?.url) ?? "";
    const caption = stringAttr(node, "caption") ?? type;
    if (format === "markdown") {
      const label = escapeMarkdownInline(caption);
      const target = markdownDestination(url);
      return type === "image" ? `![${label}](${target})\n\n` : `[${label}](${target})\n\n`;
    }
    if (type === "image")
      return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
    return `<p><a href="${escapeHtml(url)}">${escapeHtml(caption)}</a></p>`;
  }
  if (type === "callout") {
    const tone = stringAttr(node, "tone") ?? "info";
    const icon = stringAttr(node, "icon") ?? "ℹ";
    return format === "html"
      ? `<aside class="callout callout-${escapeHtml(tone)}"><span>${escapeHtml(icon)}</span>${blockChildren() || `<p>${inline}</p>`}</aside>`
      : `> ${icon} ${escapeMarkdownText(nodeText(node).trim()).replaceAll("\n", "\n> ")}\n\n`;
  }
  if (type === "math") {
    const formula = stringAttr(node, "formula") ?? nodeText(node);
    return format === "html"
      ? `<div class="math" data-formula="${escapeHtml(formula)}"><pre>${escapeHtml(formula)}</pre></div>`
      : `$$\n${formula}\n$$\n\n`;
  }
  if (type === "mermaid") {
    const source = stringAttr(node, "source") ?? nodeText(node);
    return format === "html"
      ? `<pre class="mermaid">${escapeHtml(source)}</pre>`
      : `\`\`\`mermaid\n${source}\n\`\`\`\n\n`;
  }
  if (type === "columns" || type === "column") {
    return format === "html" ? `<div class="${type}">${blockChildren()}</div>` : blockChildren();
  }
  if (type === "bookmark" || type === "embed") {
    const url = safeUrl(node.attrs?.url) ?? "";
    const title = stringAttr(node, "title") ?? url;
    return format === "html"
      ? `<p class="bookmark"><a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(title)}</a></p>`
      : `[${escapeMarkdownInline(title)}](${markdownDestination(url)})\n\n`;
  }
  if (type === "table" || type === "tableRow" || type === "tableCell" || type === "tableHeader") {
    if (format === "html") {
      const tag = type === "table" ? "table" : type === "tableRow" ? "tr" : type === "tableHeader" ? "th" : "td";
      return `<${tag}>${blockChildren() || inline}</${tag}>`;
    }
    if (type === "tableRow") return markdownTableRow(node);
    if (type !== "table") return blockChildren();
    const rows = children.filter((child) => child.type === "tableRow");
    const header = rows[0]?.content ?? [];
    // Without a separator row no Markdown reader renders these lines as a table,
    // and its width has to come from the header rather than any individual row.
    const headed = header.length > 0 && header.every((cell) => cell.type === "tableHeader");
    const lines = rows.map((row) => markdownTableRow(row));
    if (headed) lines.splice(1, 0, `| ${header.map(() => "---").join(" | ")} |\n`);
    return `${lines.join("")}\n`;
  }

  const fallback = blockChildren() || inline || escapeHtml(nodeText(node));
  return format === "html"
    ? `<div data-unsupported-node="${escapeHtml(type)}">${fallback}</div>`
    : `${escapeMarkdownText(nodeText(node).trim())}\n\n`;
}

function excerptAround(text: string, offset: number) {
  const start = Math.max(0, offset - Math.floor(EXCERPT_CHARS / 2));
  return normalizeText(text.slice(start, start + EXCERPT_CHARS * 2)).slice(0, EXCERPT_CHARS);
}

export function projectDocument(root: ProseMirrorJson): DocumentProjection {
  const parts: string[] = [];
  const pageOffsets = new Map<string, number>();
  const userOffsets = new Map<string, number>();
  let textLength = 0;

  const append = (text: string) => {
    parts.push(text);
    textLength += text.length;
  };

  const visit = (node: ProseMirrorJson) => {
    if (typeof node.text === "string") append(node.text);

    if (node.type === "mention") {
      const entityType = stringAttr(node, "entityType");
      const entityId = stringAttr(node, "entityId");
      const label = stringAttr(node, "label");
      if (entityId && label && (entityType === "page" || entityType === "user")) {
        const offsets = entityType === "page" ? pageOffsets : userOffsets;
        if (!offsets.has(entityId)) offsets.set(entityId, textLength);
        append(label);
        append(" ");
      }
    }

    for (const child of node.content ?? []) visit(child);
    if (node.type && !["text", "mention"].includes(node.type)) append(" ");
  };

  visit(root);
  const text = parts.join("");
  const plainText = normalizeText(text).slice(0, MAX_PLAIN_TEXT);
  return {
    plainText,
    pageReferences: [...pageOffsets].map(([targetId, offset]) => ({
      targetId,
      excerpt: excerptAround(text, offset),
    })),
    memberMentions: [...userOffsets].map(([targetId, offset]) => ({
      targetId,
      excerpt: excerptAround(text, offset),
    })),
  };
}

export function serializeDocument(root: ProseMirrorJson): SerializedDocument {
  return {
    ...projectDocument(root),
    markdown: serializeNode(root, "markdown").trimEnd() + "\n",
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:16px/1.55 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 24px;color:#171717}img{max-width:100%}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px}.callout{display:flex;gap:10px;padding:12px;border-left:4px solid #777;background:#f7f7f7}.columns{display:flex;gap:16px}.column{flex:1}@media(max-width:700px){.columns{display:block}}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px}</style></head><body>${serializeNode(root, "html")}</body></html>`,
  };
}
