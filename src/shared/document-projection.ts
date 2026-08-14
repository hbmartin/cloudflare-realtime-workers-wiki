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

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function excerptAround(text: string, offset: number) {
  const start = Math.max(0, offset - Math.floor(EXCERPT_CHARS / 2));
  return normalizeText(text.slice(start, start + EXCERPT_CHARS * 2)).slice(0, EXCERPT_CHARS);
}

export function projectDocument(root: ProseMirrorJson): DocumentProjection {
  const parts: string[] = [];
  const pageOffsets = new Map<string, number>();
  const userOffsets = new Map<string, number>();
  let textLength = 0;

  const append = (text: string) => {
    parts.push(text);
    textLength += text.length;
  };

  const visit = (node: ProseMirrorJson) => {
    if (typeof node.text === "string") append(node.text);

    if (node.type === "mention") {
      const entityType = stringAttr(node, "entityType");
      const entityId = stringAttr(node, "entityId");
      const label = stringAttr(node, "label");
      if (entityId && label && (entityType === "page" || entityType === "user")) {
        const offsets = entityType === "page" ? pageOffsets : userOffsets;
        if (!offsets.has(entityId)) offsets.set(entityId, textLength);
        append(label);
        append(" ");
      }
    }

    for (const child of node.content ?? []) visit(child);
    if (node.type && !["text", "mention"].includes(node.type)) append(" ");
  };

  visit(root);
  const text = parts.join("");
  const plainText = normalizeText(text).slice(0, MAX_PLAIN_TEXT);
  return {
    plainText,
    pageReferences: [...pageOffsets].map(([targetId, offset]) => ({
      targetId,
      excerpt: excerptAround(text, offset),
    })),
    memberMentions: [...userOffsets].map(([targetId, offset]) => ({
      targetId,
      excerpt: excerptAround(text, offset),
    })),
  };
}
