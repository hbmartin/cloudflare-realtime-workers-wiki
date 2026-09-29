/** Shared wire shape. Reminder preferences stay private in D1. */
export const dateMentionInlineConfig = {
  type: "dateMention",
  content: "none",
  propSchema: {
    // One Yjs attribute keeps date, timezone, and revision together when
    // collaborators edit the same token concurrently.
    payload: { default: "" },
  },
} as const;
