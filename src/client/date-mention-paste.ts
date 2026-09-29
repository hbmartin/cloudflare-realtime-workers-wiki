import { createExtension } from "@blocknote/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { dateMentionFromProps } from "../shared/date-mentions";

export function regeneratePastedDateMentions(slice: Slice, userId: string): Slice {
  let containsDate = false;
  slice.content.descendants((node) => {
    if (node.type.name === "dateMention") containsDate = true;
    return !containsDate;
  });
  if (!containsDate) return slice;
  const rewrite = (fragment: Fragment): Fragment =>
    Fragment.fromArray(
      fragment.content.map((node: ProseMirrorNode) => {
        if (node.type.name === "dateMention") {
          const mention = dateMentionFromProps(node.attrs);
          if (mention) {
            return node.type.create(
              {
                ...node.attrs,
                payload: JSON.stringify({
                  ...mention,
                  tokenId: crypto.randomUUID(),
                  revision: crypto.randomUUID(),
                  createdBy: userId,
                }),
              },
              node.content,
              node.marks,
            );
          }
        }
        return node.content.size ? node.copy(rewrite(node.content)) : node;
      }),
    );
  return new Slice(rewrite(slice.content), slice.openStart, slice.openEnd);
}

function tokenIds(slice: Slice) {
  const ids = new Set<string>();
  slice.content.descendants((node) => {
    if (node.type.name === "dateMention") {
      const mention = dateMentionFromProps(node.attrs);
      if (mention) ids.add(mention.tokenId);
    }
  });
  return ids;
}

export function dateMentionPasteExtension(userId: string) {
  let dragSource: HTMLElement | null = null;
  let preserveDrop = false;
  let cutIds: Set<string> | null = null;
  return createExtension({
    key: "dateMentionPaste",
    prosemirrorPlugins: [
      new Plugin({
        view(view) {
          const onDragStart = (event: DragEvent) => {
            dragSource = view.dom.parentElement?.contains(event.target as Node) ? view.dom.parentElement : null;
          };
          const onDragEnd = () => {
            dragSource = null;
            preserveDrop = false;
          };
          window.addEventListener("dragstart", onDragStart);
          window.addEventListener("dragend", onDragEnd);
          return {
            destroy: () => {
              window.removeEventListener("dragstart", onDragStart);
              window.removeEventListener("dragend", onDragEnd);
            },
          };
        },
        props: {
          handleDOMEvents: {
            cut(view) {
              cutIds = tokenIds(view.state.doc.slice(view.state.selection.from, view.state.selection.to));
              return false;
            },
            copy() {
              cutIds = null;
              return false;
            },
            paste() {
              preserveDrop = false;
              return false;
            },
            drop(view, event) {
              let dragCopies: boolean | undefined;
              view.someProp("dragCopies", (test) => {
                dragCopies = Boolean(dragCopies || test(event));
              });
              const copyModifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? event.altKey : event.ctrlKey;
              preserveDrop =
                dragSource === view.dom.parentElement &&
                Boolean(view.dragging) &&
                !(dragCopies === undefined ? copyModifier : dragCopies);
              dragSource = null;
              return false;
            },
          },
          transformPasted(slice, view) {
            const ids = tokenIds(slice);
            if (!ids.size) return slice;
            const existing = new Set<string>();
            view.state.doc.descendants((node) => {
              if (node.type.name === "dateMention") {
                const mention = dateMentionFromProps(node.attrs);
                if (mention) existing.add(mention.tokenId);
              }
            });
            const movedCut = cutIds && [...ids].every((id) => cutIds!.has(id) && !existing.has(id));
            cutIds = null;
            const preserve = preserveDrop || movedCut;
            preserveDrop = false;
            if (preserve) return slice;
            return regeneratePastedDateMentions(slice, userId);
          },
        },
      }),
    ],
  });
}
