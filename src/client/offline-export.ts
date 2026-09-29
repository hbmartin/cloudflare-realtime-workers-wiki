import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";
import { serializeDocument, type ProseMirrorJson } from "../shared/document-projection";
import { loadOfflineCopy } from "./collaboration";
import { pendingKeysOf, storageEpoch, type OfflinePage } from "./offline-catalog";

export function offlineCopyMarkdown(doc: Y.Doc, title: string) {
  const projection = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("document-store")) as ProseMirrorJson;
  return `# ${title.replaceAll("\n", " ")}\n\n${serializeDocument(projection).markdown}`;
}

export function downloadOfflineMarkdown(markdown: string, filename: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown; charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replaceAll(/[\\/:*?"<>|]/g, "-");
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportOfflineCopyMarkdown(key: string, title: string, suffix: string) {
  downloadOfflineMarkdown(await offlineCopyMarkdownFromKey(key, title), `${title}-${suffix}.md`);
}

export async function offlineCopyMarkdownFromKey(key: string, title: string) {
  const doc = await loadOfflineCopy(key);
  try {
    return offlineCopyMarkdown(doc, title);
  } finally {
    doc.destroy();
  }
}

export async function exportPendingOfflinePages(pages: OfflinePage[], bestEffort = false) {
  const sections: string[] = [];
  let failed = 0;
  for (const page of pages) {
    const keys = pendingKeysOf(page);
    for (const key of keys) {
      if (!key) throw new Error(`The local copy of ${page.title} is unavailable.`);
      try {
        const doc = await loadOfflineCopy(key);
        try {
          const epoch = storageEpoch(key);
          sections.push(
            `<!-- Offline document ${page.pageId}, epoch ${epoch} -->\n${offlineCopyMarkdown(doc, page.title)}`,
          );
        } finally {
          doc.destroy();
        }
      } catch (error) {
        if (!bestEffort) throw error;
        failed += 1;
        console.error("Offline copy could not be exported", error);
      }
    }
  }
  if (!sections.length) throw new Error("No readable offline copy is available to export.");
  downloadOfflineMarkdown(
    sections.join("\n\n---\n\n"),
    `noteflare-offline-copies-${new Date().toISOString().slice(0, 10)}.md`,
  );
  return { exported: sections.length, failed };
}
