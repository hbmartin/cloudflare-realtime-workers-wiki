/** Exact, read-only verification of a completed import against its local export. */
import { setTimeout as delay } from "node:timers/promises";
import { PAGE_TITLE_MAX } from "../../src/shared/validation.ts";
import { projectDocument } from "../../src/shared/document-projection.ts";
import { documentProjectionHash, tableContentHash } from "../../src/shared/import-integrity.ts";
import { createImportEditor } from "./blocks.mjs";
import { documentJsonForBlocks } from "./document-push.mjs";
import {
  assetUrlsFor,
  canonicalSourceTable,
  convertDocument,
  deterministicResourceId,
  preflightTable,
} from "./run.mjs";

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export async function expectedDocumentProjectionHash({ index, page, manifest, included, editor, assets }) {
  const blocks = await convertDocument({
    index,
    page,
    manifest,
    included,
    editor,
    report: { issue() {}, error() {} },
    assetUrls: assets,
  });
  return documentProjectionHash(projectDocument(await documentJsonForBlocks(editor, blocks)));
}

function expectedPageMetadata(node, sourcePage, manifest) {
  return {
    ...(node.expectedPage ?? {
      id: deterministicResourceId(manifest.state.importId, "page", sourcePage.path),
      kind: sourcePage.kind === "database" ? "table" : "document",
      title: sourcePage.title.slice(0, PAGE_TITLE_MAX).trim() || "Untitled",
      parentId: sourcePage.parent
        ? (manifest.node(sourcePage.parent.path)?.pageId ?? null)
        : manifest.state.rootParentId,
    }),
    workspaceId: manifest.state.workspaceId,
  };
}

function assertPageMetadata(page, expected) {
  if (expected.id && page.id !== expected.id) throw new Error(`Expected deterministic page id ${expected.id}.`);
  if (expected.workspaceId && page.workspaceId !== expected.workspaceId) {
    throw new Error("The page belongs to a different workspace.");
  }
  if (page.kind !== expected.kind) throw new Error(`Expected kind ${expected.kind}, found ${page.kind}.`);
  const title = expected.acceptedRemoteTitle ?? expected.title;
  const parentId = Object.hasOwn(expected, "acceptedRemoteParentId")
    ? expected.acceptedRemoteParentId
    : expected.parentId;
  if (page.title !== title) throw new Error(`The live title is ${JSON.stringify(page.title)}.`);
  if ((page.parentId ?? null) !== (parentId ?? null))
    throw new Error("The live parent does not match the accepted tree.");
}

async function verifyAttachments(client, node, sourcePage) {
  const remote = new Map((await client.listAttachments(node.pageId)).map((attachment) => [attachment.id, attachment]));
  for (const assetPath of sourcePage.assets) {
    const imported = node.assets?.[assetPath];
    if (imported?.status === "skipped-unsafe") continue;
    if (!imported?.id || !imported.contentSha256) throw new Error(`Attachment ${assetPath} was not completed.`);
    const actual = remote.get(imported.id);
    if (!actual) throw new Error(`Attachment ${assetPath} is missing remotely.`);
    const expected = imported.acceptedRemote ?? imported;
    if (
      actual.contentSha256 !== expected.contentSha256 ||
      actual.size !== expected.size ||
      actual.name !== expected.name ||
      actual.mime !== expected.mime
    ) {
      throw new Error(`Attachment ${assetPath} metadata or content hash differs from the accepted value.`);
    }
  }
}

