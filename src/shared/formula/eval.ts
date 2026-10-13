/* eslint-disable typescript/consistent-return -- Exhaustive AST discriminated-union switches. */
// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/eval.ts; AGPL-3.0.
import { makeErrorCell, isErrorCell } from "./error";
import { valueToString } from "./number";
import { MAX_EVAL_DEPTH } from "./types";
import type { FormulaAST, OpCode } from "./ast";
import type { Value, EvalContext } from "./types";

export function evaluate(ast: FormulaAST, row: Record<string, unknown>, ctx: EvalContext, astDepth = 0): Value {
  const result = evaluateValue(ast, row, ctx, astDepth);
  return typeof result === "number" && !Number.isFinite(result)
    ? makeErrorCell("NON_FINITE", "Formula produced a non-finite number")
    : result;
}

function evaluateValue(ast: FormulaAST, row: Record<string, unknown>, ctx: EvalContext, astDepth: number): Value {
  // astDepth bounds AST tree-walk recursion (guards a hand-crafted deep
  // typeOptions.ast); ctx.depth separately bounds nested-formula hops.
  const depth = astDepth + 1;
  if (depth > MAX_EVAL_DEPTH) {
    return makeErrorCell("DEPTH_EXCEEDED", `formula too deeply nested (max ${MAX_EVAL_DEPTH})`);
  }

  switch (ast.t) {
    case "num":
      return ast.v;
    case "str":
      return ast.v;
    case "bool":
      return ast.v;
    case "null":
      return null;
    case "prop":
      return evalProp(ast.id, row, ctx, depth);
    case "op":
      return evalOp(ast.op, ast.args, row, ctx, depth);
    case "if": {
      const c = evaluate(ast.cond, row, ctx, depth);
      if (isErrorCell(c)) return c;
      if (c !== null && typeof c !== "boolean") return makeErrorCell("TYPE_MISMATCH", "if() condition needs boolean");
      return evaluate(c === true ? ast.then : ast.else, row, ctx, depth);
    }
    case "and": {
      const xs = ast.args;
      for (let i = 0; i < xs.length; i++) {
        const v = evaluate(xs[i]!, row, ctx, depth);
        if (isErrorCell(v)) return v;
        if (v === false) return false;
        if (v === null || v === undefined) return null;
      }
      return true;
    }
    case "or": {
      const xs = ast.args;
      for (let i = 0; i < xs.length; i++) {
        const v = evaluate(xs[i]!, row, ctx, depth);
        if (isErrorCell(v)) return v;
        if (v === true) return true;
      }
      return false;
    }
    case "call": {
      const fn = ctx.registry.get(ast.fn.toLowerCase());
      if (!fn) return makeErrorCell("MISSING_PROP", `unknown function ${ast.fn}`);
      const xs = ast.args;
      const args: Value[] = [];
      for (let i = 0; i < xs.length; i++) {
        const v = evaluate(xs[i]!, row, ctx, depth);
        if (isErrorCell(v)) return { ...v, __err: "DEPENDENCY_ERROR" };
        args[i] = v;
      }
      try {
        return fn.eval(args, ctx);
      } catch (e) {
        return makeErrorCell("TYPE_MISMATCH", (e as Error).message);
      }
    }
  }
}

function evalProp(id: string, row: Record<string, unknown>, ctx: EvalContext, astDepth: number): Value {
  if (ctx.memo.has(id)) return ctx.memo.get(id)!;
  const prop = ctx.properties.get(id);
  if (!prop) return makeErrorCell("MISSING_PROP", `missing property ${id}`);
  if (prop.type !== "formula") {
    const value = normalize(row[id] ?? null);
    if (value === null || isErrorCell(value)) return value;
    const expected =
      prop.type === "number" ? "number" : ["checkbox", "boolean"].includes(prop.type) ? "boolean" : "string";
    return typeof value === expected
      ? value
      : makeErrorCell("TYPE_MISMATCH", "Property input does not match its declared scalar type");
  }
  // astDepth continues (not reset) across the nested-formula boundary.
  if (ctx.depth >= ctx.maxDepth) return makeErrorCell("DEPTH_EXCEEDED", `max depth ${ctx.maxDepth}`);
  const opts: any = prop.typeOptions;
  if (opts.validationError) return makeErrorCell("DEPENDENCY_ERROR", opts.validationError);
  const nested: EvalContext = { ...ctx, depth: ctx.depth + 1, memo: ctx.memo };
  const v = evaluate(opts.ast, row, nested, astDepth);
  ctx.memo.set(id, v);
  return v;
}

function normalize(v: unknown): Value {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : makeErrorCell("NON_FINITE", "Non-finite property input");
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (isErrorCell(v)) return v;
  return makeErrorCell("TYPE_MISMATCH", "Collection and object inputs are unsupported");
}

function evalOp(
  op: OpCode,
  args: FormulaAST[],
  row: Record<string, unknown>,
  ctx: EvalContext,
  astDepth: number,
): Value {
  const a = evaluate(args[0]!, row, ctx, astDepth);
  if (isErrorCell(a)) return { ...a, __err: "DEPENDENCY_ERROR" };
  if (op === "neg") return a === null || a === undefined ? null : -Number(a);
  if (op === "not") return a === null || a === undefined ? null : !a;

  const b = evaluate(args[1]!, row, ctx, astDepth);
  if (isErrorCell(b)) return { ...b, __err: "DEPENDENCY_ERROR" };

  switch (op as Exclude<OpCode, "neg" | "not">) {
    case "+":
      if (typeof a === "string" || typeof b === "string") return valueToString(a) + valueToString(b);
      if (a === null || a === undefined || b === null || b === undefined) return null;
      return Number(a) + Number(b);
    case "-":
      return a === null || a === undefined || b === null || b === undefined ? null : Number(a) - Number(b);
    case "*":
      return a === null || a === undefined || b === null || b === undefined ? null : Number(a) * Number(b);
    case "/":
      if (a === null || a === undefined || b === null || b === undefined) return null;
      if (Number(b) === 0) return makeErrorCell("DIV_BY_ZERO", "division by zero");
      return Number(a) / Number(b);
    case "%":
      if (a === null || a === undefined || b === null || b === undefined) return null;
      if (Number(b) === 0) return makeErrorCell("DIV_BY_ZERO", "modulo by zero");
      return Number(a) % Number(b);
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case ">":
      return a !== null && a !== undefined && b !== null && b !== undefined && (a as any) > (b as any);
    case "<":
      return a !== null && a !== undefined && b !== null && b !== undefined && (a as any) < (b as any);
    case ">=":
      return a !== null && a !== undefined && b !== null && b !== undefined && (a as any) >= (b as any);
    case "<=":
      return a !== null && a !== undefined && b !== null && b !== undefined && (a as any) <= (b as any);
  }
}
