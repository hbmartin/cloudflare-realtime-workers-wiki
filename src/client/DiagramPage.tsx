import {
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import * as Y from "yjs";
import {
  DEFAULT_NODE_SIZE,
  diagramEdgeMap,
  diagramFromYDoc,
  diagramNodeMap,
  diagramRoots,
  renderDiagramSvg,
} from "../shared/diagram";
import type {
  ClientMemberContext,
  CommentAnchor,
  CommentThread,
  DiagramColor,
  DiagramEdge,
  DiagramNode,
  DiagramNodeType,
  MentionSuggestion,
  Page,
} from "../shared/types";
import { ApiClientError, api, apiErrorMessage, json } from "./api";
import { BacklinksPanel } from "./BacklinksPanel";
import { createNetworkCollaboration, type NetworkCollaborationBundle, userColor } from "./collaboration";
import { uploadAttachment } from "./uploads";

export type DiagramPageProps = {
  page: Page;
  member: ClientMemberContext;
  onPageChanged: (page: Page) => void;
  onPageUnavailable: (pageId: string) => void;
  onAccessDenied: (pageId: string, error: ApiClientError) => void;
  onSelectPage: (pageId: string) => void;
  backlinksRevision: number;
  commentsRevision?: number;
};

type DiagramNodeData = {
  record: DiagramNode;
  editable: boolean;
  commentCount: number;
  updateLabel: (id: string, label: string) => void;
};
type FlowNode = Node<DiagramNodeData, "diagram">;
type FlowEdge = Edge<{ record: DiagramEdge }, "default" | "straight" | "smoothstep">;

const STENCILS: Array<{ type: DiagramNodeType; label: string; icon: string }> = [
  { type: "process", label: "Process", icon: "▭" },
  { type: "service", label: "Service", icon: "▢" },
  { type: "decision", label: "Decision", icon: "◇" },
  { type: "database", label: "Database", icon: "◉" },
  { type: "queue", label: "Queue", icon: "▤" },
  { type: "document", label: "Document", icon: "▱" },
  { type: "cloud", label: "Cloud", icon: "☁" },
  { type: "actor", label: "Actor", icon: "♙" },
  { type: "device", label: "Device", icon: "▣" },
  { type: "text", label: "Text", icon: "T" },
  { type: "frame", label: "Frame", icon: "▧" },
];
const COLORS: DiagramColor[] = ["slate", "blue", "green", "amber", "red", "purple"];
const LOCAL_ORIGIN = Symbol("diagram-local");

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

const nodeTypes = { diagram: DiagramNodeView } as const;

function replaceYText(map: Y.Map<unknown>, key: string, value: string) {
  const current = map.get(key);
  if (current instanceof Y.Text) {
    current.delete(0, current.length);
    if (value) current.insert(0, value);
  }
}

function newNode(type: DiagramNodeType, index: number, assetId: string | null = null): DiagramNode {
  const size = DEFAULT_NODE_SIZE[type];
  return {
    id: crypto.randomUUID(),
    type,
    x: 80 + (index % 5) * 32,
    y: 80 + (index % 5) * 32,
    width: size.width,
    height: size.height,
    zIndex: index,
    parentId: null,
    label: type === "image" ? "Image" : (STENCILS.find((item) => item.type === type)?.label ?? "Node"),
    notes: "",
    color: "slate",
    assetId,
    references: [],
    mentions: [],
  };
}

function flowEdge(edge: DiagramEdge): FlowEdge {
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

function simpleCommentBody(value: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: value ? [{ type: "text", text: value }] : [] }],
  };
}

