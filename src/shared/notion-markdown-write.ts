import { Lexer, type Token, type Tokens } from "marked";
import type { ProseMirrorJson } from "./types";

const BLOCK_ATTRS = { backgroundColor: "default", textColor: "default", textAlignment: "left" };
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_INPUT_BLOCKS = 1000;

export class MarkdownWriteError extends Error {}

function validHref(value: string) {
  if (!value || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new MarkdownWriteError("A Markdown link has an invalid URL.");
  if (/^(?:\/|\.\.?\/|#)/.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (["https:", "http:", "mailto:"].includes(parsed.protocol)) return value;
  } catch {
    // The text is a relative URL, and will remain relative in the document.
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  }
  throw new MarkdownWriteError("A Markdown link has an unsupported URL.");
}

function textWithMath(value: string, marks: NonNullable<ProseMirrorJson["marks"]>): ProseMirrorJson[] {
  const output: ProseMirrorJson[] = [];
  let cursor = 0;
  const escaped = (position: number) => {
    let slashes = 0;
    for (let index = position - 1; index >= 0 && value[index] === "\\"; index -= 1) slashes += 1;
    return slashes % 2 === 1;
  };
  for (let index = 0; index < value.length; index += 1) {
    if (
      value[index] !== "$" ||
      escaped(index) ||
      (value[index - 1] === "$" && index > cursor) ||
      !value[index + 1] ||
      value[index + 1] === "$" ||
      /\s/.test(value[index + 1]!)
    )
      continue;
    let close = index + 1;
    while (close < value.length && value[close] !== "\n") {
      if (value[close] === "$" && !escaped(close)) break;
      close += 1;
    }
    if (close <= index + 1 || value[close] !== "$" || /\s/.test(value[close - 1]!)) continue;
    if (index > cursor)
      output.push({
        type: "text",
        text: unescapeMarkdown(value.slice(cursor, index)),
        ...(marks.length ? { marks } : {}),
      });
    output.push({ type: "inlineMath", attrs: { formula: value.slice(index + 1, close).replaceAll("\\$", "$") } });
    cursor = close + 1;
    index = close;
  }
  if (cursor < value.length)
    output.push({ type: "text", text: unescapeMarkdown(value.slice(cursor)), ...(marks.length ? { marks } : {}) });
  return output;
}

function unescapeMarkdown(value: string) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
}

function splitCrossTokenMath(tokens: Token[]) {
  const source = tokens.map((token) => token.raw).join("");
  if (!source.includes("$")) return null;
  const ranges: Array<{ from: number; to: number; type: string }> = [];
  let offset = 0;
  for (const token of tokens) {
    ranges.push({ from: offset, to: offset + token.raw.length, type: token.type });
    offset += token.raw.length;
  }
  const escaped = (position: number) => {
    let slashes = 0;
    for (let index = position - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
    return slashes % 2 === 1;
  };
  const spans: Array<{ from: number; to: number; formula: string }> = [];
  let lastClose = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (
      source[index] !== "$" ||
      escaped(index) ||
      (source[index - 1] === "$" && lastClose !== index - 1) ||
      source[index + 1] === "$" ||
      !source[index + 1] ||
      /\s/.test(source[index + 1]!)
    )
      continue;
    let close = index + 1;
    while (close < source.length && source[close] !== "\n") {
      if (source[close] === "$" && !escaped(close)) break;
      close += 1;
    }
    if (source[close] !== "$" || close <= index + 1 || /\s/.test(source[close - 1]!)) continue;
    const overlapping = ranges.filter((range) => range.from < close + 1 && range.to > index);
    if (overlapping.some((range) => ["codespan", "link", "image"].includes(range.type))) continue;
    const opening = ranges.find((range) => range.from <= index && index < range.to);
    const closing = ranges.find((range) => range.from <= close && close < range.to);
    if (opening !== closing && overlapping.some((range) => range.type !== "text" && range.type !== "escape"))
      spans.push({ from: index, to: close + 1, formula: source.slice(index + 1, close).replaceAll("\\$", "$") });
    lastClose = close;
    index = close;
  }
  return spans.length ? { source, spans } : null;
}

function inline(tokens: Token[], marks: NonNullable<ProseMirrorJson["marks"]> = []): ProseMirrorJson[] {
  const crossTokenMath = splitCrossTokenMath(tokens);
  if (crossTokenMath) {
    const output: ProseMirrorJson[] = [];
    let cursor = 0;
    for (const span of crossTokenMath.spans) {
      if (span.from > cursor)
        output.push(...inline(Lexer.lexInline(crossTokenMath.source.slice(cursor, span.from), { gfm: true }), marks));
      output.push({ type: "inlineMath", attrs: { formula: span.formula } });
      cursor = span.to;
    }
    if (cursor < crossTokenMath.source.length)
      output.push(...inline(Lexer.lexInline(crossTokenMath.source.slice(cursor), { gfm: true }), marks));
    return output;
  }
  const output: ProseMirrorJson[] = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    output.push(...textWithMath(text, marks));
    text = "";
  };
  for (const token of tokens) {
    if (token.type === "text" || token.type === "escape") {
      text += token.raw;
      continue;
    }
    flushText();
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      const mark = token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strike";
      output.push(...inline(token.tokens ?? [], [...marks, { type: mark }]));
    } else if (token.type === "codespan") {
      output.push({ type: "text", text: token.text, marks: [...marks, { type: "code" }] });
    } else if (token.type === "link") {
      const href = validHref(token.href);
      output.push(...inline(token.tokens ?? [], [...marks, { type: "link", attrs: { href } }]));
    } else if (token.type === "br") {
      output.push({ type: "hardBreak" });
    } else {
      throw new MarkdownWriteError(`Markdown inline content of type ${token.type} cannot be edited.`);
    }
  }
  flushText();
  return output;
}

