/**
 * Imports an unpacked Notion HTML export into this workspace.
 *
 * Conversion runs here rather than on the Worker deliberately. Document content has
 * exactly one ingress - the Yjs WebSocket - and parsing a large export is unbounded CPU
 * work that does not fit the Workers execution model, so the operator's machine does the
 * conversion and drives the ordinary authenticated API.
 *
 * Commands escalate in what they touch:
 *   inspect   reads the export and reports what is in it. No network, no writes.
 *   plan      also converts every page in memory, reporting each degradation. Still no
 *             network, so a rule can be corrected before anything is created.
 *   run       performs the import.
 *   verify    re-checks an existing import against the live workspace.
 *
 * The export must be unpacked first: Node ships no zip reader and this repository
 * carries no archive dependency.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertSupportedNode } from "./notion-import/node-version.mjs";

assertSupportedNode();

// These modules import shared .ts files. Keep them dynamic so the plain-JavaScript
// version guard above can explain an unsupported Node version before module loading fails.
const [blockModule, exportTree, inspect, normalizer, api, manifests, reports, runner, verifier] = await Promise.all([
  import("./notion-import/blocks.mjs"),
  import("./notion-import/export-tree.mjs"),
  import("./notion-import/inspect.mjs"),
  import("./notion-import/normalize-html.mjs"),
  import("./notion-import/api-client.mjs"),
  import("./notion-import/manifest.mjs"),
  import("./notion-import/report.mjs"),
  import("./notion-import/run.mjs"),
  import("./notion-import/verify.mjs"),
]);
const { createImportEditor, htmlToBlocks } = blockModule;
const { readExport, readPageHtml, resolveLink } = exportTree;
const { printSurvey, surveyExport } = inspect;
const { normalizeNotionHtml } = normalizer;
const { createClient } = api;
const { createManifest } = manifests;
const { createReport } = reports;
const { planTable, runImport } = runner;
const { verifyImport } = verifier;

const COMMANDS = new Set(["inspect", "plan", "run", "verify"]);

function parseArguments(argv) {
  const options = {
    command: null,
    exportDir: null,
    baseURL: process.env.NOTES_IMPORT_BASE_URL || "http://127.0.0.1:4173",
    email: process.env.NOTES_IMPORT_EMAIL || "",
    parent: null,
    limit: Number.POSITIVE_INFINITY,
    manifest: "./notion-import.manifest.json",
    requestsPerSecond: Number.parseInt(process.env.NOTES_IMPORT_RPS || "20", 10),
    lingerMs: 1_200,
    verifyTimeoutMs: Number(process.env.NOTES_IMPORT_VERIFY_TIMEOUT_MS || 120_000),
    keepAmbiguousTable: false,
    adoptLegacyFingerprint: false,
    verbose: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const [flag, inlineValue] =
      argument.startsWith("--") && equals !== -1
        ? [argument.slice(0, equals), argument.slice(equals + 1)]
        : [argument, null];
    const take = () => inlineValue ?? argv[(index += 1)];
    const takeNumber = () => {
      const value = take();
      return typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    };
    if (flag === "--base-url") options.baseURL = take();
    else if (flag === "--email") options.email = take();
    else if (flag === "--parent") options.parent = take();
    else if (flag === "--limit") options.limit = takeNumber();
    else if (flag === "--manifest") options.manifest = take();
    else if (flag === "--rps") options.requestsPerSecond = takeNumber();
    else if (flag === "--linger-ms") options.lingerMs = takeNumber();
    else if (flag === "--verify-timeout-ms") options.verifyTimeoutMs = takeNumber();
    else if (flag === "--keep-ambiguous-table") options.keepAmbiguousTable = true;
    else if (flag === "--adopt-legacy-fingerprint") options.adoptLegacyFingerprint = true;
    else if (flag === "--verbose") options.verbose = true;
    else if (flag.startsWith("--")) throw new Error(`Unknown option ${flag}.`);
    else positional.push(argument);
  }
  options.command = positional[0] ?? null;
  options.exportDir = positional[1] ?? null;
  return options;
}

function usage() {
  console.error("Usage: pnpm import:notion <inspect|plan|run|verify> <export-directory> [options]");
  console.error("");
  console.error("  --base-url <url>   Target installation. Defaults to NOTES_IMPORT_BASE_URL.");
  console.error("  --email <address>  Owner or editor account. Defaults to NOTES_IMPORT_EMAIL.");
  console.error("                     The password comes from NOTES_IMPORT_PASSWORD only.");
  console.error("  --parent <pageId>  Import beneath an existing page instead of the top level.");
  console.error("  --limit <n>        Only process the first n pages, for a smoke test.");
  console.error("  --manifest <path>  Where to record progress. Re-running resumes from it.");
  console.error("  --rps <n>          Global request rate. Defaults to NOTES_IMPORT_RPS or 20.");
  console.error("  --linger-ms <n>    How long to hold each document open so compaction is armed promptly.");
  console.error("  --verify-timeout-ms <n>  Maximum time for exact post-import verification.");
  console.error("  --keep-ambiguous-table   Settle a table reported as table_recovery_ambiguous by");
  console.error("                     accepting the live table as the destination's. The import stops");
  console.error("                     writing to it; nothing else can clear that state.");
  console.error("  --adopt-legacy-fingerprint  Resume a manifest written with the older raw-byte export");
  console.error("                     fingerprint, checking it once and migrating it to the digest form.");
  console.error("  --verbose          One line per page instead of a summary.");
}

function validate(options) {
  if (!options.command || !COMMANDS.has(options.command)) {
    usage();
    process.exit(1);
  }
  if (!options.exportDir) {
    console.error("Point the importer at an unpacked Notion HTML export directory.");
    process.exit(1);
  }
  const root = resolve(options.exportDir);
  if (options.exportDir.toLowerCase().endsWith(".zip")) {
    throw new Error(
      `Unpack the export first, for example: unzip "${options.exportDir}" -d notion-export. ` +
        "A large Notion export also contains nested Part-N.zip files that must be unpacked too.",
    );
  }
  if (!existsSync(root)) throw new Error(`No such directory: ${root}.`);
  if (options.limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  if (
    !Number.isInteger(options.requestsPerSecond) ||
    options.requestsPerSecond < 1 ||
    options.requestsPerSecond > 200
  ) {
    throw new Error("--rps must be an integer between 1 and 200.");
  }
  if (!Number.isInteger(options.lingerMs) || options.lingerMs < 0 || options.lingerMs > 60_000) {
    throw new Error("--linger-ms must be an integer between 0 and 60000.");
  }
  if (!Number.isInteger(options.verifyTimeoutMs) || options.verifyTimeoutMs < 1 || options.verifyTimeoutMs > 600_000) {
    throw new Error("--verify-timeout-ms must be an integer between 1 and 600000.");
  }
  if ((options.command === "run" || options.command === "verify") && !options.email) {
    throw new Error("Set --email or NOTES_IMPORT_EMAIL to an owner or editor account.");
  }
  if ((options.command === "run" || options.command === "verify") && !process.env.NOTES_IMPORT_PASSWORD) {
    throw new Error("Set NOTES_IMPORT_PASSWORD. The password is never taken from the command line.");
  }
  return root;
}

/**
 * Converts every page in memory and reports what would be lost.
 *
 * Link targets do not exist yet at plan time, so this resolves them to a placeholder
 * mention purely to exercise the same code path a real run takes.
 */
