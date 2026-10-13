import * as Y from "yjs";
import { DIAGRAM_NODES_ROOT } from "../shared/diagram";

/** Text, marks and presentation attributes do not change editor capabilities. */
export function documentCapabilitiesChanged(
  document: Y.Doc,
  kind: "document" | "diagram",
  transaction?: Y.Transaction,
) {
  if (!transaction) return true;
  const root = kind === "diagram" ? document.getMap(DIAGRAM_NODES_ROOT) : document.getXmlFragment("document-store");
  for (const [type, keys] of transaction.changed) {
    if (Object.is(type, root)) return true;
    if (kind === "diagram") {
      if (type instanceof Y.Map && type.parent === root && (keys.has("linkedPageId") || keys.has("linkedViewId")))
        return true;
    } else if (type instanceof Y.XmlElement && keys.has(null)) {
      let parent: Y.AbstractType<any> | null = type;
      while (parent && parent !== root) parent = parent.parent;
      if (parent === root) return true;
    }
  }
  return false;
}
