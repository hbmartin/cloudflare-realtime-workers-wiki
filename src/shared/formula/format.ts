/* eslint-disable typescript/consistent-return -- Exhaustive AST discriminated-union switches. */
// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/format.ts; AGPL-3.0.
import type { FormulaAST, OpCode } from "./ast";

const OP_STR: Partial<Record<OpCode, string>> = {
  "+": " + ",
  "-": " - ",
  "*": " * ",
  "/": " / ",
  "%": " % ",
  "==": " == ",
  "!=": " != ",
  ">": " > ",
  "<": " < ",
  ">=": " >= ",
  "<=": " <= ",
};

export function format(ast: FormulaAST, idToName: ReadonlyMap<string, string>): string {
  switch (ast.t) {
    case "num":
      return String(ast.v);
    case "str":
      return JSON.stringify(ast.v);
    case "bool":
      return ast.v ? "true" : "false";
    case "null":
      return "null";
    case "prop":
      return `prop(${JSON.stringify(idToName.get(ast.id) ?? ast.id)})`;
    case "op":
      if (ast.op === "neg") return `-${format(ast.args[0]!, idToName)}`;
      if (ast.op === "not") return `not ${format(ast.args[0]!, idToName)}`;
      return `(${format(ast.args[0]!, idToName)}${OP_STR[ast.op]}${format(ast.args[1]!, idToName)})`;
    case "if":
      return `if(${format(ast.cond, idToName)}, ${format(ast.then, idToName)}, ${format(ast.else, idToName)})`;
    case "and":
      return `(${ast.args.map((a) => format(a, idToName)).join(" and ")})`;
    case "or":
      return `(${ast.args.map((a) => format(a, idToName)).join(" or ")})`;
    case "call":
      return `${ast.fn}(${ast.args.map((a) => format(a, idToName)).join(", ")})`;
  }
}
