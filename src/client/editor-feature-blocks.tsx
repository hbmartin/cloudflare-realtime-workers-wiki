// BlockNote adaptation of Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea
// packages/editor-ext/src/lib/{tabs,status,footnotes}; AGPL-3.0.
import { createExtension, type BlockNoteEditor } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { Plugin, PluginKey, TextSelection, type Selection } from "prosemirror-state";
import type { Slice } from "prosemirror-model";

import { ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import { Decoration, DecorationSet } from "prosemirror-view";
import { useEffect, useState } from "react";
import {
  linkedTableViewConfig,
  EDITOR_LABEL_MAX,
  TABS_MAX,
  STATUS_COLORS,
  statusBadgeConfig,
  footnoteReferenceConfig,
  tabsConfig,
  tabPanelConfig,
  footnotesConfig,
  footnoteDefinitionConfig,
  footnoteAnchor,
  footnoteCatalog,
  type FootnoteCatalog,
} from "../shared/editor-features";

import { LinkedTableView } from "./LinkedTableView";
import { remapFeatureSlice } from "./editor-copy";
import { moveTabPanel, duplicateTabPanel } from "./tab-operations";

export type FeatureEditor = BlockNoteEditor<any, any, any>;
const footnotesPluginKey = new PluginKey<FootnoteCatalog>("notesFootnotes");
function pmFootnoteCatalog(doc: import("prosemirror-model").Node): FootnoteCatalog {
  const numbers = new Map<string, number>();
  const definitions: FootnoteCatalog["definitions"] = new Map();
  doc.descendants((node) => {
    const id = node.attrs.definitionId as unknown;
    if (typeof id === "string" && id) {
      if (node.type.name === "footnoteReference" && !numbers.has(id)) numbers.set(id, numbers.size + 1);
      if (node.type.name === "footnoteDefinition" && !definitions.has(id)) definitions.set(id, node.toJSON());
    }
  });
  return { numbers, definitions };
}
export const footnotesExtension = createExtension({
  key: "notesFootnotes",
  prosemirrorPlugins: [
    new Plugin<FootnoteCatalog>({
      key: footnotesPluginKey,
      state: {
        init: (_config, state) => pmFootnoteCatalog(state.doc),
        apply: (tr, previous) => (tr.docChanged ? pmFootnoteCatalog(tr.doc) : previous),
      },
      props: { transformPasted: (slice, view) => (view.dragging?.move ? slice : remapFeatureSlice(slice)) },
    }),
  ],
});
export const tabsPluginKey = new PluginKey<ReadonlyMap<string, string>>("notesTabs");
export function selectionInsideTabs(selection: Selection) {
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type.name === "blockContainer" && node.firstChild?.type.name === "tabs") return true;
  }
  return false;
}
function containsNestedTabs(node: import("prosemirror-model").Node, inTabs = false): boolean {
  const tabs = node.type.name === "blockContainer" && node.firstChild?.type.name === "tabs";
  return (tabs && inTabs) || node.content.content.some((child) => containsNestedTabs(child, inTabs || tabs));
}
function tabGroups(doc: import("prosemirror-model").Node) {
  const groups: Array<{ id: string; panels: Array<{ id: string; pos: number; size: number }> }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer" || node.child(0)?.type.name !== "tabs") return true;
    const panels: Array<{ id: string; pos: number; size: number }> = [];
    let offset = pos + 1;
    node.forEach((child) => {
      if (child.type.name === "blockGroup")
        child.forEach((panel, childOffset) => {
          if (panel.child(0)?.type.name === "tabPanel")
            panels.push({ id: panel.attrs.id as string, pos: offset + 1 + childOffset, size: panel.nodeSize });
        });
      offset += child.nodeSize;
    });
    groups.push({ id: node.attrs.id as string, panels });
    return true;
  });
  return groups;
}
export const tabsExtension = createExtension({
  key: "notesTabs",
  prosemirrorPlugins: [
    new Plugin({
      key: tabsPluginKey,
      filterTransaction: (tr) => {
        if (!tr.docChanged || tr.getMeta(ySyncPluginKey)?.isChangeOrigin) return true;
        // Initial collaborative blocks may not have IDs yet. Inspect native steps
        // without converting them to BlockNote blocks before UniqueID runs.
        const structuralTabsChange = tr.steps.some((step, index) => {
          const replacement = step as { slice?: Slice; gapFrom?: number; gapTo?: number };
          let affectedTabs = false;
          const inspect = (node: import("prosemirror-model").Node) => {
            affectedTabs ||= node.type.name === "tabs";
            return !affectedTabs;
          };
          replacement.slice?.content.descendants(inspect);
          // Gap positions belong to the document immediately before this step.
          // Native indentation can preserve tabs in a wrapper-only replacement.
          if (!affectedTabs && replacement.gapFrom !== undefined && replacement.gapTo !== undefined)
            tr.docs[index]!.nodesBetween(replacement.gapFrom, replacement.gapTo, inspect);
          return affectedTabs;
        });
        return !structuralTabsChange || !containsNestedTabs(tr.doc);
      },
      state: {
        init: () => new Map<string, string>(),
        apply: (tr, previous) => {
          const next = new Map(previous);
          const active = tr.getMeta(tabsPluginKey) as { tabsId: string; panelId: string } | undefined;
          if (active) next.set(active.tabsId, active.panelId);
          if (!tr.docChanged && !tr.selectionSet && !active) return previous;
          const groups = tabGroups(tr.doc);
          const live = new Set(groups.map((group) => group.id));
          for (const id of next.keys()) if (!live.has(id)) next.delete(id);
          for (const group of groups) {
            if (!group.panels.some((panel) => panel.id === next.get(group.id))) {
              if (group.panels[0]) next.set(group.id, group.panels[0].id);
            }
            if (tr.selectionSet && !active) {
              const panel = group.panels.find(
                (item) => tr.selection.from > item.pos && tr.selection.from < item.pos + item.size,
              );
              if (panel) next.set(group.id, panel.id);
            }
          }
          return next;
        },
      },
      props: {
        decorations: (state) => {
          const active = tabsPluginKey.getState(state);
          const decorations: Decoration[] = [];
          for (const group of tabGroups(state.doc)) {
            const selected = active?.get(group.id) ?? group.panels[0]?.id;
            for (const panel of group.panels)
              if (panel.id !== selected)
                decorations.push(
                  Decoration.node(panel.pos, panel.pos + panel.size, { style: "display:none", "aria-hidden": "true" }),
                );
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
  ],
});

function TabsView({ id, editor }: { id: string; editor: FeatureEditor }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    const changes = editor.onChange(update);
    const selection = editor.onSelectionChange(update);
    return () => {
      changes();
      selection();
    };
  }, [editor]);
  const block = editor.getBlock(id);
  const panels = block?.children.filter((child) => child.type === "tabPanel") ?? [];
  const active = tabsPluginKey.getState(editor.prosemirrorState)?.get(id) ?? panels[0]?.id;
  const select = (panelId: string) => {
    editor.transact((tr) => tr.setMeta(tabsPluginKey, { tabsId: id, panelId }).setMeta("addToHistory", false));
    refresh((value) => value + 1);
  };
  const add = () => {
    const panelId = crypto.randomUUID();
    const undo = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
    undo?.stopCapturing();
    const panel = {
      id: panelId,
      type: "tabPanel",
      props: { label: `Tab ${panels.length + 1}` },
      children: [{ type: "paragraph" }],
    };
    if (panels.length) editor.insertBlocks([panel] as never, panels.at(-1)!.id, "after");
    else editor.updateBlock(id, { children: [panel] } as never);
    undo?.stopCapturing();
    select(panelId);
  };
  return (
    <div className="editor-tabs-strip" contentEditable={false}>
      <div
        role="tablist"
        tabIndex={-1}
        aria-label="Content tabs"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !panels.length) return;
          event.preventDefault();
          const current = panels.findIndex((panel) => panel.id === active);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? panels.length - 1
                : (current + (event.key === "ArrowRight" ? 1 : panels.length - 1)) % panels.length;
          select(panels[next]!.id);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {panels.map((panel) => (
          <button
            type="button"
            key={panel.id}
            role="tab"
            aria-selected={active === panel.id}
            tabIndex={active === panel.id ? 0 : -1}
            onClick={() => select(panel.id)}
          >
            {String(panel.props.label ?? "Tab")}
          </button>
        ))}
      </div>
      {editor.isEditable && (
        <>
          <button type="button" disabled={panels.length >= TABS_MAX} onClick={add}>
            Add tab
          </button>
          {panels.map(
            (panel, index) =>
              active === panel.id && (
                <span key={panel.id} className="editor-tab-actions">
                  <input
                    aria-label="Tab label"
                    maxLength={EDITOR_LABEL_MAX}
                    value={String(panel.props.label ?? "Tab")}
                    onChange={(event) =>
                      editor.updateBlock(panel.id, { props: { label: event.target.value } } as never)
                    }
                  />
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => {
                      moveTabPanel(editor, id, panel.id, -1);
                      select(panel.id);
                    }}
                  >
                    Move tab left
                  </button>
                  <button
                    type="button"
                    disabled={index === panels.length - 1}
                    onClick={() => {
                      moveTabPanel(editor, id, panel.id, 1);
                      select(panel.id);
                    }}
                  >
                    Move tab right
                  </button>
                  <button
                    type="button"
                    disabled={panels.length >= TABS_MAX}
                    onClick={() => {
                      const copyId = duplicateTabPanel(editor, panel.id);
                      if (copyId) select(copyId);
                    }}
                  >
                    Duplicate tab
                  </button>
                  <button
                    type="button"
                    disabled={panels.length < 2}
                    onClick={() => {
                      if (!confirm(`Delete “${String(panel.props.label ?? "Tab")}” and its content?`)) return;
                      const undo = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
                      undo?.stopCapturing();
                      editor.removeBlocks([panel]);
                      undo?.stopCapturing();
                      select(panels[index + 1]?.id ?? panels[index - 1]!.id);
                    }}
                  >
                    Delete tab
                  </button>
                </span>
              ),
          )}
        </>
      )}
    </div>
  );
}
function revealFootnote(editor: FeatureEditor, id: string, type: "footnoteDefinition" | "footnoteReference") {
  let target = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (target < 0 && node.type.name === type && node.attrs.definitionId === id)
      target = pos + (node.isTextblock ? 1 : 0);
  });
  if (target < 0) return;
  editor.transact((tr) =>
    tr
      .setSelection(TextSelection.near(tr.doc.resolve(target)))
      .setMeta("addToHistory", false)
      .scrollIntoView(),
  );
  editor.focus();
}

