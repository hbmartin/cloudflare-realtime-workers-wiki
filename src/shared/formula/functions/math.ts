// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/functions/math.ts; AGPL-3.0.
import { register } from "./registry";
import type { Value } from "../types";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

register({
  name: "round",
  arity: { min: 1, max: 2 },
  paramTypes: ["number", "number"],
  returnType: "number",
  eval: ([v, places]) => {
    const n = num(v);
    if (n === null || n === undefined) return null;
    const p = places === null || places === undefined ? 0 : Math.trunc(Number(places));
    const factor = Math.pow(10, p);
    return Math.round(n * factor) / factor;
  },
  doc: "Rounds to the nearest integer, or to `places` decimals if given.",
  category: "math",
});
register({
  name: "floor",
  arity: { min: 1, max: 1 },
  paramTypes: ["number"],
  returnType: "number",
  eval: ([v]) => {
    const n = num(v);
    return n === null || n === undefined ? null : Math.floor(n);
  },
  doc: "Rounds down.",
  category: "math",
});
register({
  name: "ceil",
  arity: { min: 1, max: 1 },
  paramTypes: ["number"],
  returnType: "number",
  eval: ([v]) => {
    const n = num(v);
    return n === null || n === undefined ? null : Math.ceil(n);
  },
  doc: "Rounds up.",
  category: "math",
});
register({
  name: "abs",
  arity: { min: 1, max: 1 },
  paramTypes: ["number"],
  returnType: "number",
  eval: ([v]) => {
    const n = num(v);
    return n === null || n === undefined ? null : Math.abs(n);
  },
  doc: "Absolute value.",
  category: "math",
});
register({
  name: "min",
  arity: { min: 1, max: null },
  paramTypes: "variadic-any",
  returnType: "number",
  eval: (args) => {
    const nums = args.map(num).filter((n): n is number => n !== null && n !== undefined);
    return nums.length ? Math.min(...nums) : null;
  },
  doc: "Minimum of the arguments.",
  category: "math",
});
register({
  name: "max",
  arity: { min: 1, max: null },
  paramTypes: "variadic-any",
  returnType: "number",
  eval: (args) => {
    const nums = args.map(num).filter((n): n is number => n !== null && n !== undefined);
    return nums.length ? Math.max(...nums) : null;
  },
  doc: "Maximum of the arguments.",
  category: "math",
});

register({
  name: "sum",
  arity: { min: 1, max: null },
  paramTypes: "variadic-any",
  returnType: "number",
  eval: (args) => {
    // Null propagates as 0 so `sum(prop("A"), prop("B"))` still works when
    // some cells are empty — matches Airtable/Notion semantics.
    let total = 0;
    for (const v of args) {
      const n = num(v);
      if (n !== null && n !== undefined && Number.isFinite(n)) total += n;
    }
    return total;
  },
  doc: "Sum of the arguments.",
  category: "math",
});
const meanEval = (args: Value[]): Value => {
  const nums: number[] = [];
  for (const v of args) {
    const n = num(v);
    if (n !== null && n !== undefined && Number.isFinite(n)) nums.push(n);
  }
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};

register({
  name: "average",
  arity: { min: 1, max: null },
  paramTypes: "variadic-any",
  returnType: "number",
  eval: meanEval,
  doc: "Arithmetic average of the arguments (alias of mean).",
  category: "math",
});
register({
  name: "median",
  arity: { min: 1, max: null },
  paramTypes: "variadic-any",
  returnType: "number",
  eval: (args) => {
    const nums: number[] = [];
    for (const v of args) {
      const n = num(v);
      if (n !== null && n !== undefined && Number.isFinite(n)) nums.push(n);
    }
    if (nums.length === 0) return null;
    nums.sort((a, b) => a - b);
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 === 0 ? (nums[mid - 1]! + nums[mid]!) / 2 : nums[mid]!;
  },
  doc: "Middle value of the arguments.",
  category: "math",
});
