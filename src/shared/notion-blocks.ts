import type { ProseMirrorJson } from "./types";

export const NOTION_VERSION = "2026-03-11";
export const NOTION_PAGE_SIZE_MAX = 100;
const NOTION_RICH_TEXT_MAX = 100;
const NOTION_TEXT_MAX = 2_000;

export type NotionRichText = Record<string, unknown>;
export type NotionBlock = {
  id: string;
  internalId: string;
  type: string;
  node: ProseMirrorJson;
  children: NotionBlock[];
};

type BlockRegistryEntry = {
  notionType: string;
  richText: boolean;
  writable: boolean;
};

export const notionBlockRegistry = {
  paragraph: { notionType: "paragraph", richText: true, writable: true },
  heading: { notionType: "heading", richText: true, writable: false },
  bulletListItem: { notionType: "bulleted_list_item", richText: true, writable: true },
  numberedListItem: { notionType: "numbered_list_item", richText: true, writable: true },
  checkListItem: { notionType: "to_do", richText: true, writable: true },
  toggleListItem: { notionType: "toggle", richText: true, writable: true },
  quote: { notionType: "quote", richText: true, writable: true },
  codeBlock: { notionType: "code", richText: true, writable: true },
  divider: { notionType: "divider", richText: false, writable: true },
  callout: { notionType: "callout", richText: true, writable: true },
  math: { notionType: "equation", richText: false, writable: true },
  mermaid: { notionType: "code", richText: false, writable: true },
  table: { notionType: "table", richText: false, writable: true },
  tableRow: { notionType: "table_row", richText: false, writable: true },
  tableOfContents: { notionType: "table_of_contents", richText: false, writable: true },
  columnList: { notionType: "column_list", richText: false, writable: true },
  column: { notionType: "column", richText: false, writable: true },
  syncedBlockSource: { notionType: "synced_block", richText: false, writable: true },
  syncedBlockReference: { notionType: "synced_block", richText: false, writable: true },
  breadcrumb: { notionType: "breadcrumb", richText: false, writable: true },
  linkToPage: { notionType: "link_to_page", richText: false, writable: true },
  linkedDiagram: { notionType: "link_to_page", richText: false, writable: true },
  bookmark: { notionType: "bookmark", richText: false, writable: true },
  embed: { notionType: "embed", richText: false, writable: true },
  image: { notionType: "image", richText: false, writable: true },
  video: { notionType: "video", richText: false, writable: true },
  audio: { notionType: "audio", richText: false, writable: true },
  file: { notionType: "file", richText: false, writable: true },
  pdf: { notionType: "pdf", richText: false, writable: true },
} as const satisfies Record<string, BlockRegistryEntry>;

const NOTION_WRITABLE_BLOCK_TYPES = new Set([
  ...Object.values(notionBlockRegistry)
    .filter((entry) => entry.writable)
    .map((entry) => entry.notionType),
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
]);

const DEFAULT_BLOCK_ATTRS = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
};

const NOTION_COLORS = new Set([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
]);

