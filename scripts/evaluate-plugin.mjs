import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { pluginToolContracts } from "../src/shared/plugin-contracts.ts";

export function scoreCase(example, output) {
  const result = {
    id: example.id,
    passed: false,
    selectedTool: null,
    arguments: null,
    status: typeof output?.status === "string" ? output.status : "invalid_response",
    usage: output?.usage,
    incompleteDetails: output?.incomplete_details,
  };
  if (
    !Array.isArray(output?.output) ||
    !output.output.every((item) => item && typeof item === "object" && typeof item.type === "string")
  )
    return { ...result, failureReason: "invalid_response" };

  const calls = output.output.filter((item) => item.type === "function_call");
  const call = calls[0];
  if (call) {
    result.selectedTool = typeof call.name === "string" ? call.name : null;
    if (typeof call.arguments !== "string") return { ...result, failureReason: "invalid_tool_arguments" };
    result.rawArguments = call.arguments;
    try {
      result.arguments = JSON.parse(call.arguments);
    } catch {
      return { ...result, failureReason: "invalid_tool_arguments" };
    }
  }
  if (output.status !== "completed") return { ...result, failureReason: "response_not_completed" };
  if (calls.length > 1) return { ...result, failureReason: "multiple_tool_calls" };
  if (call) {
    if (call.status !== undefined && call.status !== "completed")
      return { ...result, failureReason: "tool_call_not_completed" };
    const contract = Object.hasOwn(pluginToolContracts, result.selectedTool)
      ? pluginToolContracts[result.selectedTool]
      : null;
    if (!contract) return { ...result, failureReason: "unknown_tool" };
    if (!contract.inputSchema.safeParse(result.arguments).success)
      return { ...result, failureReason: "invalid_tool_arguments" };
  }
  if (!example.expected.includes(result.selectedTool)) return { ...result, failureReason: "unexpected_tool" };
  if (
    example.arguments &&
    !Object.entries(example.arguments).every(([key, value]) => isDeepStrictEqual(result.arguments?.[key], value))
  )
    return { ...result, failureReason: "argument_mismatch" };
  return { ...result, passed: true };
}

export async function main({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.NOTEFLARE_EVAL_MODEL ?? "gpt-5.4-mini",
  fetchImpl = fetch,
  resultsUrl = new URL("../plugins/noteflare/evals/results.json", import.meta.url),
  log = (message) => process.stdout.write(message),
} = {}) {
  if (!apiKey) throw new Error("Set OPENAI_API_KEY to run synthetic tool-selection evaluations.");
  const cases = JSON.parse(await readFile(new URL("../plugins/noteflare/evals/cases.json", import.meta.url), "utf8"));
  const workflow = await readFile(new URL("../plugins/noteflare/skills/documents/SKILL.md", import.meta.url), "utf8");
  const tools = Object.entries(pluginToolContracts).map(([name, contract]) => ({
    type: "function",
    name,
    description: contract.description,
    parameters: z.toJSONSchema(contract.inputSchema, { io: "input" }),
    strict: false,
  }));
  const report = {
    recordedAt: new Date().toISOString(),
    model,
    scope: "Synthetic next-tool selection; no MCP writes executed; installed ChatGPT acceptance is separate.",
    results: [],
  };
  const checkpoint = () => writeFile(resultsUrl, JSON.stringify(report, null, 2) + "\n");
  await checkpoint();
  for (const example of cases) {
    let response;
    let result;
    try {
      response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          store: false,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
          max_output_tokens: 1200,
          reasoning: { effort: "low" },
          input: [
            {
              role: "developer",
              content: `Use the NoteFlare workflow below. Decide the next action. Generate tool calls only when needed; no tool will be executed in this evaluation.\n${workflow}`,
            },
            ...(example.context ? [{ role: "developer", content: `Synthetic test context:\n${example.context}` }] : []),
            { role: "user", content: example.prompt },
          ],
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        const code = typeof error?.error?.code === "string" ? error.error.code : "api_error";
        result = { id: example.id, passed: false, status: "blocked", httpStatus: response.status, errorCode: code };
      } else {
        let output;
        try {
          output = await response.json();
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        result = scoreCase(example, output);
      }
    } catch (error) {
      const code = ["AbortError", "TimeoutError"].includes(error?.name) ? "timeout" : "transport_error";
      result = { id: example.id, passed: false, status: "blocked", errorCode: code };
    }
    report.results.push(result);
    if (result.status === "blocked" && result.errorCode) {
      for (const pending of cases.slice(report.results.length))
        report.results.push({ id: pending.id, passed: false, status: "not_run" });
      log(`BLOCKED ${example.id}: ${result.httpStatus ? `HTTP ${result.httpStatus}, ` : ""}${result.errorCode}\n`);
      await checkpoint();
      break;
    }
    log(`${result.passed ? "PASS" : "FAIL"} ${example.id}: ${result.selectedTool ?? "no tool"}\n`);
    await checkpoint();
  }
  return report.results.some((result) => !result.passed) ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
