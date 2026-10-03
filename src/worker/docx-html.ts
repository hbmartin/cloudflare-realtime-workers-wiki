import { hasUrlControls } from "../shared/text";
import { DomUtils, ElementType, parseDocument } from "htmlparser2";
import { BLOCK_ATTRS, type ImportIssue } from "../shared/import-content";
import type { ProseMirrorJson } from "../shared/types";
import { HttpError } from "./http";

const TABLE_MAX_COLUMNS = 256;
const TABLE_MAX_ROWS = 10_000;
const DOCUMENT_MAX_TABLE_CELLS = 10_000;
function tableLimit() {
  return new HttpError(
    413,
    "docx_tables_too_large",
    "Word tables exceed the supported row, column, or expanded-cell limits.",
  );
}
function tableSpan(value: string | undefined, maximum: number) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed) || parsed > maximum) throw tableLimit();
  return Math.max(1, Math.trunc(parsed));
}

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
type HtmlElement = ReturnType<typeof DomUtils.getElementsByTagName>[number];
function isTag(node: HtmlNode): node is HtmlElement {
  return "attribs" in node;
}

const text = (value: string, marks: ProseMirrorJson["marks"] = []): ProseMirrorJson[] =>
  value ? [{ type: "text", text: value, ...(marks.length ? { marks } : {}) }] : [];

export function safeDocxHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (!href || hasUrlControls(href) || href.includes("\\")) return null;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href, "https://docx.invalid").protocol) ? href : null;
  } catch {
    return null;
  }
}

const empty = (): ProseMirrorJson => ({
  type: "tableCell",
  attrs: { colspan: 1, rowspan: 1, colwidth: null },
  content: [{ type: "tableParagraph", attrs: { ...BLOCK_ATTRS } }],
});

