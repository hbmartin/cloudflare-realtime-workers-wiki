import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { nodeTypes, flowEdge, type FlowNode, type FlowEdge } from "./diagram-rendering";
import { subscribeDiagramEmbed, type DiagramEmbedState } from "./diagram-embed-pool";

const noEdit = () => {};
export function LiveDiagramEmbed({ account, pageId, title }: { account: string; pageId: string; title: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DiagramEmbedState>({ page: null, records: null, status: "connecting" });
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    let inView = false;
    let unsubscribe: (() => void) | undefined;
    const update = () => {
      const enabled = inView && document.visibilityState !== "hidden";
      if (enabled && !unsubscribe)
        unsubscribe = subscribeDiagramEmbed(account, pageId, (next) =>
          setState((previous) =>
            next.status === "connecting" &&
            !next.records &&
            previous.records &&
            (!next.page || next.page.contentEpoch === previous.records.contentEpoch)
              ? { ...next, page: next.page ?? previous.page, records: previous.records }
              : next,
          ),
        );
      if (!enabled && unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
        setState((previous) => ({
          ...previous,
          status: previous.status === "unavailable" ? "unavailable" : "offline",
        }));
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      unsubscribe?.();
      document.removeEventListener("visibilitychange", update);
    };
  }, [account, pageId]);
  const nodes = useMemo<FlowNode[]>(
    () =>
      (state.records?.nodes ?? []).map((record) => ({
        id: record.id,
        type: "diagram",
        position: { x: record.x, y: record.y },
        width: record.width,
        height: record.height,
        zIndex: record.type === "frame" ? -1 : record.zIndex,
        data: { account, record, editable: false, commentCount: 0, updateLabel: noEdit },
      })),
    [state.records, account],
  );
  const edges = useMemo(() => (state.records?.edges ?? []).map(flowEdge), [state.records]);
  return (
    <div ref={container} className="live-diagram-embed" aria-label={`Live diagram: ${state.page?.title ?? title}`}>
      {state.records ? (
        <div className="live-diagram-canvas">
          <ReactFlowProvider>
            <ReactFlow<FlowNode, FlowEdge>
              key={`${pageId}:${state.records.contentEpoch}`}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              proOptions={{ hideAttribution: true }}
              nodesFocusable={false}
              edgesFocusable={false}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              preventScrolling={false}
              zoomOnScroll={false}
              panOnScroll={false}
              zoomOnPinch
              panOnDrag
              fitView
              minZoom={0.1}
              maxZoom={4}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      ) : state.status === "unavailable" ? (
        <p>Diagram unavailable</p>
      ) : (
        <img
          src={`/api/pages/${encodeURIComponent(pageId)}/diagram-thumbnail.svg`}
          alt="Diagram preview"
          loading="lazy"
        />
      )}
      <div className="live-diagram-caption">
        <span aria-live="polite">
          {state.status === "connected"
            ? "Live"
            : state.status === "offline"
              ? "Offline — last available view"
              : state.status === "unavailable"
                ? "Unavailable"
                : "Connecting…"}
        </span>
        {state.status !== "unavailable" && <a href={`/?page=${encodeURIComponent(pageId)}`}>Open diagram</a>}
      </div>
    </div>
  );
}
