import { useEffect, useRef, useState } from "react";
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

export function WorkspaceTree({
  nodes,
  selectedId,
  editable,
  canCreate,
  onSelect,
  onCreate,
  onArchive,
  onMove,
  preferenceKey,
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
}) {
  const [collapsed, setCollapsed] = useState<string[]>(() => readPreference(preferenceKey, []));
  const [drop, setDrop] = useState<{ id: string; position: "before" | "inside" | "after" } | null>(null);
  const [focused, setFocused] = useState<string | null>(selectedId);
  const ref = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  useEffect(() => {
    savePreference(preferenceKey, collapsed);
  }, [collapsed, preferenceKey]);
  useEffect(() => {
    const path: string[] = [];
    const find = (items: PageNode[]): boolean =>
      items.some((node) => {
        if (node.id === selectedId) return true;
        if (find(node.children)) {
          path.push(node.id);
          return true;
        }
        return false;
      });
    find(nodes);
    if (path.length)
      // Reveal the path when external navigation selects a nested page.
      // eslint-disable-next-line react/set-state-in-effect
      setCollapsed((current) =>
        current.some((id) => path.includes(id)) ? current.filter((id) => !path.includes(id)) : current,
      );
  }, [nodes, selectedId]);
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
            if (event.key === "ArrowUp" && index > 0)
              onMove(node.id, node.parentId, items[index - 1]!.id, items[index - 2]?.id ?? null);
            else if (event.key === "ArrowDown" && index < items.length - 1)
              onMove(node.id, node.parentId, items[index + 2]?.id ?? null, items[index + 1]!.id);
            else if (event.key === "ArrowRight" && index > 0) onMove(node.id, items[index - 1]!.id, null, null);
            else if (event.key === "ArrowLeft" && node.parentId) {
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
            setDrop({ id: node.id, position: y < 0.25 ? "before" : y > 0.75 ? "after" : "inside" });
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
          {editable && (
            <div className="tree-actions" id={`page-actions-${node.id}`}>
              <CreationMenu
                label={`Add child to ${node.title}`}
                disabled={!canCreate}
                onCreate={(kind) => onCreate(node.id, kind)}
              />
              <ActionMenu label={`Actions for ${node.title}`}>
                <button aria-label={`Archive ${node.title}`} data-close-menu onClick={() => onArchive(node)}>
                  <Icon name="trash" />
                  Move to trash
                </button>
              </ActionMenu>
            </div>
          )}
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
    <div ref={ref} role="tree" aria-label="Pages">
      {render(nodes, 1)}
    </div>
  );
}
