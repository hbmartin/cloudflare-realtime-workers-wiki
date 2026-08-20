/**
 * Ceilings for structured tables, shared by the worker and the table UI.
 *
 * The original 500-row cap was enforced on both the write and the read side, so a
 * table that somehow exceeded it became entirely unreadable rather than truncated.
 * Paging replaces the read-side cap; the write-side cap remains, just much higher.
 */

/** Rows per table. Bounded by D1's 10 GB database ceiling, not by the read path. */
export const TABLE_MAX_ROWS = 20_000;

/** Rows returned when a request does not ask for a specific page size. */
export const TABLE_PAGE_DEFAULT = 500;

/** Largest page a caller may request. Keeps one response well inside D1's limits. */
export const TABLE_PAGE_MAX = 500;

/**
 * How deep an offset-paged sort may reach. Sorting by an arbitrary column cannot be
 * keyset-paged cheaply across five typed value columns, and the only caller is a
 * human scrolling a sorted view, so depth is capped rather than left unbounded.
 */
export const TABLE_SORT_MAX_OFFSET = 5_000;

/**
 * Caps for one bulk table write. Sized so a request stays far inside D1's limits:
 * each statement binds a single JSON blob plus its guards (well under 100 bound
 * parameters), and the whole batch is 7 statements against a 1000-query ceiling.
 */
export const TABLE_BULK_MAX_COLUMNS = 50;
export const TABLE_BULK_MAX_ROWS = 200;
export const TABLE_BULK_MAX_CELLS = 2_000;
export const TABLE_BULK_MAX_BODY_BYTES = 1024 * 1024;