async function planImport(index, limit) {
  const editor = await createImportEditor();
  const issues = new Map();
  const record = (code, detail, title) => {
    const key = `${code}:${detail}`;
    const entry = issues.get(key) ?? { count: 0, firstSeenIn: title };
    entry.count += 1;
    issues.set(key, entry);
  };

  let converted = 0;
  let blocks = 0;
  let failed = 0;
  for (const page of index.pages.slice(0, limit)) {
    try {
      const html = normalizeNotionHtml(readPageHtml(index.root, page), {
        onIssue: (code, detail) => record(code, detail, page.title),
        resolveHref: (href) => {
          const target = resolveLink(href, index, page.path, (code, detail) => record(code, detail, page.title));
          if (!target) return null;
          if (target.kind === "asset") return { type: "asset", url: `/api/attachments/planned` };
          return { type: "page", entityId: "00000000-0000-0000-0000-000000000000", label: target.title };
        },
      });
      blocks += (await htmlToBlocks(editor, html)).length;
      converted += 1;
      if (page.kind === "database") {
        await planTable(index, page, (code, detail) => record(code, detail, page.title));
      }
    } catch (error) {
      failed += 1;
      record("conversion_failed", error instanceof Error ? error.message : "unknown", page.title);
    }
  }
  return { converted, blocks, failed, issues };
}

