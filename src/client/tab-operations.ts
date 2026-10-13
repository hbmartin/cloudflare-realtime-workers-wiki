import type { BlockNoteEditor } from "@blocknote/core";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { yUndoPluginKey } from "y-prosemirror";
import { remapFeatureSlice } from "./editor-copy";

function containerAt(doc: PMNode, id: string) {
  let found: { node: PMNode; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "blockContainer" && node.attrs.id === id) found = { node, pos };
    return !found;
  });
  return found;
}

/** Move the actual child nodes so nested block, native-row and footnote
 * identities are retained together. */
export function moveTabPanel(editor: BlockNoteEditor<any, any, any>, tabsId: string, panelId: string, delta: -1 | 1) {
  const tabs = containerAt(editor.prosemirrorState.doc, tabsId);
  if (!tabs || tabs.node.firstChild?.type.name !== "tabs") return;
  let group: { node: PMNode; pos: number } | undefined;
  tabs.node.forEach((node, offset) => {
    if (node.type.name === "blockGroup") group = { node, pos: tabs.pos + 1 + offset };
  });
  if (!group) return;
  const panels = [...group.node.content.content];
  const index = panels.findIndex((panel) => panel.attrs.id === panelId);
  if (index < 0 || index + delta < 0 || index + delta >= panels.length) return;
  [panels[index], panels[index + delta]] = [panels[index + delta]!, panels[index]!];
  const target = group;
  const undo = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
  undo?.stopCapturing();
  editor.transact((tr) => tr.replaceWith(target.pos + 1, target.pos + target.node.nodeSize - 1, panels));
  undo?.stopCapturing();
}

export function duplicateTabPanel(editor: BlockNoteEditor<any, any, any>, panelId: string) {
  const panel = containerAt(editor.prosemirrorState.doc, panelId);
  if (!panel || panel.node.firstChild?.type.name !== "tabPanel") return null;
  const copy = remapFeatureSlice(new Slice(Fragment.from(panel.node), 0, 0)).content.firstChild!;
  const undo = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
  undo?.stopCapturing();
  editor.transact((tr) => tr.insert(panel.pos + panel.node.nodeSize, copy));
  undo?.stopCapturing();
  return String(copy.attrs.id);
}
