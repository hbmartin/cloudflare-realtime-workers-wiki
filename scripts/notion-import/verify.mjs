/**
 * Re-checks a finished import against the live workspace.
 *
 * Cheap to run and worth running: the write path reports what it sent, not what
 * survived. Projections in particular follow a 30-second compaction alarm rather than
 * the writes themselves, so a check immediately after a run legitimately finds them
 * missing - which is exactly the confusion this is meant to settle rather than cause.
 */
const VERIFY_CONCURRENCY = 8;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export async function verifyImport({ client, manifest, index }) {
  const nodes = Object.entries(manifest.state.nodes);
  const live = new Map((await client.tree()).map((page) => [page.id, page]));
  const problems = [];
  let emptyContent = 0;
  let checked = 0;

  async function checkNode([key, node]) {
    if (!node.pageId) {
      return { problem: `${node.title ?? key} was never created.`, checked: false, empty: false };
    }
    const page = live.get(node.pageId);
    if (!page) {
      return { problem: `${node.title ?? key} no longer exists in the workspace.`, checked: false, empty: false };
    }

    try {
      if (node.kind === "database") {
        const table = await client.readTable(node.pageId);
        return {
          problem: table.table.rowCount ? null : `Table "${node.title}" has no rows.`,
          checked: true,
          empty: false,
        };
      }
      // A page whose source had no text legitimately has no excerpt, so an empty preview
      // is only counted, not reported as a fault.
      const preview = await client.request(`/api/pages/${node.pageId}/preview`);
      return { problem: null, checked: true, empty: !preview.preview?.excerpt };
    } catch (error) {
      return {
        problem: `${node.title ?? key} could not be checked: ${errorMessage(error)}`,
        checked: true,
        empty: false,
      };
    }
  }

  const results = Array.from({ length: nodes.length });
  let next = 0;
  async function worker() {
    while (next < nodes.length) {
      const position = next;
      next += 1;
      results[position] = await checkNode(nodes[position]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, nodes.length) }, () => worker()));

  for (const result of results) {
    if (result.problem) problems.push(result.problem);
    if (result.checked) checked += 1;
    if (result.empty) emptyContent += 1;
  }

  console.log(`Checked ${checked} of ${nodes.length} imported pages against ${client.baseURL}.`);
  if (emptyContent) {
    console.log(
      `${emptyContent} ${emptyContent === 1 ? "page has" : "pages have"} no searchable text yet. ` +
        "Pages whose source was only images have none; " +
        "otherwise compaction may not have run, so re-check in a minute.",
    );
  }
  if (index.pages.length !== nodes.length) {
    console.log(`The export holds ${index.pages.length} pages but the manifest records ${nodes.length}.`);
  }
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length === 0) console.log("No problems found.");
  return problems.length;
}
