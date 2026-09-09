export const PAGE_KINDS = ["document", "table", "diagram"] as const;

export type PageKind = (typeof PAGE_KINDS)[number];