function DiagramComments({
  pageId,
  revision,
  anchor,
  online,
}: {
  pageId: string;
  revision: number;
  anchor: CommentAnchor | null;
  online: boolean;
}) {
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [draft, setDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void api<{ threads: CommentThread[] }>(`/api/pages/${pageId}/comments`)
      .then((data) => {
        setThreads(data.threads);
        setError("");
      })
      .catch((cause) => setError(apiErrorMessage(cause, "Comments could not be loaded.")));
  }, [pageId]);
  useEffect(load, [load, revision]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    try {
      await api(`/api/pages/${pageId}/comments`, {
        method: "POST",
        body: json({ initialComment: { body: simpleCommentBody(draft.trim()) }, anchor }),
      });
      setDraft("");
      load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The comment could not be added."));
    }
  }

  async function reply(event: FormEvent, threadId: string) {
    event.preventDefault();
    const value = replyDrafts[threadId]?.trim();
    if (!value) return;
    try {
      await api(`/api/comment-threads/${encodeURIComponent(threadId)}/replies`, {
        method: "POST",
        body: json({ comment: { body: simpleCommentBody(value) } }),
      });
      setReplyDrafts((current) => ({ ...current, [threadId]: "" }));
      load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The reply could not be added."));
    }
  }

  return (
    <aside className="side-panel diagram-comments-panel">
      <h2>Comments</h2>
      <p className="muted">
        {anchor ? `Commenting on ${anchor.target} ${anchor.targetId.slice(0, 8)}` : "Page-level conversation"}
      </p>
      <form onSubmit={(event) => void create(event)}>
        <textarea
          disabled={!online}
          aria-label="Comment content"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
        />
        <button className="primary-small" disabled={!online || !draft.trim()}>
          Add comment
        </button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="diagram-thread-list">
        {threads.map((thread) => (
          <article key={thread.id} className={thread.resolvedAt ? "resolved" : ""}>
            <small>
              {thread.anchor
                ? `${thread.anchor.target} comment`
                : thread.anchored
                  ? "Document selection"
                  : "Page comment"}
            </small>
            {thread.comments.map((comment) => (
              <p key={comment.id}>
                <strong>{comment.user.name}</strong> {comment.deletedAt ? "Comment deleted" : comment.plainText}
              </p>
            ))}
            <form onSubmit={(event) => void reply(event, thread.id)}>
              <input
                aria-label="Write a reply"
                disabled={!online}
                value={replyDrafts[thread.id] ?? ""}
                onChange={(event) => setReplyDrafts((current) => ({ ...current, [thread.id]: event.target.value }))}
              />
              <button className="quiet-button" disabled={!online || !replyDrafts[thread.id]?.trim()}>
                Reply
              </button>
            </form>
            <button
              className="quiet-button"
              disabled={!online || !thread.canResolve}
              onClick={() =>
                void api(`/api/comment-threads/${thread.id}/${thread.resolvedAt ? "reopen" : "resolve"}`, {
                  method: "POST",
                }).then(load)
              }
            >
              {thread.resolvedAt ? "Reopen" : "Resolve"}
            </button>
          </article>
        ))}
        {!threads.length ? <p className="empty-copy">No comments yet.</p> : null}
      </div>
    </aside>
  );
}

type Version = { id: string; title: string; epoch: number; sequence: number; byteSize: number; createdAt: number };

