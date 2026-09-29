import * as Y from "yjs";
import { Lexer, Tokenizer, type Token } from "marked";
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
    if (body[0] !== "#") {
      const key = body.toLowerCase();
      return Object.hasOwn(named, key) ? named[key]! : entity;
    }
    const hexadecimal = body[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    // NUL and lone surrogates cannot round-trip through Yjs text, so those entities stay literal.
    const encodable =
      Number.isFinite(codePoint) &&
      codePoint > 0 &&
      codePoint <= 0x10ffff &&
      (codePoint < 0xd800 || codePoint > 0xdfff);
    return encodable ? String.fromCodePoint(codePoint) : entity;
  });
}

function safeLink(value: string) {
  const trimmed = decodeHtml(value.trim()).replaceAll("\\", "%5C");
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

const ESCAPABLE_MARKDOWN = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
const INLINE_MARKUP_CHAR = /[!*_[\]`<&]/;

function unescapeMarkdown(value: string): string;
function unescapeMarkdown(value: string, abortOnMarkup: true): string | null;
function unescapeMarkdown(value: string, abortOnMarkup = false): string | null {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && ESCAPABLE_MARKDOWN.test(value[index + 1] ?? "")) index += 1;
    else if (abortOnMarkup && INLINE_MARKUP_CHAR.test(value[index]!)) return null;
    output += value[index];
  }
  return output;
}

function markdownInline(value: string, issues: ImportIssue[], references: string[], prepared?: Token[]) {
  if (!prepared) {
    const plain = unescapeMarkdown(value, true);
    if (plain !== null) return inline(plain);
    if (value.length > 8192) return boundedMarkdownInline(value, issues, references);
  }
  const output: ProseMirrorJson[] = [];
  const append = (text: string, marks: ProseMirrorJson["marks"] = []) => {
    if (!text) return;
    const previous = output.at(-1);
    if (!marks.length && previous?.type === "text" && !previous.marks) {
      previous.text = (previous.text ?? "") + text;
      return;
    }
    output.push(...inline(text, marks));
  };
  // Keep block conversion local, but use an inline lexer for nested
  // delimiters. The resulting tokens still pass through our URL policy.
  const walk = (tokens: Token[], marks: ProseMirrorJson["marks"] = []) => {
    for (const token of tokens) {
      const children: Token[] = "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
      if (token.type === "text") append(token.text, marks);
      else if (token.type === "escape") append(token.text, marks);
      else if (token.type === "em")
        walk(children, marks.some((mark) => mark.type === "italic") ? marks : [{ type: "italic" }, ...marks]);
      else if (token.type === "strong")
        walk(children, marks.some((mark) => mark.type === "bold") ? marks : [...marks, { type: "bold" }]);
      else if (token.type === "codespan") append(token.text, [...marks, { type: "code" }]);
      else if (token.type === "link" || token.type === "image") {
        const rawUrl = token.href;
        const url = safeLink(rawUrl);
        if (!url) {
          issues.push({ code: "unsafe_url", detail: rawUrl.slice(0, 120) });
          walk(children, marks);
        } else if (token.type === "image") {
          references.push(url);
          issues.push({ code: "image_not_imported", detail: url.slice(0, 120) });
          walk(children, marks);
        } else {
          references.push(url);
          walk(children, [...marks, { type: "link", attrs: { href: url } }]);
        }
      } else if (children.length) walk(children, marks);
      else append(token.raw, marks);
    }
  };
  walk(prepared ?? Lexer.lexInline(value, { gfm: false }));
  return output;
}

type CodeRange = { start: number; openEnd: number; closeStart: number; end: number };

function codeRanges(value: string): CodeRange[] | null {
  const runs: Array<{ start: number; end: number; length: number; escaped: boolean }> = [];
  const nextClosing = new Int32Array(value.length + 1);
  let closing = value.length;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] === ")") closing = index;
    nextClosing[index] = closing;
  }
  let destinationDepth = 0;
  let destinationLimit = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (destinationDepth && index >= destinationLimit) destinationDepth = 0;
    if (destinationDepth && value[index] === "\\") {
      index += 1;
      continue;
    }
    if (
      value[index] === "(" &&
      (destinationDepth ||
        (value[index - 1] === "]" &&
          !trailingEscape(value, index - 1) &&
          nextClosing[index]! < value.length &&
          nextClosing[index]! < index + 8192))
    ) {
      destinationDepth += 1;
      if (destinationDepth === 1) destinationLimit = index + 8192;
    } else if (value[index] === ")" && destinationDepth) destinationDepth -= 1;
    if (destinationDepth) continue;
    if (value[index] !== "`") continue;
    let end = index + 1;
    while (end < value.length && value[end] === "`") end += 1;
    runs.push({ start: index, end, length: end - index, escaped: trailingEscape(value, index) });
    // Keep hostile paragraphs with millions of delimiters inside Worker memory.
    if (runs.length > 100_000) return null;
    index = end - 1;
  }
  const next: number[] = [];
  const nextOfLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    next[index] = nextOfLength.get(run.length) ?? -1;
    nextOfLength.set(run.length, index);
  }
  const ranges: CodeRange[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    if (runs[index]!.escaped) continue;
    const closeIndex = next[index]!;
    if (closeIndex < 0) continue;
    const open = runs[index]!;
    const close = runs[closeIndex]!;
    ranges.push({ start: open.start, openEnd: open.end, closeStart: close.start, end: close.end });
    index = closeIndex;
  }
  return ranges;
}

