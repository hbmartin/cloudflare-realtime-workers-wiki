import { describe, expect, it } from "vitest";
import { FORMULA_GOLDENS } from "./golden-fixtures";
import {
  compileFormula,
  evaluateFormula,
  format,
  formulaDependencyOrder,
  retypeFormulaProperties,
  type FormulaProperty,
  type FormulaTypeOptions,
} from "./index";

const properties: FormulaProperty[] = [
  { id: "price", name: "Price", type: "number" },
  { id: "date", name: "Date", type: "date" },
];
function run(source: string, row: Record<string, unknown> = {}) {
  return evaluateFormula(compileFormula(source, properties, "result"), row, properties);
}
describe("shared deterministic formulas", () => {
  it.each(FORMULA_GOLDENS)("evaluates %s", (source, expected) => expect(run(source, { price: 4 })).toEqual(expected));
  it("binds stable IDs and reformats renamed properties", () => {
    const compiled = compileFormula('prop("Price") + 1', properties, "result");
    expect(compiled.dependencies).toEqual(["price"]);
    expect(format(compiled.ast, new Map([["price", "Cost"]]))).toBe('(prop("Cost") + 1)');
    expect(evaluateFormula(compiled, { price: 8 }, [{ ...properties[0]!, name: "Cost" }])).toBe(9);
  });
  it("round-trips renamed properties containing quotes, backslashes and line breaks", () => {
    const compiled = compileFormula('prop("Price") + 1', properties, "result");
    const name = 'Cost "net" \\ total\nnext\r\t\u0000';
    const renamed = [{ ...properties[0]!, name }];
    const source = format(compiled.ast, new Map([["price", name]]));
    expect(compileFormula(source, renamed, "result").dependencies).toEqual(["price"]);
    expect(evaluateFormula(compileFormula(source, renamed, "result"), { price: 8 }, renamed)).toBe(9);
  });
  it("retypes stored dependencies without coercion or name rebinding after conversion", () => {
    const scalar = compileFormula('prop("Price")', properties, "scalar");
    const arithmetic = compileFormula('prop("Price")*2', properties, "arithmetic");
    const changed = [
      { id: "price", name: "Cost", type: "text" },
      { id: "replacement", name: "Price", type: "number" },
      { id: "scalar", name: "Scalar", type: "formula", config: scalar },
      { id: "arithmetic", name: "Arithmetic", type: "formula", config: arithmetic },
    ];
    const current = retypeFormulaProperties<FormulaProperty>(changed);
    expect(current[2]?.config).toMatchObject({ resultType: "string", dependencies: ["price"], source: 'prop("Cost")' });
    expect(current[3]?.config).toMatchObject({ resultType: "null", validationError: expect.any(String) });
    expect(evaluateFormula(arithmetic, { price: "3", replacement: 9 }, changed)).toMatchObject({
      __err: "DEPENDENCY_ERROR",
    });
    expect(evaluateFormula(current[2]!.config as FormulaTypeOptions, { price: "3", replacement: 9 }, current)).toBe(
      "3",
    );
    expect(evaluateFormula(scalar, { price: "3" }, properties)).toMatchObject({ __err: "TYPE_MISMATCH" });
  });
  it("rejects invalid arguments, conditions, wall clock functions and collections", () => {
    for (const source of ["if(1, 2, 3)", 'round("one")', 'sum("1")', "now()", "today()", "fetch()"])
      expect(() => run(source)).toThrow(/.+/);
    expect(run('prop("Price")', { price: [1, 2] })).toMatchObject({ __err: "TYPE_MISMATCH" });
    expect(run('prop("Price")', { price: Infinity })).toMatchObject({ __err: "NON_FINITE" });
    expect(run("1 / 0")).toMatchObject({ __err: "DIV_BY_ZERO" });
    expect(run(`round(1, ${"9".repeat(400)})`)).toMatchObject({ __err: "DEPENDENCY_ERROR" });
  });
  it("detects cycles and orders invalidation by dependency", () => {
    expect(() => compileFormula('prop("Self")', [{ id: "self", name: "Self", type: "formula" }], "self")).toThrow(
      expect.objectContaining({ errors: [expect.objectContaining({ code: "CYCLE" })] }),
    );
    const a = compileFormula('prop("Price") + 1', properties, "a");
    const withA = [...properties, { id: "a", name: "A", type: "formula", config: a }];
    const b = compileFormula('prop("A") + 1', withA, "b");
    const all = [...withA, { id: "b", name: "B", type: "formula", config: b }];
    expect(formulaDependencyOrder(all, ["price"])).toEqual(["a", "b"]);
    expect(() => compileFormula('prop("B")', all, "a")).toThrow(/cycle/);
  });
});
