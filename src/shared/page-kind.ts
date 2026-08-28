export const PAGE_KINDS = ["document", "table"] as const;

export type PageKind = (typeof PAGE_KINDS)[number];
