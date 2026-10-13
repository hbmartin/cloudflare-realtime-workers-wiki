import { useEffect, useMemo, useRef, useState } from "react";
import { BRANCH_SORT_LABELS, findNode, sortedTree, type BranchSort } from "../shared/tree-model";
import type { Page, PageKind, PageNode } from "../shared/types";
import { ActionMenu, Icon, readPreference, savePreference } from "./WorkspaceUI";

export function CreationMenu({
  label,
  disabled,
  onCreate,
}: {
  label: string;
  disabled: boolean;
  onCreate: (kind: PageKind | "tasks") => void;
}) {
  return (
    <ActionMenu label={label} icon="plus" className="creation-menu">
      <p className="menu-caption">{label}</p>
      {(
        [
          ["document", "Document", "page"],
          ["table", "Table", "table"],
          ["tasks", "Task List", "tasks"],
          ["diagram", "Diagram", "diagram"],
        ] as const
      ).map(([kind, title, icon]) => (
        <button key={kind} disabled={disabled} data-close-menu onClick={() => onCreate(kind)}>
          <Icon name={icon} />
          {title}
        </button>
      ))}
    </ActionMenu>
  );
}

function ancestorIds(nodes: PageNode[], id: string | null): string[] {
  for (const node of nodes) {
    if (node.id === id) return [];
    const path = ancestorIds(node.children, id);
    if (node.children.some((child) => child.id === id) || path.length) return [node.id, ...path];
  }
  return [];
}

