import { describe, expect, it } from "vitest";
import { calculateColumn, computeRowFormulas } from "./table-computed";
import { compileFormula } from "./formula/index";
describe("typed table computations", () => {
  it("counts collection emptiness without treating collections as scalar unique values", () => {
    const inputs = [null, [], ["person"], ["first", "second"]];
    expect(calculateColumn("row_count", inputs)).toMatchObject({ value: 4, unsupportedCount: 0 });
    expect(calculateColumn("nonempty_count", inputs)).toMatchObject({ value: 2, unsupportedCount: 0 });
    expect(calculateColumn("empty_count", inputs)).toMatchObject({ value: 2, unsupportedCount: 0 });
    expect(calculateColumn("unique_count", inputs)).toMatchObject({ value: 0, unsupportedCount: 3 });
  });
  it("keeps source stamps extensible and rejects deleted dependencies", () => {
    const properties = [{ id: "price", name: "Price", type: "number" }];
    const formula = {
      id: "total",
      name: "Total",
      type: "formula",
      config: compileFormula('prop("Price")*2', properties, "total"),
    };
    const input = {
      tableId: "table",
      tableRevision: 8,
      schemaRevision: 3,
      rowId: "row",
      rowRevision: 2,
      cells: { price: 4 },
      properties: [...properties, formula],
    };
    expect(computeRowFormulas(input).total).toEqual({
      version: 1,
      value: 8,
      source: {
        version: 1,
        tableId: "table",
        tableRevision: 8,
        schemaRevision: 3,
        rowId: "row",
        rowRevision: 2,
        dependencies: [{ tableId: "table", propertyId: "price", schemaRevision: 3 }],
      },
    });
    expect(computeRowFormulas({ ...input, properties: [formula] }).total?.value).toMatchObject({
      __err: "DEPENDENCY_ERROR",
    });
  });
  it("counts all rows while excluding formula errors from scalar aggregates", () => {
    const values = [1, 2, null, "", { __err: "DIV_BY_ZERO", msg: "Division by zero", v: 1 }, [2]];
    expect(calculateColumn("row_count", values)).toMatchObject({ value: 6, errorCount: 1, unsupportedCount: 0 });
    expect(calculateColumn("sum", values).value).toBe(3);
    expect(calculateColumn("empty_count", values).value).toBe(2);
    expect(calculateColumn("unique_count", [1, "1", 1, false]).value).toBe(3);
    expect(calculateColumn("sum", []).value).toBe(0);
    expect(calculateColumn("average", []).value).toBeNull();
    expect(calculateColumn("earliest", ["2026-02-01", "2026-01-01"]).value).toBe("2026-01-01");
  });
});
