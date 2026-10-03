import type { Env } from "./env";

// These statements belong in the same D1 batch as the mutation. Context is never
// visible to another writer and rolls back with the page changes.
export function activityMutationStart(
  database: Env["DB"],
  pageIdsSql: string,
  binds: (string | number | null)[],
  operationId: string,
  source: "import" | "move" | "archive",
  slackEligible = true,
) {
  return database
    .prepare(`INSERT INTO activity_mutation_context(page_id,operation_id,source,slack_eligible,bulk)
    SELECT id,?,?,?,CASE WHEN (SELECT count(*) FROM (${pageIdsSql}))>1 THEN 1 ELSE 0 END FROM (${pageIdsSql})`)
    .bind(operationId, source, slackEligible ? 1 : 0, ...binds, ...binds);
}
export function activityMutationEnd(database: Env["DB"], operationId: string) {
  return database.prepare("DELETE FROM activity_mutation_context WHERE operation_id=?").bind(operationId);
}

// Mutation classification counts active pages while the mutation may still include archived descendants.
export function activePageSelectionSql(selection: string) {
  return `SELECT id FROM (${selection}) WHERE id IN (SELECT id FROM pages WHERE archived_at IS NULL)`;
}
