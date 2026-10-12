import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

// Count executions, including every statement in a batch, rather than prepares.
export function countedD1(original: D1Database) {
  const statements: string[] = [];
  const metadata = new WeakMap<D1PreparedStatement, { statement: D1PreparedStatement; sql: string }>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value: unknown = Reflect.get(target, property, target);
        if (["run", "all", "first", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            statements.push(sql);
            return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    metadata.set(proxy, { statement, sql });
    return proxy;
  };
  const database = new Proxy(original, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (batch: D1PreparedStatement[]) =>
          target.batch(
            batch.map((statement) => {
              const entry = metadata.get(statement);
              if (!entry) throw new Error("Uncounted batch statement");
              statements.push(entry.sql);
              return entry.statement;
            }),
          );
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, statements };
}
