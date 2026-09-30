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
const INLINE_SECTION_LIMIT = 8192;
const INLINE_SCAN_LIMIT = 128;
const INLINE_DELIMITER_LIMIT = 512;

function hasDenseInlineMarkup(value: string) {
  let scans = 0;
  let delimiters = 0;
  for (const character of value) {
    if ((character === "<" || character === "\\") && ++scans > INLINE_SCAN_LIMIT) return true;
    if ((character === "*" || character === "_" || character === "`") && ++delimiters > INLINE_DELIMITER_LIMIT)
      return true;
  }
  return false;
}

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

function markdownInline(
  value: string,
  issues: ImportIssue[],
  references: string[],
  prepared?: Token[],
  imageMarkers?: Map<string, DataImage>,
  recoverDataImages = false,
) {
  if (!prepared) {
    const plain = unescapeMarkdown(value, true);
    if (plain !== null) return inline(plain);
    if (value.length > INLINE_SECTION_LIMIT || hasDenseInlineMarkup(value))
      return boundedMarkdownInline(value, issues, references);
    if (value.includes("data:image/"))
      return markdownInline(value, issues, references, Lexer.lexInline(value, { gfm: false }), undefined, true);
  }
  const output: ProseMirrorJson[] = [];
  const appendPlain = (text: string, marks: ProseMirrorJson["marks"] = []) => {
    if (!text) return;
    const previous = output.at(-1);
    if (!marks.length && previous?.type === "text" && !previous.marks) {
      previous.text = (previous.text ?? "") + text;
      return;
    }
    output.push(...inline(text, marks));
  };
  const append = (text: string, marks: ProseMirrorJson["marks"] = []) => {
    if (recoverDataImages && !marks.some((mark) => mark.type === "code" || mark.type === "link")) {
      let start = 0;
      for (let position = text.indexOf("!["); position >= 0; position = text.indexOf("![", position + 2)) {
        const image = longDataImage(text, position);
        if (!image) continue;
        appendPlain(text.slice(start, position), marks);
        for (const node of imageLabelContent(image, marks ?? []))
          if (node.type === "text") appendPlain(node.text ?? "", node.marks ?? []);
        references.push(image.href);
        issues.push({ code: "image_not_imported", detail: image.href.slice(0, 120) });
        start = image.end;
        position = image.end - 2;
      }
      appendPlain(text.slice(start), marks);
      return;
    }
    if (!imageMarkers?.size) return appendPlain(text, marks);
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const image = imageMarkers.get(text[index]!);
      if (!image) continue;
      appendPlain(text.slice(start, index), marks);
      for (const node of imageLabelContent(image, marks ?? []))
        if (node.type === "text") appendPlain(node.text ?? "", node.marks ?? []);
      references.push(image.href);
      issues.push({ code: "image_not_imported", detail: image.href.slice(0, 120) });
      start = index + 1;
    }
    appendPlain(text.slice(start), marks);
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
        const mayHaveEscapedBracket =
          !token.raw.startsWith("<") && (token.raw.includes("\\[") || token.raw.includes("\\]"));
        const wantsRawLabel = token.type === "image" || mayHaveEscapedBracket;
        const candidateEnd = wantsRawLabel && !token.raw.startsWith("<") ? linkLabelEnd(token.raw, 0, 8192) : null;
        const labelEnd =
          candidateEnd !== null &&
          unescapeMarkdown(token.raw.slice(token.type === "image" ? 2 : 1, candidateEnd)) === token.text
            ? candidateEnd
            : null;
        const rawLabel = labelEnd === null ? token.text : token.raw.slice(token.type === "image" ? 2 : 1, labelEnd);
        const escapedBracket =
          mayHaveEscapedBracket && (labelEnd === null || rawLabel.includes("\\[") || rawLabel.includes("\\]"));
        const emitLabel = (labelMarks: NonNullable<ProseMirrorJson["marks"]>) => {
          if (escapedBracket && labelEnd !== null) {
            const { tokenizer, lexer } = markdownLexer();
            if ((rawLabel.match(/[*_]/g)?.length ?? 0) > 512) tokenizer.emStrong = () => undefined;
            const first = output.length;
            walk(lexer.inlineTokens(rawLabel), labelMarks);
            const compacted: ProseMirrorJson[] = [];
            for (const node of output.splice(first)) {
              const previous = compacted.at(-1);
              if (
                previous?.type === "text" &&
                node.type === "text" &&
                JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
              )
                previous.text = (previous.text ?? "") + (node.text ?? "");
              else compacted.push(node);
            }
            output.push(...compacted);
          } else if (escapedBracket) appendPlain(unescapeMarkdown(token.text), labelMarks);
          else if (token.type === "image" && !rawLabel.includes("["))
            output.push(...imageLabelContent({ label: token.text, rawLabel }, labelMarks));
          else walk(children, labelMarks);
        };
        if (!url) {
          emitLabel(marks ?? []);
          issues.push({ code: "unsafe_url", detail: rawUrl.slice(0, 120) });
        } else if (token.type === "image") {
          emitLabel(marks ?? []);
          references.push(url);
          issues.push({ code: "image_not_imported", detail: url.slice(0, 120) });
        } else {
          emitLabel([...marks, { type: "link", attrs: { href: url } }]);
          references.push(url);
        }
      } else if (children.length) walk(children, marks);
      else append(token.raw, marks);
    }
  };
  walk(prepared ?? Lexer.lexInline(value, { gfm: false }));
  return output;
}

