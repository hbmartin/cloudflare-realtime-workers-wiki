import { memo } from "react";
import { Handle, MarkerType, NodeResizer, Position, type Node, type Edge, type NodeProps } from "@xyflow/react";
import type { DiagramNode, DiagramEdge, DiagramNodeType } from "../shared/types";

export type DiagramNodeData = {
  record: DiagramNode;
  editable: boolean;
  commentCount: number;
  updateLabel: (id: string, label: string) => void;
};
export type FlowNode = Node<DiagramNodeData, "diagram">;
export type FlowEdge = Edge<{ record: DiagramEdge }, "default" | "straight" | "smoothstep">;

function StencilShape({ type }: { type: DiagramNodeType }) {
  if (type === "decision") return <polygon points="50,2 98,35 50,68 2,35" />;
  if (type === "database") return <path d="M3 13C3 5 97 5 97 13v43c0 10-94 10-94 0Zm0 0c0 10 94 10 94 0" />;
  if (type === "queue") return <path d="M2 8h96v54H2Zm16 0v54M82 8v54" />;
  if (type === "document") return <path d="M2 3h96v51c-20-12-31 12-48 3S21 65 2 56Z" />;
  if (type === "cloud") return <path d="M18 58C-2 49 5 28 24 29 29 3 69-1 76 27c22 1 29 24 8 31Z" />;
  if (type === "actor")
    return <path d="M50 2a13 13 0 1 1 0 26 13 13 0 0 1 0-26Zm0 26v25M24 39h52M50 53 30 69m20-16 20 16" />;
  if (type === "device") return <path d="M12 3h76v64H12Zm25 55h26" />;
  if (type === "frame") return <rect x="2" y="2" width="96" height="66" rx="5" strokeDasharray="7 5" />;
  if (type === "text") return null;
  if (type === "image") return <path d="M2 2h96v66H2Zm13 52 22-23 18 16 13-12 18 19M72 17h.1" />;
  return <rect x="2" y="2" width="96" height="66" rx={type === "service" ? 15 : 4} />;
}

const DiagramNodeView = memo(function DiagramNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const record = data.record;
  return (
    <div className={`diagram-node diagram-node-${record.type} color-${record.color}`}>
      <NodeResizer isVisible={selected && data.editable} minWidth={40} minHeight={32} />
      <svg viewBox="0 0 100 70" aria-hidden="true">
        <StencilShape type={record.type} />
      </svg>
      {record.type === "image" && record.assetId ? (
        <img src={`/api/attachments/${encodeURIComponent(record.assetId)}`} alt="" draggable={false} />
      ) : null}
      <input
        className="nodrag"
        aria-label="Node label"
        value={record.label}
        readOnly={!data.editable}
        placeholder={record.type === "text" ? "Text" : record.type === "frame" ? "Frame" : "Label"}
        onChange={(event) => data.updateLabel(id, event.target.value)}
      />
      {data.commentCount ? <span className="diagram-comment-count">{data.commentCount}</span> : null}
      {(["top", "right", "bottom", "left"] as const).flatMap((handle) => {
        const position =
          handle === "top"
            ? Position.Top
            : handle === "right"
              ? Position.Right
              : handle === "bottom"
                ? Position.Bottom
                : Position.Left;
        return [
          <Handle
            key={`target-${handle}`}
            id={handle}
            type="target"
            position={position}
            isConnectable={data.editable}
          />,
          <Handle
            key={`source-${handle}`}
            id={handle}
            type="source"
            position={position}
            isConnectable={data.editable}
          />,
        ];
      })}
    </div>
  );
});

export const nodeTypes = { diagram: DiagramNodeView } as const;

export function flowEdge(edge: DiagramEdge): FlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.label,
    type: edge.path === "step" ? "default" : edge.path,
    markerEnd: edge.arrow ? { type: MarkerType.ArrowClosed } : undefined,
    data: { record: edge },
  };
}