export function WorkspaceTree({
  nodes: sourceNodes,
  selectedId,
  editable,
  canCreate,
  onSelect,
  onCreate,
  onArchive,
  onMove,
  preferenceKey,
  revealRequest,
  onRevealHandled,
  treeReady = true,
}: {
  nodes: PageNode[];
  selectedId: string | null;
  editable: boolean;
  canCreate: boolean;
  onSelect: (id: string) => void;
  onCreate: (parentId: string, kind: PageKind | "tasks") => void;
  onArchive: (page: Page) => void;
  onMove: (id: string, parentId: string | null, beforeId: string | null, afterId: string | null) => void;
  preferenceKey: string;
  revealRequest?: { id: string; sequence: number } | undefined;
  onRevealHandled?: (sequence: number) => void;
  treeReady?: boolean;
}) {
  const [sorting, setSorting] = useState<Record<string, BranchSort>>(() =>
    readPreference(`${preferenceKey}:sorting`, {}),
  );
  const nodes = useMemo(() => sortedTree(sourceNodes, sorting), [sourceNodes, sorting]);
  const changeSort = (branch: string, mode: BranchSort) => {
    const next = { ...sorting, [branch]: mode };
    setSorting(next);
    savePreference(`${preferenceKey}:sorting`, next);
  };
  const sortControl = (branch: string, label: string) => (
    <label>
      Sort {label}
      <select
        aria-label={`Sort ${label}`}
        value={sorting[branch] ?? "manual"}
        onChange={(event) => changeSort(branch, event.target.value as BranchSort)}
      >
        {Object.entries(BRANCH_SORT_LABELS).map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const [collapsed, setCollapsed] = useState<string[]>(() => readPreference(preferenceKey, []));
  const [drop, setDrop] = useState<{ id: string; position: "before" | "inside" | "after" } | null>(null);
  const [focused, setFocused] = useState<string | null>(selectedId);
  const ref = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const handledReveal = useRef<number | null>(null);
  useEffect(() => {
    savePreference(preferenceKey, collapsed);
  }, [collapsed, preferenceKey]);
  useEffect(() => {
    const path = ancestorIds(nodes, selectedId);
    if (path.length)
      // Reveal the path when external navigation selects a nested page.
      // eslint-disable-next-line react/set-state-in-effect
      setCollapsed((current) =>
        current.some((id) => path.includes(id)) ? current.filter((id) => !path.includes(id)) : current,
      );
  }, [nodes, selectedId]);
  useEffect(() => {
    if (!revealRequest || handledReveal.current === revealRequest.sequence) return undefined;
    if (!treeReady && !findNode(nodes, revealRequest.id)) return undefined;
    const path = ancestorIds(nodes, revealRequest.id);
    if (path.some((id) => collapsed.includes(id))) {
      // eslint-disable-next-line react/set-state-in-effect
      setCollapsed((current) => current.filter((id) => !path.includes(id)));
      return undefined;
    }
    const timer = requestAnimationFrame(() => {
      const item = ref.current?.querySelector<HTMLElement>(`[data-tree-page="${CSS.escape(revealRequest.id)}"]`);
      if (item) {
        item.focus();
        item.scrollIntoView({ block: "nearest" });
        item.animate([{ backgroundColor: "var(--accent-soft, #dbeafe)" }, { backgroundColor: "transparent" }], {
          duration: 1500,
        });
      } else if (!treeReady) return;
      handledReveal.current = revealRequest.sequence;
      onRevealHandled?.(revealRequest.sequence);
    });
    return () => cancelAnimationFrame(timer);
  }, [revealRequest, collapsed, nodes, onRevealHandled, treeReady]);
  const toggle = (id: string) =>
    setCollapsed((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const visible: PageNode[] = [];
  const flatten = (items: PageNode[]) =>
    items.forEach((node) => {
      visible.push(node);
      if (!collapsed.includes(node.id)) flatten(node.children);
    });
  flatten(nodes);
  const focus = (id: string | undefined) => {
    if (id) {
      setFocused(id);
      ref.current?.querySelector<HTMLElement>(`[data-tree-page="${CSS.escape(id)}"]`)?.focus();
    }
  };
  const render = (items: PageNode[], depth: number) =>
    items.map((node, index) => (
      <div
        className="tree-branch"
        key={node.id}
        role="treeitem"
        aria-label={node.title}
        aria-level={depth}
        aria-selected={selectedId === node.id}
        aria-expanded={node.children.length ? !collapsed.includes(node.id) : undefined}
        data-tree-page={node.id}
        tabIndex={node.id === (visible.some((p) => p.id === focused) ? focused : visible[0]?.id) ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocused(node.id);
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (
            target.closest('[role="treeitem"]') === event.currentTarget &&
            !target.closest("button,summary,input,select")
          ) {
            focus(node.id);
            onSelect(node.id);
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const position = visible.findIndex((p) => p.id === node.id);
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            return;
          }
          if (event.altKey && editable) {
            if (event.key === "ArrowUp" && index > 0 && (sorting[node.parentId ?? "root"] ?? "manual") === "manual")
              onMove(node.id, node.parentId, items[index - 1]!.id, items[index - 2]?.id ?? null);
            else if (
              event.key === "ArrowDown" &&
              index < items.length - 1 &&
              (sorting[node.parentId ?? "root"] ?? "manual") === "manual"
            )
              onMove(node.id, node.parentId, items[index + 2]?.id ?? null, items[index + 1]!.id);
            else if (event.key === "ArrowRight" && index > 0) {
              const previousId = items[index - 1]!.id;
              setCollapsed((current) => current.filter((id) => id !== previousId));
              onMove(node.id, previousId, null, null);
            } else if (event.key === "ArrowLeft" && node.parentId) {
              const parent = visible.find((p) => p.id === node.parentId);
              onMove(node.id, parent?.parentId ?? null, null, null);
            } else return;
          } else if (event.key === "ArrowDown") focus(visible[position + 1]?.id);
          else if (event.key === "ArrowUp") focus(visible[position - 1]?.id);
          else if (event.key === "Home") focus(visible[0]?.id);
          else if (event.key === "End") focus(visible.at(-1)?.id);
          else if (event.key === "ArrowRight") {
            if (collapsed.includes(node.id)) toggle(node.id);
            else focus(node.children[0]?.id);
          } else if (event.key === "ArrowLeft") {
            if (node.children.length && !collapsed.includes(node.id)) toggle(node.id);
            else focus(node.parentId ?? undefined);
          } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && event.key !== " ") {
            const now = Date.now();
            typeahead.current = {
              text: (now - typeahead.current.at < 700 ? typeahead.current.text : "") + event.key.toLocaleLowerCase(),
              at: now,
            };
            focus(
              [...visible.slice(position + 1), ...visible.slice(0, position + 1)].find((p) =>
                p.title.toLocaleLowerCase().startsWith(typeahead.current.text),
              )?.id,
            );
          } else return;
          event.preventDefault();
        }}
        onKeyUp={(event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onSelect(node.id);
          }
        }}
      >
        <div
          className={`tree-row ${selectedId === node.id ? "selected" : ""} ${drop?.id === node.id ? `drop-${drop.position}` : ""}`}
          draggable={editable}
          onDragStart={(event) => {
            event.dataTransfer.setData("text/page-id", node.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDrop(null)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(null);
          }}
          onDragOver={(event) => {
            if (!editable) return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            const y = (event.clientY - bounds.top) / bounds.height;
            setDrop({
              id: node.id,
              position:
                (sorting[node.parentId ?? "root"] ?? "manual") !== "manual"
                  ? "inside"
                  : y < 0.25
                    ? "before"
                    : y > 0.75
                      ? "after"
                      : "inside",
            });
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const id = event.dataTransfer.getData("text/page-id");
            if (editable && id && id !== node.id) {
              if (drop?.position === "before") onMove(id, node.parentId, node.id, items[index - 1]?.id ?? null);
              else if (drop?.position === "after") onMove(id, node.parentId, items[index + 1]?.id ?? null, node.id);
              else {
                onMove(id, node.id, null, null);
                setCollapsed((current) => current.filter((x) => x !== node.id));
              }
            }
            setDrop(null);
          }}
        >
          <button
            id={`page-disclosure-${node.id}`}
            className={`tree-disclosure ${collapsed.includes(node.id) ? "" : "expanded"}`}
            aria-label={`${collapsed.includes(node.id) ? "Expand" : "Collapse"} ${node.title}`}
            disabled={!node.children.length}
            tabIndex={-1}
            onClick={() => toggle(node.id)}
          >
            <Icon name="chevron" />
          </button>
          <span className="page-link" title={node.title}>
            <span>{node.icon || <Icon name={node.kind === "document" ? "page" : node.kind} />}</span>
            <span>{node.title}</span>
          </span>
          {
            <div className="tree-actions" id={`page-actions-${node.id}`}>
              {editable && (
                <CreationMenu
                  label={`Add child to ${node.title}`}
                  disabled={!canCreate}
                  onCreate={(kind) => onCreate(node.id, kind)}
                />
              )}
              <ActionMenu label={`Actions for ${node.title}`}>
                {sortControl(node.id, `children of ${node.title}`)}
                {editable && (
                  <button disabled={!node.parentId} data-close-menu onClick={() => onMove(node.id, null, null, null)}>
                    Move to space root
                  </button>
                )}
                {editable && (
                  <button aria-label={`Archive ${node.title}`} data-close-menu onClick={() => onArchive(node)}>
                    <Icon name="trash" />
                    Move to trash
                  </button>
                )}
              </ActionMenu>
            </div>
          }
        </div>
        {node.children.length > 0 && !collapsed.includes(node.id) && (
          /* Nested ARIA trees require a group inside the parent tree item. */
          /* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */
          <div id={`page-children-${node.id}`} className="tree-children" role="group">
            {render(node.children, depth + 1)}
          </div>
        )}
      </div>
    ));
  return (
    <>
      {sortControl("root", "space pages")}
      <div ref={ref} role="tree" aria-label="Pages">
        {render(nodes, 1)}
      </div>
    </>
  );
}