type CodeRange = { start: number; openEnd: number; closeStart: number; end: number };
type DataImage = { kind: "image"; start: number; end: number; label: string; rawLabel: string; href: string };
const DATA_IMAGE_LABEL_LIMIT = 514;
function imageLabelContent(
  image: Pick<DataImage, "label" | "rawLabel">,
  marks: NonNullable<ProseMirrorJson["marks"]> = [],
) {
  const raw = image.rawLabel;
  let delimiters = 0;
  for (const character of raw) if ("<\\[]`*_!".includes(character)) delimiters += 1;
  if (raw.length > 512 || delimiters > 32 || raw.includes("[") || !/[*_`\\]/.test(raw))
    return inline(unescapeMarkdown(raw), marks);
  const output: ProseMirrorJson[] = [];
  const walk = (tokens: Token[], active: NonNullable<ProseMirrorJson["marks"]>) => {
    for (const token of tokens) {
      if (token.type === "text" || token.type === "escape") output.push(...inline(token.text, active));
      else if (token.type === "strong" || token.type === "em") {
        const type = token.type === "strong" ? "bold" : "italic";
        walk(token.tokens ?? [], active.some((mark) => mark.type === type) ? active : [...active, { type }]);
      } else if (token.type === "codespan") output.push(...inline(token.text, [...active, { type: "code" }]));
      else output.push(...inline(unescapeMarkdown(token.raw), active));
    }
  };
  walk(Lexer.lexInline(raw, { gfm: false }), marks);
  return output;
}
let markerPool: { candidates: string[]; used: Set<string> } | null = null;
function availableImageMarkers() {
  if (!markerPool) {
    const candidates = Array.from({ length: 0xffef - 0xa1 + 1 }, (_, index) =>
      String.fromCharCode(index + 0xa1),
    ).filter((character) => /[\p{P}\p{S}]/u.test(character));
    markerPool = { candidates, used: new Set(candidates) };
  }
  return markerPool;
}

function startsAngledDestination(value: string, opener: number, index: number) {
  if (opener < 0 || index <= opener || index - opener > 8192) return false;
  for (let position = index - 1; position > opener; position -= 1) if (!/\s/.test(value[position]!)) return false;
  return true;
}

function closingParenWithin(value: string) {
  const candidates = new Map<number, number>();
  const pending: Array<{ index: number; depth: number }> = [];
  const closes = new Map<number, number>();
  let firstPending = 0;
  let depth = 0;
  let quote: string | null = null;
  let angled = false;
  for (let index = 0; index < value.length; index += 1) {
    while (pending[firstPending] && pending[firstPending]!.index + 8192 <= index) {
      const old = pending[firstPending++]!;
      if (candidates.get(old.depth) === old.index) candidates.delete(old.depth);
    }
    if (firstPending > 8192) {
      pending.splice(0, firstPending);
      firstPending = 0;
    }
    if (!candidates.size) {
      quote = null;
      angled = false;
    }
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (!depth && value[index] === "<") {
      const end = autolinkEnd(value, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    if (quote) {
      if (value[index] === quote) quote = null;
      continue;
    }
    if (angled) {
      if (value[index] === ">") angled = false;
      continue;
    }
    if (
      candidates.size &&
      depth &&
      /\s/.test(value[index - 1] ?? "") &&
      (value[index] === '"' || value[index] === "'")
    ) {
      quote = value[index]!;
      continue;
    }
    if (value[index] === "<" && startsAngledDestination(value, candidates.get(depth) ?? -1, index)) {
      angled = true;
      continue;
    }
    if (value[index] === "(") {
      depth += 1;
      if (value[index - 1] === "]" && !trailingEscape(value, index - 1)) {
        candidates.set(depth, index);
        pending.push({ index, depth });
      }
    } else if (value[index] === ")" && depth) {
      const opener = candidates.get(depth);
      if (opener !== undefined) {
        closes.set(opener, index);
        if (closes.size > 100_000) return () => false;
        candidates.delete(depth);
      }
      depth -= 1;
    }
  }
  return (index: number) => closes.has(index);
}

function lazyClosingParenWithin(value: string) {
  let matcher: ReturnType<typeof closingParenWithin> | null = null;
  return (index: number) => (matcher ??= closingParenWithin(value))(index);
}

const { tokenizer: autolinkTokenizer } = markdownLexer();
function autolinkToken(value: string, start: number) {
  if (value[start] !== "<" || trailingEscape(value, start)) return null;
  const token = autolinkTokenizer.autolink(value.slice(start, start + 8192));
  return token?.type === "link" ? token : null;
}
function autolinkEnd(value: string, start: number) {
  const token = autolinkToken(value, start);
  return token ? start + token.raw.length - 1 : null;
}

function inlineSpans(
  value: string,
  recognizeImages: boolean,
  boundedClose = lazyClosingParenWithin(value),
): { codes: CodeRange[]; images: DataImage[] } | null {
  const runs: Array<{ start: number; end: number; length: number; escaped: boolean }> = [];
  const destinations: Array<{ start: number; end: number }> = [];
  const possibleOpeners = new Set<number>();
  let destinationDepth = 0;
  let destinationLimit = 0;
  let destinationStart = -1;
  let destinationQuote: string | null = null;
  let destinationAngled = false;
  for (let index = 0; index < value.length; index += 1) {
    if (destinationDepth && index >= destinationLimit) {
      destinationDepth = 0;
      destinationQuote = null;
      destinationAngled = false;
    }
    if (value[index] === "\\" && value[index + 1] !== "`") {
      index += 1;
      continue;
    }
    if (!destinationDepth && value[index] === "<") {
      const end = autolinkEnd(value, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    if (destinationQuote) {
      if (value[index] === destinationQuote) destinationQuote = null;
      continue;
    }
    if (destinationAngled) {
      if (value[index] === ">") destinationAngled = false;
      continue;
    }
    if (destinationDepth && /\s/.test(value[index - 1] ?? "") && (value[index] === '"' || value[index] === "'")) {
      destinationQuote = value[index]!;
      continue;
    }
    if (destinationDepth === 1 && value[index] === "<" && startsAngledDestination(value, destinationStart, index)) {
      destinationAngled = true;
      continue;
    }
    if (
      value[index] === "(" &&
      (destinationDepth || (value[index - 1] === "]" && !trailingEscape(value, index - 1) && boundedClose(index)))
    ) {
      destinationDepth += 1;
      if (destinationDepth === 1) {
        destinationStart = index;
        destinationLimit = index + 8192;
      }
    } else if (value[index] === ")" && destinationDepth) {
      destinationDepth -= 1;
      if (!destinationDepth) {
        destinations.push({ start: destinationStart, end: index + 1 });
        if (destinations.length > 100_000) return null;
      }
    }
    if (destinationDepth) continue;
    if (value[index] !== "`") continue;
    let end = index + 1;
    while (end < value.length && value[end] === "`") end += 1;
    const length = end - index;
    const escaped = trailingEscape(value, index);
    if (!escaped || length > 1 || possibleOpeners.has(length)) runs.push({ start: index, end, length, escaped });
    if (length > Number(escaped)) possibleOpeners.add(length - Number(escaped));
    // Keep hostile paragraphs with millions of delimiters inside Worker memory.
    if (runs.length > 100_000) return null;
    index = end - 1;
  }
  const next: number[] = [];
  const nextOfLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    const openerLength = run.length - Number(run.escaped);
    next[index] = openerLength ? (nextOfLength.get(openerLength) ?? -1) : -1;
    nextOfLength.set(run.length, index);
  }
  const codes: CodeRange[] = [];
  const images: DataImage[] = [];
  if (!recognizeImages) {
    for (let index = 0; index < runs.length; index += 1) {
      const open = runs[index]!;
      const closeIndex = next[index]!;
      if (closeIndex < 0) continue;
      const close = runs[closeIndex]!;
      codes.push({
        start: open.start + Number(open.escaped),
        openEnd: open.end,
        closeStart: close.start,
        end: close.end,
      });
      index = closeIndex;
    }
    return { codes, images };
  }
  let runIndex = 0;
  let destinationIndex = 0;
  for (let position = 0; position < value.length; position += 1) {
    while (runs[runIndex] && runs[runIndex]!.end <= position) runIndex += 1;
    while (destinations[destinationIndex] && destinations[destinationIndex]!.end <= position) destinationIndex += 1;
    const inDestination = destinations[destinationIndex] && destinations[destinationIndex]!.start <= position;
    if (!inDestination && value[position] === "<") {
      const end = autolinkEnd(value, position);
      if (end !== null) {
        position = end;
        continue;
      }
    }
    if (!inDestination && value[position] === "!" && value[position + 1] === "[") {
      const image = longDataImage(value, position);
      if (image) {
        images.push({ kind: "image", start: position, ...image });
        position = image.end - 1;
        continue;
      }
    }
    const open = runs[runIndex];
    if (!open || open.start !== position) continue;
    if (open.escaped && open.length === 1) continue;
    const closeIndex = next[runIndex]!;
    if (closeIndex < 0) {
      position = open.end - 1;
      continue;
    }
    const close = runs[closeIndex]!;
    codes.push({
      start: open.start + Number(open.escaped),
      openEnd: open.end,
      closeStart: close.start,
      end: close.end,
    });
    position = close.end - 1;
    runIndex = closeIndex + 1;
  }
  return { codes, images };
}

function codeRanges(value: string): CodeRange[] | null {
  return inlineSpans(value, false)?.codes ?? null;
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

function enclosingBracket(brackets: number[], value: string, start: number, anchor: number) {
  for (const opening of brackets) {
    if (opening <= start || anchor - opening > 1024) continue;
    return value[opening - 1] === "!" ? opening - 1 : opening;
  }
  return Infinity;
}

function safeInlineCut(
  value: string,
  start: number,
  maximum: number,
  codes: CodeRange[],
  boundedClose: (index: number) => boolean,
) {
  const brackets: number[] = [];
  let parenDepth = 0;
  let destinationStart = -1;
  let linkStart = -1;
  let quote: string | null = null;
  let angled = false;
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
          enclosingBracket(brackets, value, start, code.start),
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
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (angled) {
      if (character === ">") angled = false;
      continue;
    }
    if (!parenDepth && character === "<") {
      const end = autolinkEnd(value, index);
      if (end !== null) {
        if (end >= maximum) {
          const earliest = Math.min(index, enclosingBracket(brackets, value, start, index));
          return earliest > start ? earliest : maximum;
        }
        index = end;
        continue;
      }
    }
    if (parenDepth && /\s/.test(value[index - 1] ?? "") && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    if (parenDepth === 1 && character === "<" && startsAngledDestination(value, destinationStart, index)) {
      angled = true;
      continue;
    }
    if (character === "[") brackets.push(index);
    else if (character === "]" && brackets.length) {
      const opening = brackets.pop()!;
      if (value[index + 1] === "(" && boundedClose(index + 1))
        linkStart = value[opening - 1] === "!" ? opening - 1 : opening;
    } else if (
      character === "(" &&
      (parenDepth || (value[index - 1] === "]" && !trailingEscape(value, index - 1) && boundedClose(index)))
    ) {
      if (!parenDepth) destinationStart = index;
      parenDepth += 1;
    } else if (character === ")" && parenDepth) {
      parenDepth -= 1;
      if (!parenDepth) linkStart = -1;
    }
    if (character === " " && index >= start + 1024) {
      fallback = index + 1;
      if (!brackets.length && !parenDepth) whitespace = index + 1;
    }
  }
  if (parenDepth && linkStart >= 0) {
    const earliest = Math.min(linkStart, enclosingBracket(brackets, value, start, linkStart));
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

function dataImageLabelEnd(value: string, start: number) {
  const limit = Math.min(value.length, start + DATA_IMAGE_LABEL_LIMIT);
  const candidates: number[] = [];
  for (let position = start + 2; position < limit; position += 1)
    if (
      value[position] === "]" &&
      value[position + 1] === "(" &&
      /^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(value.slice(position + 2, position + 42))
    )
      candidates.push(position);
  if (!candidates.length) return null;
  const codes = codeRanges(value.slice(start, limit)) ?? [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]!;
    let codeIndex = 0;
    let depth = 1;
    for (let index = start + 2; index <= candidate; index += 1) {
      const code = codes[codeIndex];
      if (
        code &&
        index === start + code.start &&
        (start + code.end <= candidate ||
          (start + code.end <= limit &&
            value[start + code.end] !== "`" &&
            !value.slice(candidate + 2, start + code.end).includes("![")))
      ) {
        index = start + code.end - 1;
        codeIndex += 1;
      } else if (value[index] === "\\") index += 1;
      else if (value[index] === "[") depth += 1;
      else if (value[index] === "]" && --depth === 0) return index === candidate ? candidate : null;
    }
  }
  return null;
}

function longDataImage(value: string, start: number) {
  if (!value.startsWith("![", start) || trailingEscape(value, start)) return null;
  const labelEnd = dataImageLabelEnd(value, start);
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
  const rawLabel = value.slice(start + 2, labelEnd);
  return { label: unescapeMarkdown(rawLabel), rawLabel, href, end: end + 1 };
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

function boundedMarkdownInline(
  value: string,
  issues: ImportIssue[],
  references: string[],
  imageMarkers?: Map<string, DataImage>,
) {
  if (!imageMarkers)
    issues.push({
      code: "inline_markup_simplified",
      detail:
        value.length > INLINE_SECTION_LIMIT
          ? "Long inline content was parsed in bounded sections."
          : "Dense inline content was parsed in bounded sections; complex formatting may be simplified.",
    });
  const output: ProseMirrorJson[] = [];
  const recordImage = (image: Pick<DataImage, "href">) => {
    references.push(image.href);
    issues.push({ code: "image_not_imported", detail: image.href.slice(0, 120) });
  };
  const append = (section: ProseMirrorJson[]) => {
    for (const node of section) {
      const parts: ProseMirrorJson[] = [];
      if (imageMarkers?.size && node.type === "text" && node.text) {
        let start = 0;
        for (let index = 0; index < node.text.length; index += 1) {
          const image = imageMarkers.get(node.text[index]!);
          if (!image) continue;
          if (index > start) parts.push({ ...node, text: node.text.slice(start, index) });
          parts.push(...imageLabelContent(image, node.marks ?? []));
          recordImage(image);
          start = index + 1;
        }
        if (start < node.text.length) parts.push({ ...node, text: node.text.slice(start) });
      } else parts.push(node);
      for (const part of parts) {
        const previous = output.at(-1);
        if (part.type === "text" && !part.marks && previous?.type === "text" && !previous.marks)
          previous.text = (previous.text ?? "") + (part.text ?? "");
        else output.push(part);
      }
    }
  };
  const boundedClose = closingParenWithin(value);
  const spans = inlineSpans(value, true, boundedClose);
  if (!spans) {
    let start = 0;
    for (let position = value.indexOf("!["); position >= 0; position = value.indexOf("![", position + 2)) {
      const image = longDataImage(value, position);
      if (!image) continue;
      append(inline(unescapeMarkdown(value.slice(start, position))));
      append(imageLabelContent(image));
      recordImage(image);
      start = image.end;
      position = image.end - 2;
    }
    append(inline(unescapeMarkdown(value.slice(start))));
    return output;
  }
  const markerOptions = spans.images.length ? availableImageMarkers() : null;
  let imageMarkersExhausted = Boolean(markerOptions && spans.images.length > markerOptions.candidates.length);
  if (!imageMarkers && spans.images.length && !imageMarkersExhausted) {
    const markers = new Map<string, DataImage>();
    const usedMarkers = new Set<string>();
    for (const character of value) if (markerOptions!.used.has(character)) usedMarkers.add(character);
    let nextMarker = 0;
    let cursor = 0;
    let transformed = "";
    for (const image of spans.images) {
      while (usedMarkers.has(markerOptions!.candidates[nextMarker]!)) nextMarker += 1;
      if (nextMarker >= markerOptions!.candidates.length) {
        imageMarkersExhausted = true;
        break;
      }
      const marker = markerOptions!.candidates[nextMarker++]!;
      markers.set(marker, image);
      transformed += value.slice(cursor, image.start) + marker;
      cursor = image.end;
    }
    if (markers.size === spans.images.length)
      return boundedMarkdownInline(transformed + value.slice(cursor), issues, references, markers);
  }
  const { codes: effectiveCodes } = spans;
  const specials: Array<DataImage | (CodeRange & { kind: "code" })> = [
    ...effectiveCodes
      .filter((range) => range.end - range.start > 8192)
      .map((range) => ({ kind: "code" as const, ...range })),
    ...spans.images.filter(
      (image) => image.end - image.start > 8192 || (imageMarkersExhausted && image.rawLabel.includes("`")),
    ),
  ];
  specials.sort((left, right) => left.start - right.start);
  const appendDenseText = (text: string) => {
    const plain = unescapeMarkdown(text, true);
    if (plain !== null) return append(inline(plain));
    for (let start = 0; start < text.length;) {
      let cut = Math.min(start + INLINE_SECTION_LIMIT, text.length);
      let scans = 0;
      let delimiters = 0;
      for (let index = start; index < cut; index += 1) {
        const character = text[index];
        if (
          ((character === "<" || character === "\\") && ++scans > INLINE_SCAN_LIMIT) ||
          ((character === "*" || character === "_" || character === "`") && ++delimiters > INLINE_DELIMITER_LIMIT)
        ) {
          cut = index;
          break;
        }
      }
      if (trailingEscape(text, cut, start) && cut < text.length) cut -= 1;
      const part = text.slice(start, cut);
      const plainPart = unescapeMarkdown(part, true);
      if (plainPart !== null) append(inline(plainPart));
      else {
        const { lexer } = markdownLexer();
        append(markdownInline(part, issues, references, lexer.inlineTokens(part), imageMarkers));
      }
      start = cut;
    }
  };
  const appendDense = (section: string) => {
    const { tokenizer } = markdownLexer();
    const sectionCodes = codeRanges(section) ?? [];
    let sectionCodeIndex = 0;
    let cursor = 0;
    let failedCandidates = 0;
    const dataImagePattern = /data:image\//gi;
    let nextDataImage = dataImagePattern.exec(section)?.index ?? -1;
    for (let index = 0; index < section.length; index += 1) {
      while (sectionCodes[sectionCodeIndex] && sectionCodes[sectionCodeIndex]!.end <= index) sectionCodeIndex += 1;
      const character = section[index];
      if (character === "<") {
        const token = autolinkToken(section, index);
        if (token) {
          const end = index + token.raw.length - 1;
          appendDenseText(section.slice(cursor, index));
          append(markdownInline("", issues, references, [token], imageMarkers));
          cursor = end + 1;
          index = end;
          continue;
        }
      }
      const code = sectionCodes[sectionCodeIndex];
      if (code && code.start === index) {
        appendDenseText(section.slice(cursor, index));
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
      if (++failedCandidates > INLINE_SCAN_LIMIT) {
        while (nextDataImage >= 0 && nextDataImage < start) nextDataImage = dataImagePattern.exec(section)?.index ?? -1;
        if (character === "!" && nextDataImage >= 0 && nextDataImage - start <= DATA_IMAGE_LABEL_LIMIT + 1) {
          const image = longDataImage(section, start);
          if (image) {
            appendDenseText(section.slice(cursor, start));
            append(imageLabelContent(image));
            recordImage(image);
            cursor = image.end;
            index = cursor - 1;
          }
        }
        continue;
      }
      const labelEnd = linkLabelEnd(section, start, 8192);
      if (labelEnd === null) continue;
      const label = section.slice(start, labelEnd);
      if (label.length > 512 && (label.match(/[<\\*_`]/g)?.length ?? 0) > 32) {
        const simple = simpleLongLink(section, start, labelEnd);
        if (!simple) continue;
        const href = safeLink(simple.href);
        appendDenseText(section.slice(cursor, start));
        if (!href) {
          issues.push({ code: "unsafe_url", detail: simple.href.slice(0, 120) });
          append(inline(simple.label));
        } else if (section[start] === "!") {
          append(inline(simple.label));
          recordImage({ href });
        } else {
          append(inline(simple.label, [{ type: "link", attrs: { href } }]));
          references.push(href);
        }
        failedCandidates -= 1;
        cursor = simple.end;
        index = cursor - 1;
        continue;
      }
      const token = tokenizer.link(section.slice(start));
      if (!token || (token.type !== "link" && token.type !== "image")) continue;
      appendDenseText(section.slice(cursor, start));
      append(markdownInline("", issues, references, [token], imageMarkers));
      failedCandidates -= 1;
      cursor = start + token.raw.length;
      index = cursor - 1;
    }
    appendDenseText(section.slice(cursor));
  };
  // Bound every Marked call. A malformed tag or escape can make its inline
  // scanner revisit the remainder of its input for each delimiter.
  let specialIndex = 0;
  for (let start = 0; start < value.length;) {
    while (specials[specialIndex] && specials[specialIndex]!.end <= start) specialIndex += 1;
    const special = specials[specialIndex];
    if (special?.start === start) {
      if (special.kind === "image") {
        recordImage(special);
        append(imageLabelContent(special));
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
      cut = safeInlineCut(value, start, cut, effectiveCodes, boundedClose);
      if (trailingEscape(value, cut, start) && value[cut] !== undefined) cut -= 1;
    }
    if (cut <= start) cut = Math.min(start + 8192, special?.start ?? value.length);
    const section = value.slice(start, cut);
    if (hasDenseInlineMarkup(section)) appendDense(section);
    else {
      const { lexer } = markdownLexer();
      append(markdownInline(section, issues, references, lexer.inlineTokens(section), imageMarkers));
    }
    start = cut;
  }
  return output;
}

function markdownImage(value: string) {
  const trimmed = value.trim();
  // Bound the label before Marked tokenizes it: Marked lexes image labels
  // recursively, and a hostile long label can otherwise dominate the import.
  if (!trimmed.startsWith("![")) return null;
  if (trimmed.length > 64_000) {
    const recovered = longDataImage(trimmed, 0);
    return recovered?.end === trimmed.length &&
      /^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(recovered.href)
      ? { label: recovered.label, href: recovered.href }
      : null;
  }
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
