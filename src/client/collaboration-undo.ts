import { createExtension } from "@blocknote/core";
import { yUndoPluginKey } from "y-prosemirror";

export const collaborationUndoLifecycleExtension = createExtension(({ editor }) => ({
  key: "collaborationUndoLifecycle",
  mount() {
    const manager = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
    // BlockNote 0.55 retains plugin state across a view remount, while the Yjs
    // plugin destroys its manager on unmount. React's development replay and
    // editable-state remounts must reconnect that same history manager.
    if (manager && !manager.trackedOrigins.has(manager)) {
      manager.trackedOrigins.add(manager);
      manager.doc.on("afterTransaction", manager.afterTransactionHandler);
      // oxlint-disable-next-line typescript/unbound-method -- Yjs binds destroy in the UndoManager constructor.
      manager.doc.on("destroy", manager.destroy);
    }
  },
}));
