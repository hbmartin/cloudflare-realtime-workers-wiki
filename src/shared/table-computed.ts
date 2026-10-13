import {
  evaluateFormula,
  formulaDependencyOrder,
  isErrorCell,
  type ComputedValue,
  type FormulaProperty,
  type FormulaTypeOptions,
  type Value,
} from "./formula/index";

export function computeRowFormulas(input: {
  tableId: string;
  tableRevision: number;
  schemaRevision: number;
  rowId: string;
  rowRevision: number;
  cells: Record<string, unknown>;
  properties: readonly FormulaProperty[];
}): Record<string, ComputedValue> {
  const values = { ...input.cells };
  const computed: Record<string, ComputedValue> = {};
  for (const id of formulaDependencyOrder(input.properties)) {
    const property = input.properties.find((candidate) => candidate.id === id)!;
    const config = property.config as FormulaTypeOptions;
    const value = evaluateFormula(config, values, input.properties);
    values[id] = value;
    computed[id] = {
      version: 1,
      value,
      source: {
        version: 1,
        tableId: input.tableId,
        tableRevision: input.tableRevision,
        schemaRevision: input.schemaRevision,
        rowId: input.rowId,
        rowRevision: input.rowRevision,
        dependencies: config.dependencies.map((propertyId) => ({
          tableId: input.tableId,
          propertyId,
          schemaRevision: input.schemaRevision,
        })),
      },
    };
  }
  return computed;
}

export const CALCULATION_KINDS = [
  "row_count",
  "nonempty_count",
  "empty_count",
  "unique_count",
  "sum",
  "average",
  "min",
  "max",
  "earliest",
  "latest",
] as const;
export type CalculationKind = (typeof CALCULATION_KINDS)[number];
export type CalculationResult = {
  kind: CalculationKind;
  value: number | string | null;
  errorCount: number;
  unsupportedCount: number;
};

/** Pure algorithms adapted from AFFiNE 0b69a6da21e8fd35beb85667bb8496d9b3852238,
 * blocksuite/affine/data-view/src/core/statistics/{any,number}.ts; MIT.
 * Results stay typed; error cells/collections are excluded and reported. */
export function calculateColumn(kind: CalculationKind, inputs: readonly unknown[]): CalculationResult {
  let errorCount = 0,
    unsupportedCount = 0;
  const values: Value[] = [];
  for (const input of inputs) {
    if (isErrorCell(input)) {
      errorCount++;
      continue;
    }
    if (Array.isArray(input) && ["row_count", "nonempty_count", "empty_count"].includes(kind)) {
      values.push(input.length ? true : null);
      continue;
    }
    if (
      input !== null &&
      input !== undefined &&
      typeof input !== "string" &&
      typeof input !== "number" &&
      typeof input !== "boolean"
    ) {
      unsupportedCount++;
      continue;
    }
    if (typeof input === "number" && !Number.isFinite(input)) {
      errorCount++;
      continue;
    }
    values.push(input ?? null);
  }
  const nonempty = values.filter((value) => value !== null && value !== "");
  let value: number | string | null = null;
  if (kind === "row_count") value = inputs.length;
  else if (kind === "nonempty_count") value = nonempty.length;
  else if (kind === "empty_count") value = values.length - nonempty.length;
  else if (kind === "unique_count") value = new Set(nonempty.map((item) => `${typeof item}:${String(item)}`)).size;
  else if (kind === "earliest" || kind === "latest") {
    const dates = nonempty.filter(
      (item): item is string => typeof item === "string" && Number.isFinite(Date.parse(item)),
    );
    dates.sort((a, b) => Date.parse(a) - Date.parse(b));
    value = (kind === "earliest" ? dates[0] : dates.at(-1)) ?? null;
  } else {
    const numbers = nonempty.filter((item): item is number => typeof item === "number");
    if (kind === "sum") value = numbers.reduce((a, b) => a + b, 0);
    else if (numbers.length) {
      if (kind === "average") value = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      else if (kind === "min") value = Math.min(...numbers);
      else if (kind === "max") value = Math.max(...numbers);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      value = null;
      errorCount++;
    }
  }
  return { kind, value, errorCount, unsupportedCount };
}
