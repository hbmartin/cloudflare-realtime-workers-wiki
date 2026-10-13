// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/ast.ts; AGPL-3.0.
export type OpCode = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | ">" | "<" | ">=" | "<=" | "neg" | "not";

export type FormulaAST =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "prop"; id: string }
  | { t: "op"; op: OpCode; args: FormulaAST[] }
  | { t: "if"; cond: FormulaAST; then: FormulaAST; else: FormulaAST }
  | { t: "and"; args: FormulaAST[] }
  | { t: "or"; args: FormulaAST[] }
  | { t: "call"; fn: string; args: FormulaAST[] };

/*
 * Raw AST: what the parser produces before resolving property names to IDs.
 * Only the `propName` variant differs from FormulaAST — every other node is
 * reused directly. We deliberately keep this type-level to avoid duplicating
 * the tree shape.
 */
export type RawFormulaAST =
  | Exclude<FormulaAST, { t: "prop" }>
  | { t: "propName"; name: string }
  | { t: "op"; op: OpCode; args: RawFormulaAST[] }
  | { t: "if"; cond: RawFormulaAST; then: RawFormulaAST; else: RawFormulaAST }
  | { t: "and"; args: RawFormulaAST[] }
  | { t: "or"; args: RawFormulaAST[] }
  | { t: "call"; fn: string; args: RawFormulaAST[] };