function container(node: ProseMirrorJson, children: ProseMirrorJson[] = []): ProseMirrorJson {
  return {
    type: "blockContainer",
    attrs: { id: crypto.randomUUID() },
    content: [node, ...(children.length ? [{ type: "blockGroup", content: children }] : [])],
  };
}

function list(token: Token): ProseMirrorJson[] {
  const tokens = token as Tokens.List;
  if (!Array.isArray(tokens.items)) throw new MarkdownWriteError("Invalid Markdown list.");
  return tokens.items.map((item) => {
    const own = item.tokens.filter((child) => child.type !== "list");
    if (own.length > 1 || own.some((child) => child.type !== "text" && child.type !== "paragraph"))
      throw new MarkdownWriteError("A list item contains blocks that cannot be edited as Markdown.");
    const label = own[0];
    const content = label && "tokens" in label && Array.isArray(label.tokens) ? inline(label.tokens) : [];
    const type = item.task ? "checkListItem" : tokens.ordered ? "numberedListItem" : "bulletListItem";
    const node: ProseMirrorJson = {
      type,
      attrs: {
        ...BLOCK_ATTRS,
        ...(item.task ? { checked: item.checked === true } : type === "numberedListItem" ? { start: 1 } : {}),
      },
      ...(content.length ? { content } : {}),
    };
    const nested = item.tokens.flatMap((child) => (child.type === "list" ? list(child) : []));
    return container(node, nested);
  });
}

/** Parse only Markdown structures that can be represented without changing their meaning. */
export function parseWritableMarkdownWithSource(source: string): { blocks: ProseMirrorJson[]; rawBlocks: string[] } {
  if (new TextEncoder().encode(source).length > MAX_INPUT_BYTES)
    throw new MarkdownWriteError("Markdown content exceeds 128 KiB.");
  if (source.includes("\0")) throw new MarkdownWriteError("Markdown content contains an invalid character.");
  const normalized = source.replaceAll(/\r\n?/g, "\n");
  const blocks = new Lexer({ gfm: true }).blockTokens(normalized);
  let delimiterCount = 0;
  const countInline = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "code" || token.type === "space") continue;
      if (token.type === "list") {
        for (const item of token.items) countInline(item.tokens);
        continue;
      }
      if (token.type === "blockquote") {
        countInline(token.tokens ?? []);
        continue;
      }
      const inlineSource = "text" in token && typeof token.text === "string" ? token.text : token.raw;
      for (const character of inlineSource)
        if ("<\\[]`*_!".includes(character) && ++delimiterCount > 4096)
          throw new MarkdownWriteError("Markdown content has too many markup delimiters.");
    }
  };
  countInline(blocks);
  const output: ProseMirrorJson[] = [];
  const rawBlocks: string[] = [];
  for (const token of Lexer.lex(normalized, { gfm: true })) {
    if (token.type === "space") continue;
    if (token.type === "list") {
      output.push(...list(token));
      rawBlocks.push(...token.items.map((item: Tokens.ListItem) => item.raw.trimEnd()));
    } else if (token.type === "heading") {
      output.push(
        container({
          type: "heading",
          attrs: { ...BLOCK_ATTRS, level: token.depth, isToggleable: false },
          content: inline(token.tokens ?? []),
        }),
      );
    } else if (token.type === "paragraph" || token.type === "text") {
      const raw = token.text.trim();
      const displayMath = /^\$\$\n([\s\S]*?)\n\$\$$/.exec(raw);
      if (displayMath) {
        output.push(container({ type: "math", attrs: { formula: displayMath[1]!.replaceAll("\\$\\$", () => "$$") } }));
      } else if (token.tokens?.length === 1 && token.tokens[0]?.type === "image") {
        const image = token.tokens[0] as Tokens.Image;
        output.push(
          container({
            type: "image",
            attrs: {
              url: validHref(image.href),
              caption: unescapeMarkdown(image.text),
              name: unescapeMarkdown(image.text) || "image",
              showPreview: true,
              previewWidth: 512,
              ...BLOCK_ATTRS,
            },
          }),
        );
      } else {
        output.push(container({ type: "paragraph", attrs: BLOCK_ATTRS, content: inline(token.tokens ?? []) }));
      }
    } else if (token.type === "code") {
      const language = token.lang?.trim() ?? "";
      if (language.length > 64 || language.includes("`")) throw new MarkdownWriteError("Code language is invalid.");
      output.push(
        container(
          language === "mermaid"
            ? { type: "mermaid", attrs: { source: token.text } }
            : {
                type: "codeBlock",
                attrs: { language },
                content: token.text ? [{ type: "text", text: token.text }] : [],
              },
        ),
      );
    } else if (token.type === "blockquote") {
      if (token.tokens?.length !== 1 || token.tokens[0]?.type !== "paragraph")
        throw new MarkdownWriteError("Nested quotes cannot be edited as Markdown.");
      output.push(container({ type: "quote", attrs: BLOCK_ATTRS, content: inline(token.tokens[0].tokens ?? []) }));
    } else if (token.type === "hr") {
      output.push(container({ type: "divider" }));
    } else {
      throw new MarkdownWriteError(`Markdown blocks of type ${token.type} cannot be edited.`);
    }
    if (token.type !== "list") rawBlocks.push(token.raw.trimEnd());
    if (output.length > MAX_INPUT_BLOCKS) throw new MarkdownWriteError("Markdown content exceeds 1000 blocks.");
  }
  return { blocks: output, rawBlocks };
}

export function parseWritableMarkdown(source: string): ProseMirrorJson[] {
  return parseWritableMarkdownWithSource(source).blocks;
}
