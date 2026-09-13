import { describe, expect, it } from "vitest";
import { requireImportOptions, parseImportOptions } from "./import-space-mapping";

describe("import option diagnostics", () => {
  it.each([
    [{ format: "pdf" }, "Import options are invalid."],
    [{ groupSpaceIds: { Imported: 42 } }, "Import space mappings are invalid."],
    [{ previewGroupKeys: ["Imported", "Imported"] }, "Import preview groups are invalid."],
    [{ previewId: "" }, "Import preview groups are invalid."],
    [{ previewGroupKeys: ["Imported"], groupSpaceIds: { Other: "space" } }, "Import space mappings are invalid."],
  ])("retains a specific diagnostic for %j", (invalid, message) => {
    const options = { filename: "notes.md", format: "markdown", confirmed: false, ...invalid };
    expect(parseImportOptions(options)).toBeNull();
    expect(() => requireImportOptions(options)).toThrow(message);
  });
});
