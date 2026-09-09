import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  DIAGRAM_RENDER_MAX_NODES,
  DIAGRAM_RENDER_MAX_SVG_BYTES,
  diagramEdgeMap,
  diagramFromYDoc,
  diagramNodeMap,
  diagramRoots,
  projectDiagram,
  renderDiagramSvg,
} from "./diagram";
import type { DiagramEdge, DiagramNode } from "./types";

const first: DiagramNode = {
  id: "node-one",
  type: "service",
  x: 20,
  y: 30,
  width: 160,
  height: 80,
  zIndex: 1,
  parentId: null,
  label: "API <gateway>",
  notes: "Routes requests",
  color: "blue",
  assetId: null,
  references: [{ id: "page-architecture", label: "Architecture" }],
  mentions: [{ id: "user-alex", label: "Alex" }],
};

const second: DiagramNode = {
  ...first,
  id: "node-two",
  type: "database",
  x: 320,
  label: "Primary database",
  notes: "",
  color: "green",
  references: [],
  mentions: [],
};

const edge: DiagramEdge = {
  id: "edge-one",
  source: first.id,
  target: second.id,
  sourceHandle: "right",
  targetHandle: "left",
  path: "step",
  label: "writes",
  color: "slate",
  arrow: true,
};

describe("diagram projection", () => {
  it("round-trips the shared Yjs schema and indexes labels, notes, links, and mentions", () => {
    const document = new Y.Doc();
    const roots = diagramRoots(document);
    roots.nodes.set(first.id, diagramNodeMap(first));
    roots.nodes.set(second.id, diagramNodeMap(second));
    roots.edges.set(edge.id, diagramEdgeMap(edge));

    const diagram = diagramFromYDoc(document, { pageId: "diagram-one", contentEpoch: 3, sequence: 7 });
    expect(diagram).toMatchObject({ pageId: "diagram-one", contentEpoch: 3, sequence: 7 });
    expect(diagram.nodes).toHaveLength(2);
    expect(diagram.edges).toEqual([edge]);

    const projection = projectDiagram(diagram);
    expect(projection.plainText).toContain("API <gateway> Routes requests Architecture Alex");
    expect(projection.pageReferences).toEqual([expect.objectContaining({ targetId: "page-architecture" })]);
    expect(projection.memberMentions).toEqual([expect.objectContaining({ targetId: "user-alex" })]);
  });

  it("renders a deterministic, escaped SVG without executable markup", () => {
    const escapedFirst = { ...first, id: 'node-"one&', type: "image" as const, assetId: "asset-one" };
    const escapedSecond = { ...second, id: "node-two" };
    const escapedEdge = { ...edge, source: escapedFirst.id, target: escapedSecond.id, label: 'writes & says "yes"' };
    const diagram = { nodes: [escapedFirst, escapedSecond], edges: [escapedEdge] };
    const options = {
      width: 960,
      height: 540,
      title: 'System & "data"',
      assetHref: () => 'https://example.test/image?a=1&label="unsafe"',
    };
    const svg = renderDiagramSvg(diagram, options);
    expect(svg).toContain("<svg");
    expect(svg).toContain("System &amp; &quot;data&quot;");
    expect(svg).toContain("API &lt;gateway&gt;");
    expect(svg).toContain('data-node-id="node-&quot;one&amp;"');
    expect(svg).toContain('href="https://example.test/image?a=1&amp;label=&quot;unsafe&quot;"');
    expect(svg).toContain("writes &amp; says &quot;yes&quot;");
    expect(svg).not.toContain("<script");
    expect(renderDiagramSvg(diagram, options)).toBe(renderDiagramSvg(diagram, options));
  });

  it("returns a small deterministic fallback when render work or output exceeds its bounds", () => {
    const oversized = {
      nodes: Array.from({ length: DIAGRAM_RENDER_MAX_NODES + 1 }, (_, index) => ({
        ...first,
        id: `node-${index}`,
      })),
      edges: [],
    };

    const firstFallback = renderDiagramSvg(oversized, { width: 960, height: 540, title: "Too large" });
    const secondFallback = renderDiagramSvg(oversized, { width: 960, height: 540, title: "Too large" });
    expect(firstFallback).toBe(secondFallback);
    expect(firstFallback).toContain("Diagram preview unavailable");
    expect(firstFallback).not.toContain("node-0");
    expect(new TextEncoder().encode(firstFallback).byteLength).toBeLessThan(DIAGRAM_RENDER_MAX_SVG_BYTES);
    expect(() =>
      renderDiagramSvg({ nodes: [null] as unknown as DiagramNode[], edges: [] }, { title: "Malformed" }),
    ).not.toThrow();
    expect(renderDiagramSvg({ nodes: [null] as unknown as DiagramNode[], edges: [] })).toContain(
      "Diagram preview unavailable",
    );
  });
});
