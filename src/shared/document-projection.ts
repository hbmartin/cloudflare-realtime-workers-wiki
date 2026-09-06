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
  let value = format === "html" ? escapeHtml(node.text ?? "") : (node.text ?? "");
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
          format === "html" ? `<a href="${escapeHtml(href)}" rel="noreferrer">${value}</a>` : `[${value}](${href})`;
    }
  }
  return value;
}

function nodeText(node: ProseMirrorJson): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "mention") return stringAttr(node, "label") ?? "";
  return (node.content ?? []).map(nodeText).join("");
}

function serializeInline(node: ProseMirrorJson, format: "markdown" | "html"): string {
  if (typeof node.text === "string") return markedText(node, format);
  if (node.type === "mention") {
    const label = stringAttr(node, "label") ?? "Mention";
    const id = stringAttr(node, "entityId");
    if (format === "html") return `<span data-mention-id="${escapeHtml(id ?? "")}">${escapeHtml(label)}</span>`;
    return `@${label}`;
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

function serializeNode(node: ProseMirrorJson, format: "markdown" | "html", depth = 0): string {
  const children = node.content ?? [];
  const inline = children.map((child) => serializeInline(child, format)).join("");
  const blockChildren = () => children.map((child) => serializeNode(child, format, depth + 1)).join("");
  const type = node.type ?? "unknown";

  if (type === "doc") return blockChildren();
  if (type === "text" || type === "mention" || type === "inlineMath") return serializeInline(node, format);
  if (type === "paragraph") return format === "html" ? `<p>${inline}</p>` : `${inline}\n\n`;
  if (type === "heading" || /^heading[1-6]$/.test(type)) {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? type.slice(7) ?? 1)));
    return format === "html" ? `<h${level}>${inline}</h${level}>` : `${"#".repeat(level)} ${inline}\n\n`;
  }
  if (type === "blockquote" || type === "quote") {
    const text = nodeText(node).trim();
    return format === "html"
      ? `<blockquote>${blockChildren() || escapeHtml(text)}</blockquote>`
      : `${text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
  }
  if (
    type === "bulletList" ||
    type === "bulletListItem" ||
    type === "numberedList" ||
    type === "numberedListItem" ||
    type === "checkListItem"
  ) {
    if (type.endsWith("List")) {
      const tag = type === "bulletList" ? "ul" : "ol";
      return format === "html" ? `<${tag}>${blockChildren()}</${tag}>` : blockChildren();
    }
    const marker =
      type === "numberedListItem" ? "1." : type === "checkListItem" ? `- [${node.attrs?.checked ? "x" : " "}]` : "-";
    return format === "html"
      ? `<li>${inline || blockChildren()}</li>`
      : `${"  ".repeat(depth)}${marker} ${nodeText(node).trim()}\n`;
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
    if (format === "markdown") return type === "image" ? `![${caption}](${url})\n\n` : `[${caption}](${url})\n\n`;
    if (type === "image")
      return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
    return `<p><a href="${escapeHtml(url)}">${escapeHtml(caption)}</a></p>`;
  }
  if (type === "callout") {
    const tone = stringAttr(node, "tone") ?? "info";
    const icon = stringAttr(node, "icon") ?? "ℹ";
    return format === "html"
      ? `<aside class="callout callout-${escapeHtml(tone)}"><span>${escapeHtml(icon)}</span>${blockChildren() || `<p>${inline}</p>`}</aside>`
      : `> ${icon} ${nodeText(node).trim().replaceAll("\n", "\n> ")}\n\n`;
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
      : `[${title}](${url})\n\n`;
  }
  if (type === "table" || type === "tableRow" || type === "tableCell" || type === "tableHeader") {
    if (format === "html") {
      const tag = type === "table" ? "table" : type === "tableRow" ? "tr" : type === "tableHeader" ? "th" : "td";
      return `<${tag}>${blockChildren() || inline}</${tag}>`;
    }
    if (type === "tableRow") return `| ${children.map((child) => nodeText(child).trim()).join(" | ")} |\n`;
    return blockChildren();
  }

  const fallback = blockChildren() || inline || escapeHtml(nodeText(node));
  return format === "html"
    ? `<div data-unsupported-node="${escapeHtml(type)}">${fallback}</div>`
    : `${nodeText(node).trim()}\n\n`;
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