export async function verifyImport({ client, manifest, index, timeoutMs = 120_000, pollIntervalMs = 1_000 }) {
  const expectedPaths = manifest.state.selectedPaths ?? index.pages.map((page) => page.path);
  const expectedSet = new Set(expectedPaths);
  const pagesByPath = new Map(index.pages.map((page) => [page.path, page]));
  const included = new Set(expectedPaths.flatMap((path) => (pagesByPath.has(path) ? [pagesByPath.get(path)] : [])));
  const assets = assetUrlsFor(included, manifest);
  const editor = await createImportEditor();
  const problems = [];
  const pendingDocuments = [];
  let checked = 0;

  // First sweep checks every facet once. Only projection lag is retried; missing
  // resources, metadata drift, table mismatches, and attachment mismatches are final.
  for (const key of expectedPaths) {
    const node = manifest.node(key);
    try {
      const sourcePage = pagesByPath.get(key);
      if (!sourcePage) throw new Error("The source page is missing from the export index.");
      if (!node?.pageId) throw new Error("The page was never created.");
      await verifyAttachments(client, node, sourcePage);
      const expectedPage = expectedPageMetadata(node, sourcePage, manifest);

      if (sourcePage.kind === "database") {
        if (node.table?.phase !== "complete") throw new Error("The table import is not marked complete.");
        const canonical = canonicalSourceTable(preflightTable(index, sourcePage));
        const localHash = await tableContentHash(canonical.columns, canonical.rows);
        if (node.table.contentHash && node.table.contentHash !== localHash) {
          throw new Error("The saved table hash does not match the local CSV.");
        }
        const expectedHash = node.table.acceptedRemoteHash ?? localHash;
        const verification = await client.tableVerification(node.pageId);
        if (verification.contentHash !== expectedHash) {
          throw new Error(`The live table content hash differs from the accepted value (${verification.contentHash}).`);
        }
        const expectedRows = node.table.acceptedRemoteHash ? node.table.acceptedRemoteRowCount : canonical.rows.length;
        if (verification.rowCount !== expectedRows) {
          throw new Error(`Expected ${expectedRows} table rows, found ${verification.rowCount}.`);
        }
        assertPageMetadata((await client.pageVerification(node.pageId)).page, expectedPage);
        checked += 1;
      } else {
        const status = node.content?.status ?? node.content;
        const acceptedDestination = status === "destination-owned" && node.content?.acceptedRemoteHash;
        if (status !== "written" && status !== "unchanged" && !acceptedDestination) {
          throw new Error(`Document content status is ${status ?? "missing"}.`);
        }
        const localHash = await expectedDocumentProjectionHash({
          index,
          page: sourcePage,
          manifest,
          included,
          editor,
          assets,
        });
        if (node.content?.projectionHash && node.content.projectionHash !== localHash) {
          throw new Error("The saved document hash does not match the local export conversion.");
        }
        const expectedHash = node.content?.acceptedRemoteHash ?? localHash;
        const verification = await client.pageVerification(node.pageId);
        assertPageMetadata(verification.page, expectedPage);
        if (verification.projectionHash === expectedHash) checked += 1;
        else pendingDocuments.push({ key, node, expectedHash, expectedPage, lastHash: verification.projectionHash });
      }
    } catch (error) {
      problems.push(`${node?.title ?? key}: ${errorMessage(error)}`);
    }
  }

  // Compaction/indexing is asynchronous. Give all mismatching documents one shared
  // timeout starting after the first sweep, rather than spending the budget serially.
  const deadline = Date.now() + timeoutMs;
  let pending = pendingDocuments;
  while (pending.length && Date.now() < deadline) {
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    const next = [];
    for (const item of pending) {
      try {
        const verification = await client.pageVerification(item.node.pageId);
        assertPageMetadata(verification.page, item.expectedPage);
        if (verification.projectionHash === item.expectedHash) checked += 1;
        else next.push({ ...item, lastHash: verification.projectionHash });
      } catch (error) {
        problems.push(`${item.node.title ?? item.key}: ${errorMessage(error)}`);
      }
    }
    pending = next;
  }
  for (const item of pending) {
    problems.push(
      `${item.node.title ?? item.key}: Timed out waiting for exact document projection ` +
        `(expected ${item.expectedHash}, found ${item.lastHash}).`,
    );
  }

  const extra = Object.keys(manifest.state.nodes).filter((path) => !expectedSet.has(path));
  if (extra.length) problems.push(`The manifest contains ${extra.length} page(s) outside its saved selection.`);
  if (new Set(expectedPaths).size !== expectedPaths.length)
    problems.push("The manifest selection contains duplicate paths.");
  console.log(`Exactly checked ${checked} of ${expectedPaths.length} imported pages against ${client.baseURL}.`);
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length === 0) console.log("No problems found.");
  return problems.length;
}
