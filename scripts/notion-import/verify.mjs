/**
 * Re-checks a finished import against the live workspace.
 *
 * Cheap to run and worth running: the write path reports what it sent, not what
 * survived. Projections in particular follow a 30-second compaction alarm rather than
 * the writes themselves, so a check immediately after a run legitimately finds them
 * missing - which is exactly the confusion this is meant to settle rather than cause.
 */
export async function verifyImport({ client, manifest, index }) {
  const nodes = Object.entries(manifest.state.nodes);
  const live = new Map((await client.tree()).map((page) => [page.id, page]));
  const problems = [];
  let emptyContent = 0;
  let checked = 0;

  for (const [key, node] of nodes) {
    if (!node.pageId) {
      problems.push(`${node.title ?? key} was never created.`);
      continue;
    }
    const page = live.get(node.pageId);
    if (!page) {
      problems.push(`${node.title ?? key} no longer exists in the workspace.`);
      continue;
    }
    checked += 1;

    if (node.kind === "database") {
      const table = await client.readTable(node.pageId);
      if (!table.table.rowCount) problems.push(`Table "${node.title}" has no rows.`);
      continue;
    }
    // A page whose source had no text legitimately has no excerpt, so an empty preview
    // is only counted, not reported as a fault.
    const preview = await client.request(`/api/pages/${node.pageId}/preview`);
    if (!preview.preview?.excerpt) emptyContent += 1;
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
