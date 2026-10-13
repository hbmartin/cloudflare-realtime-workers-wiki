import type {
  PageKind,
  SearchArchiveState,
  SearchFilters,
  SearchResponse,
  SearchSnippetSource,
  SearchTitleSuggestion,
} from "../shared/types";
import { PAGE_KINDS } from "../shared/page-kind";
import { ID_PATTERN } from "../shared/validation";
import type { MemberContext } from "./env";
import { HttpError } from "./http";
import { ACCEPTED_PAGE_DELETION_SQL } from "./cleanup";
import { pageJson, type PageJsonRow } from "./page-row";
import { normalizedTitle, titleSimilarity, titleTrigramMatch } from "../shared/title-search";

const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_OFFSET_MAX = 1_000;

/** Forward-only normalization repair. Triggers provide immediate substring reads;
 * the queue handles Unicode NFKC unavailable in SQLite's built-in lower(). */
export async function normalizeQueuedTitles(database: D1Database, workspaceId?: string) {
  const rows = await database
    .prepare(
      `SELECT p.id,p.title,p.updated_at,p.is_template,p.import_job_id FROM page_title_normalization_queue q
     JOIN pages p ON p.id=q.page_id WHERE (? IS NULL OR p.workspace_id=?) ORDER BY p.id LIMIT 500`,
    )
    .bind(workspaceId ?? null, workspaceId ?? null)
    .all<{ id: string; title: string; updated_at: number; is_template: number; import_job_id: string | null }>();
  for (let index = 0; index < rows.results.length; index += 25) {
    await database.batch(
      rows.results.slice(index, index + 25).flatMap((row) => [
        database
          .prepare(`UPDATE page_title_titles SET normalized_title=? WHERE page_id=? AND EXISTS(
        SELECT 1 FROM pages p WHERE p.id=? AND p.title=? AND p.updated_at=? AND p.is_template=0 AND p.import_job_id IS NULL)`)
          .bind(normalizedTitle(row.title), row.id, row.id, row.title, row.updated_at),
        database
          .prepare(`DELETE FROM page_title_normalization_queue WHERE page_id=? AND EXISTS(
        SELECT 1 FROM pages p WHERE p.id=? AND p.title=? AND p.updated_at=?)`)
          .bind(row.id, row.id, row.title, row.updated_at),
      ]),
    );
  }
  const pending = await database
    .prepare(`SELECT count(*) count FROM page_title_normalization_queue q
    JOIN pages p ON p.id=q.page_id WHERE (? IS NULL OR p.workspace_id=?)`)
    .bind(workspaceId ?? null, workspaceId ?? null)
    .first<{ count: number }>();
  return { inspected: rows.results.length, pending: pending?.count ?? 0, complete: pending?.count === 0 };
}
// Private-use sentinels, written as escapes so they survive editors and review.
const SNIPPET_OPEN = "\uE000";
const SNIPPET_CLOSE = "\uE001";

type SearchRow = PageJsonRow & {
  space_name: string;
  space_icon: string | null;
  rank_tier: number;
  score: number;
  title_excerpt: string;
  tag_excerpt: string;
  body_excerpt: string;
  comment_excerpt: string;
  attachment_excerpt: string;
};

type TitleRow = PageJsonRow & { space_name: string; space_icon: string | null };