// Mammoth's semantic HTML needs a tree parser: the general HTML importer flattens
// nested lists and tables. This adapter only handles DOCX conversion output.
export function docxHtmlToDocument(html: string, imageSources: ReadonlySet<string> = new Set()) {
  const issues: ImportIssue[] = [];
  let sequence = 0;
  let expandedTableCells = 0;
  const container = (block: ProseMirrorJson, children: ProseMirrorJson[] = []): ProseMirrorJson => ({
    type: "blockContainer",
    attrs: { id: `docx-${++sequence}` },
    content: [block, ...(children.length ? [{ type: "blockGroup", content: children }] : [])],
  });

  const parsed = parseDocument(html);
  // Check every source table, including tables whose contents are later flattened.
  // Reserve the full rectangular footprint before allocating cells or row padding.
  const layouts = new Map<
    HtmlElement,
    {
      rows: HtmlElement[];
      width: number;
      cells: { cell: HtmlElement; row: number; column: number; colspan: number; rowspan: number }[];
    }
  >();
  for (const table of DomUtils.getElementsByTagName("table", parsed.children)) {
    const rows = DomUtils.getElementsByTagName("tr", table.children).filter((row) => {
      let parent = row.parent;
      while (parent && parent !== table) {
        if (isTag(parent) && parent.name === "table") return false;
        parent = parent.parent;
      }
      return parent === table;
    });
    if (rows.length > TABLE_MAX_ROWS) throw tableLimit();
    const occupied = new Set<number>();
    const cells = [];
    let width = 0;
    for (const [rowIndex, row] of rows.entries()) {
      let column = 0;
      for (const cell of row.children.filter((child) => isTag(child) && ["td", "th"].includes(child.name))) {
        if (!isTag(cell)) throw new Error("Invalid table cell");
        const colspan = tableSpan(cell.attribs.colspan, TABLE_MAX_COLUMNS);
        const rowspan = tableSpan(cell.attribs.rowspan, rows.length - rowIndex);
        while (
          Array.from({ length: colspan }, (_, i) => occupied.has(rowIndex * TABLE_MAX_COLUMNS + column + i)).some(
            Boolean,
          )
        ) {
          column++;
          if (column + colspan > TABLE_MAX_COLUMNS) throw tableLimit();
        }
        width = Math.max(width, column + colspan);
        if (width > TABLE_MAX_COLUMNS || expandedTableCells + rows.length * width > DOCUMENT_MAX_TABLE_CELLS)
          throw tableLimit();
        for (let r = 0; r < rowspan; r++)
          for (let c = 0; c < colspan; c++) occupied.add((rowIndex + r) * TABLE_MAX_COLUMNS + column + c);
        cells.push({ cell, row: rowIndex, column, colspan, rowspan });
        column += colspan;
      }
    }
    expandedTableCells += rows.length * width;
    layouts.set(table, { rows, width, cells });
  }

  function inline(
    nodes: HtmlNode[],
    marks: ProseMirrorJson["marks"] = [],
    depth = 0,
    flattenLists = false,
  ): ProseMirrorJson[] {
    if (depth > 64) {
      issues.push({ code: "docx_nesting_simplified", detail: "Deeply nested formatting" });
      return text(nodes.map((node) => DomUtils.textContent(node)).join(""), marks);
    }
    return nodes.flatMap((node, index): ProseMirrorJson[] => {
      if (node.type === ElementType.Text) return text(node.data, marks);
      if (!isTag(node) || ["script", "style", "template"].includes(node.name)) return [];
      const name = node.name;
      if (name === "ul" || name === "ol") return flattenLists ? inline(node.children, marks, depth + 1, true) : [];
      if (name === "br") return [{ type: "hardBreak" }];
      if (name === "img") {
        const label = node.attribs.alt || "Image";
        const source = node.attribs.src ?? "";
        if (imageSources.has(source))
          return [
            {
              type: "image",
              attrs: {
                backgroundColor: "default",
                textAlignment: "left",
                url: source,
                caption: node.attribs.alt ?? "",
                name: label,
                showPreview: true,
                previewWidth: 512,
              },
            },
          ];
        const href = safeDocxHref(source);
        issues.push({ code: "docx_image_not_embedded", detail: label });
        return text(`[${label}]`, href ? [{ type: "link", attrs: { href } }] : marks);
      }
      const style = (
        {
          strong: "bold",
          b: "bold",
          em: "italic",
          i: "italic",
          u: "underline",
          s: "strike",
          del: "strike",
          code: "code",
        } as Record<string, string>
      )[name];
      let active = style && !marks.some((mark) => mark.type === style) ? [...marks, { type: style }] : marks;
      if (name === "a") {
        const href = safeDocxHref(node.attribs.href);
        if (href) active = [...active, { type: "link", attrs: { href } }];
        else if (node.attribs.href) issues.push({ code: "unsafe_url", detail: node.attribs.href.slice(0, 120) });
      }
      const content = inline(node.children, active, depth + 1, flattenLists);
      return (name === "p" || (flattenLists && name === "li")) && content.length && index < nodes.length - 1
        ? [...content, { type: "hardBreak" }]
        : content;
    });
  }

  function paragraphs(content: ProseMirrorJson[], type = "paragraph", attrs: Record<string, unknown> = {}) {
    const output: ProseMirrorJson[] = [];
    let pending: ProseMirrorJson[] = [];
    const flush = () => {
      if (pending.length) output.push(container({ type, attrs: { ...BLOCK_ATTRS, ...attrs }, content: pending }));
      pending = [];
    };
    for (const node of content) {
      if (node.type === "image") {
        flush();
        output.push(container(node));
      } else pending.push(node);
    }
    flush();
    return output.length ? output : [container({ type, attrs: { ...BLOCK_ATTRS, ...attrs } })];
  }

  function blocks(nodes: HtmlNode[], depth = 0): ProseMirrorJson[] {
    if (depth > 64) {
      issues.push({ code: "docx_nesting_simplified", detail: "Deeply nested blocks" });
      return paragraphs(text(nodes.map((node) => DomUtils.textContent(node)).join("")));
    }
    const output: ProseMirrorJson[] = [];
    for (const node of nodes) {
      if (!isTag(node)) {
        if (node.type === ElementType.Text && node.data.trim()) output.push(...paragraphs(text(node.data)));
        continue;
      }
      if (["script", "style", "template"].includes(node.name)) continue;
      if (node.name === "ul" || node.name === "ol") {
        for (const item of node.children.filter((child) => isTag(child) && child.name === "li")) {
          if (!isTag(item)) continue;
          const root = container({
            type: node.name === "ol" ? "numberedListItem" : "bulletListItem",
            attrs: { ...BLOCK_ATTRS },
          });
          const continuation: ProseMirrorJson[] = [];
          let first = true,
            pending: HtmlNode[] = [];
          const flush = () => {
            if (!pending.length) return;
            const parts = paragraphs(inline(pending));
            if (first && parts[0]?.content?.[0]?.type === "paragraph") {
              root.content![0]!.content = parts.shift()!.content![0]!.content ?? [];
            }
            continuation.push(...parts);
            pending = [];
            first = false;
          };
          for (const child of item.children) {
            if (isTag(child) && ["ul", "ol"].includes(child.name)) {
              flush();
              first = false;
              continuation.push(...blocks([child], depth + 1));
            } else pending.push(child);
          }
          flush();
          if (continuation.length) root.content!.push({ type: "blockGroup", content: continuation });
          output.push(root);
        }
      } else if (node.name === "table") {
        const { rows, width, cells } = layouts.get(node)!;
        const images: ProseMirrorJson[] = [];
        const grid: ProseMirrorJson[][] = Array.from({ length: rows.length }, () => []);
        for (const { cell, row: rowIndex, column, colspan, rowspan } of cells) {
          if (
            Number(cell.attribs.colspan || 1) > 1 ||
            Number(cell.attribs.rowspan || 1) > 1 ||
            DomUtils.getElementsByTagName("table", cell.children).length ||
            DomUtils.getElementsByTagName("ul", cell.children).length ||
            DomUtils.getElementsByTagName("ol", cell.children).length
          )
            issues.push({ code: "docx_table_simplified", detail: "Merged or nested table cell" });
          const content = inline(cell.children, [], 0, true);
          images.push(...content.filter((child) => child.type === "image"));
          const own = content.filter((child) => child.type !== "image");
          grid[rowIndex]![column] = {
            type: cell.name === "th" ? "tableHeader" : "tableCell",
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: "tableParagraph", attrs: { ...BLOCK_ATTRS }, ...(own.length ? { content: own } : {}) }],
          };
          for (let r = 0; r < rowspan; r++)
            for (let c = 0; c < colspan; c++) if (r || c) grid[rowIndex + r]![column + c] = empty();
        }
        const converted = grid.map((content) => ({ type: "tableRow", content }));
        for (const row of converted) {
          for (let col = 0; col < width; col++) row.content![col] ??= empty();
        }
        if (width) output.push(container({ type: "table", attrs: { ...BLOCK_ATTRS }, content: converted }));
        if (images.length) {
          issues.push({ code: "docx_table_images_moved", detail: "Images moved below their table" });
          output.push(...images.map((image) => container(image)));
        }
      } else if (node.name === "pre")
        output.push(
          ...paragraphs(
            inline(node.children).map((child) =>
              child.type === "text"
                ? { type: "text", text: child.text! }
                : child.type === "hardBreak"
                  ? { type: "text", text: "\n" }
                  : child,
            ),
            "codeBlock",
            { language: "text" },
          ),
        );
      else if (/^h[1-6]$/.test(node.name)) {
        output.push(
          ...paragraphs(inline(node.children), "heading", { level: Number(node.name[1]), isToggleable: false }),
        );
      } else if (node.name === "blockquote") output.push(...paragraphs(inline(node.children), "quote"));
      else if (node.name === "p" || node.name === "img")
        output.push(...paragraphs(inline(node.name === "img" ? [node] : node.children)));
      else if (node.name === "hr") output.push(container({ type: "divider" }));
      else output.push(...blocks(node.children, depth + 1));
    }
    return output;
  }

  const content = blocks(parsed.children);
  const document: ProseMirrorJson = {
    type: "doc",
    content: [{ type: "blockGroup", content: content.length ? content : paragraphs([]) }],
  };
  return { document, issues };
}