function DiagramHistory({
  page,
  member,
  onRestored,
  onError,
}: {
  page: Page;
  member: ClientMemberContext;
  onRestored: (epoch: number) => void;
  onError: (message: string) => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<Version | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ versions: Version[] }>(`/api/pages/${page.id}/versions`)
      .then((data) => setVersions(data.versions))
      .catch((cause) => onError(apiErrorMessage(cause, "Diagram history could not be loaded.")));
  }, [onError, page.id]);
  async function choose(version: Version) {
    try {
      const response = await fetch(`/api/versions/${version.id}`);
      if (!response.ok) {
        throw new ApiClientError(response.status, "version_unavailable", "The diagram version could not be loaded.");
      }
      const snapshot = new Uint8Array(await response.arrayBuffer());
      const document = new Y.Doc();
      try {
        Y.applyUpdate(document, snapshot);
        const diagram = diagramFromYDoc(document, {
          pageId: page.id,
          contentEpoch: version.epoch,
          sequence: version.sequence,
        });
        setSelected(version);
        setPreview(
          renderDiagramSvg(diagram, {
            width: 560,
            height: 315,
            title: version.title,
            assetHref: (id) => `/api/attachments/${id}`,
          }),
        );
        onError("");
      } finally {
        document.destroy();
      }
    } catch (cause) {
      onError(apiErrorMessage(cause, "The diagram version could not be loaded."));
    }
  }
  async function restore() {
    if (!selected || !confirm(`Restore this diagram from ${new Date(selected.createdAt).toLocaleString()}?`)) return;
    setBusy(true);
    try {
      const result = await api<{ contentEpoch: number }>(`/api/pages/${page.id}/restore-version`, {
        method: "POST",
        body: json({ versionId: selected.id }),
      });
      onRestored(result.contentEpoch);
      onError("");
    } catch (cause) {
      onError(apiErrorMessage(cause, "The diagram version could not be restored."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="side-panel history-panel diagram-history-panel">
      <h2>History</h2>
      <p className="muted">Automatic snapshots are kept for 30 days, up to 200.</p>
      <div className="version-list">
        {versions.map((version) => (
          <button
            key={version.id}
            className={selected?.id === version.id ? "selected" : ""}
            onClick={() => void choose(version)}
          >
            <strong>{new Date(version.createdAt).toLocaleString()}</strong>
            <span>
              {(version.byteSize / 1024).toFixed(1)} KiB · epoch {version.epoch}
            </span>
          </button>
        ))}
        {!versions.length ? <p className="empty-copy">No compacted versions yet.</p> : null}
      </div>
      {preview ? <div className="diagram-history-preview" dangerouslySetInnerHTML={{ __html: preview }} /> : null}
      {member.role === "owner" && selected ? (
        <button className="danger-button" disabled={busy} onClick={() => void restore()}>
          {busy ? "Restoring…" : "Restore this version"}
        </button>
      ) : null}
    </aside>
  );
}

function EntityPicker({
  kind,
  onChoose,
}: {
  kind: "page" | "user";
  onChoose: (suggestion: MentionSuggestion) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  useEffect(() => {
    if (!query.trim()) {
      return undefined;
    }
    const controller = new AbortController();
    void api<{ suggestions: MentionSuggestion[] }>(`/api/mentions/suggestions?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
    })
      .then((data) => setSuggestions(data.suggestions.filter((item) => item.entityType === kind)))
      .catch(() => setSuggestions([]));
    return () => controller.abort();
  }, [kind, query]);
  const visibleSuggestions = query.trim() ? suggestions : [];
  return (
    <div className="diagram-entity-picker">
      <input
        aria-label={kind === "page" ? "Find a page" : "Find a member"}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={kind === "page" ? "Link page…" : "Mention member…"}
      />
      {visibleSuggestions.length ? (
        <div className="diagram-suggestions">
          {visibleSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.entityType}:${suggestion.entityId}`}
              onClick={() => {
                onChoose(suggestion);
                setQuery("");
                setSuggestions([]);
              }}
            >
              <strong>{suggestion.label}</strong>
              <small>{suggestion.detail}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DiagramInspector({
  selectedNode,
  selectedEdge,
  frames,
  updateNode,
  updateEdge,
}: {
  selectedNode: DiagramNode | null;
  selectedEdge: DiagramEdge | null;
  frames: DiagramNode[];
  updateNode: (id: string, patch: Partial<DiagramNode>) => void;
  updateEdge: (id: string, patch: Partial<DiagramEdge>) => void;
}) {
  if (!selectedNode && !selectedEdge)
    return (
      <aside className="diagram-inspector">
        <p className="muted">Select a node or connector to edit its details.</p>
      </aside>
    );
  if (selectedEdge) {
    return (
      <aside className="diagram-inspector">
        <h3>Connector</h3>
        <label>
          Label
          <input
            value={selectedEdge.label}
            onChange={(event) => updateEdge(selectedEdge.id, { label: event.target.value })}
          />
        </label>
        <label>
          Path
          <select
            value={selectedEdge.path}
            onChange={(event) => updateEdge(selectedEdge.id, { path: event.target.value as DiagramEdge["path"] })}
          >
            <option value="step">Orthogonal</option>
            <option value="straight">Straight</option>
            <option value="smoothstep">Smooth</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={selectedEdge.arrow}
            onChange={(event) => updateEdge(selectedEdge.id, { arrow: event.target.checked })}
          />{" "}
          Arrow head
        </label>
      </aside>
    );
  }
  const node = selectedNode!;
  const addLink = (suggestion: MentionSuggestion) => {
    const key = suggestion.entityType === "page" ? "references" : "mentions";
    const values = node[key];
    if (!values.some((value) => value.id === suggestion.entityId)) {
      updateNode(node.id, { [key]: [...values, { id: suggestion.entityId, label: suggestion.label }] });
    }
  };
  return (
    <aside className="diagram-inspector">
      <h3>{node.type[0]!.toUpperCase() + node.type.slice(1)}</h3>
      <label>
        Notes
        <textarea
          value={node.notes}
          rows={4}
          onChange={(event) => updateNode(node.id, { notes: event.target.value })}
        />
      </label>
      <label>
        Color
        <select
          value={node.color}
          onChange={(event) => updateNode(node.id, { color: event.target.value as DiagramColor })}
        >
          {COLORS.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      {node.type !== "frame" ? (
        <label>
          Frame
          <select
            value={node.parentId ?? ""}
            onChange={(event) => updateNode(node.id, { parentId: event.target.value || null })}
          >
            <option value="">None</option>
            {frames
              .filter((frame) => frame.id !== node.id)
              .map((frame) => (
                <option key={frame.id} value={frame.id}>
                  {frame.label || "Untitled frame"}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <h4>Page links</h4>
      <EntityPicker kind="page" onChoose={addLink} />
      <div className="diagram-chips">
        {node.references.map((reference) => (
          <button
            key={reference.id}
            title="Remove link"
            onClick={() =>
              updateNode(node.id, { references: node.references.filter((item) => item.id !== reference.id) })
            }
          >
            {reference.label} ×
          </button>
        ))}
      </div>
      <h4>Mentions</h4>
      <EntityPicker kind="user" onChoose={addLink} />
      <div className="diagram-chips">
        {node.mentions.map((mention) => (
          <button
            key={mention.id}
            title="Remove mention"
            onClick={() => updateNode(node.id, { mentions: node.mentions.filter((item) => item.id !== mention.id) })}
          >
            @{mention.label} ×
          </button>
        ))}
      </div>
    </aside>
  );
}

type RemotePresence = { clientId: number; name: string; color: string; cursor?: { x: number; y: number } };

function DiagramCanvas({
  bundle,
  page,
  member,
  editable,
  synced,
  comments,
  onSelection,
  onError,
}: {
  bundle: NetworkCollaborationBundle;
  page: Page;
  member: ClientMemberContext;
  editable: boolean;
  synced: boolean;
  comments: CommentThread[];
  onSelection: (anchor: CommentAnchor | null) => void;
  onError: (message: string) => void;
}) {
  const transactionOrigin = useMemo(() => ({ type: LOCAL_ORIGIN }), []);
  const selectedNodes = useRef(new Set<string>());
  const selectedEdges = useRef(new Set<string>());
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [records, setRecords] = useState(() =>
    diagramFromYDoc(bundle.doc, { pageId: page.id, contentEpoch: page.contentEpoch }),
  );
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const [remote, setRemote] = useState<RemotePresence[]>([]);
  const imageInput = useRef<HTMLInputElement>(null);
  const clipboard = useRef<{ nodes: DiagramNode[]; edges: DiagramEdge[] } | null>(null);
  const canInsertNode = useRef(editable && synced);
  const roots = useMemo(() => diagramRoots(bundle.doc), [bundle.doc]);
  const undo = useMemo(
    () =>
      new Y.UndoManager([roots.nodes, roots.edges], {
        trackedOrigins: new Set([transactionOrigin]),
        captureTimeout: 400,
      }),
    [roots.edges, roots.nodes, transactionOrigin],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!editable || !synced || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "c") {
        const nodeIds = new Set(selectedNodes.current);
        const edgeIds = selectedEdges.current;
        if (!nodeIds.size && !edgeIds.size) return;
        clipboard.current = {
          nodes: records.nodes.filter((node) => nodeIds.has(node.id)),
          edges: records.edges.filter(
            (edge) => edgeIds.has(edge.id) || (nodeIds.has(edge.source) && nodeIds.has(edge.target)),
          ),
        };
        event.preventDefault();
      }
      if (event.key.toLowerCase() === "v" && clipboard.current) {
        const ids = new Map(clipboard.current.nodes.map((node) => [node.id, crypto.randomUUID()]));
        bundle.doc.transact(() => {
          for (const node of clipboard.current!.nodes) {
            roots.nodes.set(
              ids.get(node.id)!,
              diagramNodeMap({
                ...node,
                id: ids.get(node.id)!,
                x: node.x + 32,
                y: node.y + 32,
                parentId: node.parentId ? (ids.get(node.parentId) ?? null) : null,
              }),
            );
          }
          for (const edge of clipboard.current!.edges) {
            const source = ids.get(edge.source);
            const targetId = ids.get(edge.target);
            if (source && targetId) {
              const id = crypto.randomUUID();
              roots.edges.set(id, diagramEdgeMap({ ...edge, id, source, target: targetId }));
            }
          }
        }, transactionOrigin);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bundle.doc, editable, records.edges, records.nodes, roots.edges, roots.nodes, synced, transactionOrigin]);

  const updateLabel = useCallback(
    (id: string, label: string) => {
      if (!editable || !synced) return;
      bundle.doc.transact(() => {
        const map = roots.nodes.get(id);
        if (map) replaceYText(map, "label", label.slice(0, 20_000));
      }, transactionOrigin);
    },
    [bundle.doc, editable, roots.nodes, synced, transactionOrigin],
  );

  const refresh = useCallback(() => {
    const next = diagramFromYDoc(bundle.doc, { pageId: page.id, contentEpoch: page.contentEpoch });
    const counts = new Map<string, number>();
    for (const thread of comments) {
      if (thread.resolvedAt) continue;
      const target = thread.anchor?.kind === "diagram" ? thread.anchor.targetId : null;
      if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    setRecords(next);
    setNodes(
      next.nodes.map((record) => ({
        id: record.id,
        type: "diagram",
        position: { x: record.x, y: record.y },
        width: record.width,
        height: record.height,
        zIndex: record.type === "frame" ? -1 : record.zIndex,
        selected: selectedNodes.current.has(record.id),
        data: { record, editable, commentCount: counts.get(record.id) ?? 0, updateLabel },
      })),
    );
    setEdges(next.edges.map((record) => ({ ...flowEdge(record), selected: selectedEdges.current.has(record.id) })));
  }, [bundle.doc, comments, editable, page.contentEpoch, page.id, setEdges, setNodes, setRecords, updateLabel]);

  useEffect(() => {
    roots.nodes.observeDeep(refresh);
    roots.edges.observeDeep(refresh);
    let active = true;
    queueMicrotask(() => {
      if (active) refresh();
    });
    return () => {
      active = false;
      roots.nodes.unobserveDeep(refresh);
      roots.edges.unobserveDeep(refresh);
    };
  }, [refresh, roots.edges, roots.nodes]);

  useEffect(() => {
    const awareness = bundle.provider.awareness;
    awareness.setLocalStateField("user", {
      id: member.user.id,
      name: member.user.name,
      color: userColor(member.user.id),
    });
    const change = () => {
      setRemote(
        [...awareness.getStates().entries()].flatMap(([clientId, state]) => {
          if (clientId === awareness.clientID || !state.user || typeof state.user !== "object") return [];
          const user = state.user as { name?: unknown; color?: unknown };
          const cursor = state.cursor as { x?: unknown; y?: unknown } | undefined;
          return [
            {
              clientId,
              name: typeof user.name === "string" ? user.name : "Collaborator",
              color: typeof user.color === "string" ? user.color : "#2563eb",
              ...(cursor && typeof cursor.x === "number" && typeof cursor.y === "number"
                ? { cursor: { x: cursor.x, y: cursor.y } }
                : {}),
            },
          ];
        }),
      );
    };
    awareness.on("change", change);
    change();
    return () => awareness.off("change", change);
  }, [bundle.provider.awareness, member.user.id, member.user.name]);

  useEffect(() => () => undo.destroy(), [undo]);
  useLayoutEffect(() => {
    canInsertNode.current = editable && synced;
    return () => {
      canInsertNode.current = false;
    };
  }, [editable, synced]);

  const addNode = useCallback(
    (type: DiagramNodeType, assetId: string | null = null): boolean => {
      if (!canInsertNode.current) return false;
      const node = newNode(type, records.nodes.length, assetId);
      const center = instance?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      if (center) {
        node.x = center.x - node.width / 2;
        node.y = center.y - node.height / 2;
      }
      bundle.doc.transact(() => roots.nodes.set(node.id, diagramNodeMap(node)), transactionOrigin);
      return true;
    },
    [bundle.doc, instance, records.nodes.length, roots.nodes, transactionOrigin],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<DiagramNode>) => {
      if (!editable || !synced) return;
      bundle.doc.transact(() => {
        const map = roots.nodes.get(id);
        if (!map) return;
        if (patch.label !== undefined) replaceYText(map, "label", patch.label);
        if (patch.notes !== undefined) replaceYText(map, "notes", patch.notes);
        for (const key of ["x", "y", "width", "height", "zIndex", "type", "color", "assetId", "parentId"] as const) {
          if (!(key in patch)) continue;
          const value = patch[key];
          if (value === null || value === undefined) map.delete(key);
          else map.set(key, value);
        }
        for (const key of ["references", "mentions"] as const) {
          const values = patch[key];
          if (!values) continue;
          const target = map.get(key);
          if (target instanceof Y.Map) {
            target.clear();
            for (const value of values) target.set(value.id, value.label);
          }
        }
      }, transactionOrigin);
    },
    [bundle.doc, editable, roots.nodes, synced, transactionOrigin],
  );

  const updateEdge = useCallback(
    (id: string, patch: Partial<DiagramEdge>) => {
      if (!editable || !synced) return;
      bundle.doc.transact(() => {
        const map = roots.edges.get(id);
        if (!map) return;
        if (patch.label !== undefined) replaceYText(map, "label", patch.label);
        for (const key of ["path", "color", "arrow", "source", "target", "sourceHandle", "targetHandle"] as const) {
          if (patch[key] !== undefined) map.set(key, patch[key]);
        }
      }, transactionOrigin);
    },
    [bundle.doc, editable, roots.edges, synced, transactionOrigin],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const accepted = editable && synced ? changes : changes.filter((change) => change.type === "select");
      setNodes((current) => applyNodeChanges(accepted, current));
      bundle.doc.transact(() => {
        for (const change of changes) {
          if (change.type === "add" || change.type === "replace") continue;
          if (change.type === "select") {
            if (change.selected) selectedNodes.current.add(change.id);
            else selectedNodes.current.delete(change.id);
          }
          if (!editable || !synced) continue;
          const map = roots.nodes.get(change.id);
          if (!map) continue;
          if (change.type === "position" && change.position) {
            const previousX = Number(map.get("x") ?? 0);
            const previousY = Number(map.get("y") ?? 0);
            map.set("x", change.position.x);
            map.set("y", change.position.y);
            if (map.get("type") === "frame") {
              const dx = change.position.x - previousX;
              const dy = change.position.y - previousY;
              for (const child of roots.nodes.values()) {
                if (child.get("parentId") === change.id) {
                  child.set("x", Number(child.get("x") ?? 0) + dx);
                  child.set("y", Number(child.get("y") ?? 0) + dy);
                }
              }
            }
          } else if (change.type === "dimensions" && change.dimensions) {
            map.set("width", change.dimensions.width);
            map.set("height", change.dimensions.height);
          } else if (change.type === "remove") {
            roots.nodes.delete(change.id);
            for (const [edgeId, edge] of roots.edges.entries()) {
              if (edge.get("source") === change.id || edge.get("target") === change.id) roots.edges.delete(edgeId);
            }
          }
        }
      }, transactionOrigin);
    },
    [bundle.doc, editable, roots.edges, roots.nodes, setNodes, synced, transactionOrigin],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      const accepted = editable && synced ? changes : changes.filter((change) => change.type === "select");
      setEdges((current) => applyEdgeChanges(accepted, current));
      bundle.doc.transact(() => {
        for (const change of changes) {
          if (change.type === "select") {
            if (change.selected) selectedEdges.current.add(change.id);
            else selectedEdges.current.delete(change.id);
          } else if (editable && synced && change.type === "remove") roots.edges.delete(change.id);
        }
      }, transactionOrigin);
    },
    [bundle.doc, editable, roots.edges, setEdges, synced, transactionOrigin],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editable || !synced || !connection.source || !connection.target) return;
      const edge: DiagramEdge = {
        id: crypto.randomUUID(),
        source: connection.source,
        target: connection.target,
        sourceHandle: (connection.sourceHandle as DiagramEdge["sourceHandle"] | null) ?? "right",
        targetHandle: (connection.targetHandle as DiagramEdge["targetHandle"] | null) ?? "left",
        path: "step",
        label: "",
        color: "slate",
        arrow: true,
      };
      bundle.doc.transact(() => roots.edges.set(edge.id, diagramEdgeMap(edge)), transactionOrigin);
    },
    [bundle.doc, editable, roots.edges, synced, transactionOrigin],
  );

  const selection = useCallback(
    (value: OnSelectionChangeParams<FlowNode, FlowEdge>) => {
      selectedNodes.current = new Set(value.nodes.map((node) => node.id));
      selectedEdges.current = new Set(value.edges.map((edge) => edge.id));
      bundle.provider.awareness.setLocalStateField("selection", {
        nodeIds: [...selectedNodes.current],
        edgeIds: [...selectedEdges.current],
      });
      if (value.nodes.length === 1) onSelection({ kind: "diagram", target: "node", targetId: value.nodes[0]!.id });
      else if (value.edges.length === 1) onSelection({ kind: "diagram", target: "edge", targetId: value.edges[0]!.id });
      else onSelection(null);
    },
    [bundle.provider.awareness, onSelection],
  );

  const selectedNode = nodes.find((node) => node.selected)?.data.record ?? null;
  const selectedEdge = edges.find((edge) => edge.selected)?.data?.record ?? null;

  return (
    <div className="diagram-workspace">
      <nav className="diagram-stencils" aria-label="Diagram stencils">
        {STENCILS.map((stencil) => (
          <button key={stencil.type} disabled={!editable || !synced} onClick={() => addNode(stencil.type)}>
            <span>{stencil.icon}</span>
            {stencil.label}
          </button>
        ))}
        <button disabled={!editable || !synced} onClick={() => imageInput.current?.click()}>
          <span>▧</span>Image
        </button>
        <input
          ref={imageInput}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void uploadAttachment(page.id, file)
                .then(async (attachment) => {
                  if (addNode("image", attachment.id)) {
                    onError("");
                    return;
                  }
                  try {
                    await api(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" });
                    onError("The diagram image could not be added because collaboration is unavailable.");
                  } catch (cleanupError) {
                    console.error("Failed to remove an unused diagram image", cleanupError);
                    onError("The uploaded diagram image could not be added, and automatic cleanup failed.");
                  }
                })
                .catch((cause) => onError(apiErrorMessage(cause, "The diagram image could not be uploaded.")));
            }
            event.currentTarget.value = "";
          }}
        />
      </nav>
      <div className="diagram-flow">
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setInstance}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={selection}
          onPaneMouseMove={(event) => {
            if (!instance) return;
            const point = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            bundle.provider.awareness.setLocalStateField("cursor", point);
          }}
          onPaneMouseLeave={() => bundle.provider.awareness.setLocalStateField("cursor", null)}
          nodesDraggable={editable}
          nodesConnectable={editable}
          elementsSelectable
          deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
          snapToGrid
          snapGrid={[16, 16]}
          fitView
          minZoom={0.1}
          maxZoom={4}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
          <Panel position="top-left" className="diagram-canvas-actions">
            <button disabled={!editable} onClick={() => undo.undo()}>
              Undo
            </button>
            <button disabled={!editable} onClick={() => undo.redo()}>
              Redo
            </button>
          </Panel>
          <ViewportPortal>
            {remote.flatMap((presence) =>
              presence.cursor
                ? [
                    <div
                      key={presence.clientId}
                      className="diagram-remote-cursor"
                      style={{
                        transform: `translate(${presence.cursor.x}px, ${presence.cursor.y}px)`,
                        color: presence.color,
                      }}
                    >
                      <i style={{ background: presence.color }} />
                      {presence.name}
                    </div>,
                  ]
                : [],
            )}
          </ViewportPortal>
        </ReactFlow>
      </div>
      {editable ? (
        <DiagramInspector
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          frames={records.nodes.filter((node) => node.type === "frame")}
          updateNode={updateNode}
          updateEdge={updateEdge}
        />
      ) : (
        <aside className="diagram-inspector">
          <p className="muted">Reconnect or request edit access to change this diagram.</p>
        </aside>
      )}
    </div>
  );
}

export function DiagramPage({
  page,
  member,
  onPageChanged,
  onPageUnavailable,
  onAccessDenied,
  onSelectPage,
  backlinksRevision,
  commentsRevision = 0,
}: DiagramPageProps) {
  const [bundle, setBundle] = useState<NetworkCollaborationBundle | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<"offline" | "connecting" | "connected">("connecting");
  const [titleEdit, setTitleEdit] = useState({ pageId: page.id, revision: page.revision, value: page.title });
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"comments" | "history" | "backlinks" | null>(null);
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [sizeWarning, setSizeWarning] = useState<{ bytes: number; readOnly: boolean } | null>(null);
  const title = titleEdit.pageId === page.id && titleEdit.revision === page.revision ? titleEdit.value : page.title;
  useEffect(() => {
    const next = createNetworkCollaboration(page.id, page.contentEpoch, setStatus);
    let active = true;
    const custom = (message: string) => {
      try {
        const value = JSON.parse(message) as { type?: unknown; bytes?: unknown; readOnly?: unknown };
        if (value.type === "document-size" && typeof value.bytes === "number")
          setSizeWarning({ bytes: value.bytes, readOnly: value.readOnly === true });
      } catch {
        // Ignore messages from future servers.
      }
    };
    const close = (event: CloseEvent) => {
      if (!active) return;
      if (event.code === 4410 || event.code === 4412) onPageUnavailable(page.id);
      if (event.code === 4403) onAccessDenied(page.id, new ApiClientError(403, "page_access_denied", "Access denied."));
    };
    next.provider.on("custom-message", custom);
    next.provider.on("connection-close", close);
    queueMicrotask(() => {
      if (active) setBundle(next);
    });
    void next.ready.then(() => {
      if (active) setReady(true);
    });
    const unload = (event: BeforeUnloadEvent) => {
      if (next.hasUnsyncedChanges) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      active = false;
      window.removeEventListener("beforeunload", unload);
      next.provider.off("custom-message", custom);
      next.provider.off("connection-close", close);
      next.destroy();
    };
  }, [onAccessDenied, onPageUnavailable, page.contentEpoch, page.id]);
  useEffect(() => {
    void api<{ threads: CommentThread[] }>(`/api/pages/${page.id}/comments?revision=${commentsRevision}`)
      .then((data) => setThreads(data.threads))
      .catch(() => setThreads([]));
  }, [commentsRevision, page.id]);

  const connected = status === "connected" && Boolean(bundle?.synced) && ready;
  const editable = member.role !== "viewer" && connected && !sizeWarning?.readOnly;

  async function saveTitle() {
    const normalized = title.trim() || "Untitled";
    if (normalized === page.title) return;
    try {
      const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
        method: "PATCH",
        body: json({ title: normalized, revision: page.revision }),
      });
      onPageChanged(result.page);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The title could not be saved."));
    }
  }

  return (
    <main className="page-canvas diagram-page">
      <div className="page-tools">
        <span className={`sync-state sync-${connected ? "connected" : status}`}>
          <i />
          {connected ? "connected" : status === "connected" ? "syncing" : status}
        </span>
        {(["comments", "history", "backlinks"] as const).map((value) => (
          <button
            key={value}
            className="quiet-button"
            onClick={() => setPanel((current) => (current === value ? null : value))}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      {!connected ? (
        <div className="notice">This diagram is read-only until the server reconnects and finishes syncing.</div>
      ) : null}
      {sizeWarning ? (
        <div className={`notice ${sizeWarning.readOnly ? "notice-danger" : ""}`}>
          This diagram is {(sizeWarning.bytes / 1024 / 1024).toFixed(1)} MiB.
          {sizeWarning.readOnly
            ? " It is read-only at the safety limit."
            : " Consider splitting it before it reaches 24 MiB."}
        </div>
      ) : null}
      <div className={`diagram-page-layout ${panel ? "with-panel" : ""}`}>
        <section className="diagram-page-main">
          <input
            className="page-title diagram-title"
            aria-label="Page title"
            value={title}
            readOnly={member.role === "viewer" || !connected}
            onChange={(event) => setTitleEdit({ pageId: page.id, revision: page.revision, value: event.target.value })}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          {error ? <p className="form-error">{error}</p> : null}
          {bundle && ready ? (
            <ReactFlowProvider>
              <DiagramCanvas
                bundle={bundle}
                page={page}
                member={member}
                editable={editable}
                synced={connected}
                comments={threads}
                onSelection={setAnchor}
                onError={setError}
              />
            </ReactFlowProvider>
          ) : (
            <div className="editor-loading">Connecting to the authoritative diagram…</div>
          )}
        </section>
        {panel === "comments" ? (
          <DiagramComments pageId={page.id} revision={commentsRevision} anchor={anchor} online={connected} />
        ) : null}
        {panel === "history" ? (
          <DiagramHistory
            page={page}
            member={member}
            onRestored={(epoch) => onPageChanged({ ...page, contentEpoch: epoch, revision: page.revision + 1 })}
            onError={setError}
          />
        ) : null}
        {panel === "backlinks" ? (
          <BacklinksPanel pageId={page.id} revision={backlinksRevision} onSelect={onSelectPage} />
        ) : null}
      </div>
    </main>
  );
}
