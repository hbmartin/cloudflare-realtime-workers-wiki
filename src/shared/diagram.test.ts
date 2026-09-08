import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
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
    const diagram = { nodes: [first, second], edges: [edge] };
    const svg = renderDiagramSvg(diagram, { width: 960, height: 540, title: "System & data" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("System &amp; data");
    expect(svg).toContain("API &lt;gateway&gt;");
    expect(svg).not.toContain("<script");
    expect(renderDiagramSvg(diagram, { width: 960, height: 540 })).toBe(
      renderDiagramSvg(diagram, { width: 960, height: 540 }),
    );
  });
});