function reportIssues(issues) {
  if (!issues.size) {
    console.log("No degradations: every construct in this export has a mapping.");
    return;
  }
  console.log("Degradations, by reason:");
  const sorted = [...issues.entries()].sort((left, right) => right[1].count - left[1].count);
  for (const [key, entry] of sorted) {
    console.log(`  ${key.padEnd(44)} ${String(entry.count).padStart(6)}  first in "${entry.firstSeenIn}"`);
  }
}

async function connect(options, root, { adoptRootParent = false } = {}) {
  const client = await createClient({
    baseURL: options.baseURL,
    email: options.email,
    password: process.env.NOTES_IMPORT_PASSWORD,
    requestsPerSecond: options.requestsPerSecond,
  });
  const manifest = createManifest({
    path: options.manifest,
    root,
    baseURL: client.baseURL,
    workspaceId: client.workspaceId,
    rootParentId: options.parent,
    adoptRootParent,
    adoptLegacyFingerprint: options.adoptLegacyFingerprint,
  });
  return { client, manifest };
}

const options = parseArguments(process.argv.slice(2));
const root = validate(options);

console.log(`Reading ${root}.`);
const index = readExport(root);

if (options.command === "inspect") {
  printSurvey(index, surveyExport(index));
} else if (options.command === "plan") {
  printSurvey(index, surveyExport(index));
  const planned = await planImport(index, options.limit);
  console.log(
    `Converted ${planned.converted} of ${index.pages.length} pages into ${planned.blocks} blocks` +
      (planned.failed ? `; ${planned.failed} failed.` : "."),
  );
  reportIssues(planned.issues);
  if (planned.failed) process.exitCode = 1;
} else if (options.command === "run") {
  const { client, manifest } = await connect(options, root);
  console.log(`Signed in to ${options.baseURL} as ${options.email} (${client.role}).`);
  const report = createReport({ verbose: options.verbose });
  let summary;
  try {
    summary = await runImport({
      index,
      client,
      manifest,
      report,
      rootParentId: options.parent,
      limit: options.limit,
      lingerMs: options.lingerMs,
      keepAmbiguousTable: options.keepAmbiguousTable,
    });
    report.print(summary);
  } finally {
    // The manifest is what makes a resume possible, so it is written even when the run
    // fails part way through.
    manifest.flush();
  }
  console.log("Running exact post-import verification.");
  const problems = await verifyImport({
    client,
    manifest,
    index,
    timeoutMs: options.verifyTimeoutMs,
  });
  if (summary.errors > 0 || problems > 0) process.exitCode = 1;
} else if (options.command === "verify") {
  if (!existsSync(options.manifest)) {
    throw new Error(
      `No manifest at ${options.manifest}. Run the import first, or pass --manifest <path> for the run you want to verify.`,
    );
  }
  // Verification is read-only, so a manifest imported with --parent is adopted as
  // recorded rather than requiring the flag to be repeated.
  const { client, manifest } = await connect(options, root, { adoptRootParent: true });
  const problems = await verifyImport({ client, manifest, index, timeoutMs: options.verifyTimeoutMs });
  if (problems > 0) process.exitCode = 1;
}
