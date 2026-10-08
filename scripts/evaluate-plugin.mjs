import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { pluginToolContracts } from "../src/shared/plugin-contracts.ts";

if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run synthetic tool-selection evaluations.");
const model = process.env.NOTEFLARE_EVAL_MODEL ?? "gpt-5.4-mini";
const cases = JSON.parse(await readFile(new URL("../plugins/noteflare/evals/cases.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../plugins/noteflare/skills/documents/SKILL.md", import.meta.url), "utf8");
const tools = Object.entries(pluginToolContracts).map(([name, contract]) => ({
  type: "function",
  name,
  description: contract.description,
  parameters: z.toJSONSchema(contract.inputSchema, { io: "input" }),
  strict: false,
}));
const results = [];
for (const example of cases) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
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
    const error = await response.json().catch(() => ({}));
    const code = typeof error.error?.code === "string" ? error.error.code : "api_error";
    results.push({ id: example.id, passed: false, status: "blocked", httpStatus: response.status, errorCode: code });
    for (const pending of cases.slice(results.length))
      results.push({ id: pending.id, passed: false, status: "not_run" });
    process.stdout.write(`BLOCKED ${example.id}: HTTP ${response.status}, ${code}\n`);
    break;
  }
  const output = await response.json();
  const calls = output.output.filter((item) => item.type === "function_call");
  const call = calls[0];
  const args = call ? JSON.parse(call.arguments) : null;
  const contract = call ? pluginToolContracts[call.name] : null;
  const valid = !call || (!!contract && contract.inputSchema.safeParse(args).success);
  const matches =
    !example.arguments || Object.entries(example.arguments).every(([key, value]) => args?.[key] === value);
  const passed =
    output.status === "completed" &&
    calls.length <= 1 &&
    valid &&
    matches &&
    example.expected.includes(call?.name ?? null);
  results.push({
    id: example.id,
    passed,
    selectedTool: call?.name ?? null,
    arguments: args,
    usage: output.usage,
    status: output.status,
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${example.id}: ${call?.name ?? "no tool"}\n`);
}
await writeFile(
  new URL("../plugins/noteflare/evals/results.json", import.meta.url),
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      model,
      scope: "Synthetic next-tool selection; no MCP writes executed; installed ChatGPT acceptance is separate.",
      results,
    },
    null,
    2,
  ) + "\n",
);
if (results.some((result) => !result.passed)) process.exitCode = 1;
