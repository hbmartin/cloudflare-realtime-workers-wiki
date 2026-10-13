import { describe, expect, it } from "vitest";
import { FORMULA_GOLDENS } from "../shared/formula/golden-fixtures";
import { compileFormula, evaluateFormula } from "../shared/formula";
import { calculateColumn } from "../shared/table-computed";

const properties = [
  { id: "price", name: "Price", type: "number" },
  { id: "date", name: "Date", type: "date" },
];
describe("Worker formula golden values", () => {
  it.each(FORMULA_GOLDENS)("agrees with the browser-compatible evaluator for %s", (source, expected) => {
    const config = compileFormula(source, properties, "result");
    expect(evaluateFormula(config, { price: 4 }, properties)).toEqual(expected);
  });
  it("retains typed error counts and rejects non-finite aggregate output", () => {
    expect(calculateColumn("sum", [Number.MAX_VALUE, Number.MAX_VALUE])).toMatchObject({ value: null, errorCount: 1 });
    expect(
      evaluateFormula(compileFormula('prop("Price")', properties, "result"), { price: [4] }, properties),
    ).toMatchObject({ __err: "TYPE_MISMATCH", v: 1 });
  });
});
