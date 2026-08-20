/**
 * Local record of what an import has already created.
 *
 * The server has no notion of "this page came from Notion", and giving it one would mean
 * a schema change for a one-off operation. The mapping lives here instead, and the parts
 * the importer needs to resume - page ids and uploaded attachment ids - are recorded in
 * this file. Live page existence is checked separately by the verify command.
 *
 * Content needs no reconciliation at all: pushing a page that already holds the same
 * blocks produces no Yjs updates, so a retry is free and provably a no-op.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walkExport } from "./export-tree.mjs";

const MANIFEST_VERSION = 2;
const SAVE_DEBOUNCE_MS = 500;
const HASH_BUFFER_BYTES = 1024 * 1024;

function hashFile(hash, path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile()) throw new Error(`Refusing to import non-regular file ${path}.`);
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    for (let bytes = readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0;) {
      hash.update(buffer.subarray(0, bytes));
      bytes = readSync(descriptor, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function hashFileContent(path) {
  const hash = createHash("sha256");
  hashFile(hash, path);
  return hash.digest("hex");
}

/**
 * Identifies the export a manifest belongs to.
 *
 * Resuming against a re-downloaded or edited export would map Notion ids onto pages that
 * no longer correspond to them, so a mismatch is refused rather than reconciled. The
 * fingerprint is derived from per-file digests so each file is read exactly once; the
 * digests are returned for the upload pass to reuse instead of re-hashing every asset.
 */
export function fingerprintExport(root) {
  const { files } = walkExport(root);
  const digests = new Map();
  const hash = createHash("sha256");
  for (const path of files) {
    const digest = hashFileContent(join(root, path));
    digests.set(path, digest);
    hash.update(path);
    hash.update("\0");
    hash.update(digest);
    hash.update("\0");
  }
  return { fingerprint: hash.digest("hex"), digests };
}

export function createManifest({ path, root, baseURL, workspaceId, rootParentId, adoptRootParent = false }) {
  const { fingerprint, digests } = fingerprintExport(root);
  let state;

  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${path} is not readable as a manifest: ${detail}. Move it aside to start over.`, { cause });
    }
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !state.nodes ||
      typeof state.nodes !== "object" ||
      Array.isArray(state.nodes)
    ) {
      throw new Error(`${path} does not contain a valid manifest. Move it aside to start over.`);
    }
    if (state.version !== MANIFEST_VERSION) {
      const detail = state.version === 1 ? "Version 1 did not hash file contents and cannot be resumed safely." : "";
      throw new Error(
        `${path} was written by a different version of the importer. ${detail} Move it aside to start over.`.replace(
          "  ",
          " ",
        ),
      );
    }
    if (!/^[0-9a-f]{32}$/.test(state.importId ?? "")) {
      throw new Error(`${path} does not contain a valid version 2 import id. Move it aside to start over.`);
    }
    if (state.exportFingerprint !== fingerprint) {
      throw new Error(
        `${path} belongs to a different copy of this export. Move it aside to start over, ` +
          "or point the importer at the directory it was created from.",
      );
    }
    if (state.baseURL !== baseURL) {
      throw new Error(`${path} was created against ${state.baseURL}, not ${baseURL}.`);
    }
    if (state.workspaceId !== workspaceId) {
      throw new Error(`${path} was created against a different workspace. Move it aside to start over.`);
    }
    // A read-only command (verify) adopts the recorded parent rather than demanding
    // the flag be repeated; a run must still match, or resuming would re-root the tree.
    if (!(adoptRootParent && (rootParentId ?? null) === null) && state.rootParentId !== (rootParentId ?? null)) {
      throw new Error(`${path} was created with a different --parent. Move it aside to start over.`);
    }
  } else {
    // Each run owns a fresh idempotency namespace. Reusing ids for a new manifest of
    // the same export would accidentally replay resources from an earlier import.
    const importId = randomBytes(16).toString("hex");
    state = {
      version: MANIFEST_VERSION,
      importId,
      startedAt: Date.now(),
      baseURL,
      workspaceId,
      exportRoot: root,
      exportFingerprint: fingerprint,
      rootParentId: rootParentId ?? null,
      nodes: {},
    };
  }

  let pending = null;

  function flush() {
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    state.updatedAt = Date.now();
    // Written to a sibling then renamed, which is atomic on POSIX, so a kill during a
    // save cannot leave a truncated manifest behind.
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }

  function save() {
    if (pending) return;
    pending = setTimeout(flush, SAVE_DEBOUNCE_MS);
    pending.unref?.();
  }

  return {
    state,
    /** SHA-256 of one export file, from the fingerprint pass, keyed by relative path. */
    contentSha256(relativePath) {
      return digests.get(relativePath) ?? null;
    },
    node(notionKey) {
      return state.nodes[notionKey] ?? null;
    },
    record(notionKey, patch) {
      state.nodes[notionKey] = { ...state.nodes[notionKey], ...patch };
      save();
    },
    recordNow(notionKey, patch) {
      state.nodes[notionKey] = { ...state.nodes[notionKey], ...patch };
      flush();
    },
    flush,
  };
}
