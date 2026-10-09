import { describe, expect, it } from "vitest";
import { Lexer } from "marked";
import { vi } from "vitest";
import { parseAiMarkdown } from "./ai-writing";
import { parseWritableMarkdown, parseWritableMarkdownWithSource } from "./notion-markdown-write";

const nestedList = (depth: number) =>
  Array.from({ length: depth }, (_, index) => `${"  ".repeat(index)}- item`).join("\n");
describe("AI Markdown budgets", () => {
  it.each(["a", "界"])(
    "applies 250,000 characters of %s prose without changing the Markdown API byte limit",
    (letter) => {
      const text = letter.repeat(250000);
      expect(JSON.stringify(parseAiMarkdown(text))).toContain(text);
      expect(() => parseAiMarkdown(text + letter)).toThrow(/250000 characters/);
      expect(() => parseWritableMarkdown(text)).toThrow(/128 KiB/);
    },
  );
  it("accepts ordinary formatted output beyond the default delimiter budget", () => {
    const text = Array.from({ length: 20 }, () => "**word** ".repeat(100)).join("\n\n");
    expect(parseAiMarkdown(text)).toHaveLength(20);
    expect(() => parseWritableMarkdown(text)).toThrow(/delimiters/);
    expect(parseWritableMarkdownWithSource("**word**", 4).delimiterCount).toBe(4);
    expect(() => parseWritableMarkdownWithSource("**word**", 3)).toThrow(/delimiters/);
  });
  it("budgets strikethrough and math delimiters for AI without changing legacy delimiter counts", () => {
    expect(() => parseAiMarkdown("~~word~~ ".repeat(2049))).toThrow(/block has too many/);
    expect(() => parseAiMarkdown("$".repeat(8193))).toThrow(/block has too many/);
    expect(parseWritableMarkdownWithSource("~~word~~").delimiterCount).toBe(0);
  });
  it("supports multibyte supplementary Unicode within the existing string-length limit", () => {
    const text = "😀".repeat(125000);
    expect(JSON.stringify(parseAiMarkdown(text))).toContain(text);
    expect(() => parseAiMarkdown(text + "😀")).toThrow(/250000 characters/);
    const options = { maxBytes: 1_000_000 };
    expect(parseWritableMarkdown("界".repeat(333333), options)).toHaveLength(1);
    expect(() => parseWritableMarkdown("界".repeat(333334), options)).toThrow(/1000000 bytes/);
  });
  it("checks total and per-block delimiter budgets before inline parsing", () => {
    const inline = vi.spyOn(Lexer, "lex");
    expect(() => parseAiMarkdown("*".repeat(8193) + " text")).toThrow(/block has too many/);
    expect(inline).not.toHaveBeenCalled();
    const paragraph = "**word** ".repeat(2048);
    expect(parseAiMarkdown(paragraph)).toHaveLength(1);
    expect(parseAiMarkdown(Array.from({ length: 8 }, () => paragraph).join("\n\n"))).toHaveLength(8);
    expect(() => parseAiMarkdown(Array.from({ length: 9 }, () => paragraph).join("\n\n"))).toThrow(/too many markup/);
    inline.mockRestore();
  });
  it("counts nested containers and limits nesting depth", () => {
    expect(parseAiMarkdown(nestedList(16))).toHaveLength(1);
    expect(() => parseAiMarkdown(nestedList(17))).toThrow(/nesting/);
    expect(parseAiMarkdown("paragraph\n\n".repeat(4096))).toHaveLength(4096);
    expect(() => parseAiMarkdown("paragraph\n\n".repeat(4097))).toThrow(/4096 blocks/);
    const text = "- parent\n  - child\n".repeat(2048);
    expect(parseAiMarkdown(text)).toHaveLength(2048);
    expect(() => parseAiMarkdown(text + "- extra")).toThrow(/4096 blocks/);
    expect(() => parseWritableMarkdown("paragraph\n\n".repeat(1001))).toThrow(/1000 blocks/);
  });
  it("keeps unsupported structures copy-only with an explanation", () => {
    expect(() => parseAiMarkdown("![image](https://example.test/image.png)")).toThrow(/outside standard writing/);
    expect(() => parseAiMarkdown("> outer\n>\n> > inner")).toThrow(/Nested quotes/);
  });
});
