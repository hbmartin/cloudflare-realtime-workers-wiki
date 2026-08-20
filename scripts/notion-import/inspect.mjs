/**
 * Read-only survey of an export.
 *
 * The rule table in `normalize-html.mjs` was written from Notion's documented and
 * observed markup, and the least verifiable thing about it is whether a particular
 * workspace actually contains those shapes. This counts what is really there, so a rule
 * can be added or corrected before an import is attempted rather than after.
 */
import { JSDOM } from "jsdom";
import { readPageHtml } from "./export-tree.mjs";

// Constructs worth calling out by name, with what the importer will do with each.
const NOTED_CONSTRUCTS = [
  ["figure.callout", "degrades to a quote"],
  ["div.column-list", "flattened in document order"],
  ["nav.table_of_contents", "dropped"],
  ["nav.breadcrumb", "dropped"],
  ["figure.equation", "kept as a latex code block"],
  ["span.notion-text-equation-token", "kept as inline code"],
  ["a.bookmark", "degrades to a link"],
  ["ul.to-do-list", "checklist"],
  ["ul.toggle", "toggle list"],
  ["table.simple-table", "table"],
  ["div.collection-content", "database view"],
  ["figure.link-to-page", "page mention"],
  ["div.indented", "nesting flattened outside lists"],
  ["span.user", "plain text; Notion exports no user id"],
];

export function surveyExport(index) {
  const constructs = new Map();
  const elements = new Map();
  const assetExtensions = new Map();
  let largest = { title: null, bytes: 0 };

  for (const page of index.pages) {
    const html = readPageHtml(index.root, page);
    if (html.length > largest.bytes) largest = { title: page.title, bytes: html.length };
    const body = new JSDOM(html).window.document.querySelector("div.page-body");
    if (!body) continue;
    for (const [selector, outcome] of NOTED_CONSTRUCTS) {
      const count = body.querySelectorAll(selector).length;
      if (!count) continue;
      const entry = constructs.get(selector) ?? { count: 0, outcome, firstSeenIn: page.title };
      entry.count += count;
      constructs.set(selector, entry);
    }
    for (const element of body.querySelectorAll("*")) {
      const tag = element.tagName.toLowerCase();
      elements.set(tag, (elements.get(tag) ?? 0) + 1);
    }
    for (const asset of page.assets) {
      const extension = asset.toLowerCase().match(/\.[^./]+$/)?.[0] ?? "(none)";
      assetExtensions.set(extension, (assetExtensions.get(extension) ?? 0) + 1);
    }
  }

  return {
    documents: index.pages.filter((page) => page.kind === "document").length,
    databases: index.pages.filter((page) => page.kind === "database").length,
    assets: index.pages.reduce((total, page) => total + page.assets.length, 0),
    roots: index.roots.length,
    constructs: [...constructs.entries()].sort((left, right) => right[1].count - left[1].count),
    elements: [...elements.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10),
    assetExtensions: [...assetExtensions.entries()].sort((left, right) => right[1] - left[1]),
    largest,
  };
}

const plural = (count, singular, many = `${singular}s`) => `${count} ${count === 1 ? singular : many}`;

function bytes(count) {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)} MiB`;
  if (count >= 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${count} bytes`;
}

export function printSurvey(index, survey) {
  console.log(
    `Read ${plural(index.pages.length, "page")}: ${plural(survey.documents, "document")}, ` +
      `${plural(survey.databases, "database")}, ${plural(survey.assets, "asset")}, ` +
      `${survey.roots} at the top level.`,
  );
  if (survey.largest.title) {
    console.log(`Largest page body: "${survey.largest.title}" (${bytes(survey.largest.bytes)}).`);
  }
  if (survey.constructs.length) {
    console.log("Notion constructs found:");
    for (const [selector, entry] of survey.constructs) {
      console.log(`  ${selector.padEnd(34)} ${String(entry.count).padStart(6)}  → ${entry.outcome}`);
    }
  }
  if (survey.assetExtensions.length) {
    const listed = survey.assetExtensions.map(([extension, count]) => `${extension} ${count}`).join(", ");
    console.log(`Asset types: ${listed}.`);
  }
  for (const issue of index.issues) {
    console.log(`Note: ${issue.code} (${issue.detail}).`);
  }
}
