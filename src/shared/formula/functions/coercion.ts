// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/functions/coercion.ts; AGPL-3.0.
import { register } from "./registry";
import { valueToString } from "../number";

register({
  name: "toNumber",
  arity: { min: 1, max: 1 },
  paramTypes: "any",
  returnType: "number",
  eval: ([v]) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  doc: "Parses the value as a number, or null.",
  category: "coercion",
});
register({
  name: "toString",
  arity: { min: 1, max: 1 },
  paramTypes: "any",
  returnType: "string",
  eval: ([v]) => valueToString(v),
  doc: "Converts the value to a string.",
  category: "coercion",
});
