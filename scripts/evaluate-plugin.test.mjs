import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, scoreCase } from "./evaluate-plugin.mjs";

const cases = JSON.parse(await readFile(new URL("../plugins/noteflare/evals/cases.json", import.meta.url), "utf8"));
const search = { id: "search", expected: ["search_pages"] };
const selected = (name = "search_pages", args = { query: "launch" }) => ({
  status: "completed",
  output: [{ type: "function_call", name, arguments: JSON.stringify(args), status: "completed" }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe("synthetic tool-selection scoring", () => {
  it("scores valid calls and intentional no-tool responses", () => {
    expect(scoreCase(search, selected())).toMatchObject({ passed: true, arguments: { query: "launch" } });
    expect(scoreCase({ id: "draft", expected: [null] }, { status: "completed", output: [] })).toMatchObject({
      passed: true,
      selectedTool: null,
    });
  });

  it("records truncated arguments and incomplete details instead of throwing", () => {
    const output = selected("fetch_page");
    output.status = "incomplete";
    output.incomplete_details = { reason: "max_output_tokens" };
    output.output[0].arguments = '{"page_id":';
    expect(scoreCase(search, output)).toMatchObject({
      passed: false,
      status: "incomplete",
      failureReason: "invalid_tool_arguments",
      rawArguments: '{"page_id":',
      incompleteDetails: { reason: "max_output_tokens" },
    });
  });

  it.each([null, {}, { output: null }, { output: [null] }, { output: [{}] }])(
    "rejects malformed response shapes: %j",
    (output) => {
      expect(scoreCase(search, output)).toMatchObject({ passed: false, failureReason: "invalid_response" });
    },
  );

  it.each(["unknown_tool", "__proto__", "toString"])("rejects unknown tool %s", (name) => {
    expect(scoreCase(search, selected(name))).toMatchObject({ passed: false, failureReason: "unknown_tool" });
  });

  it.each([null, {}, { query: 12 }])("rejects schema-invalid arguments: %j", (args) => {
    expect(scoreCase(search, selected("search_pages", args))).toMatchObject({
      passed: false,
      failureReason: "invalid_tool_arguments",
    });
  });

  it("rejects non-string argument payloads", () => {
    const output = selected();
    output.output[0].arguments = null;
    expect(scoreCase(search, output)).toMatchObject({ passed: false, failureReason: "invalid_tool_arguments" });
  });

  it("rejects incomplete responses and tool calls even when JSON is valid", () => {
    const output = selected();
    expect(scoreCase(search, { ...output, status: "incomplete" })).toMatchObject({
      passed: false,
      failureReason: "response_not_completed",
    });
    output.output[0].status = "incomplete";
    expect(scoreCase(search, output)).toMatchObject({ passed: false, failureReason: "tool_call_not_completed" });
  });

  it("rejects multiple calls, unexpected selection, and mismatched expected arguments", () => {
    const output = selected();
    expect(scoreCase(search, { ...output, output: [...output.output, ...output.output] })).toMatchObject({
      passed: false,
      failureReason: "multiple_tool_calls",
    });
    expect(scoreCase({ ...search, expected: [null] }, output)).toMatchObject({
      passed: false,
      failureReason: "unexpected_tool",
    });
    expect(scoreCase({ ...search, arguments: { query: "different" } }, output)).toMatchObject({
      passed: false,
      failureReason: "argument_mismatch",
    });
  });
});

describe("synthetic evaluation reporting", () => {
  let directory;
  let resultsUrl;
  const log = vi.fn();
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "noteflare-eval-"));
    resultsUrl = join(directory, "results.json");
    await writeFile(resultsUrl, '{"stale":true}');
    log.mockClear();
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const report = () => readFile(resultsUrl, "utf8").then(JSON.parse);

  it("returns success for a complete valid run without executing selected tools", async () => {
    const argumentsByTool = {
      search_pages: { query: "launch" },
      fetch_page: { page_id: "test-document" },
      list_spaces: {},
      list_pages: { space_id: "test-space" },
      open_noteflare: {},
      create_page: {
        space_id: "test-space",
        title: "Launch note",
        markdown: "Ready",
        operation_id: "create-operation",
      },
      update_page: {
        page_id: "test-document",
        command: { type: "insert_content", insert_content: { content: "Review complete", position: { type: "end" } } },
        operation_id: "update-operation",
        expected_revision: 10,
        expected_content_epoch: 3,
      },
      create_comment: { page_id: "test-document", body: "Looks good", operation_id: "comment-operation" },
    };
    let index = 0;
    const fetchImpl = vi.fn(async (url, request) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(JSON.parse(request.body)).toMatchObject({ store: false, parallel_tool_calls: false });
      const example = cases[index++];
      const name = example.expected[0];
      return Response.json(
        name ? selected(name, { ...argumentsByTool[name], ...example.arguments }) : { status: "completed", output: [] },
      );
    });
    expect(await main({ apiKey: "offline-test-key", fetchImpl, resultsUrl, log })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(cases.length);
    expect((await report()).results.every((result) => result.passed)).toBe(true);
  });

  it("checkpoints completed cases and continues after malformed model arguments", async () => {
    let index = 0;
    const fetchImpl = vi.fn(async () => {
      const checkpoint = await report();
      expect(checkpoint.stale).toBeUndefined();
      expect(checkpoint.results).toHaveLength(index);
      index++;
      if (index === 2)
        return Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "function_call", name: "fetch_page", arguments: '{"page_id":' }],
        });
      if (index === 1) return Response.json(selected());
      return Response.json({ status: "completed", output: [] });
    });
    expect(await main({ apiKey: "offline-test-key", fetchImpl, resultsUrl, log })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(cases.length);
    const saved = await report();
    expect(saved.results[0]).toMatchObject({ id: "search", passed: true });
    expect(saved.results[1]).toMatchObject({ id: "read", passed: false, rawArguments: '{"page_id":' });
    expect(saved.results.at(-1).status).toBe("completed");
  });

  it("scores malformed response JSON as a failed case and continues", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{"));
    fetchImpl.mockImplementation(async () => Response.json({ status: "completed", output: [] }));
    expect(await main({ apiKey: "offline-test-key", fetchImpl, resultsUrl, log })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(cases.length);
    expect((await report()).results[0]).toMatchObject({
      status: "invalid_response",
      failureReason: "invalid_response",
    });
  });

  it("retains completed results and marks an API failure plus remaining cases accurately", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(selected()))
      .mockResolvedValueOnce(Response.json({ error: { code: "credit_balance_exhausted" } }, { status: 429 }));
    expect(await main({ apiKey: "offline-test-key", fetchImpl, resultsUrl, log })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const saved = await report();
    expect(saved.results).toHaveLength(cases.length);
    expect(saved.results[0].passed).toBe(true);
    expect(saved.results[1]).toMatchObject({
      status: "blocked",
      httpStatus: 429,
      errorCode: "credit_balance_exhausted",
    });
    expect(saved.results.slice(2).every((result) => result.status === "not_run")).toBe(true);
  });

  it.each([
    [new TypeError("Network unavailable"), "transport_error"],
    [new DOMException("Timed out", "TimeoutError"), "timeout"],
  ])("records a terminal transport failure: %s", async (error, errorCode) => {
    const fetchImpl = vi.fn().mockRejectedValue(error);
    expect(await main({ apiKey: "offline-test-key", fetchImpl, resultsUrl, log })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const saved = await report();
    expect(saved.results[0]).toMatchObject({ status: "blocked", errorCode });
    expect(saved.results.slice(1).every((result) => result.status === "not_run")).toBe(true);
  });

  it("marks a response-body transport failure as blocked", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new TypeError("Stream failed");
      },
    });
    expect(await main({ apiKey: "offline-test-key", fetchImpl, resultsUrl, log })).toBe(1);
    expect((await report()).results[0]).toMatchObject({ status: "blocked", errorCode: "transport_error" });
  });

  it("does not fetch or overwrite evidence without an API key", async () => {
    const fetchImpl = vi.fn();
    await expect(main({ apiKey: "", fetchImpl, resultsUrl, log })).rejects.toThrow("Set OPENAI_API_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await report()).toEqual({ stale: true });
  });
});
