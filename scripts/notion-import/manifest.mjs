/**
 * Local record of what an import has already created.
 *
 * The server has no notion of "this page came from Notion", and giving it one would mean
 * a schema change for a one-off operation. The mapping lives here instead, and the parts
 * the server can confirm cheaply - which pages still exist, which attachments a page
 * already has - are re-read from it on a resume rather than trusted from this file.
 *
 * Content needs no reconciliation at all: pushing a page that already holds the same
 * blocks produces no Yjs updates, so a retry is free and provably a no-op.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walkExport } from "./export-tree.mjs";

const MANIFEST_VERSION = 1;
const SAVE_DEBOUNCE_MS = 500;

/**
 * Identifies the export a manifest belongs to.
 *
 * Resuming against a re-downloaded or edited export would map Notion ids onto pages that
 * no longer correspond to them, so a mismatch is refused rather than reconciled.
 */
export function fingerprintExport(root) {
  const { files } = walkExport(root);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update("\0");
    hash.update(String(statSync(join(root, path)).size));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function createManifest({ path, root, baseURL, workspaceId, rootParentId }) {
  const fingerprint = fingerprintExport(root);
  let state;

  if (existsSync(path)) {
    state = JSON.parse(readFileSync(path, "utf8"));
    if (state.version !== MANIFEST_VERSION) {
      throw new Error(`${path} was written by a different version of the importer. Move it aside to start over.`);
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
  } else {
    state = {
      version: MANIFEST_VERSION,
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
    node(notionKey) {
      return state.nodes[notionKey] ?? null;
    },
    record(notionKey, patch) {
      state.nodes[notionKey] = { ...state.nodes[notionKey], ...patch };
      save();
    },
    flush,
  };
}
