import type { ProseMirrorJson } from "./types";

// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea
// packages/editor-ext/src/lib/{status,tabs,footnotes}; AGPL-3.0.
export const STATUS_COLORS = ["gray", "blue", "green", "yellow", "red", "purple"] as const;
export const EDITOR_LABEL_MAX = 200;
export const TABS_MAX = 20;
export const statusBadgeConfig = {
  type: "statusBadge",
  content: "none",
  propSchema: { label: { default: "Status" }, color: { default: "gray", values: STATUS_COLORS } },
} as const;
export const footnoteReferenceConfig = {
  type: "footnoteReference",
  content: "none",
  propSchema: { definitionId: { default: "" } },
} as const;
export const tabsConfig = { type: "tabs", content: "none", propSchema: {} } as const;
export const tabPanelConfig = { type: "tabPanel", content: "none", propSchema: { label: { default: "Tab" } } } as const;
export const footnotesConfig = { type: "footnotes", content: "none", propSchema: {} } as const;
export const footnoteDefinitionConfig = {
  type: "footnoteDefinition",
  content: "inline",
  propSchema: { definitionId: { default: "" } },
} as const;

export type FootnoteCatalog = { numbers: Map<string, number>; definitions: Map<string, ProseMirrorJson> };
export function footnoteCatalog(document: ProseMirrorJson): FootnoteCatalog {
  const numbers = new Map<string, number>();
  const definitions = new Map<string, ProseMirrorJson>();
  const visit = (node: ProseMirrorJson) => {
    const id = node.attrs?.definitionId;
    if (typeof id === "string" && id) {
      if (node.type === "footnoteReference" && !numbers.has(id)) numbers.set(id, numbers.size + 1);
      if (node.type === "footnoteDefinition" && !definitions.has(id)) definitions.set(id, node);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(document);
  return { numbers, definitions };
}
export function footnoteAnchor(id: string) {
  return `footnote-${encodeURIComponent(id)}`;
}
export function statusBadgeText(node: ProseMirrorJson) {
  return typeof node.attrs?.label === "string" ? node.attrs.label : "Status";
}
export function tabPanelLabel(node: ProseMirrorJson) {
  return typeof node.attrs?.label === "string" ? node.attrs.label : "Tab";
}

export const linkedTableViewConfig = {
  type: "linkedTableView",
  content: "none",
  propSchema: { tablePageId: { default: "" }, viewId: { default: "" }, title: { default: "Linked table" } },
} as const;
