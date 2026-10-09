import { describe, expect, it } from "vitest";
import { AI_ACTIONS, aiGenerateSchema, aiInstructions } from "./ai";
import { parseAiMarkdown, writingProtected } from "./ai-writing";
import { readSse } from "./sse";

const valid = {
  operationId: "9bf905db-67a6-4e02-a7fd-850ee98eae24",
  pageId: "doc",
  action: "rewrite",
  prompt: "",
  funding: "api",
  sources: [{ pageId: "doc", scope: { kind: "page" } }],
};
describe("writing requests", () => {
  it("supports each agreed preset and defaults to Fast", () => {
    for (const action of Object.keys(AI_ACTIONS)) {
      const result = aiGenerateSchema.parse({
        ...valid,
        action,
        prompt: "Please write in French",
        targetLanguage: "Spanish",
        tone: "Friendly",
      });
      expect(result.quality).toBe("fast");
      expect(aiInstructions(result)).toContain("standard Markdown");
    }
    expect(aiInstructions({ action: "draft" })).toContain("language of the instruction");
    expect(aiInstructions({ action: "rewrite" })).toContain("Preserve the source language");
    expect(aiInstructions({ action: "translate", targetLanguage: "Spanish" })).toContain("into: Spanish");
    expect(aiInstructions({ action: "summarize" })).toContain("inline");
    expect(aiInstructions({ action: "extract_actions" })).toContain("Do not invent owners or deadlines");
  });
  it("requires an explicit translation language, drafting instruction, current page, and unique sources", () => {
    expect(aiGenerateSchema.safeParse({ ...valid, action: "translate" }).success).toBe(false);
    expect(aiGenerateSchema.safeParse({ ...valid, action: "draft" }).success).toBe(false);
    expect(
      aiGenerateSchema.safeParse({ ...valid, sources: [{ pageId: "other", scope: { kind: "page" } }] }).success,
    ).toBe(false);
    expect(aiGenerateSchema.safeParse({ ...valid, sources: [valid.sources[0], valid.sources[0]] }).success).toBe(false);
    expect(
      aiGenerateSchema.safeParse({
        ...valid,
        sources: Array.from({ length: 21 }, (_, index) => ({
          pageId: index ? `page-${index}` : "doc",
          scope: { kind: "page" },
        })),
      }).success,
    ).toBe(false);
  });
  it("limits application to standard Markdown without active images, HTML, or custom structures", () => {
    expect(
      parseAiMarkdown(
        "# Title\n\n**Bold** and [link](https://example.test)\n\n- Task\n\n```ts\nconst value = 1;\n```\n",
      ),
    ).toHaveLength(4);
    expect(() => parseAiMarkdown("![image](https://tracker.test/pixel)")).toThrow(/standard writing Markdown/);
    expect(() => parseAiMarkdown("<script>alert(1)</script>")).toThrow(/cannot be edited/);
    expect(() => parseAiMarkdown("[bad](javascript:alert(1))")).toThrow(/unsupported URL/);
    expect(writingProtected({ type: "mention" })).toBe(true);
    expect(writingProtected({ type: "text", text: "Anchored", marks: [{ type: "comment" }] })).toBe(true);
    expect(writingProtected({ type: "blockContainer", attrs: { id: "anchored" } }, new Set(["anchored"]))).toBe(true);
    expect(writingProtected(parseAiMarkdown("Ordinary text")[0]!)).toBe(false);
    expect(parseAiMarkdown("```mermaid\nA-->B\n```")[0]?.content?.[0]?.type).toBe("codeBlock");
  });
});
describe("SSE framing", () => {
  it("handles fragmented Unicode, CRLF, comments, and multiline data", async () => {
    const bytes = new TextEncoder().encode(': keepalive\r\ndata: {"text":"é"}\r\n\r\ndata: first\ndata: second\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const result = [];
    for await (const value of readSse(stream)) result.push(value);
    expect(result).toEqual(['{"text":"é"}', "first\nsecond"]);
  });
  it("does not accept an incomplete terminal frame", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}'));
        controller.close();
      },
    });
    const result = [];
    for await (const value of readSse(stream)) result.push(value);
    expect(result).toEqual([]);
  });
});
