import { createExtension } from "@blocknote/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { dateMentionFromProps } from "../shared/date-mentions";

export function regeneratePastedDateMentions(slice: Slice, userId: string): Slice {
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

export function dateMentionPasteExtension(userId: string) {
  return createExtension({
    key: "dateMentionPaste",
    prosemirrorPlugins: [
      new Plugin({
        props: { transformPasted: (slice) => regeneratePastedDateMentions(slice, userId) },
      }),
    ],
  });
}