function firstCodeEndingAfter(codes: CodeRange[], position: number) {
  let left = 0;
  let right = codes.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (codes[middle]!.end <= position) left = middle + 1;
    else right = middle;
  }
  return left;
}

function enclosingBracket(brackets: number[], value: string, start: number, boundary: number) {
  for (const opening of brackets) {
    if (opening <= start || boundary - opening > 1024) continue;
    return value[opening - 1] === "!" ? opening - 1 : opening;
  }
  return Infinity;
}

function safeInlineCut(value: string, start: number, maximum: number, codes: CodeRange[]) {
  const brackets: number[] = [];
  let parenDepth = 0;
  let linkStart = -1;
  let whitespace = 0;
  let fallback = 0;
  let codeIndex = firstCodeEndingAfter(codes, start);
  for (let index = start; index < maximum; index += 1) {
    const character = value[index];
    const code = codes[codeIndex];
    if (code && index === code.start) {
      if (code.end > maximum) {
        const earliest = Math.min(
          code.start,
          enclosingBracket(brackets, value, start, maximum),
          parenDepth && linkStart >= 0 ? linkStart : Infinity,
        );
        return earliest > start ? earliest : code.start > start ? code.start : maximum;
      }
      index = code.end - 1;
      codeIndex += 1;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") brackets.push(index);
    else if (character === "]" && brackets.length) {
      const opening = brackets.pop()!;
      if (value[index + 1] === "(") linkStart = value[opening - 1] === "!" ? opening - 1 : opening;
    } else if (character === "(" && (parenDepth || value[index - 1] === "]")) parenDepth += 1;
    else if (character === ")" && parenDepth) {
      parenDepth -= 1;
      if (!parenDepth) linkStart = -1;
    }
    if (character === " " && index >= start + 1024) {
      fallback = index + 1;
      if (!brackets.length && !parenDepth) whitespace = index + 1;
    }
  }
  if (parenDepth && linkStart >= 0) {
    const earliest = Math.min(linkStart, enclosingBracket(brackets, value, start, maximum));
    if (earliest > start) return earliest;
    if (linkStart > start) return linkStart;
  }
  return whitespace || fallback || maximum;
}

function trailingEscape(value: string, boundary: number, start = 0) {
  let count = 0;
  for (let index = boundary - 1; index >= start && value[index] === "\\"; index -= 1) count += 1;
  return count % 2 === 1;
}

function safeDenseBoundary(value: string, boundary: number) {
  const brackets: number[] = [];
  const codes = codeRanges(value) ?? [];
  let codeIndex = 0;
  let parenDepth = 0;
  let linkStart = -1;
  for (let index = 0; index < boundary; index += 1) {
    const character = value[index];
    const code = codes[codeIndex];
    if (code && index === code.start) {
      if (code.end > boundary) return code.start;
      index = code.end - 1;
      codeIndex += 1;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") brackets.push(index);
    else if (character === "]" && brackets.length) {
      const opening = brackets.pop()!;
      if (value[index + 1] === "(") linkStart = value[opening - 1] === "!" ? opening - 1 : opening;
    } else if (character === "(" && (parenDepth || value[index - 1] === "]")) parenDepth += 1;
    else if (character === ")" && parenDepth) {
      parenDepth -= 1;
      if (!parenDepth) linkStart = -1;
    }
  }
  const outer = enclosingBracket(brackets, value, -1, boundary);
  return parenDepth && linkStart >= 0 ? Math.min(linkStart, outer) : Math.min(outer, boundary);
}

function longDataImage(value: string, start: number) {
  if (!value.startsWith("![", start) || trailingEscape(value, start)) return null;
  const labelEnd = linkLabelEnd(value, start, 514);
  if (labelEnd === null) return null;
  const destinationStart = labelEnd + 2;
  const prefix = /^data:image\/(?:png|gif|jpeg|webp);base64,/i.exec(
    value.slice(destinationStart, destinationStart + 40),
  )?.[0];
  if (!prefix) return null;
  let end = destinationStart + prefix.length;
  while (end < value.length && /[A-Za-z0-9+/_=%-]/.test(value[end]!)) end += 1;
  const payloadEnd = end;
  while (value[end] === " " || value[end] === "\t") end += 1;
  if (value[end] === '"' || value[end] === "'") {
    const quote = value[end++];
    while (end < value.length && value[end] !== quote) end += value[end] === "\\" ? 2 : 1;
    if (end >= value.length || value[end] !== quote) return null;
    end += 1;
    while (value[end] === " " || value[end] === "\t") end += 1;
  }
  if (value[end] !== ")") return null;
  const href = safeLink(value.slice(destinationStart, payloadEnd));
  if (!href) return null;
  return { label: unescapeMarkdown(value.slice(start + 2, labelEnd)), href, end: end + 1 };
}

function linkLabelEnd(value: string, start: number, maximum: number) {
  let depth = 1;
  const limit = Math.min(value.length, start + maximum);
  const codes = codeRanges(value.slice(start, limit)) ?? [];
  let codeIndex = 0;
  let index = start + (value[start] === "!" ? 2 : 1);
  for (; index < limit && depth; index += 1) {
    const character = value[index];
    const code = codes[codeIndex];
    if (code && index === start + code.start) {
      index = start + code.end - 1;
      codeIndex += 1;
      continue;
    }
    if (character === "\\") index += 1;
    else if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
  }
  return !depth && value[index] === "(" ? index - 1 : null;
}

function simpleLongLink(value: string, start: number, labelEnd: number) {
  let depth = 1;
  let end = labelEnd + 2;
  for (; end < value.length && depth; end += 1) {
    if (value[end] === "\\") end += 1;
    else if (value[end] === "(") depth += 1;
    else if (value[end] === ")") depth -= 1;
  }
  if (depth) return null;
  let rawDestination = value.slice(labelEnd + 2, end - 1).trim();
  if (rawDestination.startsWith("<")) {
    const closing = rawDestination.indexOf(">");
    if (
      closing < 0 ||
      (rawDestination.slice(closing + 1).trim() && !/^\s+["'][\s\S]*["']$/.test(rawDestination.slice(closing + 1)))
    )
      return null;
    rawDestination = rawDestination.slice(1, closing);
  } else {
    const space = rawDestination.search(/\s/);
    if (space >= 0) {
      const title = rawDestination.slice(space).trim();
      if (title.length < 2 || !['"', "'"].includes(title[0]!) || title.at(-1) !== title[0]) return null;
      for (let index = 1; index < title.length - 1; index += 1) {
        if (title[index] === "\\") {
          if (index + 1 >= title.length - 1) return null;
          index += 1;
        } else if (title[index] === title[0]) return null;
      }
      rawDestination = rawDestination.slice(0, space);
    }
  }
  return {
    label: unescapeMarkdown(value.slice(start + (value[start] === "!" ? 2 : 1), labelEnd)),
    href: unescapeMarkdown(rawDestination),
    end,
  };
}

function markdownLexer() {
  const tokenizer = new Tokenizer({ gfm: false });
  return { tokenizer, lexer: new Lexer({ gfm: false, tokenizer }) };
}

function boundedMarkdownInline(value: string, issues: ImportIssue[], references: string[]) {
  issues.push({ code: "inline_markup_simplified", detail: "Long inline content was parsed in bounded sections." });
  const output: ProseMirrorJson[] = [];
  const codes = codeRanges(value);
  if (!codes) {
    let start = 0;
    for (let position = value.indexOf("!["); position >= 0; position = value.indexOf("![", position + 2)) {
      const image = longDataImage(value, position);
      if (!image) continue;
      output.push(...inline(unescapeMarkdown(value.slice(start, position))), ...inline(image.label));
      references.push(image.href);
      issues.push({ code: "image_not_imported", detail: image.href.slice(0, 120) });
      start = image.end;
      position = image.end - 2;
    }
    output.push(...inline(unescapeMarkdown(value.slice(start))));
    return output;
  }
  const images: Array<{ kind: "image"; start: number; end: number; label: string; href: string }> = [];
  for (let position = value.indexOf("!["); position >= 0; position = value.indexOf("![", position + 2)) {
    const image = longDataImage(value, position);
    if (!image || image.end - position <= 1024) continue;
    images.push({ kind: "image", start: position, ...image });
    position = image.end - 2;
  }
  let imageIndex = 0;
  const effectiveCodes = codes.filter((range) => {
    while (images[imageIndex] && images[imageIndex]!.end <= range.start) imageIndex += 1;
    return !images[imageIndex] || range.start < images[imageIndex]!.start;
  });
  const specials: Array<
    | { kind: "image"; start: number; end: number; label: string; href: string }
    | { kind: "code"; start: number; end: number; openEnd: number; closeStart: number }
  > = effectiveCodes.filter((range) => range.end - range.start > 8192).map((range) => ({ kind: "code", ...range }));
  let codeIndex = 0;
  for (const image of images) {
    while (effectiveCodes[codeIndex] && effectiveCodes[codeIndex]!.end <= image.start) codeIndex += 1;
    if (effectiveCodes[codeIndex] && effectiveCodes[codeIndex]!.start <= image.start) continue;
    specials.push(image);
  }
  specials.sort((left, right) => left.start - right.start);
  const append = (section: ProseMirrorJson[]) => {
    for (const node of section) {
      const previous = output.at(-1);
      if (node.type === "text" && !node.marks && previous?.type === "text" && !previous.marks)
        previous.text = (previous.text ?? "") + (node.text ?? "");
      else output.push(node);
    }
  };
  const appendDense = (section: string) => {
    const { tokenizer } = markdownLexer();
    const sectionCodes = codeRanges(section) ?? [];
    let sectionCodeIndex = 0;
    let cursor = 0;
    let candidates = 0;
    for (let index = 0; index < section.length; index += 1) {
      while (sectionCodes[sectionCodeIndex] && sectionCodes[sectionCodeIndex]!.end <= index) sectionCodeIndex += 1;
      const character = section[index];
      const code = sectionCodes[sectionCodeIndex];
      if (code && code.start === index) {
        append(inline(unescapeMarkdown(section.slice(cursor, index))));
        let content = section.slice(code.openEnd, code.closeStart).replaceAll("\n", " ");
        if (content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
        append(inline(content, [{ type: "code" }]));
        cursor = code.end;
        index = cursor - 1;
        sectionCodeIndex += 1;
        continue;
      }
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character !== "[" && !(character === "!" && section[index + 1] === "[")) continue;
      const start = index;
      if (++candidates > 128) break;
      const labelEnd = linkLabelEnd(section, start, 8192);
      if (labelEnd === null) continue;
      const label = section.slice(start, labelEnd);
      if (label.length > 512 && (label.match(/[<\\*_`]/g)?.length ?? 0) > 32) {
        const simple = simpleLongLink(section, start, labelEnd);
        if (!simple) continue;
        const href = safeLink(simple.href);
        append(inline(unescapeMarkdown(section.slice(cursor, start))));
        if (!href) {
          issues.push({ code: "unsafe_url", detail: simple.href.slice(0, 120) });
          append(inline(simple.label));
        } else if (section[start] === "!") {
          references.push(href);
          issues.push({ code: "image_not_imported", detail: href.slice(0, 120) });
          append(inline(simple.label));
        } else {
          references.push(href);
          append(inline(simple.label, [{ type: "link", attrs: { href } }]));
        }
        cursor = simple.end;
        index = cursor - 1;
        continue;
      }
      const token = tokenizer.link(section.slice(start));
      if (!token || (token.type !== "link" && token.type !== "image")) continue;
      append(inline(unescapeMarkdown(section.slice(cursor, start))));
      append(markdownInline("", issues, references, [token]));
      cursor = start + token.raw.length;
      index = cursor - 1;
    }
    append(inline(unescapeMarkdown(section.slice(cursor))));
  };
  // Bound every Marked call. A malformed tag or escape can make its inline
  // scanner revisit the remainder of its input for each delimiter.
  let specialIndex = 0;
  for (let start = 0; start < value.length;) {
    while (specials[specialIndex] && specials[specialIndex]!.end <= start) specialIndex += 1;
    const special = specials[specialIndex];
    if (special?.start === start) {
      if (special.kind === "image") {
        references.push(special.href);
        issues.push({ code: "image_not_imported", detail: special.href.slice(0, 120) });
        append(inline(special.label));
      } else {
        let content = value.slice(special.openEnd, special.closeStart).replaceAll("\n", " ");
        if (content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
        append(inline(content, [{ type: "code" }]));
      }
      start = special.end;
      specialIndex += 1;
      continue;
    }
    let cut = Math.min(start + 8192, value.length, special?.start ?? value.length);
    if (cut < value.length) {
      cut = safeInlineCut(value, start, cut, effectiveCodes);
      if (trailingEscape(value, cut, start) && value[cut] !== undefined) cut -= 1;
    }
    if (cut <= start) cut = Math.min(start + 8192, special?.start ?? value.length);
    const section = value.slice(start, cut);
    if ((section.match(/[<\\]/g)?.length ?? 0) > 128) {
      let count = 0;
      let boundary = 0;
      while (boundary < section.length && count < 128) {
        if (section[boundary] === "<" || section[boundary] === "\\") count += 1;
        boundary += 1;
      }
      boundary = safeDenseBoundary(section, boundary);
      if (trailingEscape(section, boundary) && boundary < section.length) boundary += 1;
      const prefix = section.slice(0, boundary);
      const { tokenizer: prefixTokenizer, lexer: prefixLexer } = markdownLexer();
      if ((prefix.match(/[*_`]/g)?.length ?? 0) > 512) prefixTokenizer.emStrong = () => undefined;
      append(markdownInline(prefix, issues, references, prefixLexer.inlineTokens(prefix)));
      appendDense(section.slice(boundary));
    } else {
      const { tokenizer, lexer } = markdownLexer();
      if ((section.match(/[*_`]/g)?.length ?? 0) > 512) tokenizer.emStrong = () => undefined;
      append(markdownInline(section, issues, references, lexer.inlineTokens(section)));
    }
    start = cut;
  }
  return output;
}

function markdownImage(value: string) {
  const trimmed = value.trim();
  // Bound the label before Marked tokenizes it: Marked lexes image labels
  // recursively, and a hostile long label can otherwise dominate the import.
  if (!trimmed.startsWith("![") || trimmed.length > 64_000) return null;
  const labelEnd = linkLabelEnd(trimmed, 0, 8192);
  if (labelEnd === null) return null;
  const { tokenizer } = markdownLexer();
  const image = tokenizer.link(trimmed);
  if (image?.type !== "image" || image.raw !== trimmed) return null;
  return { label: unescapeMarkdown(trimmed.slice(2, labelEnd)), href: image.href };
}

export function markdownToDocument(source: string) {
  const issues: ImportIssue[] = [];
  const references: string[] = [];
  const blocks: ProseMirrorJson[] = [];
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let paragraphLines: string[] = [];
  let codeLines: string[] | null = null;
  let codeLanguage = "";
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push(paragraph(markdownInline(paragraphLines.join(" ").trim(), issues, references)));
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
    const image = markdownImage(line);
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
          content: markdownInline(heading[2]!, issues, references),
        });
      } else if (image) {
        const url = safeLink(image.href);
        if (url) {
          references.push(url);
          blocks.push({
            type: "image",
            attrs: {
              backgroundColor: "default",
              textAlignment: "left",
              url,
              caption: image.label,
              name: image.label || "image",
              showPreview: true,
              previewWidth: 512,
            },
          });
        } else {
          issues.push({ code: "unsafe_url", detail: image.href.slice(0, 120) });
          blocks.push(paragraph(inline(image.label || "image")));
        }
      } else if (checklist) {
        blocks.push({
          type: "checkListItem",
          attrs: { ...BLOCK_ATTRS, checked: checklist[1]!.toLowerCase() === "x" },
          content: markdownInline(checklist[2]!, issues, references),
        });
      } else if (bullet) {
        blocks.push({
          type: "bulletListItem",
          attrs: { ...BLOCK_ATTRS },
          content: markdownInline(bullet[1]!, issues, references),
        });
      } else if (numbered) {
        blocks.push({
          type: "numberedListItem",
          attrs: { ...BLOCK_ATTRS, start: 1 },
          content: markdownInline(numbered[1]!, issues, references),
        });
      } else if (quote) {
        blocks.push({
          type: "quote",
          attrs: { ...BLOCK_ATTRS },
          content: markdownInline(quote[1]!, issues, references),
        });
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
  return { document: blockDocument(blocks), issues, references };
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
  const references: string[] = [];
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
  const resetBlock = () => {
    content = [];
    kind = "paragraph";
    level = 1;
    checked = false;
    link = null;
    marks.length = 0;
  };
  const flush = () => {
    // Only empty text is dropped: a hardBreak carries no `text` at all, and testing
    // for undefined here deleted every <br> along with any block holding just one.
    const compact = content.filter((node) => node.text !== "");
    if (!compact.length) {
      resetBlock();
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
    resetBlock();
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
      if (url) {
        references.push(url);
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
      } else if (attrs.src) issues.push({ code: "unsafe_url", detail: attrs.src.slice(0, 120) });
    } else if (!closing && name === "a") {
      const url = safeLink(attrs.href ?? "");
      if (!url && attrs.href) issues.push({ code: "unsafe_url", detail: attrs.href.slice(0, 120) });
      if (url) references.push(url);
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
  return { document: blockDocument(blocks), title, issues, references };
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
