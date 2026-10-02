import { sanitizeXmlText } from "../shared/text";
import { sha256Hex } from "../shared/import-integrity";
import { inlineImageMime } from "./attachments";
import { Buffer } from "node:buffer";
import mammoth from "mammoth";
import { DomUtils, parseDocument } from "htmlparser2";
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  Tab,
  type IRunOptions,
  WidthType,
  type ParagraphChild,
} from "docx";
import { dateMentionText } from "../shared/document-projection";
import type { ImportIssue } from "../shared/import-content";
import type { ProseMirrorJson } from "../shared/types";
import { readZip, ZipValidationError } from "../shared/zip";
import { docxHtmlToDocument, safeDocxHref } from "./docx-html";
import { HttpError } from "./http";

export type DocxImage = { bytes: Uint8Array; mime: string };
const IMAGE_TYPES: Record<string, "png" | "jpg" | "gif"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  if (
    mime === "image/png" &&
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    mime === "image/gif" &&
    bytes.length >= 10 &&
    String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)
  ) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      if (marker === 255) {
        offset += 1;
        continue;
      }
      if (marker === 217 || marker === 218) break;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = view.getUint16(offset + 5);
        width = view.getUint16(offset + 7);
        break;
      }
      offset += length + 2;
    }
  }
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : null;
}

const canonical = (path: string) => decodeURIComponent(new URL(path, "https://package.invalid/").pathname.slice(1));
const clean = (node: ProseMirrorJson): ProseMirrorJson => ({
  ...node,
  ...(node.text === undefined ? {} : { text: sanitizeXmlText(node.text) }),
  ...(node.attrs
    ? {
        attrs: Object.fromEntries(
          Object.entries(node.attrs).map(([key, value]) => [
            key,
            typeof value === "string" ? sanitizeXmlText(value) : value,
          ]),
        ),
      }
    : {}),
  ...(node.marks
    ? {
        marks: node.marks.map((mark) => ({
          ...mark,
          ...(mark.attrs
            ? {
                attrs: Object.fromEntries(
                  Object.entries(mark.attrs).map(([key, value]) => [
                    key,
                    typeof value === "string" ? sanitizeXmlText(value) : value,
                  ]),
                ),
              }
            : {}),
        })),
      }
    : {}),
  ...(node.content ? { content: node.content.map(clean) } : {}),
});
const textRuns = (value: string, options: IRunOptions = {}) =>
  sanitizeXmlText(value)
    .split(/(\r\n|\r|\n|\t)/)
    .filter(Boolean)
    .map((part) =>
      part === "\t"
        ? new TextRun({ ...options, children: [new Tab()] })
        : /^(\r\n|\r|\n)$/.test(part)
          ? new TextRun({ ...options, break: 1 })
          : new TextRun({ ...options, text: part }),
    );

