import { describe, expect, it } from "vitest";
import { coerceValue, inferColumnType, parseCsv, tableFromCsv } from "./csv.mjs";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, and newlines inside a cell", () => {
    const rows = parseCsv('a,b\n"quoted, comma","says ""hi"""\n"line\nbreak",plain\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["quoted, comma", 'says "hi"'],
      ["line\nbreak", "plain"],
    ]);
  });

  it("normalizes CRLF record separators and quoted multiline fields", () => {
    expect(parseCsv('a,b\r\n"line\r\nbreak",plain\r\n')).toEqual([
      ["a", "b"],
      ["line\nbreak", "plain"],
    ]);
  });

  it("strips a byte order mark and tolerates a missing trailing newline", () => {
    expect(parseCsv("﻿Name,Age\nAda,36")).toEqual([
      ["Name", "Age"],
      ["Ada", "36"],
    ]);
  });

  it("keeps empty trailing fields", () => {
    expect(parseCsv("a,b,c\n1,,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("inferColumnType", () => {
  it("reads Notion's yes/no as a checkbox", () => {
    expect(inferColumnType(["Yes", "No", "yes"])).toBe("checkbox");
  });

  it("reads dates and numbers", () => {
    expect(inferColumnType(["2026-01-02", "2026-03-04"])).toBe("date");
    expect(inferColumnType(["1.25", "2.5", "-3.75"])).toBe("number");
    // Integers and ordinary decimals are numbers: their canonical string form
    // regenerates the source exactly, so verification hashes still match.
    expect(inferColumnType(["1", "2", "3"])).toBe("number");
    expect(inferColumnType(["0.1", "19.99", "-4.7"])).toBe("number");
  });

  it("uses select only when values actually repeat", () => {
    expect(inferColumnType(["Todo", "Doing", "Todo", "Doing", "Todo", "Done"])).toBe("select");
    // All distinct: option rows would cost more than they explain.
    expect(inferColumnType(["alpha", "beta", "gamma"])).toBe("text");
  });

  it("keeps a multi-select as text rather than inventing one option per combination", () => {
    expect(inferColumnType(["red, blue", "red", "red, blue", "red"])).toBe("text");
  });

  it("falls back to text for an empty column", () => {
    expect(inferColumnType(["", "", ""])).toBe("text");
  });

  it("keeps leading-zero ids, exponents, and lossy decimal forms as text", () => {
    expect(inferColumnType(["00123", "00456"])).toBe("text");
    expect(inferColumnType(["9007199254740993", "9007199254740995"])).toBe("text");
    expect(inferColumnType(["1e3", "2e3"])).toBe("text");
    expect(inferColumnType(["1.50", "2.50"])).toBe("text");
    expect(inferColumnType(["-0", "0"])).toBe("text");
    expect(tableFromCsv("Code\n00123\n9007199254740993\n").rows.map((row) => row.cells["ref:c0"])).toEqual([
      "00123",
      "9007199254740993",
    ]);
  });
});

describe("coerceValue", () => {
  it("maps each type to what the cell route accepts", () => {
    expect(coerceValue("checkbox", "Yes")).toBe(true);
    expect(coerceValue("checkbox", "No")).toBe(false);
    expect(coerceValue("number", "42")).toBe(42);
    // Notion writes a range or a timestamp; only the leading day is representable.
    expect(coerceValue("date", "2026-01-02 → 2026-01-09")).toBe("2026-01-02");
    expect(coerceValue("select", "Todo")).toEqual({ option: "Todo" });
    expect(coerceValue("text", "")).toBeNull();
  });
});

describe("tableFromCsv", () => {
  it("builds columns and rows addressed by ref so one request carries both", () => {
    const issues = [];
    const table = tableFromCsv(
      "Name,Status,Done,Count\nFirst,Todo,Yes,1.25\nSecond,Doing,No,2.5\nThird,Todo,Yes,3.75\nFourth,Doing,No,4.5\n",
      (code, detail) => issues.push(`${code}:${detail}`),
    );

    expect(table.columns).toEqual([
      { ref: "c0", name: "Name", type: "text" },
      { ref: "c1", name: "Status", type: "select" },
      { ref: "c2", name: "Done", type: "checkbox" },
      { ref: "c3", name: "Count", type: "number" },
    ]);
    expect(table.rows[0].cells).toEqual({
      "ref:c0": "First",
      "ref:c1": { option: "Todo" },
      "ref:c2": true,
      "ref:c3": 1.25,
    });
    expect(issues).toEqual([]);
  });

  it("skips blank rows and omits empty cells, which already read as null", () => {
    const table = tableFromCsv("Name,Note\nOnly,\n,\n");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].cells).toEqual({ "ref:c0": "Only" });
  });

  it("names an unnamed column and reports a degraded multi-select", () => {
    const issues = [];
    // The multi-select has to be quoted, or the comma inside it is a field separator.
    const table = tableFromCsv('Tags,\n"red, blue",x\n"red, blue",y\nred,z\n', (code, detail) =>
      issues.push(`${code}:${detail}`),
    );
    expect(table.columns[1].name).toBe("Column 2");
    expect(issues.some((issue) => issue.startsWith("column_type_degraded:"))).toBe(true);
  });
});
