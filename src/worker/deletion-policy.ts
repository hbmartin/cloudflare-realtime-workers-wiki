/** Trusted SQL expressions may reference any caller alias or use bound placeholders. */
export function acceptedPageDeletionSql(pageId: string, workspaceId: string) {
  let alias = "accepted_deletion";
  while (pageId.includes(alias) || workspaceId.includes(alias)) alias += "_";
  return `EXISTS(SELECT 1 FROM deletion_job_pages ${alias}_page
    JOIN deletion_jobs ${alias}_job ON ${alias}_job.id=${alias}_page.job_id
    WHERE ${alias}_page.page_id=${pageId} AND ${alias}_job.workspace_id=${workspaceId}
      AND ${alias}_job.phase IN ('rows','cleanup'))`;
}

export const ACCEPTED_PAGE_DELETION_SQL = acceptedPageDeletionSql("p.id", "p.workspace_id");
