import type { ExportFormat } from "./types";
import type { PageKind } from "./page-kind";
export const EXPORT_CAPABILITIES: Record<
  ExportFormat,
  { portable: boolean; kinds: readonly PageKind[]; browser: boolean }
> = {
  markdown: { portable: true, kinds: ["document", "table"], browser: false },
  html: { portable: true, kinds: ["document", "table"], browser: false },
  pdf: { portable: false, kinds: ["document", "table", "diagram"], browser: true },
  docx: { portable: false, kinds: ["document"], browser: false },
  json: { portable: true, kinds: ["diagram"], browser: false },
  svg: { portable: true, kinds: ["diagram"], browser: false },
  png: { portable: false, kinds: ["diagram"], browser: true },
};