const CALLOUT_TONE_TO_COLOR = { info: "blue", success: "green", warning: "yellow", danger: "red" } as const;
const NOTION_COLOR_TO_TONE = { blue: "info", green: "success", yellow: "warning", red: "danger" } as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function string(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function attrs(node: ProseMirrorJson) {
  return node.attrs ?? {};
}

function childGroup(container: ProseMirrorJson) {
  return container.content?.find((child) => child.type === "blockGroup");
}

function contentNode(container: ProseMirrorJson) {
  return container.content?.find((child) => child.type !== "blockGroup");
}

export function documentBlocks(root: ProseMirrorJson): NotionBlock[] {
  const group = root.type === "blockGroup" ? root : root.content?.find((child) => child.type === "blockGroup");
  if (!group) return [];
  const visit = (container: ProseMirrorJson): NotionBlock | null => {
    if (container.type !== "blockContainer") return null;
    const node = contentNode(container);
    const id = string(container.attrs?.id);
    if (!node || !id) return null;
    return {
      id,
      internalId: id,
      type: node.type ?? "unsupported",
      node,
      children: (childGroup(container)?.content ?? []).map(visit).filter((item): item is NotionBlock => Boolean(item)),
    };
  };
  return (group.content ?? []).map(visit).filter((item): item is NotionBlock => Boolean(item));
}

export function flattenDocumentBlocks(root: ProseMirrorJson) {
  const output: NotionBlock[] = [];
  const visit = (blocks: NotionBlock[]) => {
    for (const block of blocks) {
      output.push(block);
      visit(block.children);
    }
  };
  visit(documentBlocks(root));
  return output;
}

export function findDocumentBlock(root: ProseMirrorJson, id: string) {
  return flattenDocumentBlocks(root).find((block) => block.internalId === id) ?? null;
}

function notionAnnotations(node: ProseMirrorJson) {
  const names = new Set((node.marks ?? []).map((itemMark) => itemMark.type));
  const colorMark = (node.marks ?? []).find(
    (itemMark) => itemMark.type === "textColor" || itemMark.type === "backgroundColor",
  );
  const markColor = string(colorMark?.attrs?.stringValue, "default");
  return {
    bold: names.has("bold"),
    italic: names.has("italic"),
    strikethrough: names.has("strike"),
    underline: names.has("underline"),
    code: names.has("code"),
    color: colorMark?.type === "backgroundColor" && markColor !== "default" ? `${markColor}_background` : markColor,
  };
}

export function proseMirrorInlineToNotion(nodes: ProseMirrorJson[] = []): NotionRichText[] {
  const output: NotionRichText[] = [];
  for (const node of nodes) {
    if (typeof node.text === "string") {
      const link = (node.marks ?? []).find((itemMark) => itemMark.type === "link");
      output.push({
        type: "text",
        text: {
          content: node.text,
          link: typeof link?.attrs?.href === "string" ? { url: link.attrs.href } : null,
        },
        annotations: notionAnnotations(node),
        plain_text: node.text,
        href: typeof link?.attrs?.href === "string" ? link.attrs.href : null,
      });
      continue;
    }
    if (node.type === "mention") {
      const entityType = string(node.attrs?.entityType);
      const entityId = string(node.attrs?.entityId);
      const label = string(node.attrs?.label, "Mention");
      const type = entityType === "user" ? "user" : "page";
      output.push({
        type: "mention",
        mention: { type, [type]: { id: entityId } },
        annotations: notionAnnotations(node),
        plain_text: label,
        href: null,
      });
      continue;
    }
    if (node.type === "inlineMath") {
      const expression = string(node.attrs?.formula);
      output.push({
        type: "equation",
        equation: { expression },
        annotations: notionAnnotations(node),
        plain_text: expression,
        href: null,
      });
    }
  }
  return output.slice(0, NOTION_RICH_TEXT_MAX);
}

function pmMark(type: string, markAttrs?: Record<string, unknown>) {
  return { type, ...(markAttrs ? { attrs: markAttrs } : {}) };
}

export function notionRichTextToProseMirror(value: unknown): ProseMirrorJson[] {
  if (!Array.isArray(value) || value.length > NOTION_RICH_TEXT_MAX)
    throw new Error("rich_text must be an array of at most 100 items.");
  const output: ProseMirrorJson[] = [];
  for (const raw of value) {
    const item = record(raw);
    const annotations = record(item.annotations);
    const marks: NonNullable<ProseMirrorJson["marks"]> = [];
    if (annotations.bold === true) marks.push(pmMark("bold"));
    if (annotations.italic === true) marks.push(pmMark("italic"));
    if (annotations.strikethrough === true) marks.push(pmMark("strike"));
    if (annotations.underline === true) marks.push(pmMark("underline"));
    if (annotations.code === true) marks.push(pmMark("code"));
    const color = string(annotations.color, "default");
    const baseColor = color.endsWith("_background") ? color.slice(0, -11) : color;
    if (!NOTION_COLORS.has(baseColor)) throw new Error("Rich text color is unsupported.");
    if (color.endsWith("_background")) marks.push(pmMark("backgroundColor", { stringValue: color.slice(0, -11) }));
    else if (color !== "default") marks.push(pmMark("textColor", { stringValue: color }));
    if (item.type === "text" || "text" in item) {
      const text = record(item.text);
      const content = string(text.content);
      if (content.length > NOTION_TEXT_MAX) throw new Error("Rich text content exceeds 2000 characters.");
      const link = record(text.link).url;
      if (typeof link === "string" && link) marks.push(pmMark("link", { href: link }));
      if (content) output.push({ type: "text", text: content, ...(marks.length ? { marks } : {}) });
      continue;
    }
    if (item.type === "mention" || "mention" in item) {
      const mention = record(item.mention);
      const entityType = mention.type === "user" ? "user" : "page";
      const entity = record(mention[entityType]);
      const entityId = string(entity.id);
      if (!entityId) throw new Error("Mention id is required.");
      output.push({
        type: "mention",
        attrs: { entityType, entityId, label: string(item.plain_text, entityType === "user" ? "User" : "Page") },
        ...(marks.length ? { marks } : {}),
      });
      continue;
    }
    if (item.type === "equation" || "equation" in item) {
      const expression = string(record(item.equation).expression);
      if (expression.length > 1_000) throw new Error("Equation exceeds 1000 characters.");
      output.push({ type: "inlineMath", attrs: { formula: expression }, ...(marks.length ? { marks } : {}) });
      continue;
    }
    throw new Error("Unsupported rich text item.");
  }
  return output;
}

function nodeRichText(node: ProseMirrorJson) {
  return proseMirrorInlineToNotion(node.content ?? []);
}

function mediaPayload(node: ProseMirrorJson) {
  const url = string(attrs(node).url);
  const caption = string(attrs(node).caption);
  return {
    type: "external",
    external: { url },
    caption: caption ? [{ type: "text", text: { content: caption }, plain_text: caption }] : [],
  };
}

export function notionPayloadForBlock(block: NotionBlock): { type: string; payload: Record<string, unknown> } {
  const node = block.node;
  const type = node.type ?? "unsupported";
  const properties = attrs(node);
  if (type === "heading") {
    const level = Number(properties.level ?? 1);
    if (level < 1 || level > 4) return { type: "unsupported", payload: {} };
    const notionType = `heading_${level}`;
    return {
      type: notionType,
      payload: {
        rich_text: nodeRichText(node),
        is_toggleable: properties.isToggleable === true,
        color: string(properties.textColor, "default"),
      },
    };
  }
  if (type === "paragraph")
    return {
      type: "paragraph",
      payload: { rich_text: nodeRichText(node), color: string(properties.textColor, "default") },
    };
  if (type === "bulletListItem")
    return {
      type: "bulleted_list_item",
      payload: { rich_text: nodeRichText(node), color: string(properties.textColor, "default") },
    };
  if (type === "numberedListItem")
    return {
      type: "numbered_list_item",
      payload: { rich_text: nodeRichText(node), color: string(properties.textColor, "default") },
    };
  if (type === "checkListItem")
    return {
      type: "to_do",
      payload: {
        rich_text: nodeRichText(node),
        checked: properties.checked === true,
        color: string(properties.textColor, "default"),
      },
    };
  if (type === "toggleListItem")
    return {
      type: "toggle",
      payload: { rich_text: nodeRichText(node), color: string(properties.textColor, "default") },
    };
  if (type === "quote")
    return {
      type: "quote",
      payload: { rich_text: nodeRichText(node), color: string(properties.textColor, "default") },
    };
  if (type === "codeBlock")
    return {
      type: "code",
      payload: { rich_text: nodeRichText(node), language: string(properties.language, "plain text"), caption: [] },
    };
  if (type === "mermaid") {
    const source = string(properties.source);
    return {
      type: "code",
      payload: {
        rich_text: [{ type: "text", text: { content: source }, plain_text: source }],
        language: "mermaid",
        caption: [],
      },
    };
  }
  if (type === "divider") return { type: "divider", payload: {} };
  if (type === "callout")
    return {
      type: "callout",
      payload: {
        rich_text: nodeRichText(node),
        icon: { type: "emoji", emoji: string(properties.icon, "💡") },
        color: CALLOUT_TONE_TO_COLOR[string(properties.tone, "info") as keyof typeof CALLOUT_TONE_TO_COLOR] ?? "blue",
      },
    };
  if (type === "math") return { type: "equation", payload: { expression: string(properties.formula) } };
  if (type === "tableOfContents")
    return { type: "table_of_contents", payload: { color: string(properties.color, "default") } };
  if (type === "columnList") return { type: "column_list", payload: {} };
  if (type === "column") return { type: "column", payload: {} };
  if (type === "syncedBlockSource") return { type: "synced_block", payload: { synced_from: null } };
  if (type === "syncedBlockReference")
    return {
      type: "synced_block",
      payload: { synced_from: { type: "block_id", block_id: string(properties.blockId) } },
    };
  if (type === "breadcrumb") return { type: "breadcrumb", payload: {} };
  if (type === "linkToPage")
    return { type: "link_to_page", payload: { type: "page_id", page_id: string(properties.pageId) } };
  if (type === "linkedDiagram")
    return { type: "link_to_page", payload: { type: "page_id", page_id: string(properties.pageId) } };
  if (type === "bookmark") return { type: "bookmark", payload: { url: string(properties.url), caption: [] } };
  if (type === "embed") return { type: "embed", payload: { url: string(properties.url) } };
  if (["image", "video", "audio", "file", "pdf"].includes(type)) return { type, payload: mediaPayload(node) };
  if (type === "table") {
    const rows = block.children.map((child) => child.node).filter((row) => row.type === "tableRow");
    const width = Math.max(1, ...rows.map((row) => row.content?.length ?? 0));
    const hasColumnHeader = Boolean(
      rows[0]?.content?.length && rows[0].content.every((cell) => cell.type === "tableHeader"),
    );
    const hasRowHeader = Boolean(rows.length && rows.every((row) => row.content?.[0]?.type === "tableHeader"));
    return {
      type: "table",
      payload: {
        table_width: width,
        has_column_header: hasColumnHeader,
        has_row_header: hasRowHeader,
      },
    };
  }
  if (type === "tableRow") {
    return {
      type: "table_row",
      payload: { cells: (node.content ?? []).map((cell) => proseMirrorInlineToNotion(cell.content ?? [])) },
    };
  }
  return { type: "unsupported", payload: {} };
}

function notionMediaUrl(payload: Record<string, unknown>) {
  const type = string(payload.type, "external");
  const source = record(payload[type]);
  return validatedExternalUrl(string(source.url), "Media");
}

function validatedExternalUrl(value: string, label: string) {
  if (!value || value.length > 2_000) throw new Error(`${label} URL is required and must be at most 2000 characters.`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.href;
  } catch {
    throw new Error(`${label} URL must be an HTTP or HTTPS URL.`);
  }
}

function validatedEmbedUrl(value: string) {
  const href = validatedExternalUrl(value, "Embed");
  const hostname = new URL(href).hostname.toLowerCase();
  if (
    ![
      "youtu.be",
      "youtube.com",
      "www.youtube.com",
      "vimeo.com",
      "www.vimeo.com",
      "figma.com",
      "www.figma.com",
    ].includes(hostname)
  ) {
    throw new Error("Embeds are limited to YouTube, Vimeo, and Figma URLs.");
  }
  return href;
}

function notionPlainText(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value
    .map((raw) => {
      const item = record(raw);
      if (typeof item.plain_text === "string") return item.plain_text;
      return string(record(item.text).content) || string(record(item.equation).expression);
    })
    .join("");
}

function blockNode(type: string, payload: Record<string, unknown>): ProseMirrorJson {
  const rich = () => notionRichTextToProseMirror(payload.rich_text ?? []);
  if (/^heading_[1-4]$/.test(type))
    return {
      type: "heading",
      attrs: { ...DEFAULT_BLOCK_ATTRS, level: Number(type.slice(-1)), isToggleable: payload.is_toggleable === true },
      content: rich(),
    };
  if (type === "paragraph") return { type: "paragraph", attrs: DEFAULT_BLOCK_ATTRS, content: rich() };
  if (type === "bulleted_list_item") return { type: "bulletListItem", attrs: DEFAULT_BLOCK_ATTRS, content: rich() };
  if (type === "numbered_list_item") return { type: "numberedListItem", attrs: DEFAULT_BLOCK_ATTRS, content: rich() };
  if (type === "to_do")
    return {
      type: "checkListItem",
      attrs: { ...DEFAULT_BLOCK_ATTRS, checked: payload.checked === true },
      content: rich(),
    };
  if (type === "toggle") return { type: "toggleListItem", attrs: DEFAULT_BLOCK_ATTRS, content: rich() };
  if (type === "quote") return { type: "quote", attrs: DEFAULT_BLOCK_ATTRS, content: rich() };
  if (type === "code") {
    const language = string(payload.language);
    return language === "mermaid"
      ? { type: "mermaid", attrs: { source: notionPlainText(payload.rich_text) } }
      : { type: "codeBlock", attrs: { language }, content: rich() };
  }
  if (type === "divider") return { type: "divider" };
  if (type === "callout")
    return {
      type: "callout",
      attrs: {
        icon: string(record(payload.icon).emoji, "💡"),
        tone: NOTION_COLOR_TO_TONE[string(payload.color, "blue") as keyof typeof NOTION_COLOR_TO_TONE] ?? "info",
      },
      content: rich(),
    };
  if (type === "equation") return { type: "math", attrs: { formula: string(payload.expression) } };
  if (type === "table_of_contents")
    return { type: "tableOfContents", attrs: { color: string(payload.color, "default") } };
  if (type === "column_list") return { type: "columnList" };
  if (type === "column") return { type: "column" };
  if (type === "synced_block") {
    const synced = record(payload.synced_from);
    return synced.block_id
      ? {
          type: "syncedBlockReference",
          attrs: { sourcePageId: string(payload.source_page_id), blockId: string(synced.block_id) },
        }
      : { type: "syncedBlockSource", attrs: { blockId: "" } };
  }
  if (type === "breadcrumb") return { type: "breadcrumb" };
  if (type === "link_to_page")
    return {
      type: "linkToPage",
      attrs: { pageId: string(payload.page_id), title: string(payload.title, "Linked page") },
    };
  if (type === "bookmark")
    return {
      type: "bookmark",
      attrs: { url: validatedExternalUrl(string(payload.url), "Bookmark"), title: string(payload.title, "Bookmark") },
    };
  if (type === "embed")
    return { type: "embed", attrs: { url: validatedEmbedUrl(string(payload.url)), title: "Embedded link" } };
  if (["image", "video", "audio", "file", "pdf"].includes(type))
    return { type, attrs: { url: notionMediaUrl(payload), caption: "", name: type, showPreview: true } };
  if (type === "table")
    return {
      type: "table",
      attrs: {
        hasColumnHeader: payload.has_column_header === true,
        hasRowHeader: payload.has_row_header === true,
      },
    };
  if (type === "table_row") {
    const cells = Array.isArray(payload.cells) ? payload.cells : [];
    return {
      type: "tableRow",
      content: cells.map((cell) => ({ type: "tableCell", content: notionRichTextToProseMirror(cell) })),
    };
  }
  throw new Error(`Unsupported block type: ${type}`);
}

export function notionInputToBlockContainer(value: unknown, depth = 0): ProseMirrorJson {
  if (depth > 2) throw new Error("Block nesting exceeds the supported depth.");
  const input = record(value);
  const inferredTypes = Object.keys(input).filter((key) => NOTION_WRITABLE_BLOCK_TYPES.has(key));
  if (!string(input.type) && inferredTypes.length > 1) throw new Error("Block type is ambiguous.");
  const type = string(input.type) || inferredTypes[0] || "";
  if (!type) throw new Error("Block type is required.");
  const payload = record(input[type]);
  const id = typeof input.id === "string" && input.id ? input.id : crypto.randomUUID();
  const node = blockNode(type, payload);
  if (node.type === "syncedBlockSource") node.attrs = { ...node.attrs, blockId: id };
  const childrenInput = Array.isArray(payload.children) ? payload.children : [];
  if (node.type === "syncedBlockReference" && childrenInput.length) {
    throw new Error("A synced block reference cannot contain children.");
  }
  const content: ProseMirrorJson[] = [node];
  if (childrenInput.length) {
    if (childrenInput.length > NOTION_PAGE_SIZE_MAX)
      throw new Error("A block may contain at most 100 children per request.");
    const children = childrenInput.map((child) => notionInputToBlockContainer(child, depth + 1));
    if (
      node.type === "columnList" &&
      children.some((child) => child.content?.find((item) => item.type !== "blockGroup")?.type !== "column")
    ) {
      throw new Error("A column_list may contain only column blocks.");
    }
    if (
      node.type === "table" &&
      children.some((child) => child.content?.find((item) => item.type !== "blockGroup")?.type !== "tableRow")
    ) {
      throw new Error("A table may contain only table_row blocks.");
    }
    if (node.type === "table") {
      const hasColumnHeader = node.attrs?.hasColumnHeader === true;
      const hasRowHeader = node.attrs?.hasRowHeader === true;
      for (const [rowIndex, child] of children.entries()) {
        const row = child.content?.find((item) => item.type === "tableRow");
        if (!row?.content) continue;
        row.content = row.content.map((cell, columnIndex) => ({
          ...cell,
          type:
            (hasColumnHeader && rowIndex === 0) || (hasRowHeader && columnIndex === 0) ? "tableHeader" : "tableCell",
        }));
      }
    }
    content.push({
      type: "blockGroup",
      content: children,
    });
  }
  return { type: "blockContainer", attrs: { id }, content };
}
