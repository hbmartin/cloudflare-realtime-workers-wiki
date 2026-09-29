import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { serializeDocument, type ProseMirrorJson } from "../shared/document-projection";
import { loadOfflineCopy } from "./collaboration";
import type { OfflinePage } from "./offline-catalog";

export async function exportPendingOfflinePages(pages: OfflinePage[]) {
  const sections: string[] = [];
  for (const page of pages) {
    const key = page.storageKeys.at(-1);
    if (!key) throw new Error(`The local copy of ${page.title} is unavailable.`);
    const doc = await loadOfflineCopy(key);
    try {
      const projection = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("document-store")) as ProseMirrorJson;
      sections.push(
        `<!-- Offline document ${page.pageId}, epoch ${page.epoch} -->\n# ${page.title.replaceAll("\n", " ")}\n\n${serializeDocument(projection).markdown}`,
      );
    } finally {
      doc.destroy();
    }
  }
  const url = URL.createObjectURL(new Blob([sections.join("\n\n---\n\n")], { type: "text/markdown; charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `noteflare-offline-copies-${new Date().toISOString().slice(0, 10)}.md`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
