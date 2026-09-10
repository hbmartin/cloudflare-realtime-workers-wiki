import * as Y from "yjs";
import {
  DIAGRAM_NODE_TYPES,
  type DiagramColor,
  type DiagramContentEnvelope,
  type DiagramEdge,
  type DiagramEdgePath,
  type DiagramEntityLink,
  type DiagramNode,
  type DiagramNodeType,
} from "./types";
import type { DocumentProjection, ProjectedReference } from "./document-projection";

const DIAGRAM_SCHEMA_VERSION = 1 as const;
export const DIAGRAM_META_ROOT = "diagram:meta";
export const DIAGRAM_NODES_ROOT = "diagram:nodes";
export const DIAGRAM_EDGES_ROOT = "diagram:edges";

const NODE_TYPES = new Set<string>(DIAGRAM_NODE_TYPES);
const COLORS = new Set<DiagramColor>(["slate", "blue", "green", "amber", "red", "purple"]);
const PATHS = new Set<DiagramEdgePath>(["straight", "step", "smoothstep"]);
const HANDLES = new Set<DiagramEdge["sourceHandle"]>(["top", "right", "bottom", "left"]);
const MAX_TEXT = 20_000;
const MAX_PLAIN_TEXT = 500_000;
export const DIAGRAM_RENDER_MAX_NODES = 2_000;
const DIAGRAM_RENDER_MAX_EDGES = 4_000;
export const DIAGRAM_RENDER_MAX_SVG_BYTES = 2 * 1024 * 1024;
const DIAGRAM_RENDER_MAX_IDENTIFIER = 100;
const DIAGRAM_RENDER_MAX_TITLE = 500;
const DIAGRAM_RENDER_MAX_ASSET_HREF = 2_048;

const PALETTE: Record<DiagramColor, { fill: string; stroke: string; text: string }> = {
  slate: { fill: "#f8fafc", stroke: "#475569", text: "#0f172a" },
  blue: { fill: "#eff6ff", stroke: "#2563eb", text: "#1e3a8a" },
  green: { fill: "#f0fdf4", stroke: "#16a34a", text: "#14532d" },
  amber: { fill: "#fffbeb", stroke: "#d97706", text: "#78350f" },
  red: { fill: "#fef2f2", stroke: "#dc2626", text: "#7f1d1d" },
  purple: { fill: "#faf5ff", stroke: "#9333ea", text: "#581c87" },
};

export const DEFAULT_NODE_SIZE: Record<DiagramNodeType, { width: number; height: number }> = {
  process: { width: 160, height: 80 },
  service: { width: 160, height: 80 },
  decision: { width: 150, height: 110 },
  database: { width: 140, height: 100 },
  queue: { width: 150, height: 76 },
  document: { width: 150, height: 96 },
  cloud: { width: 170, height: 96 },
  actor: { width: 100, height: 120 },
  device: { width: 120, height: 100 },
  text: { width: 180, height: 56 },
  frame: { width: 360, height: 240 },
  image: { width: 220, height: 150 },
};

function text(value: unknown, fallback = "", maximum = MAX_TEXT) {
  return typeof value === "string" ? value.slice(0, maximum) : fallback;
}

function number(value: unknown, fallback: number, minimum = -1_000_000, maximum = 1_000_000) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function yText(value: unknown) {
  return value instanceof Y.Text ? value.toString().slice(0, MAX_TEXT) : text(value);
}

function color(value: unknown): DiagramColor {
  return typeof value === "string" && COLORS.has(value as DiagramColor) ? (value as DiagramColor) : "slate";
}