export const featureBlockSpecs = {
  linkedTableView: createReactBlockSpec(linkedTableViewConfig, {
    render: ({ block, editor }) => (
      <LinkedTableView
        {...block.props}
        editable={editor.isEditable}
        update={(props) => editor.updateBlock(block, { props })}
      />
    ),
    toExternalHTML: ({ block }) => (
      <a href={`/?page=${encodeURIComponent(block.props.tablePageId)}`}>{block.props.title}</a>
    ),
  })(),
  tabs: createReactBlockSpec(tabsConfig, {
    render: ({ block, editor }) => <TabsView id={block.id} editor={editor as FeatureEditor} />,
    toExternalHTML: () => <section data-type="tabs" />,
  })(),
  tabPanel: createReactBlockSpec(tabPanelConfig, {
    render: () => <span className="editor-tab-panel-label" contentEditable={false} />,
    toExternalHTML: ({ block }) => (
      <section data-type="tab-panel">
        <h4>{block.props.label}</h4>
      </section>
    ),
  })(),
  footnotes: createReactBlockSpec(footnotesConfig, {
    render: () => (
      <h2 className="editor-footnotes-label" contentEditable={false}>
        Footnotes
      </h2>
    ),
    toExternalHTML: () => <section data-type="footnotes" />,
  })(),
  footnoteDefinition: createReactBlockSpec(footnoteDefinitionConfig, {
    render: ({ block, editor, contentRef }) => (
      <FootnoteDefinition id={block.props.definitionId} editor={editor as FeatureEditor} contentRef={contentRef} />
    ),
    toExternalHTML: ({ block, contentRef }) => (
      <p id={footnoteAnchor(block.props.definitionId)} data-footnote-id={block.props.definitionId} ref={contentRef} />
    ),
  })(),
};
function useFootnotes(editor: FeatureEditor) {
  const [, refresh] = useState(0);
  useEffect(() => editor.onChange(() => refresh((value) => value + 1)), [editor]);
  return footnotesPluginKey.getState(editor.prosemirrorState) ?? footnoteCatalog(editor.prosemirrorState.doc.toJSON());
}
function FootnoteDefinition({
  id,
  editor,
  contentRef,
}: {
  id: string;
  editor: FeatureEditor;
  contentRef: (element: HTMLElement | null) => void;
}) {
  const catalog = useFootnotes(editor);
  return (
    <div className="editor-footnote-definition" id={footnoteAnchor(id)}>
      <span contentEditable={false}>{catalog.numbers.get(id) ?? "Unused"}.</span>
      <div ref={contentRef} />
      <button
        type="button"
        contentEditable={false}
        aria-label="Back to footnote reference"
        onClick={() => {
          revealFootnote(editor, id, "footnoteReference");
          const reference = editor.domElement?.querySelector<HTMLElement>(
            `[data-footnote-reference="${CSS.escape(id)}"]`,
          );
          reference?.scrollIntoView({ block: "center" });
          reference?.focus();
        }}
      >
        ↩
      </button>
    </div>
  );
}
function FootnoteReference({ id, editor }: { id: string; editor: FeatureEditor }) {
  const catalog = useFootnotes(editor);
  const missing = !catalog.definitions.has(id);
  return (
    <sup>
      <button
        type="button"
        data-footnote-reference={id}
        contentEditable={false}
        title={missing ? "Missing footnote" : "Open footnote"}
        onClick={() => {
          if (missing && editor.isEditable) appendFootnoteDefinition(editor, id);
          revealFootnote(editor, id, "footnoteDefinition");
          const target = editor.domElement?.querySelector<HTMLElement>(`#${CSS.escape(footnoteAnchor(id))}`);
          target?.scrollIntoView({ block: "center" });
          target?.querySelector<HTMLElement>("[contenteditable]")?.focus();
        }}
      >
        {missing ? "Missing footnote" : (catalog.numbers.get(id) ?? "?")}
      </button>
    </sup>
  );
}
export const featureInlineSpecs = {
  statusBadge: createReactInlineContentSpec(statusBadgeConfig, {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <span className={`editor-status status-${inlineContent.props.color}`} contentEditable={false}>
        {editor.isEditable ? (
          <>
            <input
              aria-label="Status label"
              maxLength={EDITOR_LABEL_MAX}
              value={inlineContent.props.label}
              onChange={(event) =>
                updateInlineContent({
                  type: "statusBadge",
                  props: { ...inlineContent.props, label: event.target.value },
                })
              }
            />
            <select
              aria-label="Status color"
              value={inlineContent.props.color}
              onChange={(event) =>
                updateInlineContent({
                  type: "statusBadge",
                  props: { ...inlineContent.props, color: event.target.value as (typeof STATUS_COLORS)[number] },
                })
              }
            >
              {STATUS_COLORS.map((color) => (
                <option key={color}>{color}</option>
              ))}
            </select>
          </>
        ) : (
          inlineContent.props.label
        )}
      </span>
    ),
    toExternalHTML: ({ inlineContent }) => (
      <span data-type="status" data-color={inlineContent.props.color}>
        {inlineContent.props.label}
      </span>
    ),
  }),
  footnoteReference: createReactInlineContentSpec(footnoteReferenceConfig, {
    render: ({ inlineContent, editor }) => (
      <FootnoteReference id={inlineContent.props.definitionId} editor={editor as FeatureEditor} />
    ),
    toExternalHTML: ({ inlineContent }) => (
      <sup>
        <a
          href={`#${footnoteAnchor(inlineContent.props.definitionId)}`}
          data-footnote-reference={inlineContent.props.definitionId}
        >
          *
        </a>
      </sup>
    ),
  }),
};
function appendFootnoteDefinition(editor: FeatureEditor, definitionId: string) {
  const definition = { type: "footnoteDefinition", props: { definitionId }, content: "Footnote" };
  const footnotes = editor.document.find((block) => block.type === "footnotes");
  if (footnotes) editor.updateBlock(footnotes, { children: [...footnotes.children, definition] } as never);
  else editor.insertBlocks([{ type: "footnotes", children: [definition] }] as never, editor.document.at(-1)!, "after");
}
export function insertFootnote(editor: FeatureEditor) {
  const definitionId = crypto.randomUUID();
  const undo = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
  undo?.stopCapturing();
  editor.transact(() => {
    editor.insertInlineContent([{ type: "footnoteReference", props: { definitionId } }] as never);
    appendFootnoteDefinition(editor, definitionId);
  });
  undo?.stopCapturing();
}