function integerParameter(value: string | null, name: string, fallback: number, minimum: number, maximum: number) {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new HttpError(422, "invalid_search_filter", `${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(422, "invalid_search_filter", `${name} is outside the supported range.`);
  }
  return parsed;
}

function optionalTimestamp(value: string | null, name: string) {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(422, "invalid_search_filter", `${name} must be a Unix timestamp in milliseconds.`);
  }
  return parsed;
}

function optionalId(value: string | null, name: string) {
  if (value === null || value === "") return undefined;
  if (!ID_PATTERN.test(value)) throw new HttpError(422, "invalid_search_filter", `${name} is invalid.`);
  return value;
}

function oneOf<T extends string>(value: string | null, name: string, values: readonly T[]): T | undefined {
  if (value === null || value === "") return undefined;
  if (!values.includes(value as T)) {
    throw new HttpError(422, "invalid_search_filter", `${name} is invalid.`);
  }
  return value as T;
}

export function parseSearchRequest(url: string) {
  const parameters = new URL(url).searchParams;
  const query = (parameters.get("q") ?? "").trim().slice(0, 200);
  const tagIds = [...new Set(parameters.getAll("tag").flatMap((value) => value.split(",")))].filter(Boolean);
  if (tagIds.length > 20 || tagIds.some((id) => !ID_PATTERN.test(id))) {
    throw new HttpError(422, "invalid_search_filter", "tag is invalid.");
  }
  const updatedFrom = optionalTimestamp(parameters.get("updatedFrom"), "updatedFrom");
  const updatedTo = optionalTimestamp(parameters.get("updatedTo"), "updatedTo");
  if (updatedFrom !== undefined && updatedTo !== undefined && updatedFrom > updatedTo) {
    throw new HttpError(422, "invalid_search_filter", "updatedFrom must not be later than updatedTo.");
  }
  const hasCommentsValue = oneOf(parameters.get("hasComments"), "hasComments", ["true", "false"] as const);
  const spaceId = optionalId(parameters.get("space"), "space");
  const creatorId = optionalId(parameters.get("creator"), "creator");
  const kind = oneOf<PageKind>(parameters.get("kind"), "kind", PAGE_KINDS);
  const archive = oneOf<SearchArchiveState>(parameters.get("archive"), "archive", ["active", "archived", "all"]);
  const filters: SearchFilters = {
    ...(spaceId ? { spaceId } : {}),
    ...(tagIds.length ? { tagIds } : {}),
    ...(creatorId ? { creatorId } : {}),
    ...(kind ? { kind } : {}),
    ...(updatedFrom === undefined ? {} : { updatedFrom }),
    ...(updatedTo === undefined ? {} : { updatedTo }),
    ...(hasCommentsValue === undefined ? {} : { hasComments: hasCommentsValue === "true" }),
    ...(archive ? { archive } : {}),
  };
  return {
    query,
    filters,
    limit: integerParameter(parameters.get("limit"), "limit", SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX),
    offset: integerParameter(parameters.get("offset"), "offset", 0, 0, SEARCH_OFFSET_MAX),
  };
}

function searchMatch(query: string) {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
  return terms.length ? terms.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" AND ") : null;
}

function cleanExcerpt(value: string) {
  return value.replaceAll(SNIPPET_OPEN, "").replaceAll(SNIPPET_CLOSE, "").trim();
}

function resultSnippet(row: SearchRow): { source: SearchSnippetSource; text: string } {
  const candidates: Array<[SearchSnippetSource, string]> = [
    ["title", row.title_excerpt],
    ["tag", row.tag_excerpt],
    ["body", row.body_excerpt],
    ["comment", row.comment_excerpt],
    ["attachment", row.attachment_excerpt],
  ];
  const marked = candidates.find(([, value]) => value.includes(SNIPPET_OPEN));
  if (marked) return { source: marked[0], text: cleanExcerpt(marked[1]) };
  return { source: "title", text: row.title };
}

export async function searchPages(
  database: D1Database,
  member: MemberContext,
  request: ReturnType<typeof parseSearchRequest>,
): Promise<SearchResponse> {
  const match = searchMatch(request.query);
  if (!match) return { results: [], limit: request.limit, offset: request.offset, hasMore: false };
  await normalizeQueuedTitles(database, member.workspace.id);

  const conditions = [
    "page_search_v2 MATCH ?",
    "p.workspace_id = ?",
    "p.import_job_id IS NULL",
    "p.is_template = 0",
    `NOT ${ACCEPTED_PAGE_DELETION_SQL}`,
    "(? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)",
  ];
  const whereBindings: unknown[] = [match, member.workspace.id, member.role];
  const { filters } = request;
  if (filters.spaceId) {
    conditions.push("p.space_id = ?");
    whereBindings.push(filters.spaceId);
  }
  if (filters.tagIds?.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM page_tags selected_tag
        WHERE selected_tag.page_id = p.id AND selected_tag.tag_id IN (${filters.tagIds.map(() => "?").join(", ")}))`,
    );
    whereBindings.push(...filters.tagIds);
  }
  if (filters.creatorId) {
    conditions.push("p.created_by = ?");
    whereBindings.push(filters.creatorId);
  }
  if (filters.kind) {
    conditions.push("p.kind = ?");
    whereBindings.push(filters.kind);
  }
  if (filters.updatedFrom !== undefined) {
    conditions.push("p.updated_at >= ?");
    whereBindings.push(filters.updatedFrom);
  }
  if (filters.updatedTo !== undefined) {
    conditions.push("p.updated_at <= ?");
    whereBindings.push(filters.updatedTo);
  }
  if (filters.hasComments !== undefined) {
    conditions.push(
      `${filters.hasComments ? "" : "NOT "}EXISTS (
        SELECT 1 FROM comment_threads present_thread JOIN comments present_comment
          ON present_comment.thread_id = present_thread.id AND present_comment.deleted_at IS NULL
         WHERE present_thread.page_id = p.id)`,
    );
  }
  if ((filters.archive ?? "active") === "active") conditions.push("p.archived_at IS NULL");
  if (filters.archive === "archived") conditions.push("p.archived_at IS NOT NULL");

  const normalized = request.query.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase();
  const prefix = `${normalized.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = await database
    .prepare(
      `SELECT p.*, s.name space_name, s.icon space_icon,
              CASE WHEN lower(trim(p.title)) = ? THEN 0
                   WHEN lower(p.title) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END rank_tier,
              bm25(page_search_v2, 0, 0, 0, 12.0, 8.0, 4.0, 2.0, 1.0) score,
              snippet(page_search_v2, 3, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) title_excerpt,
              snippet(page_search_v2, 4, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) tag_excerpt,
              snippet(page_search_v2, 5, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) body_excerpt,
              snippet(page_search_v2, 6, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) comment_excerpt,
              snippet(page_search_v2, 7, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) attachment_excerpt
         FROM page_search_v2 JOIN pages p ON p.id = page_search_v2.page_id
         JOIN spaces s ON s.id = p.space_id
         LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank_tier, score, p.updated_at DESC, p.id
        LIMIT ? OFFSET ?`,
    )
    .bind(normalized, prefix, member.user.id, ...whereBindings, request.limit + 1, request.offset)
    .all<SearchRow>();
  const hasMore = rows.results.length > request.limit;
  if (!rows.results.length && Array.from(request.query).length >= 4) {
    // An empty later page must not switch algorithms after primary results.
    const primaryExists =
      request.offset > 0
        ? await database
            .prepare(
              `SELECT 1 FROM page_search_v2 JOIN pages p ON p.id=page_search_v2.page_id
       JOIN spaces s ON s.id=p.space_id LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=?
       WHERE ${conditions.join(" AND ")} LIMIT 1`,
            )
            .bind(member.user.id, ...whereBindings)
            .first()
        : null;
    const trigramMatch = titleTrigramMatch(request.query);
    if (!primaryExists && trigramMatch) {
      const fuzzyConditions = ["page_title_trigrams MATCH ?", ...conditions.slice(1)];
      const candidates = await database
        .prepare(
          `SELECT p.*,s.name space_name,s.icon space_icon FROM page_title_trigrams
         JOIN pages p ON p.id=page_title_trigrams.page_id JOIN spaces s ON s.id=p.space_id
         LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=?
         WHERE ${fuzzyConditions.join(" AND ")}
         ORDER BY bm25(page_title_trigrams),p.updated_at DESC,p.id LIMIT 500`,
        )
        .bind(member.user.id, trigramMatch, ...whereBindings.slice(1))
        .all<TitleRow>();
      const ranked = candidates.results
        .map((row) => ({ row, score: titleSimilarity(request.query, row.title) }))
        .filter((candidate) => candidate.score >= 0.2)
        .sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at || a.row.id.localeCompare(b.row.id));
      return {
        results: ranked.slice(request.offset, request.offset + request.limit).map(({ row }) => ({
          page: pageJson(row),
          space: { id: row.space_id!, name: row.space_name, icon: row.space_icon },
          snippet: { source: "title", text: row.title },
        })),
        limit: request.limit,
        offset: request.offset,
        hasMore: ranked.length > request.offset + request.limit,
        matchMode: "title-typo",
      };
    }
  }
  return {
    results: rows.results.slice(0, request.limit).map((row) => ({
      page: pageJson(row),
      space: { id: row.space_id!, name: row.space_name, icon: row.space_icon },
      snippet: resultSnippet(row),
    })),
    limit: request.limit,
    offset: request.offset,
    hasMore,
  };
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export async function searchTitles(database: D1Database, member: MemberContext, url: string) {
  const parameters = new URL(url).searchParams;
  const query = (parameters.get("q") ?? "").trim().slice(0, 100);
  const limit = integerParameter(parameters.get("limit"), "limit", 10, 1, 20);
  const kind = oneOf<PageKind>(parameters.get("kind"), "kind", PAGE_KINDS);
  if (!query) return { suggestions: [] as SearchTitleSuggestion[] };
  const escaped = escapeLike(query);
  const rows = await database
    .prepare(
      `SELECT p.*, s.name space_name, s.icon space_icon
         FROM pages p JOIN spaces s ON s.id = p.space_id
         LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE p.workspace_id = ? AND p.import_job_id IS NULL AND p.is_template = 0
          AND p.archived_at IS NULL AND p.title LIKE ? ESCAPE '\\'
          AND (? IS NULL OR p.kind = ?)
          AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        ORDER BY CASE WHEN lower(trim(p.title)) = lower(?) THEN 0
                      WHEN p.title LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                 p.updated_at DESC, p.id
        LIMIT ?`,
    )
    .bind(
      member.user.id,
      member.workspace.id,
      `%${escaped}%`,
      kind ?? null,
      kind ?? null,
      member.role,
      query,
      `${escaped}%`,
      limit,
    )
    .all<TitleRow>();
  return {
    suggestions: rows.results.map((row) => ({
      page: {
        id: row.id,
        spaceId: row.space_id!,
        kind: row.kind,
        title: row.title,
        icon: row.icon,
        archivedAt: row.archived_at,
        updatedAt: row.updated_at,
      },
      space: { id: row.space_id!, name: row.space_name, icon: row.space_icon },
    })),
  };
}