function links(value: unknown): DiagramEntityLink[] {
  if (!(value instanceof Y.Map)) return [];
  const result: DiagramEntityLink[] = [];
  for (const [id, label] of value.entries()) {
    if (/^[\w-]{1,100}$/.test(id) && typeof label === "string") result.push({ id, label: label.slice(0, 200) });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function nodeFromMap(id: string, value: Y.Map<unknown>): DiagramNode {
  const rawType = value.get("type");
  const type = typeof rawType === "string" && NODE_TYPES.has(rawType) ? (rawType as DiagramNodeType) : "process";
  const defaults = DEFAULT_NODE_SIZE[type];
  const rawParentId = value.get("parentId");
  const rawAssetId = value.get("assetId");
  return {
    id,
    type,
    x: number(value.get("x"), 0),
    y: number(value.get("y"), 0),
    width: number(value.get("width"), defaults.width, 40, 5_000),
    height: number(value.get("height"), defaults.height, 32, 5_000),
    zIndex: number(value.get("zIndex"), 0, -100_000, 100_000),
    parentId: typeof rawParentId === "string" && rawParentId !== id ? rawParentId : null,
    label: yText(value.get("label")),
    notes: yText(value.get("notes")),
    color: color(value.get("color")),
    assetId: typeof rawAssetId === "string" && /^[\w-]{1,100}$/.test(rawAssetId) ? rawAssetId : null,
    references: links(value.get("references")),
    mentions: links(value.get("mentions")),
  };
}

function edgeFromMap(id: string, value: Y.Map<unknown>): DiagramEdge | null {
  const source = text(value.get("source"), "", 100);
  const target = text(value.get("target"), "", 100);
  if (!source || !target) return null;
  const rawSourceHandle = value.get("sourceHandle");
  const rawTargetHandle = value.get("targetHandle");
  const rawPath = value.get("path");
  return {
    id,
    source,
    target,
    sourceHandle:
      typeof rawSourceHandle === "string" && HANDLES.has(rawSourceHandle as DiagramEdge["sourceHandle"])
        ? (rawSourceHandle as DiagramEdge["sourceHandle"])
        : "right",
    targetHandle:
      typeof rawTargetHandle === "string" && HANDLES.has(rawTargetHandle as DiagramEdge["targetHandle"])
        ? (rawTargetHandle as DiagramEdge["targetHandle"])
        : "left",
    path: typeof rawPath === "string" && PATHS.has(rawPath as DiagramEdgePath) ? (rawPath as DiagramEdgePath) : "step",
    label: yText(value.get("label")),
    color: color(value.get("color")),
    arrow: value.get("arrow") !== false,
  };
}

export function diagramRoots(document: Y.Doc) {
  const meta = document.getMap<unknown>(DIAGRAM_META_ROOT);
  if (!meta.has("schemaVersion")) meta.set("schemaVersion", DIAGRAM_SCHEMA_VERSION);
  return {
    meta,
    nodes: document.getMap<Y.Map<unknown>>(DIAGRAM_NODES_ROOT),
    edges: document.getMap<Y.Map<unknown>>(DIAGRAM_EDGES_ROOT),
  };
}

export function diagramFromYDoc(
  document: Y.Doc,
  identity: { pageId: string; contentEpoch: number; sequence?: number },
): DiagramContentEnvelope {
  const { nodes: nodeMap, edges: edgeMap } = diagramRoots(document);
  const nodes = [...nodeMap.entries()]
    .filter((entry): entry is [string, Y.Map<unknown>] => entry[1] instanceof Y.Map)
    .map(([id, value]) => nodeFromMap(id, value))
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = [...edgeMap.entries()]
    .filter((entry): entry is [string, Y.Map<unknown>] => entry[1] instanceof Y.Map)
    .map(([id, value]) => edgeFromMap(id, value))
    .filter((edge): edge is DiagramEdge => Boolean(edge && nodeIds.has(edge.source) && nodeIds.has(edge.target)))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: DIAGRAM_SCHEMA_VERSION,
    pageId: identity.pageId,
    contentEpoch: identity.contentEpoch,
    sequence: identity.sequence ?? 0,
    nodes,
    edges,
  };
}

function makeText(value: string) {
  const result = new Y.Text();
  if (value) result.insert(0, value.slice(0, MAX_TEXT));
  return result;
}

function makeLinks(values: readonly DiagramEntityLink[]) {
  const result = new Y.Map<string>();
  for (const value of values) {
    if (/^[\w-]{1,100}$/.test(value.id)) result.set(value.id, value.label.slice(0, 200));
  }
  return result;
}

export function diagramNodeMap(node: DiagramNode) {
  const result = new Y.Map<unknown>();
  result.set("type", node.type);
  result.set("x", node.x);
  result.set("y", node.y);
  result.set("width", node.width);
  result.set("height", node.height);
  result.set("zIndex", node.zIndex);
  if (node.parentId) result.set("parentId", node.parentId);
  result.set("label", makeText(node.label));
  result.set("notes", makeText(node.notes));
  result.set("color", node.color);
  if (node.assetId) result.set("assetId", node.assetId);
  result.set("references", makeLinks(node.references));
  result.set("mentions", makeLinks(node.mentions));
  return result;
}

export function diagramEdgeMap(edge: DiagramEdge) {
  const result = new Y.Map<unknown>();
  result.set("source", edge.source);
  result.set("target", edge.target);
  result.set("sourceHandle", edge.sourceHandle);
  result.set("targetHandle", edge.targetHandle);
  result.set("path", edge.path);
  result.set("label", makeText(edge.label));
  result.set("color", edge.color);
  result.set("arrow", edge.arrow);
  return result;
}

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function excerpt(node: DiagramNode, label: string) {
  return normalized([node.label, node.notes, label].filter(Boolean).join(" — ")).slice(0, 240);
}

export function projectDiagram(diagram: Pick<DiagramContentEnvelope, "nodes" | "edges">): DocumentProjection {
  const parts: string[] = [];
  const pageReferences = new Map<string, ProjectedReference>();
  const memberMentions = new Map<string, ProjectedReference>();
  for (const node of diagram.nodes) {
    parts.push(node.label, node.notes);
    for (const reference of node.references) {
      parts.push(reference.label);
      if (!pageReferences.has(reference.id)) {
        pageReferences.set(reference.id, { targetId: reference.id, excerpt: excerpt(node, reference.label) });
      }
    }
    for (const mention of node.mentions) {
      parts.push(mention.label);
      if (!memberMentions.has(mention.id)) {
        memberMentions.set(mention.id, { targetId: mention.id, excerpt: excerpt(node, `@${mention.label}`) });
      }
    }
  }
  for (const edge of diagram.edges) parts.push(edge.label);
  return {
    plainText: normalized(parts.join(" ")).slice(0, MAX_PLAIN_TEXT),
    pageReferences: [...pageReferences.values()],
    memberMentions: [...memberMentions.values()],
  };
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function compact(value: number) {
  return Number(value.toFixed(2));
}

function diagramBounds(nodes: readonly DiagramNode[]) {
  if (!nodes.length) return { x: 0, y: 0, width: 960, height: 540 };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  const padding = 36;
  return {
    x: compact(left - padding),
    y: compact(top - padding),
    width: compact(Math.max(1, right - left + padding * 2)),
    height: compact(Math.max(1, bottom - top + padding * 2)),
  };
}

function fittedBounds(nodes: readonly DiagramNode[], ratio?: number) {
  const bounds = diagramBounds(nodes);
  if (!ratio) return bounds;
  const current = bounds.width / bounds.height;
  if (current > ratio) {
    const height = bounds.width / ratio;
    return { ...bounds, y: compact(bounds.y - (height - bounds.height) / 2), height: compact(height) };
  }
  const width = bounds.height * ratio;
  return { ...bounds, x: compact(bounds.x - (width - bounds.width) / 2), width: compact(width) };
}

function handlePoint(node: DiagramNode, handle: DiagramEdge["sourceHandle"]) {
  if (handle === "top") return { x: node.x + node.width / 2, y: node.y };
  if (handle === "bottom") return { x: node.x + node.width / 2, y: node.y + node.height };
  if (handle === "left") return { x: node.x, y: node.y + node.height / 2 };
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function edgePath(edge: DiagramEdge, source: DiagramNode, target: DiagramNode) {
  const start = handlePoint(source, edge.sourceHandle);
  const end = handlePoint(target, edge.targetHandle);
  if (edge.path === "straight")
    return `M ${compact(start.x)} ${compact(start.y)} L ${compact(end.x)} ${compact(end.y)}`;
  if (edge.path === "smoothstep") {
    const offset = Math.max(48, Math.abs(end.x - start.x) / 2);
    const sourceDirection = edge.sourceHandle === "left" ? -1 : edge.sourceHandle === "right" ? 1 : 0;
    const targetDirection = edge.targetHandle === "left" ? -1 : edge.targetHandle === "right" ? 1 : 0;
    return `M ${compact(start.x)} ${compact(start.y)} C ${compact(start.x + sourceDirection * offset)} ${compact(start.y)}, ${compact(end.x + targetDirection * offset)} ${compact(end.y)}, ${compact(end.x)} ${compact(end.y)}`;
  }
  const vertical = edge.sourceHandle === "top" || edge.sourceHandle === "bottom";
  if (vertical) {
    const middle = compact((start.y + end.y) / 2);
    return `M ${compact(start.x)} ${compact(start.y)} L ${compact(start.x)} ${middle} L ${compact(end.x)} ${middle} L ${compact(end.x)} ${compact(end.y)}`;
  }
  const middle = compact((start.x + end.x) / 2);
  return `M ${compact(start.x)} ${compact(start.y)} L ${middle} ${compact(start.y)} L ${middle} ${compact(end.y)} L ${compact(end.x)} ${compact(end.y)}`;
}

function shapeMarkup(node: DiagramNode, assetHref?: (assetId: string) => string | null) {
  const { fill, stroke } = PALETTE[node.color];
  const x = compact(node.x);
  const y = compact(node.y);
  const width = compact(node.width);
  const height = compact(node.height);
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="2"`;
  if (node.type === "decision") {
    return `<polygon points="${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}" ${common}/>`;
  }
  if (node.type === "database") {
    const cap = Math.min(18, height / 5);
    return `<path d="M ${x} ${y + cap} A ${width / 2} ${cap} 0 0 1 ${x + width} ${y + cap} V ${y + height - cap} A ${width / 2} ${cap} 0 0 1 ${x} ${y + height - cap} Z" ${common}/><ellipse cx="${x + width / 2}" cy="${y + cap}" rx="${width / 2}" ry="${cap}" ${common}/>`;
  }
  if (node.type === "queue") {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" ${common}/><path d="M ${x + 24} ${y} V ${y + height} M ${x + width - 24} ${y} V ${y + height}" fill="none" stroke="${stroke}" stroke-width="2"/>`;
  }
  if (node.type === "document") {
    return `<path d="M ${x} ${y} H ${x + width} V ${y + height - 16} Q ${x + width * 0.75} ${y + height - 32} ${x + width / 2} ${y + height - 16} Q ${x + width * 0.25} ${y + height} ${x} ${y + height - 16} Z" ${common}/>`;
  }
  if (node.type === "cloud") {
    return `<path d="M ${x + width * 0.2} ${y + height * 0.78} C ${x - 4} ${y + height * 0.7} ${x + width * 0.03} ${y + height * 0.42} ${x + width * 0.25} ${y + height * 0.42} C ${x + width * 0.3} ${y + height * 0.08} ${x + width * 0.7} ${y + height * 0.05} ${x + width * 0.76} ${y + height * 0.4} C ${x + width * 1.02} ${y + height * 0.42} ${x + width * 1.03} ${y + height * 0.74} ${x + width * 0.8} ${y + height * 0.78} Z" ${common}/>`;
  }
  if (node.type === "actor") {
    const cx = x + width / 2;
    return `<circle cx="${cx}" cy="${y + 22}" r="18" ${common}/><path d="M ${cx} ${y + 40} V ${y + 78} M ${x + 18} ${y + 55} H ${x + width - 18} M ${cx} ${y + 78} L ${x + 24} ${y + height} M ${cx} ${y + 78} L ${x + width - 24} ${y + height}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>`;
  }
  if (node.type === "device") {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" ${common}/><line x1="${x + width * 0.35}" y1="${y + height - 12}" x2="${x + width * 0.65}" y2="${y + height - 12}" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>`;
  }
  if (node.type === "frame") {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="${fill}" fill-opacity="0.35" stroke="${stroke}" stroke-width="2" stroke-dasharray="8 6"/>`;
  }
  if (node.type === "text") return "";
  if (node.type === "image") {
    const href = node.assetId ? assetHref?.(node.assetId) : null;
    return href
      ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" ${common}/><image href="${escapeXml(href)}" x="${x + 4}" y="${y + 4}" width="${Math.max(1, width - 8)}" height="${Math.max(1, height - 8)}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" ${common}/><path d="M ${x + width * 0.2} ${y + height * 0.72} L ${x + width * 0.42} ${y + height * 0.45} L ${x + width * 0.58} ${y + height * 0.62} L ${x + width * 0.72} ${y + height * 0.42} L ${x + width * 0.86} ${y + height * 0.72} Z" fill="none" stroke="${stroke}" stroke-width="2"/><circle cx="${x + width * 0.72}" cy="${y + height * 0.28}" r="7" fill="${stroke}"/>`;
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${node.type === "service" ? 18 : 4}" ${common}/>`;
}

function nodeLabel(node: DiagramNode) {
  if (!node.label) return "";
  const { text: textColor } = PALETTE[node.color];
  const value = node.label.replace(/\s+/g, " ").trim().slice(0, 100);
  const midpoint = compact(node.x + node.width / 2);
  const baseline = compact(node.y + node.height / 2 + 5);
  return `<text x="${midpoint}" y="${baseline}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${textColor}">${escapeXml(value)}</text>`;
}

export type DiagramRenderOptions = {
  width?: number;
  height?: number;
  title?: string;
  assetHref?: (assetId: string) => string | null;
};

function renderIdentifier(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > DIAGRAM_RENDER_MAX_IDENTIFIER) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function finiteDiagramNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function diagramDimension(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(4_096, value)) : undefined;
}

function renderableDiagram(diagram: Pick<DiagramContentEnvelope, "nodes" | "edges">) {
  if (!Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) return false;
  if (diagram.nodes.length > DIAGRAM_RENDER_MAX_NODES || diagram.edges.length > DIAGRAM_RENDER_MAX_EDGES) return false;
  for (const node of diagram.nodes) {
    if (
      !renderIdentifier(node.id) ||
      !NODE_TYPES.has(node.type) ||
      !COLORS.has(node.color) ||
      !finiteDiagramNumber(node.x) ||
      !finiteDiagramNumber(node.y) ||
      !finiteDiagramNumber(node.width) ||
      !finiteDiagramNumber(node.height) ||
      !finiteDiagramNumber(node.zIndex) ||
      node.width < 1 ||
      node.height < 1 ||
      typeof node.label !== "string" ||
      node.label.length > MAX_TEXT ||
      typeof node.notes !== "string" ||
      node.notes.length > MAX_TEXT ||
      (node.parentId !== null && !renderIdentifier(node.parentId)) ||
      (node.assetId !== null && !renderIdentifier(node.assetId))
    )
      return false;
  }
  for (const edge of diagram.edges) {
    if (
      !renderIdentifier(edge.id) ||
      !renderIdentifier(edge.source) ||
      !renderIdentifier(edge.target) ||
      !HANDLES.has(edge.sourceHandle) ||
      !HANDLES.has(edge.targetHandle) ||
      !PATHS.has(edge.path) ||
      !COLORS.has(edge.color) ||
      typeof edge.label !== "string" ||
      edge.label.length > MAX_TEXT
    )
      return false;
  }
  return true;
}

function renderDiagramSvgUnchecked(
  diagram: Pick<DiagramContentEnvelope, "nodes" | "edges">,
  options: DiagramRenderOptions & { message?: string },
) {
  const ratio = options.width && options.height ? options.width / options.height : undefined;
  const bounds = fittedBounds(diagram.nodes, ratio);
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const edges = diagram.edges
    .map((edge) => {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!source || !target) return "";
      const palette = PALETTE[edge.color];
      const start = handlePoint(source, edge.sourceHandle);
      const end = handlePoint(target, edge.targetHandle);
      const marker = edge.arrow ? ' marker-end="url(#diagram-arrow)"' : "";
      const label = edge.label
        ? `<text x="${compact((start.x + end.x) / 2)}" y="${compact((start.y + end.y) / 2 - 7)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="${palette.text}" paint-order="stroke" stroke="#fff" stroke-width="4">${escapeXml(edge.label.slice(0, 100))}</text>`
        : "";
      return `<path d="${edgePath(edge, source, target)}" fill="none" stroke="${palette.stroke}" stroke-width="2"${marker}/>${label}`;
    })
    .join("");
  const shapes = [...diagram.nodes]
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
    .map(
      (node) => `<g data-node-id="${escapeXml(node.id)}">${shapeMarkup(node, options.assetHref)}${nodeLabel(node)}</g>`,
    )
    .join("");
  const width = options.width ? ` width="${Math.round(options.width)}"` : "";
  const height = options.height ? ` height="${Math.round(options.height)}"` : "";
  const message = options.message
    ? `<text x="${compact(bounds.x + bounds.width / 2)}" y="${compact(bounds.y + bounds.height / 2)}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="18" fill="#475569">${escapeXml(options.message)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${width}${height} viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" role="img" aria-label="${escapeXml(options.title ?? "Diagram")}"><title>${escapeXml(options.title ?? "Diagram")}</title><defs><marker id="diagram-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker></defs><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="#fff"/>${message}${edges}${shapes}</svg>`;
}

export function renderDiagramSvg(
  diagram: Pick<DiagramContentEnvelope, "nodes" | "edges">,
  options: DiagramRenderOptions = {},
) {
  const width = diagramDimension(options.width);
  const height = diagramDimension(options.height);
  const safeOptions: DiagramRenderOptions = {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    title: (options.title ?? "Diagram").slice(0, DIAGRAM_RENDER_MAX_TITLE),
    ...(options.assetHref
      ? {
          assetHref: (assetId: string) => {
            const href = options.assetHref?.(assetId);
            return href && href.length <= DIAGRAM_RENDER_MAX_ASSET_HREF ? href : null;
          },
        }
      : {}),
  };
  const fallback = () =>
    renderDiagramSvgUnchecked(
      { nodes: [], edges: [] },
      {
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        title: "Diagram preview unavailable",
        message: "Diagram preview unavailable",
      },
    );
  try {
    if (!renderableDiagram(diagram)) return fallback();
    const rendered = renderDiagramSvgUnchecked(diagram, safeOptions);
    return new TextEncoder().encode(rendered).byteLength <= DIAGRAM_RENDER_MAX_SVG_BYTES ? rendered : fallback();
  } catch {
    return fallback();
  }
}
