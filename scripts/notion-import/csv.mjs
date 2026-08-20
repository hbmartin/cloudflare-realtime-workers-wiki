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
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)\.\d*[1-9]$/;

function isValidDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isSafeNumber(value) {
  // Integer-shaped exports are commonly ids. Require an explicit decimal point and a
  // canonical JS round trip; padded, exponent, and precision-changing forms stay text.
  if (!CANONICAL_DECIMAL.test(value)) return false;
  const number = Number(value);
  if (!Number.isFinite(number) || Object.is(number, -0)) return false;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction] = unsigned.split(".");
  const decimalNumerator = BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n);
  const decimalDenominator = 10n ** BigInt(fraction.length);

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, number, false);
  const bits = view.getBigUint64(0, false);
  const sign = bits >> 63n ? -1n : 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & ((1n << 52n) - 1n);
  const mantissa = rawExponent === 0 ? fractionBits : (1n << 52n) | fractionBits;
  const binaryExponent = (rawExponent === 0 ? 1 - 1023 : rawExponent - 1023) - 52;
  const binaryNumerator = sign * (binaryExponent >= 0 ? mantissa << BigInt(binaryExponent) : mantissa);
  const binaryDenominator = binaryExponent >= 0 ? 1n : 1n << BigInt(-binaryExponent);
  return decimalNumerator * binaryDenominator === binaryNumerator * decimalDenominator;
}

/** RFC 4180 parser: quoted fields, escaped quotes, and newlines inside a cell. */
export function parseCsv(input) {
  const withoutBom = input.charCodeAt(0) === 0xfe_ff ? input.slice(1) : input;
  // Outside a quoted field the parser already drops the CR half of CRLF. Normalize
  // first so a multiline quoted field gets the same newline representation.
  const text = withoutBom.replaceAll("\r\n", "\n");
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
  if (present.every((value) => isValidDate(value.slice(0, 10)))) {
    return "date";
  }
  if (present.every(isSafeNumber)) return "number";
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
