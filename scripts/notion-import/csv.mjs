/**
 * Notion database CSV to typed table columns and rows.
 *
 * Notion exports a database as a CSV of display strings: nothing in the file says which
 * property was a number, a date, or a select. The type is therefore inferred from the
 * values, conservatively - a column falls back to text whenever the evidence is weak,
 * because a wrong type is worse than a plain one. Anything a column cannot represent is
 * reported rather than silently coerced.
 */

const SELECT_MAX_DISTINCT = 40;
const BOOLEAN_VALUES = /^(yes|no|true|false)$/i;
const TRUE_VALUES = /^(yes|true)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** RFC 4180 parser: quoted fields, escaped quotes, and newlines inside a cell. */
export function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xfe_ff ? input.slice(1) : input;
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let started = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    started = true;
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else if (character !== "\r") field += character;
  }
  if (started || field) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Picks the narrowest column type the values all satisfy.
 *
 * A select needs repetition to be worth the option rows, so a column of mostly distinct
 * values stays text even when there are few enough of them. Anything containing a comma
 * is treated as a Notion multi-select, which has no equivalent here, so it stays text
 * rather than becoming one option per unique combination.
 */
export function inferColumnType(values) {
  const present = values.filter((value) => value !== "");
  if (present.length === 0) return "text";
  if (present.every((value) => BOOLEAN_VALUES.test(value))) return "checkbox";
  if (present.every((value) => ISO_DATE.test(value.slice(0, 10)) && !Number.isNaN(Date.parse(value.slice(0, 10))))) {
    return "date";
  }
  if (present.every((value) => value.trim() !== "" && Number.isFinite(Number(value)))) return "number";
  const distinct = new Set(present);
  const repeats = distinct.size <= SELECT_MAX_DISTINCT && distinct.size * 2 <= present.length;
  if (repeats && ![...distinct].some((value) => value.includes(","))) return "select";
  return "text";
}

export function coerceValue(type, raw) {
  if (raw === "") return null;
  if (type === "checkbox") return TRUE_VALUES.test(raw);
  if (type === "number") return Number(raw);
  // Notion writes a date range or a timestamp; only the leading day survives.
  if (type === "date") return raw.slice(0, 10);
  if (type === "select") return { option: raw };
  return raw;
}

/**
 * Turns a parsed CSV into the column and row shapes the bulk table route accepts.
 *
 * Columns are addressed by a `ref` token so a column and the rows that fill it can be
 * sent in the same request, rather than costing a round trip to learn generated ids.
 */
export function tableFromCsv(text, onIssue = () => {}) {
  const rows = parseCsv(text);
  const header = rows.shift() ?? [];
  const columns = header.map((name, index) => {
    const values = rows.map((row) => (row[index] ?? "").trim());
    const type = inferColumnType(values);
    if (type === "text" && values.some((value) => value.includes(","))) {
      onIssue("column_type_degraded", `${name || `column ${index + 1}`}: multi-select kept as text`);
    }
    return { ref: `c${index}`, name: name.trim() || `Column ${index + 1}`, type };
  });

  const body = rows
    .filter((row) => row.some((value) => value.trim() !== ""))
    .map((row) => {
      const cells = {};
      for (const [index, column] of columns.entries()) {
        const value = coerceValue(column.type, (row[index] ?? "").trim());
        if (value !== null) cells[`ref:${column.ref}`] = value;
      }
      return { cells };
    });

  return { columns, rows: body };
}
