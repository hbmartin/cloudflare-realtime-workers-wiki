import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";
import { serializeDocument, type ProseMirrorJson } from "../shared/document-projection";
import { loadOfflineCopy } from "./collaboration";
import { pendingKeysOf, type OfflinePage } from "./offline-catalog";

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
  const doc = await loadOfflineCopy(key);
  try {
    downloadOfflineMarkdown(offlineCopyMarkdown(doc, title), `${title}-${suffix}.md`);
  } finally {
    doc.destroy();
  }
}

export async function exportPendingOfflinePages(pages: OfflinePage[]) {
  const sections: string[] = [];
  for (const page of pages) {
    const keys = pendingKeysOf(page);
    for (const key of keys) {
      if (!key) throw new Error(`The local copy of ${page.title} is unavailable.`);
      const doc = await loadOfflineCopy(key);
      try {
        const epoch = Number(key.split(":").at(-2));
        sections.push(
          `<!-- Offline document ${page.pageId}, epoch ${epoch} -->\n${offlineCopyMarkdown(doc, page.title)}`,
        );
      } finally {
        doc.destroy();
      }
    }
  }
  downloadOfflineMarkdown(
    sections.join("\n\n---\n\n"),
    `noteflare-offline-copies-${new Date().toISOString().slice(0, 10)}.md`,
  );
}
