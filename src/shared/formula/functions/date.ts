// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/functions/date.ts; AGPL-3.0.
import { register } from "./registry";
import { makeErrorCell } from "../error";

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
};

register({
  name: "dateAdd",
  arity: { min: 3, max: 3 },
  paramTypes: ["date", "number", "string"],
  returnType: "date",
  eval: ([base, amt, unit]) => {
    const d = toDate(base);
    if (!d) return makeErrorCell("DATE_INVALID", "invalid date");
    const n = Number(amt);
    const u = String(unit);
    const r = new Date(d);
    if (u === "days") r.setUTCDate(r.getUTCDate() + n);
    else if (u === "hours") r.setUTCHours(r.getUTCHours() + n);
    else if (u === "minutes") r.setUTCMinutes(r.getUTCMinutes() + n);
    else if (u === "months") r.setUTCMonth(r.getUTCMonth() + n);
    else if (u === "years") r.setUTCFullYear(r.getUTCFullYear() + n);
    else return makeErrorCell("TYPE_MISMATCH", `unknown unit ${u}`);
    return r.toISOString();
  },
  doc: "Adds a duration to a date. Units: days, hours, minutes, months, years.",
  category: "date",
});
register({
  name: "dateBetween",
  arity: { min: 3, max: 3 },
  paramTypes: ["date", "date", "string"],
  returnType: "number",
  eval: ([a, b, unit]) => {
    const da = toDate(a),
      db = toDate(b);
    if (!da || !db) return makeErrorCell("DATE_INVALID", "invalid date");
    const ms = db.getTime() - da.getTime();
    const u = String(unit);
    if (u === "days") return Math.floor(ms / 86_400_000);
    if (u === "hours") return Math.floor(ms / 3_600_000);
    if (u === "minutes") return Math.floor(ms / 60_000);
    return makeErrorCell("TYPE_MISMATCH", `unknown unit ${u}`);
  },
  doc: "Difference between two dates in a given unit.",
  category: "date",
});