export async function readDocx(bytes: Uint8Array) {
  let entries;
  try {
    entries = await readZip(bytes);
  } catch (error) {
    if (error instanceof ZipValidationError)
      throw new HttpError(
        error.kind === "limit" ? 413 : 422,
        "invalid_docx",
        error.kind === "limit"
          ? error.message
          : "This is not a readable Word .docx file. Encrypted documents and older .doc files must be saved as an unencrypted .docx file in Word.",
      );
    throw error;
  }
  const decoder = new TextDecoder();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (/\.(xml|rels)$/i.test(entry.path) && /<!\s*(DOCTYPE|ENTITY)\b/i.test(decoder.decode(entry.bytes)))
      throw new HttpError(422, "invalid_docx", "Word documents with XML entity declarations are not supported.");
  }

  const packageRelationships = byPath.get("_rels/.rels");
  const relations = packageRelationships
    ? DomUtils.getElementsByTagName(
        "Relationship",
        parseDocument(decoder.decode(packageRelationships.bytes), { xmlMode: true }).children,
      )
    : [];
  const candidates = relations
    .filter(
      (r) =>
        r.attribs.Type === "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" &&
        r.attribs.TargetMode !== "External",
    )
    .map((r) => canonical(r.attribs.Target!));
  const mainPath = candidates.find((path) => byPath.has(path)) ?? "word/document.xml";
  const types = byPath.get("[Content_Types].xml");
  const overrides = types
    ? DomUtils.getElementsByTagName("Override", parseDocument(decoder.decode(types.bytes), { xmlMode: true }).children)
    : [];
  if (
    !byPath.has(mainPath) ||
    !overrides.some(
      (part) =>
        canonical(part.attribs.PartName!) === mainPath &&
        part.attribs.ContentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    ) ||
    entries.some((entry) => /vbaProject|macroEnabled/i.test(entry.path)) ||
    (types && /macroEnabled/i.test(decoder.decode(types.bytes)))
  )
    throw new HttpError(
      422,
      "invalid_docx",
      "The file is not a supported Word .docx document. Save an unencrypted .docx file in Word and try again.",
    );
  const directory = mainPath.includes("/") ? mainPath.slice(0, mainPath.lastIndexOf("/") + 1) : "";
  const relationshipsPath = `${directory}_rels/${mainPath.slice(directory.length)}.rels`;
  const mainXml = decoder.decode(byPath.get(mainPath)!.bytes);
  const mainTree = parseDocument(mainXml, { xmlMode: true });
  const issues: ImportIssue[] = [];
  if (
    entries.some((entry) => /^word\/(?:header|footer|comments)/.test(entry.path)) ||
    /<w:(?:ins|del)\b/.test(mainXml) ||
    DomUtils.getElementsByTagName("w:cols", mainTree.children).some(
      (cols) =>
        Number(cols.attribs["w:num"] ?? 1) > 1 || DomUtils.getElementsByTagName("w:col", cols.children).length > 1,
    )
  )
    issues.push({ code: "docx_word_layout_simplified", detail: "Word layout and review metadata are simplified." });
  const images = new Map<string, { path: string; bytes: Uint8Array }>();
  let imageBytes = 0;
  const imageHashes = new Map<string, string>();
  let converted;
  try {
    converted = await mammoth.convertToHtml(
      // Mammoth 1.13 accepts this localized file adapter. Every byte comes from
      // readZip's validated entries; no second JSZip inflation or upload copy.
      {
        file: {
          exists: (name: string) => byPath.has(canonical(name)),
          read: async (name: string, encoding?: string) => {
            const entry = byPath.get(canonical(name));
            if (!entry) throw new Error("Missing DOCX part");
            if (encoding === "base64")
              return Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength).toString("base64");
            return encoding ? new TextDecoder(encoding).decode(entry.bytes) : entry.bytes;
          },
        },
      } as unknown as Parameters<typeof mammoth.convertToHtml>[0],
      {
        includeEmbeddedStyleMap: false,
        externalFileAccess: false,
        ignoreEmptyParagraphs: false,
        styleMap: [
          "u => u",
          "strike => s",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Title'] => p:fresh",
          "p[style-name='Code'] => pre:fresh",
        ],
        convertImage: mammoth.images.imgElement(async (image) => {
          const mime = inlineImageMime(image.contentType);
          const type = mime ? IMAGE_TYPES[mime] : null;
          if (!type) {
            issues.push({ code: "docx_unsupported_image", detail: image.contentType });
            return { src: "" };
          }
          const data = new Uint8Array(await image.readAsArrayBuffer());
          const hash = `${mime}:${await sha256Hex(data)}`;
          const existing = imageHashes.get(hash);
          if (existing) return { src: existing };
          if (!imageDimensions(data, mime!)) {
            issues.push({ code: "docx_invalid_image", detail: image.contentType });
            return { src: "" };
          }
          imageBytes += data.byteLength;
          if (imageBytes > MAX_IMAGE_BYTES)
            throw new HttpError(413, "docx_images_too_large", "Embedded Word images exceed the 24 MiB limit.");
          const path = `docx-images/image-${images.size + 1}.${type}`;
          imageHashes.set(hash, path);
          images.set(path, { path, bytes: data });
          return { src: path };
        }),
      },
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      422,
      "invalid_docx",
      "The Word document could not be read. Check that it is a valid, unencrypted .docx file.",
    );
  }
  // Mammoth turns image failures into messages. Limit failures must still abort.
  if (imageBytes > MAX_IMAGE_BYTES)
    throw new HttpError(413, "docx_images_too_large", "Embedded Word images exceed the 24 MiB limit.");
  issues.push(
    ...converted.messages.map((message) => ({
      code: "docx_conversion_warning",
      detail: message.message.slice(0, 240),
    })),
  );
  const parsed = docxHtmlToDocument(converted.value, new Set(images.keys()));
  // Mammoth cannot read linked images with external access disabled. Preserve
  // their URLs as links below the body rather than fetching or silently losing them.
  const marker = byPath.get("docProps/custom.xml");
  const generatedTitle =
    marker &&
    DomUtils.getElementsByTagName(
      "property",
      parseDocument(decoder.decode(marker.bytes), { xmlMode: true }).children,
    ).some((property) => property.attribs.name === "NoteFlareGeneratedTitle" && DomUtils.textContent(property) === "1");
  const firstParagraph = DomUtils.getElementsByTagName("w:p", mainTree.children)[0];
  if (
    generatedTitle &&
    firstParagraph &&
    DomUtils.getElementsByTagName("w:pStyle", firstParagraph.children).some(
      (style) => style.attribs["w:val"] === "Title",
    )
  )
    parsed.document.content![0]!.content!.shift();
  const relationships = byPath.get(relationshipsPath);
  const linkedIds = new Set(
    [...mainXml.matchAll(/\br:(?:link|embed)\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]),
  );
  if (relationships) {
    const root = parseDocument(decoder.decode(relationships.bytes), { xmlMode: true });
    const links = new Set<string>();
    for (const relationship of DomUtils.getElementsByTagName("Relationship", root.children)) {
      const attrs = relationship.attribs;
      if (attrs.TargetMode !== "External" || !attrs.Type?.endsWith("/image") || !linkedIds.has(attrs.Id)) continue;
      const href = safeDocxHref(attrs.Target);
      if (!href || links.has(href)) continue;
      links.add(href);
      parsed.document.content![0]!.content!.push({
        type: "blockContainer",
        attrs: { id: `docx-external-image-${links.size}` },
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Linked image", marks: [{ type: "link", attrs: { href } }] }],
          },
        ],
      });
      issues.push({ code: "docx_external_image_link", detail: "Linked image preserved below the document body." });
    }
  }
  if (!parsed.document.content![0]!.content!.length)
    parsed.document.content![0]!.content!.push({
      type: "blockContainer",
      attrs: { id: "docx-empty" },
      content: [{ type: "paragraph" }],
    });
  return { document: parsed.document, issues: [...issues, ...parsed.issues], entries: images };
}

