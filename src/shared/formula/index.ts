// One browser/Worker entry point. Evaluation receives data; it never fetches it.
import "./functions/index";
import { parseRaw } from "./parser";
import { resolve } from "./resolver";
import { typecheck } from "./typecheck";
import { registry } from "./functions/registry";
import { evaluate } from "./eval";
import { BaseFormulaGraph } from "./graph";
import { FormulaParseError } from "./error";
import { DEFAULT_MAX_DEPTH, type FormulaTypeOptions, type FormulaResultType, type Value } from "./types";
import { format } from "./format";
export { format } from "./format";
export { isErrorCell } from "./error";
export type { FormulaTypeOptions, Value } from "./types";

export type FormulaProperty = { id: string; name: string; type: string; config?: unknown };
export type ComputedSourceStamp = {
  version: 1;
  tableId: string;
  tableRevision: number;
  schemaRevision: number;
  rowId: string;
  rowRevision: number;
  dependencies: Array<{ tableId: string; propertyId: string; schemaRevision: number }>;
};
export type ComputedValue = { version: 1; value: Value; source: ComputedSourceStamp };

export function compileFormula(
  source: string,
  properties: readonly FormulaProperty[],
  propertyId: string,
): FormulaTypeOptions {
  const names = new Map(properties.map((p) => [p.name, p.id]));
  const resolved = resolve(parseRaw(source), names);
  if (resolved.dependencies.includes(propertyId))
    throw new FormulaParseError([
      {
        code: "CYCLE",
        message: "Formula cycle: a property cannot reference itself",
        span: { start: 0, end: source.length },
      },
    ]);
  const types = new Map<string, FormulaResultType>();
  for (const p of properties) {
    const type = propertyResultType(p);
    if (type) types.set(p.id, type);
  }
  const resultType = typecheck(resolved.ast, types, registry).resultType;
  const config: FormulaTypeOptions = { source, ...resolved, resultType, astVersion: 1 };
  const graph = new BaseFormulaGraph(properties.map((p) => ({ id: p.id, type: p.type, typeOptions: p.config })));
  const cycle = graph.detectCycle({ id: propertyId, type: "formula", typeOptions: config });
  if (cycle)
    throw new FormulaParseError([
      { code: "CYCLE", message: `Formula cycle: ${cycle.join(" → ")}`, span: { start: 0, end: source.length } },
    ]);
  return config;
}

function propertyResultType(property: FormulaProperty): FormulaResultType | undefined {
  if (property.type === "formula") {
    const config = property.config as FormulaTypeOptions | undefined;
    return config?.validationError ? undefined : config?.resultType;
  }
  if (property.type === "number") return "number";
  if (property.type === "checkbox" || property.type === "boolean") return "boolean";
  if (["date", "created_time", "last_edited_time"].includes(property.type)) return "date";
  if (["text", "url", "email", "phone", "select", "status", "created_by", "last_edited_by"].includes(property.type))
    return "string";
  return undefined;
}

/** Recheck the stored ID-bound AST after schema changes; never resolve old source
 * names again. Invalid dependencies stay readable and produce explicit errors. */
function retypeFormula(config: FormulaTypeOptions, properties: readonly FormulaProperty[]): FormulaTypeOptions {
  try {
    const types = new Map<string, FormulaResultType>();
    for (const property of properties) {
      const type = propertyResultType(property);
      if (type) types.set(property.id, type);
    }
    const resultType = typecheck(config.ast, types, registry).resultType;
    return {
      ...config,
      source: format(config.ast, new Map(properties.map((property) => [property.id, property.name]))),
      resultType,
      validationError: undefined,
    };
  } catch (cause) {
    if (!(cause instanceof FormulaParseError)) throw cause;
    return { ...config, resultType: "null", validationError: cause.message };
  }
}

export function retypeFormulaProperties<T extends FormulaProperty>(properties: readonly T[]): T[] {
  const next = properties.map((property) => ({ ...property }));
  for (const id of formulaDependencyOrder(next)) {
    const index = next.findIndex((property) => property.id === id);
    const property = next[index]!;
    next[index] = { ...property, config: retypeFormula(property.config as FormulaTypeOptions, next) };
  }
  return next;
}

export function evaluateFormula(
  config: FormulaTypeOptions,
  row: Record<string, unknown>,
  properties: readonly FormulaProperty[],
): Value {
  if (config.astVersion !== 1) return { __err: "TYPE_MISMATCH", msg: "Unsupported formula AST version", v: 1 };
  const currentProperties = retypeFormulaProperties(properties);
  const current = retypeFormula(config, currentProperties);
  if (current.validationError) return { __err: "DEPENDENCY_ERROR", msg: current.validationError, v: 1 };
  return evaluate(config.ast, row, {
    registry,
    properties: new Map(currentProperties.map((p) => [p.id, { id: p.id, type: p.type, typeOptions: p.config }])),
    depth: 0,
    maxDepth: DEFAULT_MAX_DEPTH,
    memo: new Map(),
  });
}

export function formulaDependencyOrder(properties: readonly FormulaProperty[], changedIds?: string[]): string[] {
  const graph = new BaseFormulaGraph(properties.map((p) => ({ id: p.id, type: p.type, typeOptions: p.config })));
  const affected = changedIds ? new Set(graph.affectedFormulas(changedIds)) : undefined;
  return graph
    .evalOrder()
    .filter((id) => properties.some((p) => p.id === id && p.type === "formula") && (!affected || affected.has(id)));
}
