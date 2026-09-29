/** Shared wire shape. Reminder preferences stay private in D1. */
export const dateMentionInlineConfig = {
  type: "dateMention",
  content: "none",
  propSchema: {
    tokenId: { default: "" },
    revision: { default: "" },
    createdBy: { default: "" },
    kind: { default: "all-day", values: ["all-day", "timed"] },
    value: { default: "" },
    timezone: { default: "UTC" },
  },
} as const;
