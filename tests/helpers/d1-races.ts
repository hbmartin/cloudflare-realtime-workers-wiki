import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

// Run a competing write after a real D1 statement, so tests exercise the SQL CAS.
export function afterD1(
  db: D1Database,
  matches: (sql: string, method: string) => boolean,
  compete: () => Promise<void>,
) {
  let fired = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(statement, {
              get(prepared, method) {
                if (method === "bind") return (...args: unknown[]) => wrap(prepared.bind(...args));
                const value = Reflect.get(prepared, method, prepared);
                if (["first", "run", "all"].includes(String(method)) && typeof value === "function")
                  return async (...args: unknown[]) => {
                    const result: unknown = await value.apply(prepared, args);
                    if (!fired && matches(sql, String(method))) {
                      fired = true;
                      await compete();
                    }
                    return result;
                  };
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          return wrap(target.prepare(sql));
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
