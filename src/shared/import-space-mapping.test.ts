import { describe, expect, it } from "vitest";
import type { ImportPreview } from "./types";
import {
  hasCurrentImportConfirmation,
  importConfirmationMatchesPreview,
  NOTION_GROUPING_VERSION,
  requireImportOptions,
  parseImportOptions,
  type ImportOptions,
} from "./import-space-mapping";

describe("import option diagnostics", () => {
  it.each([
    [{ format: "pdf" }, "Import options are invalid."],
    [{ groupSpaceIds: { Imported: 42 } }, "Import space mappings are invalid."],
    [{ previewGroupKeys: ["Imported", "Imported"] }, "Import preview groups are invalid."],
    [{ previewId: "" }, "Import preview groups are invalid."],
    [{ previewGroupKeys: ["Imported"], groupSpaceIds: { Other: "space" } }, "Import space mappings are invalid."],
    [{ parentId: "" }, "Import parent is invalid."],
    [{ parentId: 42 }, "Import parent is invalid."],
    [{ parentId: "p".repeat(101) }, "Import parent is invalid."],
    [{ parentId: "bad/path" }, "Import parent is invalid."],
    [{ parentId: "parent", format: "notion_zip" }, "Import parent is invalid."],
  ])("retains a specific diagnostic for %j", (invalid, message) => {
    const options = { filename: "notes.md", format: "markdown", confirmed: false, ...invalid };
    expect(parseImportOptions(options)).toBeNull();
    expect(() => requireImportOptions(options)).toThrow(message);
  });
});

describe("single-page import parent", () => {
  it("accepts DOCX options through preview confirmation", () => {
    const options = requireImportOptions({
      filename: "brief.docx",
      format: "docx",
      parentId: "parent",
      confirmed: true,
      previewId: "preview",
      previewGroupKeys: ["Imported"],
    });
    expect(options.format).toBe("docx");
    expect(hasCurrentImportConfirmation(options)).toBe(true);
  });

  it("retains a parent while a Markdown import moves from inspection to confirmation", () => {
    const options = requireImportOptions({
      filename: "notes.md",
      format: "markdown",
      confirmed: false,
      parentId: "parent",
    });
    expect(options.parentId).toBe("parent");
    expect(requireImportOptions({ ...options, confirmed: true, previewId: "preview" }).parentId).toBe("parent");
    expect(requireImportOptions({ ...options, parentId: null }).parentId).toBeUndefined();
  });
});

describe("import preview currency", () => {
  const preview: ImportPreview = {
    format: "notion_zip",
    filename: "notes.zip",
    previewId: "preview",
    groupingVersion: NOTION_GROUPING_VERSION,
    pages: 1,
    tables: 0,
    assets: 0,
    roots: 1,
    nested: 0,
    maxDepth: 0,
    resolvedLinks: 0,
    unresolvedLinks: 0,
    unresolvedParents: 0,
    groups: [],
    warnings: [],
  };
  const confirmed = {
    filename: preview.filename,
    format: preview.format,
    confirmed: true,
    previewId: "preview",
    previewGroupingVersion: NOTION_GROUPING_VERSION,
  } satisfies ImportOptions;

  it("distinguishes current confirmation metadata from matching the saved preview", () => {
    expect(hasCurrentImportConfirmation(confirmed)).toBe(true);
    expect(importConfirmationMatchesPreview(confirmed, preview)).toBe(true);
    expect(importConfirmationMatchesPreview({ ...confirmed, previewId: "other" }, preview)).toBe(false);
    expect(hasCurrentImportConfirmation({ ...confirmed, previewGroupingVersion: NOTION_GROUPING_VERSION - 1 })).toBe(
      false,
    );
    expect(
      importConfirmationMatchesPreview(
        { ...confirmed, previewGroupingVersion: NOTION_GROUPING_VERSION - 1 },
        { ...preview, groupingVersion: NOTION_GROUPING_VERSION - 1 },
      ),
    ).toBe(true);
  });
});
