/**
 * The `mention` inline content configuration, deliberately free of React.
 *
 * Two very different callers have to build the *same* TipTap node from this:
 * `src/client/mentions.tsx` pairs it with a React renderer for the browser, and
 * the Notion importer (`scripts/notion-import/`) pairs it with a headless stub so
 * it can convert HTML to a Yjs document in plain Node. If the two ever drifted,
 * imported mentions would parse back as unknown nodes and `projectDocument` would
 * silently stop producing backlinks for them, so the shape lives here once.
 *
 * The prop names are also a wire contract: `propsToAttributes` maps each one to a
 * `data-kebab-case` attribute, which is how the importer emits a mention as plain
 * HTML rather than by constructing ProseMirror nodes by hand.
 */
export const mentionInlineConfig = {
  type: "mention",
  content: "none",
  propSchema: {
    entityType: { default: "page", values: ["page", "user"] },
    entityId: { default: "" },
    label: { default: "" },
  },
} as const;
