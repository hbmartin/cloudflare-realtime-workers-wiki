import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";

/** Copies receive new block/native-row identities, and definitions carried by
 * the selection remap their paired references. Standalone references retain
 * their targets. Internal moves bypass this transform in the editor plugin. */
export function remapFeatureSlice(slice: Slice) {
  const ids = new Map<string, string>();
  slice.content.descendants((node) => {
    if (node.type.name === "footnoteDefinition" && node.attrs.definitionId && !ids.has(node.attrs.definitionId))
      ids.set(node.attrs.definitionId, crypto.randomUUID());
  });
  const rewrite = (node: PMNode): PMNode => {
    const attrs = { ...node.attrs };
    if (node.type.name === "blockContainer") attrs.id = crypto.randomUUID();
    if (node.type.name === "tableRow" && attrs.apiRowId) attrs.apiRowId = crypto.randomUUID();
    if (["footnoteDefinition", "footnoteReference"].includes(node.type.name) && ids.has(attrs.definitionId))
      attrs.definitionId = ids.get(attrs.definitionId);
    return node.isText
      ? node
      : node.type.create(attrs, Fragment.fromArray([...node.content.content].map(rewrite)), node.marks);
  };
  return new Slice(Fragment.fromArray([...slice.content.content].map(rewrite)), slice.openStart, slice.openEnd);
}
