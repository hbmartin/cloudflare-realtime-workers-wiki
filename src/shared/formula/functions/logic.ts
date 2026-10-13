// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/functions/logic.ts; AGPL-3.0.
import { register } from "./registry";

register({
  name: "empty",
  arity: { min: 1, max: 1 },
  paramTypes: "any",
  returnType: "boolean",
  eval: ([v]) => v === null || v === undefined || v === "" || (typeof v === "object" && v !== null && "__err" in v),
  doc: "Returns true if the value is null or empty string or an error.",
  category: "logic",
});
