import { test, expect } from "@playwright/test";
import { signInOwner } from "./security-helpers";
import { writeFileSync } from "node:fs";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
test("records controlled eager/deferred 1k, 5k and 10k real mixed editor profiles", async ({ page }) => {
  test.setTimeout(240000);
  await signInOwner(page);
  const samples = await page.evaluate(async () => {
    const path = "/tests/e2e/fixtures/editor-render-benchmark.mjs";
    const { renderBenchmark } = (await import(path)) as {
      renderBenchmark: (
        count: number,
        eager: boolean,
      ) => Promise<{
        count: number;
        mode: string;
        firstPaintMs: number;
        editPaintMs: number;
        totalBlocks: number;
        mathPreviews: number;
        highlightedBlocks: number;
        docUnchangedByPreviews: boolean;
      }>;
    };
    await renderBenchmark(100, false);
    await renderBenchmark(100, true);
    const output = [];
    for (const count of [1000, 5000, 10000]) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const modes = repeat % 2 ? [false, true] : [true, false];
        for (const eager of modes) output.push(await renderBenchmark(count, eager));
      }
    }
    return output;
  });
  for (const sample of samples) {
    expect(sample.totalBlocks).toBe(sample.count);
    expect(sample.docUnchangedByPreviews).toBe(true);
  }
  writeFileSync(
    "/tmp/noteflare-editor-rendering.json",
    JSON.stringify(
      {
        viewport: "1280x800",
        repeats: 3,
        profile: "97% paragraphs, 1% H2 headings, 1% JavaScript code, 1% KaTeX math",
        samples,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(samples));
});
