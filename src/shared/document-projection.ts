export type ProseMirrorJson = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: ProseMirrorJson[];
};

export type ProjectedReference = {
  targetId: string;
  excerpt: string;
};

export type DocumentProjection = {
  plainText: string;
  pageReferences: ProjectedReference[];
  memberMentions: ProjectedReference[];
};

const MAX_PLAIN_TEXT = 500_000;
const EXCERPT_CHARS = 240;

function stringAttr(node: ProseMirrorJson, name: string) {
  const value = node.attrs?.[name];
  return typeof value === "string" ? value : null;
}

function referenceKey(entityType: string, entityId: string) {
  return `\u0000${entityType}:${entityId}\u0000`;
}

function excerptAround(text: string, marker: string) {
  const index = text.indexOf(marker);
  if (index < 0) return text.replace(/\u0000[^\u0000]+\u0000/g, " ").replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
  const withoutMarkers = text.replaceAll(marker, " ").replace(/\u0000[^\u0000]+\u0000/g, " ");
  const markerlessIndex = text.slice(0, index).replace(/\u0000[^\u0000]+\u0000/g, " ").length;
  const start = Math.max(0, markerlessIndex - Math.floor(EXCERPT_CHARS / 2));
  return withoutMarkers.slice(start, start + EXCERPT_CHARS).replace(/\s+/g, " ").trim();
}

export function projectDocument(root: ProseMirrorJson): DocumentProjection {
  const parts: string[] = [];
  const pageIds = new Set<string>();
  const userIds = new Set<string>();

  const visit = (node: ProseMirrorJson) => {
    if (typeof node.text === "string") parts.push(node.text);

    if (node.type === "mention") {
      const entityType = stringAttr(node, "entityType");
      const entityId = stringAttr(node, "entityId");
      const label = stringAttr(node, "label") ?? "Mention";
      if (entityType && entityId) {
        parts.push(referenceKey(entityType, entityId), label, " ");
        if (entityType === "page") pageIds.add(entityId);
        if (entityType === "user") userIds.add(entityId);
      }
    }

    for (const child of node.content ?? []) visit(child);
    if (node.type && !["text", "mention"].includes(node.type)) parts.push(" ");
  };

  visit(root);
  const markedText = parts.join("");
  const plainText = markedText
    .replace(/\u0000[^\u0000]+\u0000/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PLAIN_TEXT);
  return {
    plainText,
    pageReferences: [...pageIds].map((targetId) => ({
      targetId,
      excerpt: excerptAround(markedText, referenceKey("page", targetId)),
    })),
    memberMentions: [...userIds].map((targetId) => ({
      targetId,
      excerpt: excerptAround(markedText, referenceKey("user", targetId)),
    })),
  };
}
