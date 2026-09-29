/** Shared wire shape. Reminder preferences stay private in D1. */
export const dateMentionInlineConfig = {
  type: "dateMention",
  content: "none",
  propSchema: {
    // One Yjs attribute keeps date, timezone, and revision together when
    // collaborators edit the same token concurrently.
    payload: { default: "" },
    // Earlier Phase 3 documents stored these separately. Keep the attributes
    // in the schema until every such token has been edited into a payload.
    tokenId: { default: "" },
    revision: { default: "" },
    createdBy: { default: "" },
    kind: { default: "all-day" },
    value: { default: "" },
    timezone: { default: "" },
  },
} as const;
