import * as Y from "yjs";
import type { ColumnType, ProseMirrorJson } from "./types";

export type ImportedTable = {
  columns: Array<{ name: string; type: ColumnType; options: string[] }>;
  rows: Array<Array<string | number | boolean | null>>;
};

export type ImportIssue = { code: string; detail: string };

const BLOCK_ATTRS = { backgroundColor: "default", textColor: "default", textAlignment: "left" };
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== "#") return named[body.toLowerCase()] ?? entity;
    const hexadecimal = body[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

function safeLink(value: string) {
  const trimmed = decodeHtml(value.trim());
  if (!trimmed) return null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  if (/^(?:\/|\.?\.\/|#)/.test(trimmed)) return trimmed;
  if (/^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(trimmed)) return trimmed;
  if (!/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(trimmed).protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

function inline(text: string, marks: ProseMirrorJson["marks"] = []): ProseMirrorJson[] {
  return text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : [];
}

function paragraph(content: ProseMirrorJson[]): ProseMirrorJson {
  return { type: "paragraph", attrs: { ...BLOCK_ATTRS }, ...(content.length ? { content } : {}) };
}

function blockDocument(blocks: ProseMirrorJson[]) {
  const safeBlocks = blocks.length ? blocks : [paragraph([])];
  return {
    type: "doc",
    content: [
      {
        type: "blockGroup",
        content: safeBlocks.map((block, index) => ({
          type: "blockContainer",
          attrs: { id: `import-${index + 1}` },
          content: [block],
        })),
      },
    ],
  } satisfies ProseMirrorJson;
}

function markdownInline(value: string, issues: ImportIssue[]) {
  const output: ProseMirrorJson[] = [];
  const pattern = /(!?)\[([^\]]*)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    output.push(...inline(value.slice(offset, match.index)));
    const [whole, image, label, rawUrl, boldA, boldB, code, italicA, italicB] = match;
    if (rawUrl !== undefined) {
      const url = safeLink(rawUrl);
      if (!url) {
        issues.push({ code: "unsafe_url", detail: rawUrl.slice(0, 120) });
        output.push(...inline(label ?? ""));
      } else if (image) {
        output.push(...inline(whole));
      } else {
        output.push(...inline(label ?? "", [{ type: "link", attrs: { href: url } }]));
      }
    } else if (boldA !== undefined || boldB !== undefined) {
      output.push(...inline(boldA ?? boldB ?? "", [{ type: "bold" }]));
    } else if (code !== undefined) {
      output.push(...inline(code, [{ type: "code" }]));
    } else {
      output.push(...inline(italicA ?? italicB ?? "", [{ type: "italic" }]));
    }
    offset = (match.index ?? 0) + whole.length;
  }
  output.push(...inline(value.slice(offset)));
  return output;
}

export function markdownToDocument(source: string) {
  const issues: ImportIssue[] = [];
  const blocks: ProseMirrorJson[] = [];
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let paragraphLines: string[] = [];
  let codeLines: string[] | null = null;
  let codeLanguage = "";
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push(paragraph(markdownInline(paragraphLines.join(" ").trim(), issues)));
    paragraphLines = [];
  };
  for (const line of lines) {
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (codeLines) {
      if (fence) {
        blocks.push({
          type: codeLanguage === "mermaid" ? "mermaid" : "codeBlock",
          attrs: codeLanguage === "mermaid" ? { source: codeLines.join("\n") } : { language: codeLanguage },
          ...(codeLanguage === "mermaid" ? {} : { content: inline(codeLines.join("\n")) }),
        });
        codeLines = null;
        codeLanguage = "";
      } else codeLines.push(line);
      continue;
    }
    if (fence) {
      flushParagraph();
      codeLines = [];
      codeLanguage = fence[1]?.toLowerCase() ?? "";
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const image = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    const checklist = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (heading || image || checklist || bullet || numbered || quote || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      if (heading) {
        blocks.push({
          type: "heading",
          attrs: { ...BLOCK_ATTRS, level: heading[1]!.length, isToggleable: false },
          content: markdownInline(heading[2]!, issues),
        });
      } else if (image) {
        const url = safeLink(image[2]!);
        if (url)
          blocks.push({
            type: "image",
            attrs: {
              backgroundColor: "default",
              textAlignment: "left",
              url,
              caption: image[1] ?? "",
              name: image[1] || "image",
              showPreview: true,
              previewWidth: 512,
            },
          });
        else {
          issues.push({ code: "unsafe_url", detail: image[2]!.slice(0, 120) });
          blocks.push(paragraph(inline(image[1] ?? "image")));
        }
      } else if (checklist) {
        blocks.push({
          type: "checkListItem",
          attrs: { ...BLOCK_ATTRS, checked: checklist[1]!.toLowerCase() === "x" },
          content: markdownInline(checklist[2]!, issues),
        });
      } else if (bullet) {
        blocks.push({ type: "bulletListItem", attrs: { ...BLOCK_ATTRS }, content: markdownInline(bullet[1]!, issues) });
      } else if (numbered) {
        blocks.push({
          type: "numberedListItem",
          attrs: { ...BLOCK_ATTRS, start: 1 },
          content: markdownInline(numbered[1]!, issues),
        });
      } else if (quote) {
        blocks.push({ type: "quote", attrs: { ...BLOCK_ATTRS }, content: markdownInline(quote[1]!, issues) });
      } else blocks.push({ type: "divider" });
      continue;
    }
    paragraphLines.push(line.trim());
  }
  flushParagraph();
  if (codeLines) {
    issues.push({ code: "unterminated_code_fence", detail: "The final code block had no closing fence." });
    blocks.push({ type: "codeBlock", attrs: { language: codeLanguage }, content: inline(codeLines.join("\n")) });
  }
  return { document: blockDocument(blocks), issues };
}

function htmlAttributes(tag: string) {
  const output: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    output[match[1]!.toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return output;
}

export function htmlToDocument(source: string) {
  const issues: ImportIssue[] = [];
  const blocks: ProseMirrorJson[] = [];
  const cleaned = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const title = decodeHtml(
    /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(cleaned)?.[1]?.replace(/<[^>]*>/g, "") ?? "",
  ).trim();
  const body =
    /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(cleaned)?.[1] ??
    cleaned.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "");
  const tokens = body.match(/<[^>]*>|[^<]+/g) ?? [];
  let content: ProseMirrorJson[] = [];
  let kind: "paragraph" | "heading" | "quote" | "bulletListItem" | "numberedListItem" | "checkListItem" | "codeBlock" =
    "paragraph";
  let level = 1;
  let checked = false;
  let link: string | null = null;
  let list: "bullet" | "numbered" | null = null;
  const marks: Array<"bold" | "italic" | "strike" | "code"> = [];
  const flush = () => {
    const compact = content.filter((node) => node.text !== "" && node.text !== undefined);
    if (!compact.length) {
      content = [];
      return;
    }
    const attrs =
      kind === "heading"
        ? { ...BLOCK_ATTRS, level, isToggleable: false }
        : kind === "checkListItem"
          ? { ...BLOCK_ATTRS, checked }
          : kind === "codeBlock"
            ? { language: "" }
            : { ...BLOCK_ATTRS };
    blocks.push({ type: kind, attrs, content: compact });
    content = [];
    kind = "paragraph";
    checked = false;
  };
  for (const token of tokens) {
    if (token[0] !== "<") {
      const text = kind === "codeBlock" ? decodeHtml(token) : decodeHtml(token).replace(/\s+/g, " ");
      if (!text || (!text.trim() && !content.length)) continue;
      const activeMarks: NonNullable<ProseMirrorJson["marks"]> = marks.map((type) => ({ type }));
      if (link) activeMarks.push({ type: "link", attrs: { href: link } });
      content.push(...inline(text, activeMarks));
      continue;
    }
    const closing = /^<\s*\//.test(token);
    const name = /^<\s*\/?\s*([\w-]+)/.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    const attrs = htmlAttributes(token);
    if (!closing && /^h[1-6]$/.test(name)) {
      flush();
      kind = "heading";
      level = Number(name[1]);
    } else if (closing && /^h[1-6]$/.test(name)) flush();
    else if (!closing && ["p", "div", "section", "article"].includes(name)) {
      if (content.some((node) => node.text?.trim())) flush();
    } else if (closing && ["p", "div", "section", "article"].includes(name)) flush();
    else if (!closing && name === "blockquote") {
      flush();
      kind = "quote";
    } else if (closing && name === "blockquote") flush();
    else if (!closing && name === "ul") list = "bullet";
    else if (!closing && name === "ol") list = "numbered";
    else if (closing && (name === "ul" || name === "ol")) list = null;
    else if (!closing && name === "li") {
      flush();
      kind = list === "numbered" ? "numberedListItem" : "bulletListItem";
    } else if (closing && name === "li") flush();
    else if (!closing && name === "pre") {
      flush();
      kind = "codeBlock";
    } else if (closing && name === "pre") flush();
    else if (!closing && name === "input" && attrs.type?.toLowerCase() === "checkbox") {
      kind = "checkListItem";
      checked = "checked" in attrs || /\schecked(?:\s|\/?>)/i.test(token);
    } else if (!closing && name === "br") content.push({ type: "hardBreak" });
    else if (!closing && name === "hr") {
      flush();
      blocks.push({ type: "divider" });
    } else if (!closing && name === "img") {
      flush();
      const url = safeLink(attrs.src ?? "");
      if (url)
        blocks.push({
          type: "image",
          attrs: {
            backgroundColor: "default",
            textAlignment: "left",
            url,
            caption: attrs.alt ?? "",
            name: attrs.alt || "image",
            showPreview: true,
            previewWidth: Math.min(Math.max(Number(attrs.width) || 512, 64), 1600),
          },
        });
      else if (attrs.src) issues.push({ code: "unsafe_url", detail: attrs.src.slice(0, 120) });
    } else if (!closing && name === "a") {
      const url = safeLink(attrs.href ?? "");
      if (!url && attrs.href) issues.push({ code: "unsafe_url", detail: attrs.href.slice(0, 120) });
      link = url;
    } else if (closing && name === "a") link = null;
    else {
      const mark =
        name === "strong" || name === "b"
          ? "bold"
          : name === "em" || name === "i"
            ? "italic"
            : name === "s" || name === "del"
              ? "strike"
              : name === "code" && kind !== "codeBlock"
                ? "code"
                : null;
      if (mark) {
        if (closing) {
          const index = marks.lastIndexOf(mark);
          if (index !== -1) marks.splice(index, 1);
        } else marks.push(mark);
      }
    }
  }
  flush();
  return { document: blockDocument(blocks), title, issues };
}

function prosemirrorNodeToYjs(node: ProseMirrorJson): Y.XmlElement | Y.XmlText {
  if (node.type === "text") {
    const text = new Y.XmlText();
    text.insert(
      0,
      node.text ?? "",
      Object.fromEntries((node.marks ?? []).flatMap((mark) => (mark.type ? [[mark.type, mark.attrs ?? {}]] : []))),
    );
    return text;
  }
  const element = new Y.XmlElement(node.type ?? "paragraph");
  for (const [name, value] of Object.entries(node.attrs ?? {})) element.setAttribute(name, value as string);
  if (node.content?.length) element.insert(0, node.content.map(prosemirrorNodeToYjs));
  return element;
}

export function documentToYjsUpdate(document: ProseMirrorJson) {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("document-store");
  fragment.insert(0, (document.content ?? []).map(prosemirrorNodeToYjs));
  return Y.encodeStateAsUpdate(ydoc);
}

const SELECT_MAX_DISTINCT = 40;
const BOOLEAN_VALUES = /^(yes|no|true|false)$/i;
const TRUE_VALUES = /^(yes|true)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isSafeNumber(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && String(number) === value;
}

export function parseCsv(input: string) {
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replaceAll("\r\n", "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    started = true;
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else if (character !== "\r") field += character;
  }
  if (started || field) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function csvToTable(source: string, issues: ImportIssue[] = []): ImportedTable {
  const rows = parseCsv(source);
  const header = rows.shift() ?? [];
  const columns = header.slice(0, 50).map((rawName, index) => {
    const values = rows.map((row) => (row[index] ?? "").trim());
    const present = values.filter(Boolean);
    let type: ColumnType = "text";
    if (present.length && present.every((value) => BOOLEAN_VALUES.test(value))) type = "checkbox";
    else if (present.length && present.every((value) => isValidDate(value.slice(0, 10)))) type = "date";
    else if (present.length && present.every(isSafeNumber)) type = "number";
    else {
      const distinct = new Set(present);
      if (
        distinct.size &&
        distinct.size <= SELECT_MAX_DISTINCT &&
        distinct.size * 2 <= present.length &&
        ![...distinct].some((value) => value.includes(","))
      )
        type = "select";
      else if (present.some((value) => value.includes(",")))
        issues.push({
          code: "column_type_degraded",
          detail: `${rawName || `Column ${index + 1}`}: multi-select kept as text`,
        });
    }
    return {
      name: rawName.trim().slice(0, 200) || `Column ${index + 1}`,
      type,
      options: type === "select" ? [...new Set(present)].slice(0, SELECT_MAX_DISTINCT) : [],
    };
  });
  return {
    columns,
    rows: rows
      .filter((row) => row.some((value) => value.trim()))
      .slice(0, 20_000)
      .map((row) =>
        columns.map((column, index) => {
          const value = (row[index] ?? "").trim();
          if (!value) return null;
          if (column.type === "checkbox") return TRUE_VALUES.test(value);
          if (column.type === "number") return Number(value);
          if (column.type === "date") return value.slice(0, 10);
          return value.slice(0, 10_000);
        }),
      ),
  };
}