function nodeText(node: ProseMirrorJson): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  if (node.type === "dateMention") return dateMentionText(node);
  if (node.type === "mention") return String(node.attrs?.label ?? "Mention");
  if (node.type === "inlineMath") return String(node.attrs?.formula ?? "");
  return (node.content ?? []).map(nodeText).join("");
}

const paragraph = (content: ParagraphChild[]) => new Paragraph({ children: content });

export async function writeDocx(
  document: ProseMirrorJson,
  title: string,
  baseUrl: string,
  resolveImage: (url: string) => Promise<DocxImage | null>,
) {
  document = clean(document);
  title = sanitizeXmlText(title);
  const warnings = new Set<string>();
  const images = new Map<string, Promise<DocxImage | null>>();
  let imageBytes = 0;
  const image = (url: string) => {
    let pending = images.get(url);
    if (!pending) {
      pending = resolveImage(url).then((asset) => {
        imageBytes += asset?.bytes.byteLength ?? 0;
        if (imageBytes > MAX_IMAGE_BYTES)
          throw new HttpError(413, "docx_images_too_large", "Embedded Word images exceed the 24 MiB limit.");
        return asset;
      });
      images.set(url, pending);
    }
    return pending;
  };
  const href = (value: unknown) => {
    const safe = safeDocxHref(value);
    return safe ? new URL(safe, baseUrl).href : null;
  };
  function runs(nodes: ProseMirrorJson[]): ParagraphChild[] {
    return nodes.flatMap((node): ParagraphChild[] => {
      if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
      if (node.type === "text" || ["mention", "dateMention", "inlineMath"].includes(node.type ?? "")) {
        const marks = new Set((node.marks ?? []).map((mark) => mark.type));
        const content = textRuns(nodeText(node), {
          bold: marks.has("bold"),
          italics: marks.has("italic"),
          strike: marks.has("strike"),
          ...(marks.has("underline") ? { underline: {} } : {}),
          ...(marks.has("code") ? { font: "Courier New" } : {}),
        });
        const link = href(node.marks?.find((mark) => mark.type === "link")?.attrs?.href);
        if (node.type === "inlineMath") warnings.add("Math formulas are exported as source text.");
        return link ? [new ExternalHyperlink({ link, children: content })] : content;
      }
      return runs(node.content ?? []);
    });
  }
  const linkParagraph = (label: string, url: unknown) => {
    const link = href(url);
    return paragraph([
      link ? new ExternalHyperlink({ link, children: textRuns(label) }) : new TextRun(sanitizeXmlText(label)),
    ]);
  };
  type WordBlock = Paragraph | Table;
  let orderedSequence = 0;
  const numbering: Array<{
    reference: string;
    levels: Array<{
      level: number;
      format: typeof LevelFormat.DECIMAL;
      text: string;
      alignment: typeof AlignmentType.START;
      style: { paragraph: { indent: { left: number; hanging: number } } };
    }>;
  }> = [];

  async function sequence(nodes: ProseMirrorJson[], depth = 0): Promise<WordBlock[]> {
    const output: WordBlock[] = [];
    let orderedReference: string | undefined;
    for (const node of nodes) {
      const own = node.type === "blockContainer" ? node.content?.find((child) => child.type !== "blockGroup") : node;
      if (own?.type === "numberedListItem" && !orderedReference) {
        orderedReference = `ordered-${++orderedSequence}`;
        numbering.push({
          reference: orderedReference,
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        });
      } else if (own?.type !== "numberedListItem") orderedReference = undefined;
      output.push(...(await block(node, depth, orderedReference)));
    }
    return output;
  }
  async function block(node: ProseMirrorJson, depth: number, orderedReference?: string): Promise<WordBlock[]> {
    const children = node.content ?? [];
    const type = node.type ?? "unknown";
    if (["doc", "blockGroup", "syncedBlockSource", "columnList", "column"].includes(type))
      return sequence(children, depth);
    if (["tableOfContents", "breadcrumb"].includes(type)) return [];
    if (type === "blockContainer") {
      const output: WordBlock[] = [];
      const table = children.find((child) => child.type === "table");
      if (table && !table.content?.length) {
        const rows = children
          .filter((child) => child.type === "blockGroup")
          .flatMap((group) =>
            (group.content ?? []).flatMap((child) =>
              child.type === "tableRow" ? [child] : (child.content ?? []).filter((part) => part.type === "tableRow"),
            ),
          );
        if (rows.length) return block({ ...table, content: rows }, depth, orderedReference);
      }
      for (const child of children)
        output.push(...(await block(child, child.type === "blockGroup" ? depth + 1 : depth, orderedReference)));
      return output;
    }
    if (
      [
        "paragraph",
        "heading",
        "quote",
        "blockquote",
        "bulletListItem",
        "numberedListItem",
        "checkListItem",
        "codeBlock",
      ].includes(type)
    ) {
      const content = runs(children);
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ];
      return [
        new Paragraph({
          children: type === "checkListItem" ? [new TextRun(node.attrs?.checked ? "☑ " : "☐ "), ...content] : content,
          ...(type === "heading"
            ? { heading: levels[Math.min(5, Math.max(0, Number(node.attrs?.level ?? 1) - 1))]! }
            : {}),
          ...(type === "bulletListItem" ? { bullet: { level: Math.min(8, depth) } } : {}),
          ...(type === "numberedListItem" && orderedReference
            ? { numbering: { reference: orderedReference, level: Math.min(8, depth) } }
            : {}),
          ...(type === "quote" || type === "blockquote" ? { indent: { left: 720 } } : {}),
          ...(type === "codeBlock" ? { style: "DocxCode" } : {}),
        }),
      ];
    }
    if (type === "table") {
      const rows = children.filter((child) => child.type === "tableRow");
      if (!rows.length || rows.some((row) => !row.content?.length)) {
        warnings.add("An unsupported table structure was exported as text.");
        return [paragraph(runs(children))];
      }
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map(
            (row) =>
              new TableRow({
                children: (row.content ?? []).map((cell) => {
                  const content = cell.content ?? [];
                  const parts = content.some((part) =>
                    ["tableParagraph", "paragraph", "tableContent"].includes(part.type ?? ""),
                  )
                    ? content.map((part) => paragraph(runs(part.content ?? [])))
                    : [paragraph(runs(content))];
                  return new TableCell({
                    children: parts.length ? parts : [paragraph([])],
                    columnSpan: Math.min(256, Math.max(1, Number(cell.attrs?.colspan) || 1)),
                    rowSpan: Math.min(rows.length, Math.max(1, Number(cell.attrs?.rowspan) || 1)),
                  });
                }),
              }),
          ),
        }),
      ];
    }
    if (type === "image") {
      const url = String(node.attrs?.url ?? "");
      const label = String(node.attrs?.caption || node.attrs?.name || "Image");
      const asset = await image(url);
      const dimensions = asset ? imageDimensions(asset.bytes, asset.mime) : null;
      const format = asset ? IMAGE_TYPES[asset.mime] : null;
      if (!asset || !dimensions || !format) {
        warnings.add("Some images could not be embedded and were exported as labels or links.");
        return [linkParagraph(label, url)];
      }
      const width = Math.min(600, Math.max(64, Number(node.attrs?.previewWidth) || dimensions.width));
      return [
        paragraph([
          new ImageRun({
            type: format,
            data: asset.bytes,
            transformation: { width, height: Math.max(1, Math.round((width * dimensions.height) / dimensions.width)) },
            altText: { title: label, description: label, name: label },
          }),
        ]),
        ...(node.attrs?.caption ? [paragraph([new TextRun(sanitizeXmlText(String(node.attrs.caption)))])] : []),
      ];
    }
    if (type === "divider") return [new Paragraph({ thematicBreak: true })];
    if (type === "linkedDiagram" || type === "linkToPage") {
      warnings.add("Linked pages and diagrams are exported as links.");
      return [
        linkParagraph(
          String(node.attrs?.title ?? "Linked page"),
          `/?page=${encodeURIComponent(String(node.attrs?.pageId ?? ""))}`,
        ),
      ];
    }
    if (["bookmark", "embed", "file", "pdf", "video", "audio"].includes(type)) {
      warnings.add("Embeds and attached files are exported as links.");
      return [linkParagraph(String(node.attrs?.title || node.attrs?.name || node.attrs?.url || type), node.attrs?.url)];
    }
    if (["text", "mention", "dateMention", "inlineMath", "hardBreak"].includes(type)) return [paragraph(runs([node]))];
    warnings.add("Custom blocks are exported as readable text, source text, or links.");
    if (type === "syncedBlockReference")
      return [linkParagraph("Synced content", `/?page=${encodeURIComponent(String(node.attrs?.sourcePageId ?? ""))}`)];
    if (type === "math" || type === "mermaid")
      return [paragraph(textRuns(String(node.attrs?.formula ?? node.attrs?.source ?? nodeText(node))))];
    if (children.length)
      return children.some((child) => child.type === "blockGroup" || child.type === "blockContainer")
        ? sequence(children, depth)
        : [paragraph(runs(children))];
    return [paragraph([new TextRun(String(node.attrs?.title ?? `[${type}]`))])];
  }
  const content = await sequence(document.content ?? []);
  const output = new Document({
    title,
    customProperties: [{ name: "NoteFlareGeneratedTitle", value: "1" }],
    styles: { paragraphStyles: [{ id: "DocxCode", name: "Code", run: { font: "Courier New" } }] },
    numbering: { config: numbering },
    sections: [{ children: [new Paragraph({ text: title, heading: HeadingLevel.TITLE }), ...content] }],
  });
  return { bytes: new Uint8Array(await Packer.toArrayBuffer(output)), warnings: [...warnings] };
}
